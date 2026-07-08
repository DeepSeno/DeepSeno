// Capture proxy URL from env vars BEFORE clearing them.
// Proxy tools (Clash, V2Ray) typically set HTTP_PROXY / HTTPS_PROXY to a local
// address like http://127.0.0.1:7890. We save this so we can later configure
// Chromium's session proxy (for net.fetch → Telegram, GitHub, etc.) while
// keeping Node.js fetch (→ Local) proxy-free.
declare const __API_BASE_URL__: string;
const _savedProxyUrl: string = (() => {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy
            || process.env.HTTP_PROXY || process.env.http_proxy
            || process.env.ALL_PROXY || process.env.all_proxy
            || '';
  // Clear local proxy env vars so Node.js fetch() to localhost is not proxied
  const localProxyPattern = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/i;
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    if (process.env[key] && localProxyPattern.test(process.env[key]!)) {
      delete process.env[key];
    }
  }
  // Ensure localhost is in NO_PROXY
  const noProxy = new Set((process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean));
  noProxy.add('localhost');
  noProxy.add('127.0.0.1');
  process.env.NO_PROXY = process.env.no_proxy = [...noProxy].join(',');
  return url;
})();

// Fallback: set Windows console code page to UTF-8.
// The primary fix is in scripts/dev.cjs which runs chcp BEFORE Electron starts.
// This fallback covers the case where Electron is launched directly (not via
// `pnpm dev`). Note: as a GUI-subsystem app, Electron may not have proper
// console attachment, so this may silently fail — that's OK.
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'pipe' });
  } catch { /* ignore — non-critical */ }

  // Patch child_process.spawn to always set windowsHide: true.
  // Prevents MCP plugin processes (and any other child processes)
  // from showing visible console windows to the user.
  const cp = require('child_process');
  const _origSpawn = cp.spawn;
  (globalThis as any).__deepsenoOriginalSpawn = _origSpawn;
  cp.spawn = function patchedSpawn(cmd: string, args?: any, opts?: any) {
    if (args && !Array.isArray(args)) { opts = args; args = undefined; }
    opts = { ...opts, windowsHide: true };
    return args ? _origSpawn(cmd, args, opts) : _origSpawn(cmd, opts);
  };
}

// Gracefully ignore EPIPE errors on stdout/stderr (happens during HMR reload)
process.stdout?.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});
process.stderr?.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});
// Also catch EPIPE thrown synchronously by console.log/console.error
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  // EPIPE: broken pipe from HMR reload — harmless
  if (err.code === 'EPIPE') return;
  console.error('[UncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

import { app, BrowserWindow, protocol, globalShortcut, ipcMain, session, clipboard, Menu, Tray, nativeImage, screen, systemPreferences, shell, dialog, desktopCapturer, autoUpdater as nativeAutoUpdater } from 'electron';

// Enable remote debugging only in non-packaged (dev) builds for agent-browser.
// Never expose the CDP port in production, otherwise any local process could take over the app.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
import type { AudioSource, RecordingScene } from '../src/main/audio/recording-scene';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { createFileResponse } from './media-protocol';

/**
 * Resolve FFmpeg binary path via FFmpegManager.
 * Priority: downloaded (app data) > legacy bundled (resources/) > system PATH.
 */
function getFFmpegBinPath(): string {
  try {
    const mgr = getFFmpegManager();
    const paths = mgr.find();
    return paths?.ffmpeg || 'ffmpeg';
  } catch {
    return 'ffmpeg'; // fallback to system PATH
  }
}

// Proxy is configured via session.setProxy() after app.ready (see below).
// Do NOT use --no-proxy-server or --proxy-bypass-list here — they interfere
// with session.setProxy() and prevent net.fetch from reaching external APIs.
import { autoUpdater } from 'electron-updater';
import { registerIpcHandlers, cleanupIpc, startFileWatching, getRecordingFilePath, enqueueForProcessing, getQueryEngine, getTaskQueue, getProcessor, initFeishuBot, stopFeishuBot, getFeishuBot, getSyncManager, startRealtimeTranscription, stopRealtimeTranscription, prewarmTranscriber, getSegmentTextForRecording, hasPendingSegmentOptimizations, awaitAndMergeSegmentOptimizations, pasteClean, triggerPostProcessing, getCurrentScene, stopChannels, getDingTalkChannel, getWeChatChannel, getMessageRouter, stopPlugins, getPluginEngine, getSherpaEngine, setDownloadManager, getAgentExecutor, getKnowledgeCompiler, getInsightEngine, resetLLMClients } from '../src/main/ipc-handlers';
import { BackgroundDownloadManager } from '../src/main/download-manager';
import { VoiceBrainDB } from '../src/main/db/database';
import { getDbPath } from '../src/main/paths';
import { TaskScheduler } from '../src/main/scheduler/task-scheduler';
import { TaskExecutor } from '../src/main/scheduler/task-executor';
import { seedPredefinedTasks } from '../src/main/scheduler/seed-tasks';
import { loadSettings, updateSettings } from '../src/main/settings';
import { createLLMClient, getLLMModel, getEmbedModel } from '../src/main/llm/create-client';
import { appendAppLog, captureRendererConsole, installMainConsoleCapture, registerLogIpcHandlers } from '../src/main/logging/log-bus';
import { LanServer } from '../src/main/server/lan-server';
import { RelayTunnel } from '../src/main/server/relay-tunnel';
import { PairingManager } from '../src/main/server/relay-pairing';
import { CertManager } from '../src/main/server/cert-manager';
import { loadLocalConfig } from '../src/main/local-config';
import { TodoTracker } from '../src/main/agent/todo-tracker';
import { EmailService } from '../src/main/channels/email-service';
import { WorkflowEngine } from '../src/main/agent/workflow-engine';
import { AgentEventBus } from '../src/main/agent/event-bus';
import { getFFmpegManager } from '../src/main/audio/ffmpeg-manager';
import { LlamaServerManager } from '../src/main/llm/llama-server-manager';
import type { LlamaRouterCapacityDecision } from '../src/main/llm/llama-server-manager';
import { ensureLlamaServer, getLlamaServer, setLlamaServer } from '../src/main/ipc/context';
import { prepareLlamaRouterRuntime } from '../src/main/llm/llama-router-runtime';

installMainConsoleCapture();

let taskScheduler: TaskScheduler | null = null;
let ollamaManager: OllamaManager | null = null;
let llamaServer: LlamaServerManager | null = null;
let lanServer: LanServer | null = null;
// Relay tunnel (P2P + server relay fallback). Lazily created.
let relayTunnel: RelayTunnel | null = null;
let relayCertManager: CertManager | null = null;
// Initialize eagerly so relay info is available in lanServer:getStatus
let relayPairingManager: PairingManager | null = new PairingManager();

// Write QR JSON to disk for automated testing

/** The API base URL, injected by electron-vite at build time. */
declare const __API_BASE_URL__: string;

// ─── LAN server IPC handlers (module-level) ───
// Registered early so the renderer can call them immediately on mount,
// even if LanServer construction fails for any reason.
ipcMain.handle('lanServer:getStatus', () => {
  const status: any = {
    running: lanServer?.isRunning() || false,
    clientCount: lanServer?.getClientCount() || 0,
    ...lanServer?.getConnectionInfo(),
  };
  // Use cached relay session — don't regenerate every poll
  if (status.running && relayPairingManager) {
    try {
      const session = relayPairingManager.getSession();
      if (!session) {
        const relay = relayPairingManager.startSession(loadLocalConfig().machineId || '');
        status.relayUrl = relay.url;
      } else {
        const url = `deepseno://pair?mid=${encodeURIComponent(loadLocalConfig().machineId || '')}&pub=${encodeURIComponent(session.publicKeyBase64)}&nonce=${encodeURIComponent(session.nonce)}`;
        status.relayUrl = url;
      }
    } catch (e) {
      console.error('[main] Failed to embed relay URL:', e);
    }
  }
  // Print once so the test script can capture it
  if (status.relayUrl && !(global as any).__printedRelay) {
    (global as any).__printedRelay = true;
    console.log('[RELAY_QR]', JSON.stringify({ relayUrl: status.relayUrl, fingerprint: status.fingerprint, token: status.token }));
  }
  return status;
});
ipcMain.handle('lanServer:start', async () => {
  if (!lanServer) return { success: false, error: 'Server not initialized' };
  try {
    const token = await lanServer.start();
    return { success: true, token, ...lanServer.getConnectionInfo() };
  } catch (err) {
    console.error('[main] LAN server start failed:', err);
    return { success: false, error: String(err) };
  }
});
ipcMain.handle('lanServer:stop', () => {
  lanServer?.stop();
  return { success: true };
});

// ─── Relay tunnel lifecycle ───
// The relay tunnel connects to the server WebSocket so phones can reach
// this desktop from anywhere. It starts automatically with the LAN server —
// no license key or subscription required.
function startRelayTunnel(): void {
  if (!lanServer) return;

  // Lazily create the cert manager.
  if (!relayCertManager) relayCertManager = new CertManager();
  // PairingManager is already eagerly initialized

  // Disconnect any existing tunnel before starting a new one.
  relayTunnel?.disconnect();

  const apiBase = typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : '';
  const wsUrl = apiBase.replace(/^http/, 'ws') + '/relay/ws';
  console.log('[main] Starting relay tunnel:', wsUrl);

  relayTunnel = new RelayTunnel({
    serverUrl: wsUrl,
    machineId: loadLocalConfig().machineId || '',
    lanServer,
    certManager: relayCertManager,
    pairingManager: relayPairingManager,
  });
  relayTunnel.connect();
  // Write QR file after a short delay (wait for connection)
}

ipcMain.handle('relay:getStatus', () => {
  return {
    enabled: true,
    status: relayTunnel?.currentStatus || 'disconnected',
    paired: relayPairingManager?.isPaired() || false,
    transportMode: relayTunnel?.currentTransportMode || 'none',
  };
});

ipcMain.handle('relay:enable', (_e, enabled: boolean) => {
  updateSettings({ relayTunnelEnabled: enabled });
  if (enabled) startRelayTunnel();
  else relayTunnel?.disconnect();
  return { success: true, status: relayTunnel?.currentStatus || 'disconnected' };
});

// Generate a QR code for phone pairing. Always available — no license required.
ipcMain.handle('relay:getPairingQR', () => {
  if (!relayPairingManager) relayPairingManager = new PairingManager();
  const qr = relayPairingManager.startSession(loadLocalConfig().machineId || '');
  return { url: qr.url, expiresAt: qr.expiresAt };
});

// Clear the pairing credential (unpair the phone).
ipcMain.handle('relay:unpair', () => {
  relayPairingManager?.clearCredential();
  return { success: true };
});

// ─── Theme-aware window chrome (matches CSS theme switch) ───
// Renderer calls this when the user toggles Sun/Moon so the OS-level
// window background and Windows title-bar overlay track the theme.
const THEME_COLORS = {
  dark:  { bg: '#0a0a0b', symbol: '#ececef' },
  light: { bg: '#f8f8fa', symbol: '#1a1a1f' },
};
ipcMain.on('theme:changed', (_event, theme: 'dark' | 'light') => {
  const c = THEME_COLORS[theme] || THEME_COLORS.dark;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.setBackgroundColor(c.bg); } catch {}
    try {
      // Windows-only; no-op on macOS/Linux.
      win.setTitleBarOverlay?.({ color: c.bg, symbolColor: c.symbol });
    } catch {}
  }
});

let recorderWindow: BrowserWindow | null = null;
let logWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let isRecording = false;
let isStarting = false; // true while start async work (AudioWorklet init) is in progress
let currentRecordingScene: RecordingScene = 'dictation';
let previousAppBundleId: string | null = null; // frontmost app before recording started (macOS)
let previousWindowHandle: string | null = null; // foreground window handle before recording started (Windows)
let isStopping = false; // true while stop + post-stop async work is in progress
let pendingUpdateInstallerPath: string | null = null;

function getUpdateDownloadUrl(): string {
  return typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__.replace(/\/api\/v1$/, '') : '';
}

function serializeUpdaterLogDetails(details?: unknown): string {
  if (details == null) return '';
  try {
    return ` ${JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    })}`;
  } catch {
    return ` ${String(details)}`;
  }
}

function appendUpdaterInstallLog(level: 'info' | 'warn' | 'error', message: string, details?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${serializeUpdaterLogDetails(details)}\n`;
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'updater-install.log'), line, 'utf8');
  } catch {
    // Logging must never block update flow.
  }
  const log = level === 'error' ? console.warn : level === 'warn' ? console.warn : console.log;
  log(`[AutoUpdater] ${message}`, details ?? '');
}

function notifyUpdateInstallFailed(error?: unknown): void {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  appendUpdaterInstallLog('error', 'Update install failed', { error: message });
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-install-failed', {
      downloadUrl: getUpdateDownloadUrl(),
      error: message,
    });
  }
}

function getPendingUpdateInstallerPath(): string | null {
  const updaterAny = autoUpdater as any;
  return pendingUpdateInstallerPath
    || updaterAny.downloadedUpdateHelper?.file
    || updaterAny.installerPath
    || null;
}

function getDownloadedUpdateFileInfo(): { isAdminRightsRequired?: boolean } | null {
  return ((autoUpdater as any).downloadedUpdateHelper?.downloadedFileInfo ?? null) as { isAdminRightsRequired?: boolean } | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInstallerFileReady(filePath: string): Promise<{ size: number }> {
  let previousSize = -1;
  let stableReads = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error('Downloaded update is not a file');
      if (stat.size <= 0) throw new Error('Downloaded update is empty');

      const handle = await fs.promises.open(filePath, 'r');
      await handle.close();

      if (stat.size === previousSize) {
        stableReads++;
      } else {
        previousSize = stat.size;
        stableReads = 0;
      }

      if (stableReads >= 2) return { size: stat.size };
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'timed out');
  throw new Error(`Update installer is not ready: ${reason}`);
}

function getOriginalChildProcessSpawn(): typeof import('child_process').spawn {
  return ((globalThis as any).__deepsenoOriginalSpawn || require('child_process').spawn) as typeof import('child_process').spawn;
}

function spawnDetachedInstaller(command: string, args: string[], graceMs: number): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const spawnImpl = getOriginalChildProcessSpawn();
    let child: ReturnType<typeof spawnImpl>;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    try {
      child = spawnImpl(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    timeout = setTimeout(() => fail(new Error('Timed out waiting for installer process to spawn')), 10_000);

    child.once('error', (err) => fail(err));
    child.once('spawn', () => {
      const pid = child.pid;
      if (!pid) {
        fail(new Error('Installer process spawned without a pid'));
        return;
      }

      appendUpdaterInstallLog('info', 'Installer process spawned', { command, args, pid });

      const complete = () => {
        if (settled) return;
        settled = true;
        cleanup();
        child.unref();
        resolve({ pid });
      };

      child.once('exit', (code, signal) => {
        fail(new Error(`Installer process exited immediately (code=${code}, signal=${signal})`));
      });

      if (graceMs <= 0) complete();
      else graceTimer = setTimeout(complete, graceMs);
    });
  });
}

async function installWindowsUpdate(): Promise<{ success: boolean }> {
  const installerPath = getPendingUpdateInstallerPath();
  appendUpdaterInstallLog('info', 'Windows update install requested', { installerPath });

  if (!installerPath) {
    throw new Error('No downloaded update installer path is available');
  }
  if (path.extname(installerPath).toLowerCase() !== '.exe') {
    throw new Error(`Downloaded update is not a Windows installer: ${installerPath}`);
  }

  const fileInfo = await waitForInstallerFileReady(installerPath);
  const installerArgs = ['--updated', '--force-run'];
  const downloadedInfo = getDownloadedUpdateFileInfo();
  const requiresElevation = downloadedInfo?.isAdminRightsRequired === true;
  const command = requiresElevation ? path.join(process.resourcesPath, 'elevate.exe') : installerPath;
  const args = requiresElevation ? [installerPath, ...installerArgs] : installerArgs;

  if (!fs.existsSync(command)) {
    throw new Error(`Update launcher is missing: ${command}`);
  }

  appendUpdaterInstallLog('info', 'Launching Windows update installer', {
    command,
    args,
    installerPath,
    size: fileInfo.size,
    requiresElevation,
  });

  await spawnDetachedInstaller(command, args, requiresElevation ? 0 : 1200);

  isQuitting = true;
  isUpdating = true;

  await cleanupRuntimeServices();
  appendUpdaterInstallLog('info', 'Runtime cleanup finished, quitting for update');
  app.quit();
  return { success: true };
}

// Fix userData path: in dev mode Electron uses "Electron" as app name, making
// userData point to ~/Library/Application Support/Electron. Force it to the
// same location as the packaged app so models/settings are shared.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'deepseno'));
}

// Register custom scheme as privileged (must be before app.whenReady)
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
]);

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1600, screenW),
    height: Math.min(1000, screenH),
    minWidth: 1200,
    minHeight: 700,
    autoHideMenuBar: true,
    // Match the app's dark surface so there is no white title bar / flash.
    // backgroundColor is the OS-level window bg that shows during load and behind transparent content.
    backgroundColor: '#0a0a0b',
    // macOS: hide the title bar but keep traffic lights as an overlay so the
    // content area extends to the top edge and reads as the app's own surface.
    // (Ignored on Windows/Linux.)
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    // Windows: paint the system caption with the app's dark surface so the
    // top strip matches in both themes. (Ignored on macOS/Linux.)
    titleBarOverlay: {
      color: '#0a0a0b',
      symbolColor: '#ececef',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Forward an optional startup theme override (KZ_THEME=dark|light) to the
      // renderer so the app can launch in a specific theme regardless of the
      // stored preference. Preload parses --kz-theme and exposes it; useTheme
      // honors it without persisting. Useful for screenshots / testing.
      additionalArguments:
        process.env.KZ_THEME === 'dark' || process.env.KZ_THEME === 'light'
          ? [`--kz-theme=${process.env.KZ_THEME}`]
          : [],
    },
    title: 'DeepSeno',
  });

  // Ctrl+Shift+I to open DevTools (dev mode only)
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.control && input.shift && input.key === 'I') {
        win.webContents.toggleDevTools();
      }
    });
  }

  // Windows: prevent Alt key from activating the menu bar when users choose
  // an Alt-based recording shortcut.
  if (process.platform === 'win32') {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.alt && input.type === 'keyDown') {
        _event.preventDefault();
      }
    });
  }

  captureRendererConsole(win, 'main-window');

  // Intercept close → hide to tray instead of quitting
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function getLogWindowBounds() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const targetWidth = Math.min(1760, Math.max(1500, Math.floor(width * 0.96)), width);
  const targetHeight = Math.min(820, Math.max(680, Math.floor(height * 0.92)), height);
  return {
    width: targetWidth,
    height: targetHeight,
    x: x + Math.max(0, Math.floor((width - targetWidth) / 2)),
    y: y + Math.max(0, Math.floor((height - targetHeight) / 2)),
  };
}

function createLogWindow(): BrowserWindow {
  const logWindowBounds = getLogWindowBounds();
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.setBounds(logWindowBounds);
    logWindow.show();
    logWindow.focus();
    return logWindow;
  }

  logWindow = new BrowserWindow({
    ...logWindowBounds,
    minWidth: Math.min(1180, logWindowBounds.width),
    minHeight: Math.min(640, logWindowBounds.height),
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    titleBarOverlay: {
      color: '#0a0a0b',
      symbolColor: '#ececef',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'DeepSeno Logs',
  });

  captureRendererConsole(logWindow, 'logs-window');

  logWindow.on('closed', () => {
    logWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    logWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/#/logs`);
  } else {
    logWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/logs' });
  }

  return logWindow;
}

// ─── Recorder floating window ───

function createRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    return recorderWindow;
  }

  // Use cursor position to find the active screen (supports multi-monitor + fullscreen)
  const cursorPoint = screen.getCursorScreenPoint();
  const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
  const { width: screenW } = activeDisplay.bounds;
  const { x: screenX, y: screenY } = activeDisplay.bounds;

  recorderWindow = new BrowserWindow({
    width: 400,
    height: 240,
    x: screenX + screenW - 420,
    y: screenY + 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/recorder.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    recorderWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/renderer/recorder.html`);
  } else {
    recorderWindow.loadFile(path.join(__dirname, '../renderer/src/renderer/recorder.html'));
  }

  captureRendererConsole(recorderWindow, 'recorder-window');

  recorderWindow.on('closed', () => {
    recorderWindow = null;
    isRecording = false;
  });

  return recorderWindow;
}

/** Apply fullscreen-compatible overlay properties to recorder window. */
function applyRecorderOverlayProps() {
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  recorderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  recorderWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu');
  // On macOS, force the window level to ensure it appears above fullscreen apps
  if (process.platform === 'darwin') {
    recorderWindow.setWindowButtonVisibility(false);
    // Re-assert visibility after a short delay to handle macOS Space transitions
    setTimeout(() => {
      if (recorderWindow && !recorderWindow.isDestroyed()) {
        recorderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        recorderWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 200);
  }
}

function toggleRecording(scene: RecordingScene = 'dictation') {
  // Block while start or stop async work is in progress
  if (isStarting || isStopping) return;

  if (isRecording) {
    // Stop recording
    isStopping = true;
    console.log('[Recorder] Stopping recording...');
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send('recording:stop');
    }
  } else {
    // Check screen recording permission for system audio scenes (macOS only)
    const needsSystem = ['online_meeting', 'media'].includes(scene);
    if (needsSystem && process.platform === 'darwin') {
      const screenStatus = systemPreferences.getMediaAccessStatus('screen');
      if (screenStatus !== 'granted') {
        dialog.showMessageBox({
          type: 'warning',
          title: 'Screen Recording Permission Required',
          message: '录制系统音频需要屏幕录制权限。请在系统偏好设置中授权后重启应用。',
          buttons: ['打开系统偏好设置', '取消'],
        }).then(({ response }) => {
          if (response === 0) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          }
        });
        return;
      }
    }

    // Start recording — set guard immediately to prevent double-start
    isStarting = true;
    currentRecordingScene = scene;
    console.log(`[Recorder] Starting recording (scene: ${scene})...`);

    // Capture foreground window/app BEFORE showing recorder window.
    // Must happen before createRecorderWindow() to avoid capturing our own app.
    if (process.platform === 'darwin') {
      try {
        const stdout = require('child_process').execFileSync('osascript', ['-e', 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'], { timeout: 2000, encoding: 'utf-8' }).trim();
        if (stdout) {
          previousAppBundleId = stdout;
          console.log(`[Recorder] Previous app (pre-capture): ${previousAppBundleId}`);
        }
      } catch { /* ignore */ }
    } else if (process.platform === 'win32') {
      // windowsHide:true prevents the console window from stealing focus.
      try {
        const getfgPath = app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'getfg.exe') : path.join(app.getAppPath(), 'scripts', 'getfg.exe');
        const hwnd = require('child_process').execFileSync(getfgPath, { timeout: 2000, encoding: 'utf-8', windowsHide: true }).trim();
        if (hwnd && hwnd !== '0') {
          previousWindowHandle = hwnd;
          console.log(`[Recorder] Previous window handle: ${previousWindowHandle}`);
        }
      } catch { /* ignore */ }
    }

    const win = createRecorderWindow();
    win.setSize(400, 400); // Ensure expanded size for new recording
    // Reposition to top-right of the active display (handles display/space changes)
    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const { x: sx, y: sy, width: sw } = activeDisplay.bounds;
    win.setPosition(sx + sw - 420, sy + 20);
    win.showInactive();
    // Re-apply overlay props AFTER showing — required for macOS fullscreen spaces
    applyRecorderOverlayProps();
    // Restore focus to the user's app (Electron steals it on Windows).
    // Recorder is alwaysOnTop so it stays visible regardless.
    if (process.platform === 'win32' && previousWindowHandle) {
      const setfgPath = app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'setfg.exe') : path.join(app.getAppPath(), 'scripts', 'setfg.exe');
      execFile(setfgPath, [previousWindowHandle, 'nopaste'], { windowsHide: true });
    }
    // Wait for window to be ready, then send start command
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('recording:start', scene);
      });
    } else {
      win.webContents.send('recording:start', scene);
    }
  }
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find(
    (w) => w !== recorderWindow && w !== logWindow && !w.isDestroyed()
  ) || null;
}

// ─── Recording IPC handlers ───

interface RecordingStartedDetails {
  scene?: RecordingScene;
  activeSources?: AudioSource[];
  warnings?: string[];
}

function normalizeActiveSources(details?: RecordingStartedDetails): AudioSource[] | undefined {
  if (!Array.isArray(details?.activeSources)) return undefined;
  const sources = details.activeSources.filter((source): source is AudioSource => source === 'mic' || source === 'system');
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

function setupRecordingIpc() {
  ipcMain.on('recording:started', (_event, details?: RecordingStartedDetails) => {
    isRecording = true;
    isStarting = false;
    console.log('[Recorder] Recording started');
    // previousAppBundleId / previousWindowHandle already captured in toggleRecording()
    // before the recorder window was shown, so no need to re-capture here.
    // Pause batch pipeline to free CPU for real-time transcription
    const tq = getTaskQueue();
    const wasPaused = tq?.isPaused() ?? false;
    if (tq && !wasPaused) {
      tq.pause();
      console.log('[Recorder] Paused batch pipeline for real-time recording');
    }
    // Also SIGSTOP the currently running batch Python subprocess
    const proc = getProcessor();
    if (proc) {
      proc.suspendPipeline();
      console.log('[Recorder] Suspended batch pipeline Python subprocess');
    }
    // Store flag so we only resume if WE paused it
    (globalThis as any).__recorderPausedQueue = !wasPaused;
    // Notify main window
    const mainWin = getMainWindow();
    if (mainWin) mainWin.webContents.send('recording:stateChanged', true);
    // Auto-start real-time transcription
    const activeSources = normalizeActiveSources(details);
    startRealtimeTranscription(currentRecordingScene, activeSources).then((result) => {
      if (result.success) {
        console.log(`[Recorder] Real-time transcription started (recording ${result.recordingId})`);
      } else {
        console.warn('[Recorder] Real-time transcription failed to start:', result.error);
      }
    }).catch((err) => {
      console.error('[Recorder] Real-time transcription error:', err);
    });
  });

  ipcMain.on('recording:stopped', () => {
    isRecording = false;
    console.log('[Recorder] Recording stopped');
    // Notify main window
    const mainWin = getMainWindow();
    if (mainWin) mainWin.webContents.send('recording:stateChanged', false);
    // Stop transcription FIRST (flushes remaining audio → final segments),
    // then optionally run LLM cleaning, then paste and hide
    stopRealtimeTranscription().then(async (result) => {
      if (result.success) {
        const pasteT0 = Date.now();
        const pasteTimer = (label: string) => console.log(`[Recorder] ⏱ ${label} (${((Date.now() - pasteT0) / 1000).toFixed(1)}s)`);
        console.log(`[Recorder] Real-time transcription stopped (recording ${result.recordingId}, ${result.duration?.toFixed(1)}s)`);

        if (result.recordingId) {
          const settings = loadSettings();
          const rawText = getSegmentTextForRecording(result.recordingId);
          if (!rawText) return;
          pasteTimer(`getSegmentText: ${rawText.length} chars`);

          // LLM optimization: use per-segment results computed during recording.
          // Scene-adaptive timeout: dictation=2s (speed), meeting=5s (quality).
          // No batchClean fallback — postProcessing handles full cleanup in background.
          let textToPaste = rawText;
          if (settings.llmCleanBeforePaste && rawText.trim().length >= 10) {
            if (recorderWindow && !recorderWindow.isDestroyed()) {
              recorderWindow.webContents.send('recorder:processingState', 'optimizing');
            }
            const llmCleanStart = Date.now();
            const scene = getCurrentScene();
            const timeoutMs = scene === 'dictation' ? 2000 : 5000;

            try {
              console.log(`[Recorder] Awaiting per-segment optimizations (${timeoutMs}ms, scene=${scene})...`);
              const merged = await awaitAndMergeSegmentOptimizations(result.recordingId!, timeoutMs);
              if (merged.trim() && merged !== rawText) {
                textToPaste = merged;
                console.log(`[Recorder] Per-segment optimized: ${rawText.length} → ${merged.length} chars (${((Date.now() - llmCleanStart) / 1000).toFixed(1)}s)`);
              } else {
                console.log(`[Recorder] Per-segment results same as raw (${((Date.now() - llmCleanStart) / 1000).toFixed(1)}s), using raw text`);
              }
            } catch (err) {
              console.warn('[Recorder] Per-segment merge failed:', err);
            }

            // Paste-clean: run full text through LLM with merge prompt
            // Removes filler words, merges fragments into coherent paragraph
            if (textToPaste.trim().length >= 10) {
              try {
                const pasteCleanTimeout = scene === 'dictation' ? 4000 : 8000;
                const cleaned = await Promise.race([
                  pasteClean(textToPaste, settings),
                  new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error('paste-clean timeout')), pasteCleanTimeout),
                  ),
                ]);
                if (cleaned.trim() && cleaned.trim().length >= 3) {
                  console.log(`[Recorder] Paste-clean: ${textToPaste.length} → ${cleaned.length} chars`);
                  textToPaste = cleaned;
                }
              } catch (err: any) {
                console.warn(`[Recorder] Paste-clean skipped: ${err.message}`);
              }
            }

            const mainWin = getMainWindow();
            if (mainWin) mainWin.webContents.send('recorder:llmCleanDone', textToPaste);
            console.log(`[Recorder] Final: ${textToPaste.length} chars (${textToPaste === rawText ? 'RAW' : 'OPTIMIZED'})`);
          }

          clipboard.writeText(textToPaste);
          pasteTimer(`clipboard written: ${textToPaste.length} chars (${textToPaste === rawText ? 'raw' : 'cleaned'})`);
          console.log(`[Recorder] Clipboard: ${textToPaste.length} chars (${textToPaste === rawText ? 'raw' : 'cleaned'})`);

          // Now that paste-clean is done, trigger deferred post-processing
          // (batch optimization, info extraction, etc.)
          triggerPostProcessing();

          // Show "done" state
          if (recorderWindow && !recorderWindow.isDestroyed()) {
            recorderWindow.webContents.send('recorder:processingState', 'done');
          }

          // Notify main window that post-processing is active
          const mw = getMainWindow();
          if (mw && result.recordingId) {
            mw.webContents.send('recording:postProcessing', { active: true, recordingId: result.recordingId });
          }

          if (settings.autoPasteAfterRecording) {
            // Let user see "done" state before hiding
            await new Promise((resolve) => setTimeout(resolve, 400));

            if (process.platform === 'darwin') {
              // Check Accessibility permission before attempting keystroke
              const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);

              // Hide recorder panel first
              if (recorderWindow && !recorderWindow.isDestroyed()) {
                recorderWindow.hide();
              }

              const bundleId = previousAppBundleId;
              previousAppBundleId = null;

              if (!isTrusted) {
                // No Accessibility permission — can't send keystroke.
                // Activate previous app (this doesn't need Accessibility),
                // then prompt user to grant permission.
                console.warn('[Recorder] Auto-paste skipped: no Accessibility permission');
                if (bundleId) {
                  execFile('osascript', ['-e', `tell application id "${bundleId}" to activate`], () => {});
                }
                // Prompt the system dialog
                systemPreferences.isTrustedAccessibilityClient(true);
                // Notify via main window
                const mw2 = getMainWindow();
                if (mw2) {
                  mw2.webContents.send('notification', {
                    type: 'warning',
                    message: '自动粘贴需要辅助功能权限。请在系统设置 → 隐私与安全 → 辅助功能中授权 DeepSeno，然后重启应用。文本已复制到剪贴板，可手动 ⌘V 粘贴。',
                  });
                }
              } else {
                // Give macOS time to process the panel hide and settle window stack
                await new Promise((resolve) => setTimeout(resolve, 150));

                // Use a SINGLE osascript call for activate + keystroke to guarantee
                // atomic execution. Two separate osascript processes had a race
                // condition where Cmd+V fired before the target app was active.
                const script = bundleId
                  ? `tell application id "${bundleId}" to activate\ndelay 0.3\ntell application "System Events" to keystroke "v" using command down`
                  : `delay 0.1\ntell application "System Events" to keystroke "v" using command down`;
                console.log(`[Recorder] Auto-paste: bundleId=${bundleId || '(none)'}, trusted=${isTrusted}`);
                try {
                  await new Promise<void>((resolve, reject) => {
                    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, _stdout, stderr) => {
                      if (err) {
                        console.warn(`[Recorder] Auto-paste osascript failed: ${err.message}`);
                        if (stderr) console.warn(`[Recorder] osascript stderr: ${stderr.trim()}`);
                        reject(err);
                      } else {
                        console.log('[Recorder] Auto-pasted to active app');
                        resolve();
                      }
                    });
                  });
                } catch {
                  // Paste failed — text is still in clipboard, user can Cmd+V manually
                }
              }
            } else if (process.platform === 'win32') {
              // Hide recorder first
              if (recorderWindow && !recorderWindow.isDestroyed()) {
                recorderWindow.hide();
              }
              const hwnd = previousWindowHandle;
              previousWindowHandle = null;
              console.log(`[Recorder] Win32 paste: hwnd=${hwnd}`);
              if (hwnd) {
                const setfgPath = app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'setfg.exe') : path.join(app.getAppPath(), 'scripts', 'setfg.exe');
                execFile(setfgPath, [hwnd], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
                  if (err) console.warn('[Recorder] Auto-paste failed:', err.message);
                  else console.log('[Recorder] Auto-pasted to active app');
                  if (stderr) console.log('[setfg.exe]', stderr.trim());
                });
              }
            }
            return;
          }

          // If not auto-pasting, wait longer for user to see "done" state, then hide
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      } else if (result.error !== 'Not recording') {
        console.warn('[Recorder] Real-time transcription stop failed:', result.error);
      }
    }).catch((err) => {
      console.error('[Recorder] Real-time transcription stop error:', err);
    }).finally(() => {
      // Hide recorder window (fallback — may already be hidden for auto-paste path)
      if (recorderWindow && !recorderWindow.isDestroyed() && recorderWindow.isVisible()) {
        recorderWindow.hide();
      }
      // Resume batch pipeline if we paused it
      if ((globalThis as any).__recorderPausedQueue) {
        // Resume suspended Python subprocess first (SIGCONT)
        const proc2 = getProcessor();
        if (proc2) {
          proc2.resumePipeline();
          console.log('[Recorder] Resumed batch pipeline Python subprocess');
        }
        const tq = getTaskQueue();
        if (tq) {
          tq.resume();
          console.log('[Recorder] Resumed batch pipeline after recording');
        }
        (globalThis as any).__recorderPausedQueue = false;
      }
      isStopping = false;
    });
  });

  ipcMain.on('recording:error', (_event, message: string) => {
    console.error('[Recorder] Error:', message);
    isRecording = false;
    isStarting = false;
    isStopping = false;
    // Send error to recorder window before hiding
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send('recording:error', message);
      recorderWindow.hide();
    }
    // Resume batch pipeline if we paused it
    if ((globalThis as any).__recorderPausedQueue) {
      const proc2 = getProcessor();
      if (proc2) proc2.resumePipeline();
      const tq = getTaskQueue();
      if (tq) {
        tq.resume();
        console.log('[Recorder] Resumed batch pipeline after recording error');
      }
      (globalThis as any).__recorderPausedQueue = false;
    }
    // Notify main window about error
    const mainWin = getMainWindow();
    if (mainWin) mainWin.webContents.send('recording:error', message);
  });

  ipcMain.on('recording:warning', (_event, message: string) => {
    console.warn('[Recorder] Warning:', message);
    const mainWin = getMainWindow();
    if (mainWin) mainWin.webContents.send('recording:warning', message);
  });

  ipcMain.handle('recording:save', async (_event, buffer: ArrayBuffer, duration: number) => {
    try {
      const settings = loadSettings();
      const saveDir = settings.watchDir || app.getPath('documents');

      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }

      // Generate timestamp filename
      const now = new Date();
      const ts = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const webmPath = path.join(saveDir, `REC-${ts}.webm`);
      const wavPath = path.join(saveDir, `REC-${ts}.wav`);

      // Save WebM first
      fs.writeFileSync(webmPath, Buffer.from(buffer));
      console.log(`[Recorder] Saved WebM: ${webmPath} (${(buffer.byteLength / 1024).toFixed(0)}KB, ${duration.toFixed(1)}s)`);

      // Convert to WAV using ffmpeg (bundled or system PATH)
      try {
        const ffmpegBin = getFFmpegBinPath();
        await new Promise<void>((resolve, reject) => {
          execFile(ffmpegBin, [
            '-i', webmPath,
            '-ar', '16000',
            '-ac', '1',
            '-y',
            wavPath,
          ], (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        // Remove WebM after successful conversion
        fs.unlinkSync(webmPath);
        console.log(`[Recorder] Converted to WAV: ${wavPath}`);

        // Auto-enqueue into processing pipeline
        const enqueueResult = enqueueForProcessing(wavPath);
        if (enqueueResult) {
          console.log(`[Recorder] Auto-enqueued: ${wavPath} (task ${enqueueResult.id})`);
        }

        // Notify main window
        const mainWin = getMainWindow();
        if (mainWin) {
          mainWin.webContents.send('recording:saved', { filePath: wavPath, duration });
        }

        return { success: true, filePath: wavPath };
      } catch (ffmpegErr) {
        // ffmpeg not available — report error, don't keep unusable WebM
        console.error('[Recorder] ffmpeg conversion failed:', ffmpegErr);
        try { fs.unlinkSync(webmPath); } catch { /* ignore */ }
        const mainWin = getMainWindow();
        if (mainWin) {
          mainWin.webContents.send('recording:error', 'ffmpeg_unavailable');
        }
        return { success: false, error: 'ffmpeg_unavailable' };
      }
    } catch (err) {
      console.error('[Recorder] Save failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Recorder window expand/collapse ───
  ipcMain.on('recorder:expand', () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.setSize(400, 400);
    }
  });

  ipcMain.on('recorder:collapse', () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.setSize(320, 56);
    }
  });
}

// Track registered scene shortcuts for cleanup
const registeredSceneShortcuts: Map<string, string> = new Map();

function registerAllSceneShortcuts(): void {
  for (const [, sc] of registeredSceneShortcuts) {
    globalShortcut.unregister(sc);
  }
  registeredSceneShortcuts.clear();

  const settings = loadSettings();
  const shortcuts = settings.sceneShortcuts;
  if (!shortcuts) return;

  for (const [scene, sc] of Object.entries(shortcuts)) {
    if (!sc) continue;
    try {
      const ok = globalShortcut.register(sc, () => toggleRecording(scene as RecordingScene));
      if (ok) {
        registeredSceneShortcuts.set(scene, sc);
        console.log(`[Recorder] Registered ${sc} for ${scene}`);
      } else {
        console.warn(`[Recorder] Failed to register ${sc} for ${scene}`);
      }
    } catch (err) {
      console.warn(`[Recorder] Invalid shortcut "${sc}" for ${scene}:`, err);
    }
  }
}

function updateSceneShortcut(scene: string, newShortcut: string): boolean {
  const old = registeredSceneShortcuts.get(scene);
  if (old) {
    globalShortcut.unregister(old);
    registeredSceneShortcuts.delete(scene);
  }

  if (!newShortcut) return true;

  try {
    const ok = globalShortcut.register(newShortcut, () => toggleRecording(scene as RecordingScene));
    if (ok) {
      registeredSceneShortcuts.set(scene, newShortcut);
      console.log(`[Recorder] Updated ${scene} shortcut to ${newShortcut}`);
      return true;
    }
    if (old) {
      globalShortcut.register(old, () => toggleRecording(scene as RecordingScene));
      registeredSceneShortcuts.set(scene, old);
    }
    return false;
  } catch {
    if (old) {
      try {
        globalShortcut.register(old, () => toggleRecording(scene as RecordingScene));
        registeredSceneShortcuts.set(scene, old);
      } catch {}
    }
    return false;
  }
}

// ─── App lifecycle ───

// Single instance lock — prevent multiple instances sharing the same shortcut
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.warn('[main] Another instance is already running — quitting');
  app.quit();
}
app.on('second-instance', () => {
  // Show and focus the main window when a second instance is launched
  const win = getMainWindow();
  if (win) {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  // ─── Configure Chromium session proxy for net.fetch ───
  // If a proxy URL was captured from env vars (e.g. Clash http://127.0.0.1:7890),
  // use it explicitly; otherwise fall back to OS system proxy detection.
  const bypassRules = 'localhost,127.0.0.1,<local>';
  if (_savedProxyUrl) {
    await session.defaultSession.setProxy({
      proxyRules: _savedProxyUrl,
      proxyBypassRules: bypassRules,
    });
    console.log(`[Proxy] Using proxy from env: ${_savedProxyUrl} (bypass: ${bypassRules})`);
  } else {
    await session.defaultSession.setProxy({
      mode: 'system',
      proxyBypassRules: bypassRules,
    });
    console.log(`[Proxy] Using system proxy detection (bypass: ${bypassRules})`);
  }

  // Request macOS system-level microphone permission (required since Catalina).
  // Without this, getUserMedia succeeds but returns all-zero audio.
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Mic] macOS microphone status: ${micStatus}`);
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log(`[Mic] Permission request result: ${granted}`);
    }
    const afterStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Mic] Final microphone status: ${afterStatus}`);

    // Check Accessibility permission (required for auto-paste via System Events keystroke).
    // isTrustedAccessibilityClient(true) shows the macOS system dialog if not granted.
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    console.log(`[Accessibility] Trusted: ${trusted}`);
    if (!trusted) {
      // Prompt once — shows the system "allow Accessibility" dialog
      systemPreferences.isTrustedAccessibilityClient(true);
      console.log('[Accessibility] Prompted user to grant Accessibility permission');
    }
  }

  // Allow app-owned media/fullscreen permissions. Native <video controls>
  // fullscreen requests arrive here as the distinct "fullscreen" permission.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'screen' || permission === 'fullscreen');
  });

  // Grant all permission checks (required for packaged apps on Windows to allow microphone)
  session.defaultSession.setPermissionCheckHandler((_webContents, _permission) => {
    return true;
  });

  // Enable system audio capture via getDisplayMedia (macOS ScreenCaptureKit)
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length > 0) {
      callback({ video: sources[0], audio: 'loopback' });
    } else {
      callback({});
    }
  });

  // Register custom protocol for serving local media files securely.
  // HTML media elements seek by issuing Range requests; serve 206 responses
  // here instead of delegating to file:// so desktop video scrubbing works.
  protocol.handle('media', (request) => {
    const url = new URL(request.url);
    const pathParts = url.pathname.replace(/^\/+/, '').split('/');

    if (url.hostname === 'audio' || pathParts[0] === 'audio') {
      const recordingId = parseInt(url.hostname === 'audio' ? pathParts[0] : pathParts[1], 10);
      if (isNaN(recordingId)) {
        return new Response('Invalid recording ID', { status: 400 });
      }
      const filePath = getRecordingFilePath(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Audio file not found', { status: 404 });
      }
      return createFileResponse(filePath, request);
    }

    if (url.hostname === 'image' || pathParts[0] === 'image') {
      const parts = url.hostname === 'image' ? pathParts : pathParts.slice(1);
      const recordingId = parseInt(parts[0], 10);
      const imageIndex = parts[1] ? parseInt(parts[1], 10) : undefined;
      if (isNaN(recordingId)) {
        return new Response('Invalid recording ID', { status: 400 });
      }
      const filePath = getRecordingFilePath(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Image file not found', { status: 404 });
      }
      // If file_path is a directory (image group), serve individual image by index
      if (fs.statSync(filePath).isDirectory()) {
        const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);
        const images = fs.readdirSync(filePath)
          .filter((f: string) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
          .sort();
        const idx = imageIndex ?? 0;
        if (idx >= images.length) {
          return new Response('Image index out of range', { status: 404 });
        }
        const imgPath = path.join(filePath, images[idx]);
        return createFileResponse(imgPath, request);
      }
      // Single image file — only index 0 (or omitted) is valid
      if (imageIndex !== undefined && imageIndex > 0) {
        return new Response('Image index out of range', { status: 404 });
      }
      return createFileResponse(filePath, request);
    }

    // Serve document files (PDF, DOCX, TXT) by recording ID
    if (url.hostname === 'document' || pathParts[0] === 'document') {
      const recordingId = parseInt(url.hostname === 'document' ? pathParts[0] : pathParts[1], 10);
      if (isNaN(recordingId)) {
        return new Response('Invalid recording ID', { status: 400 });
      }
      const filePath = getRecordingFilePath(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Document file not found', { status: 404 });
      }
      return createFileResponse(filePath, request);
    }

    return new Response('Not found', { status: 404 });
  });

  /** Pre-warm llama-server by loading chat model first, then embedding model.
   *  Sequential loading avoids dual I/O + Metal shader compilation stalls. */
  async function prewarmLLM(port: number, capacity: LlamaRouterCapacityDecision) {
    const s = loadSettings();
    const chatModel = getLLMModel(s);
    const embedModel = getEmbedModel(s);
    const base = `http://127.0.0.1:${port}/v1`;
    appendAppLog('info', 'main', 'local-model', 'Startup local model prewarm plan', {
      port,
      chatModel,
      embedModel,
      capacity,
    });
    // Load chat model first, then embedding — sequential avoids system freeze
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chatModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) throw new Error(`chat prewarm failed: HTTP ${res.status} ${await res.text()}`);
      appendAppLog('info', 'main', 'local-model', 'Startup chat model prewarm completed', {
        port,
        model: chatModel,
      });
    } catch (err) {
      appendAppLog('warn', 'main', 'local-model', 'Startup chat model prewarm failed; embedding prewarm skipped', {
        port,
        model: chatModel,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!capacity.allowEmbeddingPrewarm) {
      appendAppLog('info', 'main', 'local-model', 'Startup embedding prewarm skipped by router capacity decision', {
        port,
        model: embedModel,
        capacity,
      });
      return;
    }
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, input: 'hi' }),
      });
      if (!res.ok) throw new Error(`embedding prewarm failed: HTTP ${res.status} ${await res.text()}`);
      appendAppLog('info', 'main', 'local-model', 'Startup embedding model prewarm completed', {
        port,
        model: embedModel,
      });
    } catch (err) {
      appendAppLog('warn', 'main', 'local-model', 'Startup embedding model prewarm failed', {
        port,
        model: embedModel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Bundled llama-server (local provider) ──────────────────
  const settings = loadSettings();
  if (settings.llmProvider === 'local') {
    // Always create the manager so IPC handlers can access it.
    llamaServer = ensureLlamaServer();

    // Start in router mode — auto-discovers GGUF files in models directory
    const { modelsDir, presetPath } = prepareLlamaRouterRuntime();

    if (fs.existsSync(modelsDir)) {
      llamaServer.startRouter(modelsDir, {
        maxModels: 2,
        flashAttn: true,
        presetPath,
      }).then(({ port, capacity }) => {
        console.log(`[main] llama-server (router) on port ${port}`);
        updateSettings({ llamaServerPort: port });
        resetLLMClients();
        // Pre-warm: trigger model loading in background so first user request is fast
        prewarmLLM(port, capacity).catch(() => {});
      }).catch(err => {
        console.error('[main] llama-server router start failed:', err);
      });
    } else {
      console.warn('[main] local provider enabled but models directory not found:', modelsDir);
    }
  }

  // Setup recording IPC
  setupRecordingIpc();

  registerLogIpcHandlers(createLogWindow);
  registerIpcHandlers(() => getMainWindow());
  appendAppLog('info', 'main', 'startup', 'Main IPC handlers registered');

  // Initialize SherpaEngineProxy worker pool (batch + realtime workers)
  // Use 1 batch worker by default — a second worker brings little parallelism
  // benefit for single-recording workflows and doubles idle CPU/memory cost
  // (each batch worker loads SenseVoice + pyannote + 3dspeaker ONNX sessions).
  try {
    const { initSherpaEngine } = await import('../src/main/ipc/context');
    await initSherpaEngine(1);
    console.log('[main] SherpaEngineProxy worker pool ready (1 batch + 1 realtime)');
  } catch (err) {
    console.warn('[main] SherpaEngineProxy init failed (models may not be downloaded yet):', err);
  }

  // Pre-warm the streaming transcriber (loads SenseVoice + VAD in background)
  // so the first recording starts instantly
  prewarmTranscriber();

  // ── Pre-warm SherpaEngine workers (fire-and-forget) ──
  try {
    const engine = getSherpaEngine();
    if (engine?.warmup) engine.warmup();
  } catch (_) {}

  // Pre-warm paste-clean LLM model so first recording has no cold-start delay
  // Uses empty-prompt warmup (load model only, no generation) to avoid blocking user queries
  (async () => {
    try {
      const s = loadSettings();
      if (s.llmCleanBeforePaste && s.llmProvider !== 'openai' && s.llmProvider !== 'local') {
        const { resolvePasteCleanModel } = await import('../src/main/llm/paste-clean-model');
        const { model } = await resolvePasteCleanModel(s);
        await client.warmup(model, 4096);
        console.log(`[main] Paste-clean model pre-warmed: ${model}`);
      }
    } catch (err) {
      console.warn('[main] Paste-clean model pre-warm failed (non-critical):', err);
    }
  })();

  // Resume sync if previously enabled (acquires lock, starts checkpointer)
  getSyncManager().resumeSync();

  // ─── LAN HTTP server for mobile companion ───
  // IPC handlers registered at module level (above) so they're always available.
  lanServer = new LanServer(18526);

  createWindow();

  // ─── System tray ───
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../resources/icon.png');
  const trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 });
  // On macOS, mark as template image so the menu bar renders it correctly in both light/dark mode
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('DeepSeno');
  const trayMenu = Menu.buildFromTemplate([
    {
      label: settings.language === 'zh' ? '显示窗口' : 'Show Window',
      click: () => {
        const win = getMainWindow();
        if (win) { win.show(); win.focus(); }
      },
    },
    { type: 'separator' },
    {
      label: settings.language === 'zh' ? '退出' : 'Quit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(trayMenu);
  // Click tray icon to show window (Windows/Linux: left-click, macOS: handled by context menu)
  tray.on('click', () => {
    const win = getMainWindow();
    if (win) { win.show(); win.focus(); }
  });

  // Auto-update check (only in production)
  if (app.isPackaged) {
    let installRequested = false;

    if (process.platform === 'win32') {
      autoUpdater.logger = {
        info: (message?: any) => appendUpdaterInstallLog('info', 'electron-updater', message),
        warn: (message?: any) => appendUpdaterInstallLog('warn', 'electron-updater', message),
        error: (message?: any) => appendUpdaterInstallLog('error', 'electron-updater', message),
      };
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = process.platform !== 'win32';
    autoUpdater.autoRunAppAfterInstall = true;
    nativeAutoUpdater.on('before-quit-for-update', () => {
      console.log('[AutoUpdater] before-quit-for-update');
      isQuitting = true;
      isUpdating = true;
      void cleanupRuntimeServices();
    });
    autoUpdater.on('update-available', (info) => {
      console.log(`[AutoUpdater] Update available: v${info.version}`);
      const win = getMainWindow();
      if (win) win.webContents.send('update-available', { version: info.version });
    });
    autoUpdater.on('download-progress', (progress) => {
      console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
      const win = getMainWindow();
      if (win) win.webContents.send('update-download-progress', { percent: progress.percent });
    });
    autoUpdater.on('update-downloaded', (event: any) => {
      pendingUpdateInstallerPath = event?.downloadedFile || getPendingUpdateInstallerPath();
      if (process.platform === 'win32') {
        appendUpdaterInstallLog('info', 'Update downloaded', {
          downloadedFile: pendingUpdateInstallerPath,
          platform: process.platform,
        });
      } else {
        console.log('[AutoUpdater] Update downloaded, will install on quit');
      }
      const win = getMainWindow();
      if (win) win.webContents.send('update-downloaded');
    });
    autoUpdater.on('error', (err) => {
      if (process.platform === 'win32') {
        appendUpdaterInstallLog('error', 'electron-updater error', { error: err.message });
      } else {
        console.warn('[AutoUpdater] Error:', err.message);
      }
      if (installRequested) {
        installRequested = false;
        isUpdating = false;
        isQuitting = false;
        const win = getMainWindow();
        if (win) win.webContents.send('update-install-failed', process.platform === 'win32'
          ? { downloadUrl: getUpdateDownloadUrl(), error: err.message }
          : { downloadUrl: getUpdateDownloadUrl() });
      }
    });
    autoUpdater.checkForUpdates().catch(() => {});

    ipcMain.handle('system:checkForUpdate', async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
      } catch { return { available: false }; }
    });
    ipcMain.handle('system:downloadUpdate', async () => {
      try {
        await autoUpdater.downloadUpdate();
        return { success: true };
      } catch (err: any) { return { success: false, error: err.message }; }
    });
    ipcMain.handle('system:installUpdate', async () => {
      // Guard against repeated clicks. On macOS, retrying quitAndInstall while
      // Squirrel.Mac is staging the update can add duplicate native listeners.
      if (installRequested) return { success: true };
      installRequested = true;

      try {
        if (process.platform === 'win32') {
          return await installWindowsUpdate();
        }

        // Let quitAndInstall close windows instead of our tray-close handler hiding them.
        // Electron emits before-quit after closing windows for updates, so the native
        // before-quit-for-update listener above keeps this flag set at the right moment.
        isQuitting = true;
        isUpdating = true;

        await cleanupRuntimeServices();
        autoUpdater.quitAndInstall(false, true);
        return { success: true };
      } catch (err: any) {
        isUpdating = false;
        isQuitting = false;
        installRequested = false;
        if (process.platform === 'win32') {
          notifyUpdateInstallFailed(err);
        } else {
          console.warn('[AutoUpdater] quitAndInstall threw:', err?.message);
          const win = getMainWindow();
          if (win) win.webContents.send('update-install-failed', { downloadUrl: getUpdateDownloadUrl() });
        }
        return { success: false, error: err?.message };
      }
    });
  }

  // Application menu with keyboard shortcuts
  const isMac = process.platform === 'darwin';
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'DeepSeno',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Quick Search',
          accelerator: 'CmdOrCtrl+K',
          click: () => { const win = getMainWindow(); if (win) win.webContents.send('shortcut:search'); },
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => { const win = getMainWindow(); if (win) win.webContents.send('shortcut:settings'); },
        },
        {
          label: 'New Recording',
          accelerator: 'CmdOrCtrl+N',
          click: () => toggleRecording(),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' } as Electron.MenuItemConstructorOptions] : []),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [] : [{ role: 'close' as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Register all scene shortcuts from settings
  registerAllSceneShortcuts();

  // IPC: toggle recording from UI button (optionally with scene)
  ipcMain.handle('recording:toggle', (_e, scene?: string) => {
    const willRecord = !isRecording;
    toggleRecording(scene as RecordingScene | undefined);
    return { recording: willRecord };
  });

  // IPC: update a single scene shortcut
  ipcMain.handle('recording:updateSceneShortcut', (_event, scene: string, newShortcut: string) => {
    return updateSceneShortcut(scene, newShortcut);
  });

  // IPC: get desktop sources for system audio capture
  ipcMain.handle('desktop:getSources', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      return sources.map(s => ({ id: s.id, name: s.name }));
    } catch (err) {
      console.error('[desktop] Failed to get sources:', err);
      return [];
    }
  });

  // IPC: check screen recording permission (macOS)
  ipcMain.handle('system:checkScreenPermission', () => {
    if (process.platform === 'darwin') {
      return systemPreferences.getMediaAccessStatus('screen');
    }
    return 'granted';
  });

  // Seed predefined scheduled tasks from settings (first upgrade only)
  seedPredefinedTasks();

  // Start task scheduler (replaces ReportScheduler)
  taskScheduler = new TaskScheduler();

  // Create TodoTracker
  let mainTodoTracker: any;
  try {
    const todoSettings = loadSettings();
    const todoLlmClient = createLLMClient(todoSettings);
    mainTodoTracker = new TodoTracker(
      new VoiceBrainDB(getDbPath()),
      todoLlmClient,
      getLLMModel(todoSettings),
    );
    const proc = getProcessor();
    if (proc) proc.setTodoTracker(mainTodoTracker);
    console.log('[main] TodoTracker initialized');
  } catch (err) {
    console.warn('[main] TodoTracker init failed:', err);
  }

  // Parallel init of independent subsystems (single 2s delay instead of staggered 2-5s)
  setTimeout(async () => {
    await Promise.allSettled([
      // File watcher
      (async () => {
        try {
          await startFileWatching();
        } catch (err) {
          console.error('[main] Failed to start file watcher:', err);
        }
      })(),
      // Embed model warmup (only for local Local)
      (async () => {
        const settings = loadSettings();
        if (settings.llmProvider !== 'openai') {
          const embedModel = getEmbedModel(settings);
          client.warmup(embedModel, 4096).catch(() => {});
        }
      })(),
      // V2 infrastructure + TaskExecutor (wires MessageRouter, WorkflowEngine, EventBus)
      (async () => {
        try {
          const wfSettings = loadSettings();
          const wfDb = new VoiceBrainDB(getDbPath());
          const wfLlmClient = createLLMClient(wfSettings);

          const emailService = new EmailService();
          emailService.init();

          const router = getMessageRouter();
          const wfTodoTracker = new TodoTracker(wfDb, wfLlmClient, getLLMModel(wfSettings));
          const workflowEngine = new WorkflowEngine(wfDb, router || undefined, wfTodoTracker, emailService);

          const eventBus = new AgentEventBus();
          if (router) eventBus.setRouter(router);
          eventBus.setWorkflowEngine(workflowEngine);

          const proc = getProcessor();
          if (proc) proc.setEventBus(eventBus);

          const executor = new TaskExecutor(
            {
              router: router || undefined,
              insightEngine: getInsightEngine(),
              todoTracker: mainTodoTracker,
              knowledgeCompiler: getKnowledgeCompiler() || undefined,
              // Lazy: the bot is initialized in parallel; resolved at call time.
              feishuNotifier: async (cardJson: string) => {
                const handler = getFeishuBot()?.getHandler();
                const adminId = loadSettings().feishuAdminOpenId;
                if (handler && adminId) await handler.sendCard(adminId, cardJson);
              },
            },
            getAgentExecutor,
          );
          taskScheduler!.setExecutor(executor);
          taskScheduler!.start();

          console.log('[main] TaskScheduler + v2 infrastructure wired');
        } catch (err) {
          console.warn('[main] v2 infrastructure init failed:', err);
          taskScheduler!.start();
        }
      })(),
      // Feishu bot
      (async () => {
        initFeishuBot();
      })(),
      // Plugin auto-start
      (async () => {
        const engine = getPluginEngine();
        if (engine) {
          await engine.autoStartAll().catch((err) => {
            console.warn('[main] Plugin auto-start failed:', err);
          });
        }
      })(),
      // Background download manager
      (async () => {
        const s = loadSettings();
        if (!s.setupComplete) {
          console.log('[main] Setup not complete, skipping background downloads');
          return;
        }
        try {
          const sherpa = getSherpaEngine();
          if (!sherpa) {
            console.warn('[main] SherpaEngine not available, skipping background downloads');
            return;
          }
          const downloadMgr = new BackgroundDownloadManager(sherpa.getModelManager());
          const mainWin = getMainWindow();
          if (mainWin) downloadMgr.setWindow(mainWin);
          setDownloadManager(downloadMgr);
          await downloadMgr.startAll().catch((err) => {
            console.error('[main] Background download error:', err);
          });
          console.log('[main] BackgroundDownloadManager started');
        } catch (err) {
          console.warn('[main] BackgroundDownloadManager init failed:', err);
        }
      })(),
    ]);
  }, 2000);

  // ─── LAN server callback wiring ───
  // (LanServer instance + IPC handlers already registered before createWindow)
  lanServer.onFileUploaded = (filePath: string) => {
    const result = enqueueForProcessing(filePath);
    return result?.id || null;
  };
  lanServer.onGetRecordingFilePath = (recordingId: number) => {
    return getRecordingFilePath(recordingId);
  };
  lanServer.onGetRecordings = () => {
    try { return new VoiceBrainDB(getDbPath()).getAllRecordings(); } catch { return []; }
  };
  lanServer.onGetSegments = (recordingId: number) => {
    try { return new VoiceBrainDB(getDbPath()).getSegmentsByRecording(recordingId); } catch { return []; }
  };
  lanServer.onSearchSegments = (query: string) => {
    try { const q = `"${query.replace(/"/g, '""')}"`; return new VoiceBrainDB(getDbPath()).searchSegments(q); } catch { return []; }
  };
  lanServer.onGetMeetingNotes = (recordingId: number) => {
    try {
      const db = new VoiceBrainDB(getDbPath());
      const rec = db.getRecording(recordingId);
      return rec?.meeting_notes_json ? JSON.parse(rec.meeting_notes_json) : null;
    } catch { return null; }
  };

  // ─── v2 REST callbacks ───
  lanServer.onGetDailySummary = (date: string) => {
    try { return new VoiceBrainDB(getDbPath()).getDailySummary(date) || null; } catch { return null; }
  };
  lanServer.onGetWeeklySummary = (startDate: string) => {
    try {
      // Compute end date: startDate + 6 days
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const endDate = end.toISOString().split('T')[0];
      const summary = new VoiceBrainDB(getDbPath()).getWeeklySummary(startDate, endDate);
      return summary || null;
    } catch { return null; }
  };
  lanServer.onGetMonthlySummary = (startDate: string) => {
    try {
      // startDate is the month's first day; end date = last day of that month.
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      const endDate = end.toISOString().split('T')[0];
      const summary = new VoiceBrainDB(getDbPath()).getMonthlySummary(startDate, endDate);
      return summary || null;
    } catch { return null; }
  };
  lanServer.onGetExtractedItems = (opts?: { type?: string; status?: string; recordingId?: number }) => {
    try {
      const db = new VoiceBrainDB(getDbPath());
      if (opts?.recordingId) {
        return db.getExtractedItemsByRecording(opts.recordingId);
      }
      let items = db.getAllExtractedItems();
      if (opts?.type) items = items.filter(i => i.type === opts.type);
      if (opts?.status) items = items.filter(i => i.status === opts.status);
      return items;
    } catch { return []; }
  };
  lanServer.onUpdateExtractedItemStatus = (id: number, status: string) => {
    try { new VoiceBrainDB(getDbPath()).updateExtractedItemStatus(id, status); } catch {}
  };
  lanServer.onGetChatSessions = () => {
    try { return new VoiceBrainDB(getDbPath()).getAllSessions(); } catch { return []; }
  };
  lanServer.onCreateChatSession = (title?: string) => {
    try {
      const db = new VoiceBrainDB(getDbPath());
      const id = db.createSession(title);
      const now = new Date().toISOString();
      return { id, title: title || '新对话', created_at: now, updated_at: now };
    } catch { return null; }
  };
  lanServer.onGetSessionMessages = (sessionId: number) => {
    try { return new VoiceBrainDB(getDbPath()).getSessionMessages(sessionId); } catch { return []; }
  };
  lanServer.onQueryStream = async (question, onChunk, onStatus) => {
    const qe = getQueryEngine();
    if (!qe) throw new Error('Query engine not available');
    return qe.queryStream(question, onChunk, onStatus);
  };
  // Non-streaming query for relay proxy (P2P/encrypted relay path)
  lanServer.onQuery = async (question: string) => {
    const qe = getQueryEngine();
    if (!qe) throw new Error('Query engine not available');
    const result = await qe.query(question);
    return { answer: result.answer, sources: result.sources };
  };
  lanServer.onSaveChatMessage = (sessionId: number, role: string, content: string, sourcesJson?: string) => {
    try { return new VoiceBrainDB(getDbPath()).saveChatMessage(sessionId, role, content, sourcesJson); } catch { return null; }
  };

  // ─── Mobile companion callbacks ───
  lanServer.onCreateTextNote = (content: string) => {
    try {
      const db = new VoiceBrainDB(getDbPath());
      const id = db.insertTextNote({
        channel_id: 'mobile',
        user_id: 'mobile-user',
        content,
      });
      console.log(`[LanServer] Text note created: id=${id}, content=${content.slice(0, 50)}`);

      // Notify desktop UI
      const win = getMainWindow();
      if (win) {
        win.webContents.send('text-note:new', { id, channel_id: 'mobile', user_id: 'mobile-user', content });
      }

      // Broadcast to other mobile clients via WebSocket
      lanServer!.broadcast({ type: 'text-note:new', id, content: content.slice(0, 100) });

      return { success: true, id };
    } catch (err) {
      console.error('[LanServer] Failed to create text note:', err);
      return { success: false, error: String(err) };
    }
  };
  lanServer.onGetBriefing = (date: string) => {
    try {
      const db = new VoiceBrainDB(getDbPath());
      const summary = db.getDailySummary(date) || null;
      const allItems = db.getAllExtractedItems();
      const todos = allItems.filter(i => i.type === 'todo' && i.status === 'active');
      const items = allItems.slice(0, 20);
      return { summary, todos, items };
    } catch {
      return { summary: null, todos: [], items: [] };
    }
  };
  lanServer.onRegenerateBriefing = async (mode: 'daily' | 'weekly', date: string) => {
    try {
      const { actionDailyReport, actionWeeklyReport } = await import('../src/main/scheduler/predefined-actions');
      // All ActionDeps fields are optional — they skip those branches when
      // absent (no feishu push, no router, etc.). We only need the LLM call.
      const deps = {};
      if (mode === 'weekly') {
        const result = await actionWeeklyReport(deps, [], date);
        if (!result.success) return { success: false, error: result.error || 'Weekly regenerate failed' };
        // Return the freshly written weekly summary
        const db = new VoiceBrainDB(getDbPath());
        const end = new Date(date + 'T00:00:00');
        end.setDate(end.getDate() + 6);
        const summary = db.getWeeklySummary(date, end.toISOString().split('T')[0]);
        return { success: true, weekly: summary || null };
      } else {
        const result = await actionDailyReport(deps, [], { forDate: date });
        if (!result.success) return { success: false, error: result.error || 'Daily regenerate failed' };
        // Return the freshly written daily briefing
        const db = new VoiceBrainDB(getDbPath());
        const summary = db.getDailySummary(date) || null;
        const allItems = db.getAllExtractedItems();
        const todos = allItems.filter(i => i.type === 'todo' && i.status === 'active');
        const items = allItems.slice(0, 20);
        return { success: true, briefing: { summary, todos, items } };
      }
    } catch (err: any) {
      console.error('[LanServer] onRegenerateBriefing failed:', err);
      return { success: false, error: String(err?.message || err) };
    }
  };

  // ─── Channel webhook callbacks ───
  lanServer.onDingtalkWebhook = async (req, res) => {
    const ch = getDingTalkChannel();
    if (!ch) {
      res.status(404).json({ msgtype: 'empty', empty: {} });
      return;
    }
    try {
      await ch.handleWebhook(req.body);
      res.json({ msgtype: 'empty', empty: {} });
    } catch (err) {
      console.error('[main] DingTalk webhook error:', err);
      res.json({ msgtype: 'empty', empty: {} });
    }
  };

  lanServer.onWechatWebhook = async (req, res) => {
    const ch = getWeChatChannel();
    if (!ch) {
      res.status(404).send('Not configured');
      return;
    }
    const settings = loadSettings();
    try {
      const result = await ch.handleWebhook(
        req.body, // raw XML string (text parser in LanServer)
        { msg_signature: req.query.msg_signature as string, timestamp: req.query.timestamp as string, nonce: req.query.nonce as string },
        settings.wechatToken || '',
        settings.wechatEncodingAESKey || '',
      );
      res.send(result);
    } catch (err) {
      console.error('[main] WeChat webhook error:', err);
      res.send('success');
    }
  };

  lanServer.onWechatVerify = (req, res) => {
    const ch = getWeChatChannel();
    if (!ch) {
      res.status(404).send('Not configured');
      return;
    }
    const settings = loadSettings();
    const echostr = ch.handleVerify(
      { msg_signature: req.query.msg_signature as string, timestamp: req.query.timestamp as string, nonce: req.query.nonce as string, echostr: req.query.echostr as string },
      settings.wechatToken || '',
      settings.wechatEncodingAESKey || '',
    );
    if (echostr !== null) {
      res.send(echostr);
    } else {
      res.status(403).send('Verification failed');
    }
  };

  lanServer.onSendMessage = async (channelId: string, chatId: string, text: string) => {
    const router = getMessageRouter();
    if (!router) throw new Error('Message router not initialized');
    await router.sendText(channelId, chatId, text);
  };

  lanServer.start()
    .then(() => {
      console.log('[main] LAN server started:', lanServer!.getConnectionInfo());

      // Wire TaskQueue events to WebSocket broadcast
      const tq = getTaskQueue();
      if (tq && lanServer) {
        const srv = lanServer;
        tq.on('task:completed', (task) => {
          try {
            const db = new VoiceBrainDB(getDbPath());
            const rec = db.getRecordingByPath(task.filePath);
            if (rec) {
              srv.broadcast({ type: 'recording:status', recordingId: rec.id, status: 'completed' });
            }
          } catch {}
        });
        tq.on('task:progress', (task) => {
          srv.broadcast({ type: 'pipeline:progress', taskId: task.id, step: task.status, progress: task.progress });
        });
        tq.on('task:added', (task) => {
          srv.broadcast({ type: 'recording:new', recording: { taskId: task.id, filePath: task.filePath, status: task.status } });
        });
        tq.on('task:failed', (task) => {
          srv.broadcast({ type: 'pipeline:progress', taskId: task.id, step: 'failed', progress: task.progress, error: task.error });
        });
        console.log('[main] TaskQueue events wired to WS broadcast');
      }

      // Start the relay tunnel (P2P + server relay) if enabled.
      startRelayTunnel();
    })
    .catch((err: unknown) => console.error('[main] LAN server auto-start failed:', err));

});

app.on('window-all-closed', () => {
  // Do nothing — window is hidden to tray, not actually closed.
  // The app quits only via tray menu "退出" or macOS Cmd+Q.
});

app.on('activate', () => {
  // macOS: show hidden window or re-create when Dock icon is clicked
  const win = getMainWindow();
  if (win) {
    win.show();
    win.focus();
  } else if (BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0) {
    createWindow();
  }
});

let cleanupStarted = false;
let runtimeCleanupPromise: Promise<void> | null = null;
let isUpdating = false; // set by quitAndInstall to skip async cleanup

async function runShutdownTask(label: string, task: () => void | Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    console.warn(`[main] ${label} cleanup failed during shutdown:`, err);
  }
}

function cleanupRuntimeServices(): Promise<void> {
  if (runtimeCleanupPromise) return runtimeCleanupPromise;
  runtimeCleanupPromise = (async () => {
    await runShutdownTask('global shortcuts', () => globalShortcut.unregisterAll());
    await runShutdownTask('relay tunnel', () => {
      relayTunnel?.disconnect();
      relayTunnel = null;
    });
    await runShutdownTask('LAN server', () => {
      lanServer?.stop();
      lanServer = null;
    });

    const llamaStop = runShutdownTask('llama-server', async () => {
      const server = llamaServer || getLlamaServer();
      llamaServer = null;
      setLlamaServer(null);
      await server?.stop();
    });

    await runShutdownTask('task scheduler', () => {
      taskScheduler?.stop();
      taskScheduler = null;
    });
    await runShutdownTask('Feishu bot', () => stopFeishuBot());
    await runShutdownTask('channels', () => stopChannels());
    await Promise.all([
      llamaStop,
      runShutdownTask('plugins', () => stopPlugins()),
    ]);
  })();
  return runtimeCleanupPromise;
}

app.on('before-quit', (e) => {
  // Mark as quitting so window close handler allows actual close
  isQuitting = true;

  // The update install path runs cleanup before calling quitAndInstall.
  if (isUpdating) return;

  // Prevent default to allow async cleanup to complete before quitting
  e.preventDefault();
  // Guard against re-entrant calls (e.g. rapid Cmd+Q)
  if (cleanupStarted) return;
  cleanupStarted = true;

  // Await all async cleanup (with timeout), then quit for real
  const cleanupTimeout = setTimeout(() => {
    console.warn('[main] Cleanup timed out after 10s, force exiting');
    app.exit(0);
  }, 10_000);
  Promise.all([
    cleanupRuntimeServices(),
    cleanupIpc(),
  ]).finally(() => {
    clearTimeout(cleanupTimeout);
    app.exit(0);
  });
});
