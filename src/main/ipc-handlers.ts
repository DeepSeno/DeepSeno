import { BrowserWindow } from 'electron';
import { createIpcContext, cleanupSingletons } from './ipc/context';

// Re-export shared helper functions used by electron/main.ts
export { getSegmentTextForRecording, getRecordingFilePath, getKnowledgeCompiler, getInsightEngine } from './ipc/context';

// Domain handler registrations
import { registerDialogHandlers } from './ipc/dialog-handlers';
import { registerPipelineHandlers, startFileWatching as _startFileWatching, enqueueForProcessing as _enqueueForProcessing, cleanupFileWatcher } from './ipc/pipeline-handlers';
import { registerDbHandlers } from './ipc/db-handlers';
import { registerRagHandlers } from './ipc/rag-handlers';
import { registerSystemHandlers } from './ipc/system-handlers';
import { registerIntegrationHandlers, getFeishuBot as _getFeishuBot, initFeishuBot as _initFeishuBot, stopFeishuBot as _stopFeishuBot, stopChannels as _stopChannels, getDingTalkChannel as _getDingTalkChannel, getWeChatChannel as _getWeChatChannel, getMessageHandler as _getMessageHandler, getMessageRouter as _getMessageRouter, stopPlugins as _stopPlugins, getPluginEngine as _getPluginEngine, getAgentExecutor as _getAgentExecutor } from './ipc/integration-handlers';
import { registerRealtimeHandlers, prewarmTranscriber as _prewarmTranscriber, startRealtimeTranscription as _startRealtimeTranscription, stopRealtimeTranscription as _stopRealtimeTranscription, cleanupRealtime, hasPendingSegmentOptimizations as _hasPendingSegmentOptimizations, awaitAndMergeSegmentOptimizations as _awaitAndMergeSegmentOptimizations, getCurrentScene as _getCurrentScene, pasteClean as _pasteClean, triggerPostProcessing as _triggerPostProcessing } from './ipc/realtime-handlers';
import { registerSchedulerHandlers } from './ipc/scheduler-handlers';
import { registerKnowledgeHandlers } from './ipc/knowledge-handlers';
import { registerCorrectionHandlers } from './ipc/correction-handlers';

// Module-level context reference for re-exported functions
let ctx: ReturnType<typeof createIpcContext> | null = null;

// ─── Re-exports that need context binding ────────────────────

export function prewarmTranscriber(): void {
  return _prewarmTranscriber();
}

export function getFeishuBot() {
  return _getFeishuBot();
}

export async function initFeishuBot(): Promise<void> {
  if (ctx) await _initFeishuBot(ctx);
}

export function stopFeishuBot(): void {
  _stopFeishuBot();
}

export function stopChannels(): void {
  _stopChannels();
}

export function getDingTalkChannel() {
  return _getDingTalkChannel();
}

export function getWeChatChannel() {
  return _getWeChatChannel();
}

export function getUnifiedMessageHandler() {
  return _getMessageHandler();
}

export function getMessageRouter() {
  return _getMessageRouter();
}

export async function stopPlugins(): Promise<void> {
  return _stopPlugins();
}

export function getPluginEngine() {
  return _getPluginEngine();
}

export function getAgentExecutor() {
  return _getAgentExecutor();
}

export function getSyncManager() {
  return ctx!.syncManager;
}

export function getSherpaEngine() {
  return ctx?.getSherpaEngine() || null;
}

export function setDownloadManager(mgr: any) {
  ctx?.setDownloadManager(mgr);
}

export function enqueueForProcessing(filePath: string) {
  return ctx ? _enqueueForProcessing(ctx, filePath) : null;
}

export function getQueryEngine() {
  return ctx?.getQueryEngine() || null;
}

export function getTaskQueue() {
  try {
    return ctx?.getProcessor().getTaskQueue() || null;
  } catch { return null; }
}

export function getProcessor() {
  try {
    return ctx?.getProcessor() || null;
  } catch { return null; }
}

export function resetLLMClients(): void {
  ctx?.resetLLMClient();
}

export async function startFileWatching(): Promise<void> {
  if (ctx) return _startFileWatching(ctx);
}

export async function startRealtimeTranscription(scene?: string) {
  if (!ctx) return { success: false as const, error: 'Not initialized' };
  return _startRealtimeTranscription(ctx, scene as any);
}

export async function stopRealtimeTranscription() {
  if (!ctx) return { success: false as const, error: 'Not initialized' };
  return _stopRealtimeTranscription(ctx);
}

export function hasPendingSegmentOptimizations(): boolean {
  return _hasPendingSegmentOptimizations();
}

export async function awaitAndMergeSegmentOptimizations(recordingId: number, timeoutMs?: number): Promise<string> {
  return _awaitAndMergeSegmentOptimizations(recordingId, timeoutMs);
}

export function getCurrentScene(): ReturnType<typeof _getCurrentScene> {
  return _getCurrentScene();
}

export async function pasteClean(text: string, settings: any): Promise<string> {
  return _pasteClean(text, settings);
}

export function triggerPostProcessing(): void {
  _triggerPostProcessing();
}

// ─── Public API ──────────────────────────────────────────────

export function registerIpcHandlers(windowGetter: () => BrowserWindow | null): void {
  ctx = createIpcContext(windowGetter);

  // Startup DB maintenance: deduplicate recordings
  try {
    const db = ctx.getDb();
    db.deduplicateRecordings();
  } catch (err) {
    console.warn('[IPC] Startup DB maintenance failed:', err);
  }

  // Register all domain handlers
  registerDialogHandlers(ctx);
  registerPipelineHandlers(ctx);
  registerDbHandlers(ctx);
  registerRagHandlers(ctx);
  registerSystemHandlers(ctx);
  registerIntegrationHandlers(ctx);
  registerRealtimeHandlers(ctx);
  registerSchedulerHandlers(ctx);
  registerKnowledgeHandlers(ctx);
  registerCorrectionHandlers(ctx);
}

export async function cleanupIpc(): Promise<void> {
  _stopFeishuBot();
  if (ctx) {
    ctx.syncManager.cleanup();
  }
  await cleanupFileWatcher();

  // Cleanup realtime state
  const rt = cleanupRealtime();
  if (rt.prewarmedTranscriber) {
    rt.prewarmedTranscriber.destroy();
  }
  if (rt.streamingTranscriber && rt.streamingTranscriber.isRunning()) {
    try {
      await rt.streamingTranscriber.stop();
    } catch { /* ignore */ }
  }
  if (rt.liveWavStream) {
    rt.liveWavStream.end();
  }

  await cleanupSingletons();
  ctx = null;
}
