import { BrowserWindow, Notification } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DatabaseSync } from 'node:sqlite';
import { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import { createLLMClient, createEmbedClient, getLLMModel, getEmbedModel } from '../llm/create-client';
import { TextOptimizer } from '../llm/text-optimizer';
import { Processor } from '../pipeline/processor';
import { QueryEngine } from '../rag/query-engine';
import { QueryAnalyzer } from '../rag/query-analyzer';
import { QueryAnalysisCache } from '../llm/query-analysis-cache';
import { resolvePasteCleanModel } from '../llm/paste-clean-model';
import { VectorStore } from '../rag/vector-store';
import { QueueTask } from '../pipeline/task-queue';
import { getDbPath, getVecDbPath, getTempDir, getOutputDir } from '../paths';
import { loadSettings } from '../settings';
import { MemoryManager } from '../agent/memory-manager';
import { KnowledgeCompiler } from '../agent/knowledge-compiler';
import { InsightEngine } from '../agent/insight-engine';
import { SyncManager } from '../sync/sync-manager';
import { LicenseManager } from '../licensing/license-manager';
import { SherpaEngineProxy } from '../audio/sherpa-engine-proxy';
import { BackgroundDownloadManager } from '../download-manager';
import type { LlamaServerManager } from '../llm/llama-server-manager';

// ─── IpcContext Interface ──────────────────────────────────

export interface IpcContext {
  getWindow: () => BrowserWindow | null;
  getDb: () => VoiceBrainDB;
  getLLM: () => LLMClient;
  getProcessor: () => Processor;
  getQueryEngine: () => QueryEngine;
  getVectorStore: () => VectorStore;
  getLicenseManager: () => LicenseManager;
  getSherpaEngine: () => SherpaEngineProxy;
  getDownloadManager: () => BackgroundDownloadManager | null;
  setDownloadManager: (mgr: BackgroundDownloadManager) => void;
  getMemoryManager: () => MemoryManager | null;
  reinitSingletons: () => void;
  resetLLMClient: () => void;
  spawnCheck: (cmd: string, args: string[], timeout?: number) => Promise<string>;
  spawnPipShow: (pipPackage: string) => Promise<void>;
  syncManager: SyncManager;
}

// ─── Singletons (lazy) ──────────────────────────────────────

let db: VoiceBrainDB | null = null;
let local: LLMClient | null = null;
let processor: Processor | null = null;
let queryEngine: QueryEngine | null = null;
let vectorStore: VectorStore | null = null;
let vecDb: DatabaseSync | null = null;
let licenseManager: LicenseManager | null = null;
let sherpaEngine: SherpaEngineProxy | null = null;
let downloadManager: BackgroundDownloadManager | null = null;
let memoryManagerInstance: MemoryManager | null = null;
let knowledgeCompilerInstance: KnowledgeCompiler | null = null;
let insightEngineInstance: InsightEngine | null = null;
let eventsWired = false;
let getWindowFn: (() => BrowserWindow | null) | null = null;

// ─── Sync Manager ───────────────────────────────────────────

const syncManager = new SyncManager();

// ─── Singleton Getters ──────────────────────────────────────

function getDb(): VoiceBrainDB {
  if (!db) {
    db = new VoiceBrainDB(getDbPath());
    // Enforce read-only at the database level when in sync read-only mode
    if (syncManager.isReadOnly()) {
      db.getRawDb().exec('PRAGMA query_only = ON');
    }
  }
  return db;
}

function getLLM(): LLMClient {
  if (!local) {
    const settings = loadSettings();
    local = createLLMClient(settings);
  }
  return local;
}

let embedLLM: LLMClient | null = null;

function getEmbedLLM(): LLMClient {
  if (!embedLLM) {
    const settings = loadSettings();
    embedLLM = createEmbedClient(settings);
  }
  return embedLLM;
}

/** Reset cached LLM client (call when llmProvider or cloud settings change). */
function resetLLMClient(): void {
  local = null;
  embedLLM = null;
  queryEngine = null; // QueryEngine holds a reference to the old client
  // Hot-swap the processor's internal LLM client instead of destroying it
  // (destroying would lose TaskQueue event wiring and MemoryManager reference)
  if (processor) {
    const settings = loadSettings();
    const newClient = createLLMClient(settings);
    const newModel = getLLMModel(settings);
    processor.updateLLMClient(newClient, newModel);
  }
  // Hot-swap KnowledgeCompiler's LLM client too
  if (knowledgeCompilerInstance) {
    const settings = loadSettings();
    const newClient = createLLMClient(settings);
    const newEmbedClient = createEmbedClient(settings);
    knowledgeCompilerInstance.updateLLMClient(newClient, newEmbedClient);
  }
}

function getVectorStore(): VectorStore {
  if (!vecDb) {
    vecDb = new DatabaseSync(getVecDbPath(), { allowExtension: true });
    vecDb.exec('PRAGMA journal_mode = WAL');
    if (syncManager.isReadOnly()) {
      vecDb.exec('PRAGMA query_only = ON');
    }
  }
  if (!vectorStore) {
    vectorStore = new VectorStore(vecDb);
  }
  return vectorStore;
}

function getQueryEngine(): QueryEngine {
  if (!queryEngine) {
    const settings = loadSettings();
    // Query analyzer defaults to the main model; on first query the paste-
    // clean tier is resolved asynchronously and the analyzer model is
    // swapped (see resolveAnalyzerModelAsync below). This avoids making
    // getQueryEngine itself async, which would ripple through call sites.
    const mainModel = getLLMModel(settings);
    const analyzer = new QueryAnalyzer(getLLM(), mainModel, new QueryAnalysisCache());
    queryEngine = new QueryEngine(
      getDb(),
      getVectorStore(),
      getLLM(),
      getEmbedModel(settings),
      getEmbedLLM(),
      analyzer,
    );
    // Fire-and-forget upgrade to paste-clean tier when available.
    resolvePasteCleanModel(settings)
      .then(({ model }) => {
        if (model && model !== mainModel) {
          analyzer.setModel(model);
          console.log(`[QueryEngine] analyzer upgraded to paste-clean tier: ${model}`);
        }
      })
      .catch(() => { /* keep main model */ });
  }
  return queryEngine;
}

function getSherpaEngineInstance(): SherpaEngineProxy {
  if (!sherpaEngine) {
    // Create proxy without workers — sufficient for model management (checkModels, downloadModels)
    // Workers are started later by initSherpaEngine()
    sherpaEngine = new SherpaEngineProxy();
    console.log('[ipc] SherpaEngineProxy created (no workers yet)');
  }
  return sherpaEngine;
}

/** Initialize the SherpaEngineProxy worker pool. Must be called once at startup. */
export async function initSherpaEngine(numBatchWorkers = 4): Promise<SherpaEngineProxy> {
  const proxy = getSherpaEngineInstance();
  await proxy.init(numBatchWorkers);
  console.log('[ipc] SherpaEngineProxy worker pool initialized');
  return proxy;
}

function getLicenseManagerInstance(): LicenseManager {
  if (!licenseManager) {
    const settings = loadSettings();
    const firstLaunch = settings.firstLaunchTime || Date.now();
    licenseManager = new LicenseManager(firstLaunch, settings.licenseKey || null);
    // Fire-and-forget: validate with server in background.
    // Until the response comes back, cachedValidation is null and the user
    // gets trial/free features locally — acceptable for startup UX.
    licenseManager.refreshValidation().catch((err) => {
      console.warn('[IPC] Background license validation failed:', err);
    });
  }
  return licenseManager;
}

function getProcessor(): Processor {
  if (!processor) {
    const settings = loadSettings();
    processor = new Processor({
      db: getDb(),
      dbPath: getDbPath(),
      outputDir: settings.outputDir || getOutputDir(),
      tempDir: getTempDir(),
      whisperModel: settings.whisperModel || 'sensevoice',
      llmModel: getLLMModel(settings),
      sherpaEngine: getSherpaEngineInstance(),
      licenseManager: getLicenseManagerInstance(),
    });
    processor.setQueryEngine(getQueryEngine());

    // Attach DB to TaskQueue for persistence, then restore any interrupted tasks
    const tq = processor.getTaskQueue();
    tq.setDb(getDb().getRawDb());
    tq.restoreFromDb();

    const memoryManager = new MemoryManager(getDb(), getLLM(), getEmbedLLM());
    memoryManagerInstance = memoryManager;
    processor.setMemoryManager(memoryManager);
    queryEngine!.setMemoryManager(memoryManager);

    // Knowledge compiler
    knowledgeCompilerInstance = new KnowledgeCompiler(getDb(), getLLM(), getVectorStore(), getEmbedLLM());
    knowledgeCompilerInstance.start();
    processor.setKnowledgeCompiler(knowledgeCompilerInstance);
  }
  // Wire TaskQueue events to renderer (once)
  if (!eventsWired && getWindowFn) {
    const tq = processor.getTaskQueue();
    const sendToRenderer = (channel: string) => (task: QueueTask) => {
      const win = getWindowFn!();
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, {
          id: task.id,
          filePath: task.filePath,
          status: task.status,
          progress: task.progress,
          error: task.error,
          notes: task.notes,
          mediaType: task.mediaType,
          createdAt: task.createdAt.toISOString(),
        });
      }
    };
    tq.on('task:added', sendToRenderer('pipeline:task:added'));
    tq.on('task:progress', sendToRenderer('pipeline:task:progress'));
    tq.on('task:completed', (task: QueueTask) => {
      sendToRenderer('pipeline:task:completed')(task);
      if (Notification.isSupported()) {
        const lang = loadSettings().language;
        new Notification({
          title: lang === 'zh' ? '处理完成' : 'Processing Complete',
          body: lang === 'zh' ? `${path.basename(task.filePath)} 已就绪` : `${path.basename(task.filePath)} is ready.`,
        }).show();
      }
    });
    tq.on('task:failed', (task: QueueTask) => {
      sendToRenderer('pipeline:task:failed')(task);
      if (Notification.isSupported()) {
        const lang = loadSettings().language;
        new Notification({
          title: lang === 'zh' ? '处理失败' : 'Processing Failed',
          body: `${path.basename(task.filePath)}: ${task.error || (lang === 'zh' ? '未知错误' : 'Unknown error')}`,
        }).show();
      }
    });
    eventsWired = true;
  }
  return processor;
}

/** Reset all cached singletons (called when sync paths change). */
function reinitSingletons(): void {
  // Mark any active tasks as interrupted before closing the DB
  if (processor) {
    try {
      const tq = processor.getTaskQueue();
      tq.markActiveAsInterrupted();
      tq.dispose();
    } catch { /* best-effort */ }
  }
  // Close existing handles
  if (db) { db.close(); db = null; }
  if (vecDb) { vecDb.close(); vecDb = null; }
  if (sherpaEngine) { sherpaEngine.dispose().catch(() => {}); sherpaEngine = null; }
  processor = null;
  queryEngine = null;
  vectorStore = null;
  local = null;
  embedLLM = null;
  memoryManagerInstance = null;
  knowledgeCompilerInstance?.stop();
  knowledgeCompilerInstance = null;
  insightEngineInstance = null;
  licenseManager = null;
  eventsWired = false;
  console.log('[ipc] Singletons re-initialized for new paths');
}

// Wire syncManager callbacks
syncManager.setReinitCallback(reinitSingletons);
syncManager.setDbAccessors(
  () => db ? (db as any).db : null,
  () => vecDb,
);

// ─── Helpers ─────────────────────────────────────────────────

function spawnCheck(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { timeout });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        const version = stdout.split('\n')[0].trim();
        resolve(version);
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

function spawnPipShow(pipPackage: string): Promise<void> {
  const venvPip = process.platform === 'win32'
    ? require('path').join(__dirname, '../../python/venv/Scripts/pip.exe')
    : require('path').join(__dirname, '../../python/venv/bin/pip');
  return new Promise((resolve, reject) => {
    const proc = spawn(venvPip, ['show', pipPackage], { timeout: 10000 });
    proc.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`${pipPackage} not found`)); });
    proc.on('error', reject);
  });
}

// ─── Shared Helper Functions ────────────────────────────────

export function getKnowledgeCompiler(): KnowledgeCompiler | null {
  getProcessor(); // ensure initialized
  return knowledgeCompilerInstance;
}

/**
 * Lazily build the InsightEngine used by the scheduled `insight_scan` action.
 * Wires the LLM (topic-trend extraction), the embed client + vector store
 * (memory correlation). Without this, insight_scan returns "InsightEngine not
 * available" on every run.
 */
export function getInsightEngine(): InsightEngine {
  if (!insightEngineInstance) {
    const settings = loadSettings();
    const engine = new InsightEngine(getDb());
    engine.setLLM(getLLM(), getLLMModel(settings), getEmbedModel(settings), getEmbedLLM());
    engine.setVectorStore(getVectorStore());
    insightEngineInstance = engine;
  }
  return insightEngineInstance;
}

/** Get concatenated raw_text of all segments for a recording (for clipboard paste). */
export function getSegmentTextForRecording(recordingId: number): string {
  const settings = loadSettings();
  const segments = getDb().getSegmentsByRecording(recordingId);
  const texts = segments
    .map((s) => s.raw_text || '')
    .filter((t) => t.length > 0);
  return settings.clipboardContinuous ? texts.join('') : texts.join('\n');
}

/** Used by the custom `media://` protocol handler in main.ts */
export function getRecordingFilePath(recordingId: number): string | null {
  try {
    const rec = getDb().getRecording(recordingId);
    return rec?.file_path || null;
  } catch {
    return null;
  }
}

// ─── Cleanup ────────────────────────────────────────────────

export async function cleanupSingletons(): Promise<void> {
  // Mark any active tasks as interrupted before closing the DB
  if (processor) {
    try {
      const tq = processor.getTaskQueue();
      tq.markActiveAsInterrupted();
      tq.dispose();
    } catch {
      // Best-effort — DB may already be closing
    }
  }
  // Terminate worker threads before closing DB (workers may hold DB refs)
  if (sherpaEngine) {
    try {
      await sherpaEngine.dispose();
    } catch {
      // Best-effort
    }
    sherpaEngine = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  if (vecDb) {
    vecDb.close();
    vecDb = null;
  }
  processor = null;
  queryEngine = null;
  vectorStore = null;
  local = null;
  embedLLM = null;
  memoryManagerInstance = null;
  knowledgeCompilerInstance?.stop();
  knowledgeCompilerInstance = null;
  insightEngineInstance = null;
  licenseManager = null;
  eventsWired = false;
}

// ─── Factory ────────────────────────────────────────────────

export function createIpcContext(windowGetter: () => BrowserWindow | null): IpcContext {
  getWindowFn = windowGetter;

  return {
    getWindow: windowGetter,
    getDb,
    getLLM,
    getProcessor,
    getQueryEngine,
    getVectorStore,
    getLicenseManager: getLicenseManagerInstance,
    getSherpaEngine: getSherpaEngineInstance,
    getDownloadManager: () => downloadManager,
    setDownloadManager: (mgr: BackgroundDownloadManager) => { downloadManager = mgr; },
    getMemoryManager: () => { getProcessor(); return memoryManagerInstance; },
    reinitSingletons,
    resetLLMClient,
    spawnCheck,
    spawnPipShow,
    syncManager,
  };
}

// ─── LlamaServer singleton ──────────────────────────────────

let llamaServerInstance: LlamaServerManager | null = null;

export function setLlamaServer(server: LlamaServerManager | null): void {
  llamaServerInstance = server;
}

export function getLlamaServer(): LlamaServerManager | null {
  return llamaServerInstance;
}
