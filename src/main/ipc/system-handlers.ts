import { app, ipcMain, shell, clipboard, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcContext } from './context';
import { getLlamaServer } from './context';
import { findModel } from '../llm/gguf-model-catalog';
import { getLLMModelsDir } from '../paths';
import { loadSettings, updateSettings, AppSettings } from '../settings';
import { getSherpaModelMirror, getEffectiveMirror } from '../mirror-config';
import { getDbPath, getVecDbPath, getOutputDir, getEffectiveDataDir, getLLMModelsDir } from '../paths';
import { detectHardware } from '../hardware-detector';
import { getLLMModel, getEmbedModel } from '../llm/create-client';
import { OpenAIClient } from '../llm/openai-client';
import { startFileWatching, cleanupFileWatcher } from './pipeline-handlers';
import { getFFmpegManager } from '../audio/ffmpeg-manager';
import { reconfigureFFmpeg } from '../audio/preprocessor';
import { resetAgentInfrastructure } from './integration-handlers';
import { requireString, requireUrl, ValidationError } from './validate';
import { AnalyticsTracker } from '../analytics/tracker';
import { getDefaultPrompts } from '../llm/default-prompts';
import { findModel, getDownloadUrl } from '../llm/gguf-model-catalog';

// Module-level state for tracking active downloads (survives page navigation)
let sherpaDlState: { model: string; completed: number; total: number; status: string } | null = null;

// ─── GGUF Model Download ───────────────────────────────────

/** Active GGUF download abort controller (one at a time). */
let ggufAbort: AbortController | null = null;

/** Download a GGUF file from HuggingFace (or mirror) with progress reporting. */
async function downloadGGUF(
  modelId: string,
  ctx: IpcContext,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const entry = findModel(modelId);
  if (!entry) return { success: false, error: `Unknown model: ${modelId}` };

  const modelsDir = getLLMModelsDir();
  const destPath = path.join(modelsDir, entry.fileName);
  const tmpPath = destPath + '.downloading';

  // Skip if already fully downloaded
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    if (stat.size >= entry.fileSizeBytes * 0.95) {
      console.log(`[GGUF] Model already downloaded: ${entry.fileName} (${stat.size} bytes)`);
      return { success: true };
    }
  }

  // Pick mirror: default → ModelScope (works in China and globally)
  const mirror = '';
  const url = getDownloadUrl(entry, mirror);
  console.log(`[GGUF] Downloading ${entry.id} from ${mirror || 'modelscope'}: ${url}`);

  try {
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'DeepSeno/1.0' },
    });

    if (!res.ok) {
      // Try fallback mirror: ModelScope → hf-mirror → ghfast
      const fallbackMirror = mirror === '' ? 'hf-mirror' : mirror === 'hf-mirror' ? 'ghfast' : 'hf-mirror';
      const fallbackUrl = getDownloadUrl(entry, fallbackMirror);
      console.warn(`[GGUF] ${mirror} returned ${res.status}, trying ${fallbackMirror}: ${fallbackUrl}`);
      const res2 = await fetch(fallbackUrl, {
        signal,
        headers: { 'User-Agent': 'DeepSeno/1.0' },
      });
      if (!res2.ok) {
        return { success: false, error: `Download failed: HTTP ${res2.status}` };
      }
      return await streamToFile(res2, tmpPath, destPath, entry, ctx, signal);
    }

    return await streamToFile(res, tmpPath, destPath, entry, ctx, signal);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Clean up partial download
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* */ }
      return { success: false, error: 'cancelled' };
    }
    return { success: false, error: err.message || 'Download failed' };
  }
}

/** Stream HTTP response body to a temp file, rename on completion. */
async function streamToFile(
  res: Response,
  tmpPath: string,
  destPath: string,
  entry: { id: string; fileName: string; fileSizeBytes: number },
  ctx: IpcContext,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const contentLength = res.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : entry.fileSizeBytes;

  const reader = res.body!.getReader();
  const ws = fs.createWriteStream(tmpPath);
  let completed = 0;
  let lastEmit = 0;

  // Catch stream errors to prevent uncaught exceptions from crashing the process
  let streamError: Error | null = null;
  ws.on('error', (err) => { streamError = err; });

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        return { success: false, error: 'cancelled' };
      }

      if (streamError) throw streamError;

      const { done, value } = await reader.read();
      if (done) break;

      // Handle backpressure: wait for drain if write buffer is full
      if (!ws.write(value)) {
        await new Promise<void>((resolve, reject) => {
          if (streamError) { reject(streamError); return; }
          ws.once('drain', resolve);
          ws.once('error', (err) => { streamError = err; reject(err); });
        });
      }
      completed += value.length;

      // Emit progress at most every 300ms
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        const win = ctx.getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('model:pullProgress', {
            model: entry.id,
            status: 'downloading',
            completed,
            total: totalBytes,
          });
        }
      }
    }

    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    // Rename temp → final
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(tmpPath, destPath);

    console.log(`[GGUF] Download complete: ${entry.fileName} (${completed} bytes)`);

    // Final progress event
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('model:pullProgress', {
        model: entry.id,
        status: 'success',
        completed,
        total: totalBytes,
      });
    }

    return { success: true };
  } catch (err: any) {
    reader.cancel().catch(() => {});
    ws.destroy();
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* */ }
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
    try {
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
        const server = getLlamaServer();
        if (server) {
          // Fire-and-forget: restart + prewarm in background so the UI
          // doesn't freeze on the wizard's "start using" button.
          const modelsDir = getLLMModelsDir();
          const presetPath = path.join(modelsDir, 'models.ini');
          server.startRouter(modelsDir, {
            maxModels: 2,
            flashAttn: true,
            presetPath: fs.existsSync(presetPath) ? presetPath : undefined,
          }).then(async ({ port }) => {
            console.log(`[Settings] llama-server restarted on port ${port}`);
            updateSettings({ llamaServerPort: port });

            const s = loadSettings();
            const chatModel = getLLMModel(s);
            const embedModel = getEmbedModel(s);
            const base = `http://127.0.0.1:${port}/v1`;
            const body = (model: string) => JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
              stream: false,
            });
            for (const model of [chatModel, embedModel]) {
              try {
                await fetch(`${base}/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: body(model),
                });
              } catch { /* ignore */ }
            }
          }).catch((err) => {
            console.error('[Settings] llama-server restart failed:', err);
          });
        }
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
    const results = await Promise.allSettled([
      (async () => {
        // Check via FFmpegManager (downloaded or legacy bundled)
        if (getFFmpegManager().isAvailable()) return 'ready';
        // Fallback to system PATH
        return ctx.spawnCheck('ffmpeg', ['-version']);
      })(),
      (async () => {
        const ok = await ctx.getLLM().isAvailable();
        if (!ok) throw new Error('not running');
        return 'ok';
      })(),
    ]);

    const ffmpeg = results[0].status === 'fulfilled'
      ? { status: 'ok' as const, version: results[0].value }
      : { status: 'missing' as const };
    const localResult = results[1].status === 'fulfilled'
      ? { status: 'ok' as const }
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
  ipcMain.handle('cloud:check', async (_e, url: string, apiKey: string) => {
    if (!url || !apiKey) return { ok: false, error: 'Missing URL or API key' };
    const baseUrl = url.replace(/\/+$/, '');
    try {
      // Try GET /models first (standard OpenAI endpoint)
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true };
      // Some providers don't support GET /models — try a minimal chat completion
      if (res.status === 404 || res.status === 405) {
        const chatRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'test',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        // 401/403 = bad key; 400/404 with model error = API reachable, key valid
        if (chatRes.ok || chatRes.status === 400 || chatRes.status === 404) {
          return { ok: true };
        }
        const text = await chatRes.text().catch(() => '');
        return { ok: false, error: `HTTP ${chatRes.status}: ${text.slice(0, 120)}` };
      }
      // Auth error or other failure
      const text = await res.text().catch(() => '');
      let errorMsg = `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text);
        errorMsg = json.error?.message || json.message || errorMsg;
      } catch {
        if (text) errorMsg += `: ${text.slice(0, 120)}`;
      }
      return { ok: false, error: errorMsg };
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
      const files = fs.readdirSync(modelsDir);
      const downloaded = new Set(files.filter((f) => f.endsWith('.gguf') && !f.endsWith('.downloading')));
      // Map file names back to model IDs
      const { GGUF_CATALOG } = await import('../llm/gguf-model-catalog');
      return GGUF_CATALOG
        .filter((m) => downloaded.has(m.fileName))
        .map((m) => m.id);
    } catch {
      return [];
    }
  });

  ipcMain.handle('system:pullModel', async (_event, modelName: string) => {
    requireString(modelName, 'modelName', 200);

    // Cancel any existing download before starting a new one
    if (ggufAbort) {
      ggufAbort.abort();
      ggufAbort = null;
    }
    ggufAbort = new AbortController();
    const signal = ggufAbort.signal;

    try {
      console.log(`[PullModel] Starting download: ${modelName}`);
      const result = await downloadGGUF(modelName, ctx, signal);
      if (result.success) {
        return { success: true, model: modelName };
      }
      return { success: false, model: modelName, error: result.error };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[PullModel] Cancelled: ${modelName}`);
        return { success: false, model: modelName, error: 'cancelled' };
      }
      console.error(`[PullModel] Error downloading "${modelName}":`, err);
      return { success: false, model: modelName, error: err.message || 'Unknown error' };
    } finally {
      ggufAbort = null;
    }
  });

  ipcMain.handle('system:cancelPull', async () => {
    if (ggufAbort) {
      ggufAbort.abort();
      ggufAbort = null;
    }
  });

  ipcMain.handle('system:getPullStatus', () => {
    // Return null — no persistent pull state for GGUF downloads
    return null;
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

  ipcMain.handle('sherpa:downloadModels', async (_event, opts?: { mirror?: string; force?: boolean } | string) => {
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

    // Cancel background download manager to avoid file conflicts
    const bgMgr = ctx.getDownloadManager();
    if (bgMgr) {
      bgMgr.cancel();
      // Wait briefly for abort to propagate
      await new Promise(r => setTimeout(r, 300));
    }

    sherpaAbort = new AbortController();
    const win = ctx.getWindow();

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
        sherpaAbort.signal,
        force,
      );

      // Verify all models are actually installed after download
      // On Windows, antivirus software may scan/lock files briefly after download,
      // so we retry verification with increasing delays
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

      // Send completion
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
      sherpaAbort = null;
      sherpaDlState = null;
    }
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

  let localInstallAbort: AbortController | null = null;



  ipcMain.handle('system:openExternal', async (_event, url: string) => {
    const validUrl = requireUrl(url, 'url');
    await shell.openExternal(validUrl);
  });

  ipcMain.handle('system:openPath', async (_event, dirPath: string) => {
    const safePath = requireString(dirPath, 'dirPath', 1000);
    await shell.openPath(safePath);
  });

  ipcMain.handle('system:getDataDir', () => {
    return getEffectiveDataDir();
  });

  ipcMain.handle('system:isLocalInstalled', async () => {
    // llama.cpp is bundled with the app, always available
    return true;
  });

  ipcMain.handle('system:installLocal', async (event) => {
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
    const settings = loadSettings();
    if (!settings.firstLaunchTime) {
      updateSettings({ firstLaunchTime: Date.now() });
    }
    return ctx.getLicenseManager().getStatus();
  });

  ipcMain.handle('license:isPro', () => {
    return ctx.getLicenseManager().isPro();
  });

  ipcMain.handle('license:activate', (event, key: string) => {
    const mgr = ctx.getLicenseManager();
    const result = mgr.activate(key);
    if (result.success) {
      updateSettings({ licenseKey: key });
      // Re-init processor to inject premium components
      ctx.reinitSingletons();
      event.sender.send('license:changed');
      AnalyticsTracker.getInstance().track('license_activated', { tier: result.tier });
    }
    return result;
  });

  ipcMain.handle('license:deactivate', (event) => {
    updateSettings({ licenseKey: '' });
    // Re-init processor to remove premium components
    ctx.reinitSingletons();
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
      const server = getLlamaServer();
      if (!server) return { success: false, error: 'llama-server manager not initialized' };

      // Router mode: start with models directory, auto-discovers GGUF files
      const modelsDir = getLLMModelsDir();
      const { port } = await server.startRouter(modelsDir, {
        maxModels: 2,
        flashAttn: true,
      });
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
