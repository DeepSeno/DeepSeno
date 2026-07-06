import { app, ipcMain, shell, clipboard, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IpcContext } from './context';
import { ensureLlamaServer, getLlamaServer } from './context';
import { loadSettings, updateSettings, type AppSettings } from '../settings';
import { getSherpaModelMirror } from '../mirror-config';
import { getDbPath, getVecDbPath, getEffectiveDataDir, getLLMModelsDir } from '../paths';
import { detectHardware } from '../hardware-detector';
import { getLLMModel, getEmbedModel } from '../llm/create-client';
import { isExplicitModelNotFoundResponse, OpenAIClient } from '../llm/openai-client';
import { startFileWatching, cleanupFileWatcher } from './pipeline-handlers';
import { getFFmpegManager } from '../audio/ffmpeg-manager';
import { reconfigureFFmpeg } from '../audio/preprocessor';
import { resetAgentInfrastructure } from './integration-handlers';
import { requireString, requireUrl, ValidationError } from './validate';
import { getDefaultPrompts } from '../llm/default-prompts';
import { findModel, getDownloadUrl } from '../llm/gguf-model-catalog';
import { type GGUFDownloadState, ggufDownloadStateStore } from '../llm/gguf-download-state';
import { hasGGUFMagic, readGGUFFileInfo, validateGGUFFilePath } from '../llm/gguf-model-files';
import { prepareLlamaRouterRuntime } from '../llm/llama-router-runtime';
import { toLocalModelApiName } from '../llm/model-names';

// Module-level state for tracking active downloads (survives page navigation)
let sherpaDlState: { model: string; completed: number; total: number; status: string } | null = null;

// ─── GGUF Model Download ───────────────────────────────────

const activeGGUFDownloads = new Map<string, {
  controller: AbortController;
  fileKey: string;
  promise: Promise<{ success: boolean; model: string; error?: string }>;
}>();
const activeGGUFFileDownloads = new Map<string, {
  controller: AbortController;
  model: string;
  promise: Promise<{ success: boolean; model: string; error?: string }>;
}>();

function emitGGUFState(ctx: IpcContext, state: GGUFDownloadState): void {
  const win = ctx.getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('model:pullProgress', state);
  }
}

function updateGGUFState(
  ctx: IpcContext,
  model: string,
  patch: Partial<Omit<GGUFDownloadState, 'model' | 'updatedAt'>>,
): GGUFDownloadState {
  const state = ggufDownloadStateStore.update(model, patch);
  emitGGUFState(ctx, state);
  return state;
}

function getPartialDownloadSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 ? stat.size : 0;
  } catch {
    return 0;
  }
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const match = /\/(\d+)$/.exec(contentRange.trim());
  if (!match) return null;
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function promoteValidatedDownload(tmpPath: string, destPath: string): void {
  const backupPath = `${destPath}.previous`;
  try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch { /* ignore */ }

  let movedExisting = false;
  if (fs.existsSync(destPath)) {
    fs.renameSync(destPath, backupPath);
    movedExisting = true;
  }

  try {
    fs.renameSync(tmpPath, destPath);
    if (movedExisting) {
      try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    }
  } catch (err) {
    if (movedExisting && fs.existsSync(backupPath) && !fs.existsSync(destPath)) {
      try { fs.renameSync(backupPath, destPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

/** Download a GGUF file from HuggingFace (or mirror) with progress reporting. */
async function downloadGGUF(
  modelId: string,
  ctx: IpcContext,
  signal?: AbortSignal,
  force = false,
): Promise<{ success: boolean; error?: string }> {
  const entry = findModel(modelId);
  if (!entry) return { success: false, error: `Unknown model: ${modelId}` };

  const modelsDir = getLLMModelsDir();
  const destPath = path.join(modelsDir, entry.fileName);
  const tmpPath = destPath + '.downloading';
  fs.mkdirSync(modelsDir, { recursive: true });

  if (force) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  // Skip if already fully downloaded
  if (!force && fs.existsSync(destPath)) {
    const validation = validateGGUFFilePath(destPath, entry.fileSizeBytes);
    if (validation.ok) {
      console.log(`[GGUF] Model already downloaded: ${entry.fileName} (${validation.size} bytes)`);
      return { success: true };
    }
    console.warn(`[GGUF] Existing model is invalid, redownloading: ${entry.fileName} (${validation.error})`);
  }

  const mirrors = ['', 'hf-mirror', 'ghfast'];
  const errors: string[] = [];

  for (const mirror of mirrors) {
    const url = getDownloadUrl(entry, mirror);
    const mirrorLabel = mirror || 'modelscope';
    const resumeFrom = force ? 0 : getPartialDownloadSize(tmpPath);
    const headers: Record<string, string> = { 'User-Agent': 'DeepSeno/1.0' };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    console.log(`[GGUF] Downloading ${entry.id} from ${mirrorLabel}: ${url}${resumeFrom > 0 ? ` (resume from ${resumeFrom})` : ''}`);

    try {
      let res = await fetch(url, {
        signal,
        headers,
      });

      if (res.status === 416 && resumeFrom > 0) {
        const validation = validateGGUFFilePath(tmpPath, entry.fileSizeBytes);
        if (validation.ok) {
          promoteValidatedDownload(tmpPath, destPath);
          return { success: true };
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        res = await fetch(url, {
          signal,
          headers: { 'User-Agent': 'DeepSeno/1.0' },
        });
      }

      if (!res.ok) {
        errors.push(`${mirrorLabel}: HTTP ${res.status}`);
        continue;
      }

      const shouldAppend = resumeFrom > 0 && res.status === 206;
      if (resumeFrom > 0 && !shouldAppend) {
        console.warn(`[GGUF] ${mirrorLabel} ignored Range request, restarting ${entry.fileName}`);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }

      const result = await streamToFile(
        res,
        tmpPath,
        destPath,
        entry,
        ctx,
        signal,
        shouldAppend ? resumeFrom : 0,
      );
      if (result.success) return result;
      errors.push(`${mirrorLabel}: ${result.error || 'Download failed'}`);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'cancelled' };
      }
      errors.push(`${mirrorLabel}: ${err.message || 'Download failed'}`);
    }
  }

  return {
    success: false,
    error: errors.length > 0 ? errors.join(' | ') : 'Download failed',
  };
}

function createDownloadErrorPreview(filePath: string): string {
  const info = readGGUFFileInfo(filePath);
  if (!info?.header) return '';
  if (hasGGUFMagic(info.header)) return '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const sample = Buffer.alloc(160);
      const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
      const text = sample.subarray(0, bytesRead).toString('utf8').replace(/\s+/g, ' ').trim();
      return text ? `: ${text.slice(0, 120)}` : '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function isEmbedModelName(modelName: string): boolean {
  const normalized = toLocalModelApiName(modelName).toLowerCase();
  return normalized.includes('bge') || findModel(modelName)?.type === 'embed';
}

async function smokeTestLocalModel(baseUrl: string, modelName: string, signal: AbortSignal): Promise<void> {
  const apiModel = toLocalModelApiName(modelName);
  if (isEmbedModelName(modelName)) {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: apiModel, input: 'hello' }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Embedding smoke test failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data: any = await res.json();
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('Embedding smoke test returned an empty vector');
    }
    return;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: apiModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Chat smoke test failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg?.content && !msg?.reasoning_content) {
    throw new Error('Chat smoke test returned an empty response');
  }
}

async function refreshLocalRouterAfterModelChange(ctx: IpcContext): Promise<void> {
  const settings = loadSettings();
  if (settings.llmProvider !== 'local') return;

  const server = ensureLlamaServer();
  const { modelsDir, presetPath } = prepareLlamaRouterRuntime();
  const { port } = await server.startRouter(modelsDir, {
    maxModels: 2,
    flashAttn: true,
    presetPath,
  });
  updateSettings({ llamaServerPort: port });
  ctx.resetLLMClient();
}

/** Stream HTTP response body to a temp file, rename on completion. */
async function streamToFile(
  res: Response,
  tmpPath: string,
  destPath: string,
  entry: { id: string; fileName: string; fileSizeBytes: number },
  ctx: IpcContext,
  signal?: AbortSignal,
  resumeFrom = 0,
): Promise<{ success: boolean; error?: string }> {
  const contentLength = res.headers.get('content-length');
  const rangeTotal = parseContentRangeTotal(res.headers.get('content-range'));
  const responseBytes = contentLength ? parseInt(contentLength, 10) : 0;
  const totalBytes = Math.max(
    rangeTotal || 0,
    responseBytes > 0 ? resumeFrom + responseBytes : 0,
    entry.fileSizeBytes,
  );

  const reader = res.body!.getReader();
  const ws = fs.createWriteStream(tmpPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  let completed = resumeFrom;
  let lastEmit = 0;

  // Catch stream errors to prevent uncaught exceptions from crashing the process
  let streamError: Error | null = null;
  ws.on('error', (err) => { streamError = err; });

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }

      if (streamError) throw streamError;

      const { done, value } = await reader.read();
      if (done) break;

      // Handle backpressure: wait for drain if write buffer is full
      if (!ws.write(value)) {
        await new Promise<void>((resolve, reject) => {
          if (streamError) { reject(streamError); return; }
          const cleanup = () => {
            ws.off('drain', onDrain);
            ws.off('error', onError);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (err: Error) => {
            streamError = err;
            cleanup();
            reject(err);
          };
          ws.once('drain', onDrain);
          ws.once('error', onError);
        });
      }
      completed += value.length;

      // Emit progress at most every 300ms
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        updateGGUFState(ctx, entry.id, {
          status: 'downloading',
          completed,
          total: totalBytes,
        });
      }
    }

    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    const validation = validateGGUFFilePath(tmpPath, entry.fileSizeBytes);
    if (!validation.ok) {
      const preview = createDownloadErrorPreview(tmpPath);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return {
        success: false,
        error: `${validation.error || 'Model verification failed'}${preview}`,
      };
    }

    promoteValidatedDownload(tmpPath, destPath);
    completed = validation.size;

    console.log(`[GGUF] Download complete: ${entry.fileName} (${completed} bytes)`);

    updateGGUFState(ctx, entry.id, {
      status: 'success',
      completed,
      total: totalBytes,
    });

    return { success: true };
  } catch (err: any) {
    reader.cancel().catch(() => {});
    ws.destroy();
    throw err;
  }
}

// ─── Main process log capture ──────────────────────────────
const LOG_BUFFER_MAX = 500;
const logBuffer: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function captureLog(level: string, args: any[]) {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = `[${ts}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  logBuffer.push(msg);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  // Forward to renderer
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w.isDestroyed()) w.webContents.send('main:log', msg);
    }
  } catch { /* ignore */ }
}

console.log = (...args: any[]) => { originalLog.apply(console, args); captureLog('INFO', args); };
console.error = (...args: any[]) => { originalError.apply(console, args); captureLog('ERROR', args); };
console.warn = (...args: any[]) => { originalWarn.apply(console, args); captureLog('WARN', args); };

export function registerSystemHandlers(ctx: IpcContext): void {
  // ─── DevTools & Logs ──────────────────────────────────────
  ipcMain.handle('system:openDevTools', () => {
    if (app.isPackaged) return; // Disabled in production
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.openDevTools({ mode: 'detach' });
  });

  ipcMain.handle('system:getMainLogs', () => {
    return logBuffer.slice();
  });

  // ─── System ────────────────────────────────────────────────
  ipcMain.handle('system:getStatus', async () => {
    let local = false;
    let aiProvider: AppSettings['llmProvider'] = 'local';
    try {
      const settings = loadSettings();
      aiProvider = settings.llmProvider;
      if (settings.llmProvider === 'local') {
        const status = getLlamaServer()?.getStatus();
        local = Boolean(status?.running && status.port);
      } else {
        local = Boolean(settings.cloudApiUrl && settings.cloudApiKey && settings.cloudModel);
      }
    } catch {
      // LLM not available
    }

    // Compute real storage used by database + output files
    let storageUsed = '0 MB';
    try {
      const dbStat = fs.statSync(getDbPath());
      const outputDir = loadSettings().outputDir || '';
      let totalBytes = dbStat.size;
      if (outputDir && fs.existsSync(outputDir)) {
        const walkDir = (dir: string): number => {
          let size = 0;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) size += walkDir(full);
            else size += fs.statSync(full).size;
          }
          return size;
        };
        totalBytes += walkDir(outputDir);
      }
      if (totalBytes >= 1e9) storageUsed = `${(totalBytes / 1e9).toFixed(1)} GB`;
      else storageUsed = `${(totalBytes / 1e6).toFixed(1)} MB`;
    } catch {
      // ignore stat errors
    }

    return {
      local,
      aiProvider,
      dbReady: true,
      storageUsed,
    };
  });

  // ─── Settings ──────────────────────────────────────────────
  ipcMain.handle('settings:load', async () => {
    return loadSettings();
  });

  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      throw new ValidationError('settings must be an object');
    }
    // Only reset LLM when actual active config changes — not metadata like cloudPresetId/cloudProviderConfigs
    const needsLLMReset =
      partial.llmProvider !== undefined ||
      partial.llmModel !== undefined ||
      partial.embedModel !== undefined ||
      partial.localLlmModel !== undefined ||
      partial.localEmbedModel !== undefined ||
      partial.cloudApiUrl !== undefined ||
      partial.cloudApiKey !== undefined ||
      partial.cloudModel !== undefined ||
      partial.cloudEmbedModel !== undefined;
    const needsChannelRestart =
      partial.telegramEnabled !== undefined ||
      partial.telegramBotToken !== undefined ||
      partial.telegramChatId !== undefined ||
      partial.dingtalkEnabled !== undefined ||
      partial.dingtalkAppKey !== undefined ||
      partial.dingtalkAppSecret !== undefined ||
      partial.wechatEnabled !== undefined ||
      partial.wechatCorpId !== undefined ||
      partial.wechatSecret !== undefined ||
      partial.emailEnabled !== undefined ||
      partial.smtpHost !== undefined ||
      partial.smtpUser !== undefined ||
      partial.smtpPass !== undefined;

    // Detect watchDir or autoProcessWatchDir change before saving
    const currentSettings = loadSettings();
    const watchDirChanged = partial.watchDir !== undefined && partial.watchDir !== currentSettings.watchDir;
    const autoProcessChanged = partial.autoProcessWatchDir !== undefined && partial.autoProcessWatchDir !== currentSettings.autoProcessWatchDir;

    // Save new settings to disk FIRST
    const result = updateSettings(partial);

    // Reset LLM clients AFTER settings are persisted so loadSettings() returns new values
    if (needsLLMReset) {
      // Restart llama-server FIRST if we're in local mode so it picks up newly
      // downloaded GGUF files. This covers the first-run wizard flow where
      // models are downloaded after llama-server has already started with an
      // empty models directory.
      const updatedSettings = loadSettings();
      if (updatedSettings.llmProvider === 'local') {
        const server = ensureLlamaServer();
        // Fire-and-forget: restart + prewarm in background so the UI
        // doesn't freeze on the wizard's "start using" button.
        const { modelsDir, presetPath } = prepareLlamaRouterRuntime();
        server.startRouter(modelsDir, {
          maxModels: 2,
          flashAttn: true,
          presetPath,
        }).then(async ({ port }) => {
          console.log(`[Settings] llama-server restarted on port ${port}`);
          updateSettings({ llamaServerPort: port });

          const s = loadSettings();
          const chatModel = getLLMModel(s);
          const embedModel = getEmbedModel(s);
          const base = `http://127.0.0.1:${port}/v1`;
          for (const model of [chatModel, embedModel]) {
            try {
              await smokeTestLocalModel(base, model, AbortSignal.timeout(30_000));
            } catch { /* ignore */ }
          }
        }).catch((err) => {
          console.error('[Settings] llama-server restart failed:', err);
        });
      }

      ctx.resetLLMClient();
      await resetAgentInfrastructure();
    } else if (needsChannelRestart) {
      // Channel settings changed without LLM change — rebuild channels only
      await resetAgentInfrastructure();
    }

    // Update ASR language on sherpa engine if changed
    if (partial.asrLanguage !== undefined && partial.asrLanguage !== currentSettings.asrLanguage) {
      const engine = ctx.getSherpaEngine();
      if ('setLanguage' in engine && typeof engine.setLanguage === 'function') {
        engine.setLanguage(partial.asrLanguage);
        console.log(`[Settings] ASR language updated to: ${partial.asrLanguage}`);
      }
    }

    // Restart FileWatcher if watchDir or auto-process setting changed
    if (watchDirChanged || autoProcessChanged) {
      console.log(`[Settings] ${watchDirChanged ? 'watchDir' : 'autoProcessWatchDir'} changed, restarting FileWatcher...`);
      if (partial.autoProcessWatchDir === false) {
        // Turning off: just stop the watcher
        cleanupFileWatcher().catch(() => {});
      } else {
        startFileWatching(ctx).catch((err) => {
          console.error('[Settings] Failed to restart FileWatcher:', err);
        });
      }
    }

    return result;
  });

  // ─── Environment Detection ─────────────────────────────────
  ipcMain.handle('system:detectEnvironment', async () => {
    const settings = loadSettings();
    const results = await Promise.allSettled([
      (async () => {
        // Check via FFmpegManager (downloaded or legacy bundled)
        if (getFFmpegManager().isAvailable()) return 'ready';
        // Fallback to system PATH
        return ctx.spawnCheck('ffmpeg', ['-version']);
      })(),
      (async () => {
        if (settings.llmProvider === 'openai') {
          if (!settings.cloudApiUrl || !settings.cloudApiKey || !settings.cloudModel) {
            throw new Error('cloud API is not configured');
          }
          const client = new OpenAIClient(settings.cloudApiUrl, settings.cloudApiKey);
          const ok = await client.isAvailable(settings.cloudModel);
          if (!ok) throw new Error('cloud API is not reachable');
          return 'Cloud API';
        }

        const ok = await ctx.getLLM().isAvailable(getLLMModel(settings));
        if (!ok) throw new Error('not running');
        return 'Local';
      })(),
    ]);

    const ffmpeg = results[0].status === 'fulfilled'
      ? { status: 'ok' as const, version: results[0].value }
      : { status: 'missing' as const };
    const localResult = results[1].status === 'fulfilled'
      ? { status: 'ok' as const, version: results[1].value }
      : { status: 'missing' as const };

    // Check sherpa-onnx models
    const sherpaEngine = ctx.getSherpaEngine();
    const modelManager = sherpaEngine.getModelManager();
    const sherpaModels = modelManager.areAllModelsReady()
      ? { status: 'ok' as const }
      : { status: 'missing' as const };

    return { ffmpeg, local: localResult, sherpaModels };
  });

  // ─── Hardware Detection ───────────────────────────────────
  ipcMain.handle('system:detectHardware', () => {
    return detectHardware();
  });

  ipcMain.handle('system:getDefaultPrompts', () => {
    const settings = loadSettings();
    return getDefaultPrompts(settings.language || 'zh');
  });

  // ─── Cloud API Check ──────────────────────────────────────
  ipcMain.handle('cloud:check', async (_e, url: string, apiKey: string, model?: string) => {
    if (!url || !apiKey) return { ok: false, error: 'Missing URL or API key' };
    const baseUrl = url.replace(/\/+$/, '');
    const selectedModel = typeof model === 'string' ? model.trim() : '';
    const formatHttpError = (status: number, text: string) => {
      let errorMsg = `HTTP ${status}`;
      try {
        const json = JSON.parse(text);
        errorMsg = json.error?.message || json.message || errorMsg;
      } catch {
        if (text) errorMsg += `: ${text.slice(0, 120)}`;
      }
      return errorMsg;
    };

    try {
      // Try GET /models first (standard OpenAI endpoint)
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok && !selectedModel) return { ok: true };
      // Some providers don't support GET /models — try a minimal chat completion
      if (res.status !== 401 && res.status !== 403) {
        const chatRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: selectedModel || 'test',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (chatRes.ok) {
          return { ok: true };
        }

        const text = await chatRes.text().catch(() => '');
        // Without a selected model, a clear "test model not found" response
        // still proves that the OpenAI-compatible chat endpoint is reachable.
        if (!selectedModel && isExplicitModelNotFoundResponse(chatRes.status, text)) {
          return { ok: true };
        }
        return { ok: false, error: formatHttpError(chatRes.status, text) };
      }
      // Auth error or other failure
      const text = await res.text().catch(() => '');
      return { ok: false, error: formatHttpError(res.status, text) };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Connection failed' };
    }
  });

  // ─── Cloud Model List ────────────────────────────────────
  ipcMain.handle('cloud:listModels', async (_e, url: string, apiKey: string) => {
    if (!url || !apiKey) return [];
    try {
      const { OpenAIClient } = await import('../llm/openai-client');
      const client = new OpenAIClient(url, apiKey);
      return await client.listModels();
    } catch {
      return [];
    }
  });

  // ─── Model Management ─────────────────────────────────────

  /** List downloaded GGUF model IDs by checking which catalog files exist locally. */
  ipcMain.handle('system:listModels', async () => {
    try {
      const modelsDir = getLLMModelsDir();
      const { getDownloadedGGUFModelIds, readGGUFFileInfo } = await import('../llm/gguf-model-files');
      return getDownloadedGGUFModelIds((fileName) => {
        return readGGUFFileInfo(path.join(modelsDir, fileName));
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle('system:pullModel', async (_event, modelName: string, force?: boolean) => {
    requireString(modelName, 'modelName', 200);

    const entry = findModel(modelName);
    if (!entry) {
      return { success: false, model: modelName, error: `Unknown model: ${modelName}` };
    }

    const fileKey = path.join(getLLMModelsDir(), entry.fileName);
    const active = activeGGUFDownloads.get(entry.id) || activeGGUFFileDownloads.get(fileKey);
    if (active) {
      return active.promise;
    }

    const controller = new AbortController();
    const activeDownload: {
      controller: AbortController;
      fileKey: string;
      promise: Promise<{ success: boolean; model: string; error?: string }>;
    } = {
      controller,
      fileKey,
      promise: Promise.resolve({ success: false, model: entry.id, error: 'not started' }),
    };
    activeGGUFDownloads.set(entry.id, activeDownload);

    const promise = (async (): Promise<{ success: boolean; model: string; error?: string }> => {
      updateGGUFState(ctx, entry.id, {
        status: 'downloading',
        completed: 0,
        total: entry.fileSizeBytes,
      });

      try {
        console.log(`[PullModel] Starting download: ${entry.id}`);
        const result = await downloadGGUF(entry.id, ctx, controller.signal, !!force);
        if (result.success) {
          const current = ggufDownloadStateStore.get(entry.id);
          updateGGUFState(ctx, entry.id, {
            status: 'success',
            completed: current?.completed && current.completed > 0 ? current.completed : entry.fileSizeBytes,
            total: current?.total && current.total > 0 ? current.total : entry.fileSizeBytes,
          });
          try {
            await refreshLocalRouterAfterModelChange(ctx);
          } catch (err) {
            console.error('[PullModel] Failed to refresh llama-server after download:', err);
          }
          return { success: true, model: entry.id };
        }

        const status = result.error === 'cancelled' ? 'cancelled' : 'error';
        updateGGUFState(ctx, entry.id, {
          status,
          completed: ggufDownloadStateStore.get(entry.id)?.completed ?? 0,
          total: ggufDownloadStateStore.get(entry.id)?.total ?? entry.fileSizeBytes,
          error: status === 'error' ? (result.error || 'Download failed') : undefined,
        });
        return { success: false, model: entry.id, error: result.error };
      } catch (err: any) {
        const isCancelled = err.name === 'AbortError' || controller.signal.aborted;
        const status = isCancelled ? 'cancelled' : 'error';
        if (isCancelled) {
          console.log(`[PullModel] Cancelled: ${entry.id}`);
        } else {
          console.error(`[PullModel] Error downloading "${entry.id}":`, err);
        }
        updateGGUFState(ctx, entry.id, {
          status,
          completed: ggufDownloadStateStore.get(entry.id)?.completed ?? 0,
          total: ggufDownloadStateStore.get(entry.id)?.total ?? entry.fileSizeBytes,
          error: status === 'error' ? (err.message || 'Unknown error') : undefined,
        });
        return {
          success: false,
          model: entry.id,
          error: isCancelled ? 'cancelled' : (err.message || 'Unknown error'),
        };
      } finally {
        const current = activeGGUFDownloads.get(entry.id);
        if (current?.controller === controller) {
          activeGGUFDownloads.delete(entry.id);
        }
        const currentFile = activeGGUFFileDownloads.get(fileKey);
        if (currentFile?.controller === controller) {
          activeGGUFFileDownloads.delete(fileKey);
        }
      }
    })();

    activeDownload.promise = promise;
    activeGGUFFileDownloads.set(fileKey, { controller, model: entry.id, promise });
    return promise;
  });

  ipcMain.handle('system:testLocal', async (_event, modelName?: string) => {
    try {
      const settings = loadSettings();
      const requestedModel = typeof modelName === 'string' && modelName.trim()
        ? requireString(modelName, 'modelName', 200)
        : settings.localLlmModel || settings.llmModel || 'qwen3.5:4b';
      const entry = findModel(requestedModel);
      if (entry) {
        const filePath = path.join(getLLMModelsDir(), entry.fileName);
        const validation = validateGGUFFilePath(filePath, entry.fileSizeBytes);
        if (!validation.ok) {
          return { success: false, error: validation.error || 'Model file is not ready' };
        }
      }

      const server = ensureLlamaServer();
      let status = server.getStatus();
      if (!status.running || !status.port) {
        const { modelsDir, presetPath } = prepareLlamaRouterRuntime();
        const started = await server.startRouter(modelsDir, {
          maxModels: 2,
          flashAttn: true,
          presetPath,
        });
        updateSettings({ llamaServerPort: started.port });
        status = server.getStatus();
      }

      if (!status.port) {
        return { success: false, error: 'llama-server port is not available' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        await smokeTestLocalModel(`http://127.0.0.1:${status.port}/v1`, requestedModel, controller.signal);
      } finally {
        clearTimeout(timer);
      }

      return { success: true };
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? 'Model test timed out'
        : err?.message || String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('system:cancelPull', async (_event, modelName?: string) => {
    if (modelName) {
      requireString(modelName, 'modelName', 200);
      const entry = findModel(modelName);
      if (entry) {
        const fileKey = path.join(getLLMModelsDir(), entry.fileName);
        (activeGGUFDownloads.get(entry.id) || activeGGUFFileDownloads.get(fileKey))?.controller.abort();
      } else {
        activeGGUFDownloads.get(modelName)?.controller.abort();
      }
      return;
    }

    for (const active of activeGGUFDownloads.values()) {
      active.controller.abort();
    }
  });

  ipcMain.handle('system:getPullStatus', () => {
    return ggufDownloadStateStore.snapshot();
  });

  // ─── Sherpa-ONNX Model Management ─────────────────────────

  ipcMain.handle('sherpa:checkModels', async () => {
    const engine = ctx.getSherpaEngine();
    const mm = engine.getModelManager();
    return {
      allReady: mm.areAllModelsReady(),
      models: mm.getModelsStatus(),
    };
  });

  let sherpaAbort: AbortController | null = null;
  let sherpaDownloadPromise: Promise<{ success: boolean; error?: string }> | null = null;

  ipcMain.handle('sherpa:downloadModels', async (_event, opts?: { mirror?: string; force?: boolean } | string) => {
    if (sherpaDownloadPromise) return sherpaDownloadPromise;

    // Support both new object format and legacy string format
    const mirror = typeof opts === 'object' ? opts?.mirror : opts;
    const force = typeof opts === 'object' ? opts?.force : false;
    console.log(`[sherpa:downloadModels] mirror=${mirror}, force=${force}`);

    const engine = ctx.getSherpaEngine();
    const mm = engine.getModelManager();

    // Apply mirror setting: use explicit arg if provided, otherwise auto-detect
    const effectiveMirror = mirror ?? getSherpaModelMirror();
    mm.setMirror(effectiveMirror as any);

    if (!force && mm.areAllModelsReady()) {
      console.log('[sherpa:downloadModels] All models ready, skipping');
      return { success: true };
    }

    const controller = new AbortController();
    sherpaAbort = controller;
    const win = ctx.getWindow();

    sherpaDownloadPromise = (async (): Promise<{ success: boolean; error?: string }> => {
      // Cancel background download manager to avoid file conflicts. This is
      // inside the shared promise so duplicate UI calls cannot pass through
      // the wait window and start a second Sherpa download.
      const bgMgr = ctx.getDownloadManager();
      if (bgMgr) {
        bgMgr.cancel();
        await new Promise(r => setTimeout(r, 300));
      }

      try {
        await mm.downloadAllModels(
          (completed, total, modelId, fileName) => {
            sherpaDlState = {
              model: `sherpa:${modelId}`,
              completed,
              total,
              status: `downloading ${fileName}`,
            };
            if (win && !win.isDestroyed()) {
              win.webContents.send('model:pullProgress', {
                model: `sherpa:${modelId}`,
                status: `downloading ${fileName}`,
                total,
                completed,
              });
            }
          },
          controller.signal,
          force,
        );

        // Verify all models are actually installed after download.
        // On Windows, antivirus software may scan/lock files briefly after
        // download, so retry verification with increasing delays.
        let allReady = mm.areAllModelsReady();
        if (!allReady) {
          const retries = 5;
          const baseDelay = 1000; // 1s, 2s, 3s, 4s, 5s
          for (let i = 1; i <= retries; i++) {
            console.log(`[sherpa:downloadModels] Verification attempt ${i}/${retries}, waiting ${baseDelay * i}ms...`);
            await new Promise(resolve => setTimeout(resolve, baseDelay * i));
            allReady = mm.areAllModelsReady();
            if (allReady) break;
          }
        }
        if (!allReady) {
          const statuses = mm.getModelsStatus();
          const missing = statuses.filter(s => !s.installed).map(s => s.name);
          console.error(`[sherpa:downloadModels] Download completed but verification failed after retries. Missing: ${missing.join(', ')}`);
          return { success: false, error: `Model verification failed: ${missing.join(', ')} not found after download. This may be caused by antivirus software or a download mirror issue.` };
        }

        if (win && !win.isDestroyed()) {
          win.webContents.send('model:pullProgress', {
            model: 'sherpa:all',
            status: 'success',
            total: 1,
            completed: 1,
          });
        }

        return { success: true };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return { success: false, error: 'cancelled' };
        }
        return { success: false, error: err.message || 'Download failed' };
      } finally {
        if (sherpaAbort === controller) {
          sherpaAbort = null;
        }
        sherpaDlState = null;
        sherpaDownloadPromise = null;
      }
    })();

    return sherpaDownloadPromise;
  });

  ipcMain.handle('sherpa:cancelDownload', async () => {
    if (sherpaAbort) {
      sherpaAbort.abort();
      sherpaAbort = null;
    }
  });

  ipcMain.handle('sherpa:getDownloadStatus', () => {
    return sherpaDlState;
  });

  // ─── FFmpeg Management ─────────────────────────────────────
  ipcMain.handle('ffmpeg:check', () => {
    return { ready: getFFmpegManager().isAvailable() };
  });

  let ffmpegAbort: AbortController | null = null;

  ipcMain.handle('ffmpeg:download', async () => {
    const mgr = getFFmpegManager();
    if (mgr.isAvailable()) return { success: true };

    ffmpegAbort = new AbortController();
    const win = ctx.getWindow();

    try {
      await mgr.download(
        (completed: number, total: number, stage: string) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('ffmpeg:downloadProgress', { completed, total, stage });
          }
        },
        ffmpegAbort.signal,
      );
      reconfigureFFmpeg();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      ffmpegAbort = null;
    }
  });

  ipcMain.handle('ffmpeg:cancelDownload', () => {
    if (ffmpegAbort) {
      ffmpegAbort.abort();
      ffmpegAbort = null;
    }
  });

  // ─── LLM Auto-Install ──────────────────────────────────

  ipcMain.handle('system:openExternal', async (_event, url: string) => {
    const validUrl = requireUrl(url, 'url');
    await shell.openExternal(validUrl);
  });

  ipcMain.handle('system:openPath', async (_event, dirPath: string) => {
    const safePath = requireString(dirPath, 'dirPath', 1000);
    const error = await shell.openPath(safePath);
    if (error) throw new Error(error);
  });

  ipcMain.handle('system:getDataDir', () => {
    return getEffectiveDataDir();
  });

  ipcMain.handle('system:isLocalInstalled', async () => {
    // llama.cpp is bundled with the app, always available
    return true;
  });

  ipcMain.handle('system:installLocal', async () => {
    // llama.cpp is bundled with the app, no installation needed
    return { success: true };
  });

  ipcMain.handle('system:openLLMModelsDir', async () => {
    const dir = getLLMModelsDir();
    await shell.openPath(dir);
  });

  ipcMain.handle('system:openLocalModelsDir', async () => {
    const dir = getLLMModelsDir();
    await shell.openPath(dir);
  });

  // ─── License Management ──────────────────────────────────
  ipcMain.handle('license:getStatus', () => {
    return ctx.getLicenseManager().getStatus();
  });

  ipcMain.handle('license:isPro', () => {
    return ctx.getLicenseManager().isPro();
  });

  ipcMain.handle('license:activate', async (event, key: string) => {
    const result = await ctx.getLicenseManager().activate(key);
    event.sender.send('license:changed');
    return result;
  });

  ipcMain.handle('license:deactivate', (event) => {
    event.sender.send('license:changed');
    return { success: true };
  });

  // ─── Clipboard (main process has full permission) ────────
  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    clipboard.writeText(text);
  });

  // ─── Background Download Manager ─────────────────────────
  ipcMain.handle('bgdownload:getState', () => {
    return ctx.getDownloadManager()?.getState() ?? null;
  });

  ipcMain.handle('bgdownload:start', async () => {
    const mgr = ctx.getDownloadManager();
    if (mgr) {
      // Don't await — let it run in background
      mgr.startAll().catch((err) => {
        console.error('[bgdownload] startAll error:', err);
      });
    }
  });

  ipcMain.handle('bgdownload:cancel', () => {
    ctx.getDownloadManager()?.cancel();
  });

  ipcMain.handle('bgdownload:restart', async (_e, ids: string[]) => {
    const mgr = ctx.getDownloadManager();
    if (mgr) {
      mgr.restartItems(ids as any).catch((err) => {
        console.error('[bgdownload] restartItems error:', err);
      });
    }
  });

  // ─── Database Export / Backup ─────────────────────────────
  ipcMain.handle('system:exportDatabase', async () => {
    const { dialog } = require('electron');
    const win = ctx.getWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select backup destination',
    });
    if (result.canceled || !result.filePaths.length) return { success: false };
    const destDir = result.filePaths[0];

    // WAL checkpoint before copying to ensure consistency
    try {
      const db = ctx.getDb();
      db.getRawDb().pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) { /* ignore — non-critical */ }

    const timestamp = new Date().toISOString().slice(0, 10);
    const dbSrc = getDbPath();
    const vecSrc = getVecDbPath();

    try {
      fs.copyFileSync(dbSrc, path.join(destDir, `korteqo-backup-${timestamp}.db`));
      if (fs.existsSync(vecSrc)) {
        fs.copyFileSync(vecSrc, path.join(destDir, `korteqo-vec-backup-${timestamp}.db`));
      }
      return { success: true, path: destDir };
    } catch (err: any) {
      console.error('[ExportDB] Failed to copy database files:', err);
      return { success: false, error: err.message || 'Copy failed' };
    }
  });

  // ─── llama-server (bundled local inference) ────────────────
  ipcMain.handle('llama:start', async () => {
    try {
      const server = ensureLlamaServer();

      // Router mode: start with models directory, auto-discovers GGUF files
      const { modelsDir, presetPath } = prepareLlamaRouterRuntime();
      const { port } = await server.startRouter(modelsDir, {
        maxModels: 2,
        flashAttn: true,
        presetPath,
      });
      updateSettings({ llamaServerPort: port });
      return { success: true, port };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('llama:stop', async () => {
    try {
      const server = getLlamaServer();
      if (server) await server.stop();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('llama:status', async () => {
    try {
      const server = getLlamaServer();
      if (!server) return { running: false, port: null, pid: null, model: null };
      return server.getStatus();
    } catch {
      return { running: false, port: null, pid: null, model: null };
    }
  });
}
