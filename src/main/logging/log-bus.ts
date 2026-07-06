import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AppLogSource = 'main' | 'renderer';

export interface AppLogEntry {
  id: number;
  timestamp: string;
  level: AppLogLevel;
  source: AppLogSource;
  scope: string;
  message: string;
  details?: string;
}

export interface RendererLogInput {
  level?: AppLogLevel;
  scope?: string;
  message?: string;
  details?: unknown;
}

const DEFAULT_MAX_ENTRIES = 5000;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_DETAILS_LENGTH = 12000;
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...<truncated ${text.length - max} chars>` : text;
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key)) return '<redacted>';
  return value;
}

function sanitizeForJson(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value, MAX_MESSAGE_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (depth >= 4) return '[Object]';
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeForJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      output[key] = redactValue(key, sanitizeForJson(child, depth + 1));
    }
    return output;
  }
  return String(value);
}

export function stringifyLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(sanitizeForJson(arg));
  } catch {
    return String(arg);
  }
}

export function logsToText(entries: AppLogEntry[]): string {
  return entries.map((entry) => {
    const base = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}:${entry.scope}] ${entry.message}`;
    return entry.details ? `${base}\n${entry.details}` : base;
  }).join('\n');
}

export class AppLogStore {
  private entries: AppLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  append(input: Omit<AppLogEntry, 'id' | 'timestamp'> & { timestamp?: string }): AppLogEntry {
    const entry: AppLogEntry = {
      id: this.nextId++,
      timestamp: input.timestamp || new Date().toISOString(),
      level: input.level,
      source: input.source,
      scope: input.scope || 'app',
      message: truncate(input.message || '', MAX_MESSAGE_LENGTH),
      details: input.details ? truncate(input.details, MAX_DETAILS_LENGTH) : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return entry;
  }

  getEntries(): AppLogEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
  }
}

export const appLogStore = new AppLogStore();

let consoleInstalled = false;
let ipcRegistered = false;

function emitLogEntry(entry: AppLogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('logs:entry', entry);
    }
  }
}

export function appendAppLog(
  level: AppLogLevel,
  source: AppLogSource,
  scope: string,
  message: string,
  details?: unknown,
): AppLogEntry {
  const detailText = details === undefined ? undefined : stringifyLogArg(sanitizeForJson(details));
  const entry = appLogStore.append({
    level,
    source,
    scope,
    message,
    details: detailText,
  });
  emitLogEntry(entry);
  return entry;
}

function consoleLevel(method: 'debug' | 'info' | 'log' | 'warn' | 'error'): AppLogLevel {
  if (method === 'warn') return 'warn';
  if (method === 'error') return 'error';
  if (method === 'debug') return 'debug';
  return 'info';
}

export function installMainConsoleCapture(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const original = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  (['debug', 'info', 'log', 'warn', 'error'] as const).forEach((method) => {
    console[method] = (...args: unknown[]) => {
      original[method](...args);
      try {
        appendAppLog(
          consoleLevel(method),
          'main',
          'console',
          args.map(stringifyLogArg).join(' '),
        );
      } catch {
        // Logging must never break app behavior.
      }
    };
  });
}

export function captureRendererConsole(
  win: BrowserWindow,
  scope: string,
): void {
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Electron levels: 0 verbose, 1 info, 2 warning, 3 error.
    const mapped: AppLogLevel = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'info';
    appendAppLog(mapped, 'renderer', scope, message, {
      line,
      sourceId,
    });
  });
}

function normalizeRendererLog(input: RendererLogInput): Omit<AppLogEntry, 'id' | 'timestamp'> {
  const level = input.level && ['debug', 'info', 'warn', 'error'].includes(input.level)
    ? input.level
    : 'info';
  return {
    level,
    source: 'renderer',
    scope: input.scope?.trim() || 'ui',
    message: input.message?.trim() || '(empty renderer log)',
    details: input.details === undefined ? undefined : stringifyLogArg(sanitizeForJson(input.details)),
  };
}

function defaultLogFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `DeepSeno-logs-${stamp}.txt`;
}

export function registerLogIpcHandlers(openLogWindow: () => BrowserWindow): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('logs:openWindow', () => {
    const win = openLogWindow();
    appendAppLog('info', 'main', 'logs', 'Opened diagnostics log window');
    return { ok: true, id: win.id };
  });

  ipcMain.handle('logs:getEntries', () => {
    return appLogStore.getEntries();
  });

  ipcMain.handle('logs:appendRenderer', (_event, input: RendererLogInput) => {
    const normalized = normalizeRendererLog(input || {});
    const entry = appLogStore.append(normalized);
    emitLogEntry(entry);
    return { ok: true, id: entry.id };
  });

  ipcMain.handle('logs:clear', () => {
    appLogStore.clear();
    appendAppLog('info', 'main', 'logs', 'Cleared in-memory diagnostics log buffer');
    return { ok: true };
  });

  ipcMain.handle('logs:export', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow() || undefined;
    const options = {
      title: 'Export DeepSeno Logs',
      defaultPath: path.join(app.getPath('documents'), defaultLogFileName()),
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { canceled: true as const };
    }

    const entries = appLogStore.getEntries();
    const ext = path.extname(result.filePath).toLowerCase();
    const content = ext === '.json'
      ? JSON.stringify(entries, null, 2)
      : logsToText(entries);
    fs.writeFileSync(result.filePath, content, 'utf-8');
    appendAppLog('info', 'main', 'logs', 'Exported diagnostics logs', {
      filePath: result.filePath,
      count: entries.length,
    });
    return { canceled: false as const, filePath: result.filePath, count: entries.length };
  });
}
