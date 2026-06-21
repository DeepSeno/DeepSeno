import { execFile, spawn, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { loadSettings } from '../settings';

const COMMAND_TIMEOUT = 120_000;

function getCliBin(): string {
  const cliBin = path.resolve(__dirname, '../../node_modules/@larksuite/cli/scripts/run.js');
  const unpackedBin = cliBin.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  return fs.existsSync(unpackedBin) ? unpackedBin : cliBin;
}

/**
 * Get the system Node.js binary path.
 * In Electron, process.execPath points to the Electron binary — we must NOT use it
 * to spawn CLI scripts, or Electron will launch new app windows instead of running Node.
 */
let _nodeBin: string | null = null;
function getNodeBin(): string {
  if (_nodeBin) return _nodeBin;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(cmd, ['node'], { encoding: 'utf8', timeout: 3000 }).trim().split(/\r?\n/)[0].trim();
    if (result) { _nodeBin = result; return result; }
  } catch {}
  _nodeBin = 'node'; // fall back to PATH lookup
  return _nodeBin;
}

export interface FeishuCliUser {
  open_id: string;
  name: string;
  avatar_url?: string;
  scopes: string[];
}

export interface FeishuCliStatus {
  ok: boolean;
  error: string | null;
  data: FeishuCliUser | null;
}

export interface CliStatus {
  installed: boolean;
  installPath: string | null;
  configured: boolean;
  loggedIn: boolean;
  user: FeishuCliUser | null;
  lastSyncAt: string | null;
}

function sanitizeLog(text: string): string {
  return text
    .replace(/(app_secret[=:]\s*"?)\S+("?)/gi, '$1***$2')
    .replace(/(open_id[=:]\s*"?)\S+("?)/gi, '$1***$2')
    .replace(/(email[=:]\s*"?)\S+("?)/gi, '$1***$2')
    .replace(/(token[=:]\s*"?)\S+("?)/gi, '$1***$2')
    .replace(/(access_token[=:]\s*"?)\S+("?)/gi, '$1***$2')
    .replace(/(refresh_token[=:]\s*"?)\S+("?)/gi, '$1***$2');
}

function runNpx(args: string[], timeout: number = COMMAND_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(getNodeBin(), [getCliBin(), ...args], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(sanitizeLog(stderr || error.message)));
        return;
      }
      resolve({ stdout: sanitizeLog(stdout), stderr: sanitizeLog(stderr) });
    });
  });
}

function runNpxStream(args: string[], onLine: (line: string) => void, timeout: number = 180_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(getNodeBin(), [getCliBin(), ...args], {
      timeout,
      env: { ...process.env, FORCE_COLOR: '0', NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) onLine(sanitizeLog(line));
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) onLine(sanitizeLog(`[stderr] ${line}`));
      }
    });

    child.on('close', (code) => {
      if (buffer.trim()) onLine(sanitizeLog(buffer));
      resolve(code || 0);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn npx: ${err.message}`));
    });
  });
}

export class FeishuCliService extends EventEmitter {
  private static instance: FeishuCliService | null = null;

  static getInstance(): FeishuCliService {
    if (!FeishuCliService.instance) {
      FeishuCliService.instance = new FeishuCliService();
    }
    return FeishuCliService.instance;
  }

  private constructor() {
    super();
  }

  async checkInstalled(): Promise<{ installed: boolean; path: string | null }> {
    try {
      const { stdout } = await runNpx(['--version'], 10_000);
      const version = stdout.trim();
      if (version) {
        return { installed: true, path: null };
      }
      return { installed: false, path: null };
    } catch {
      return { installed: false, path: null };
    }
  }

  async install(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { stdout, stderr } = await runNpx(['install']);
      this.emit('install:progress', { step: 'download', message: 'downloading CLI binary...' });

      const verified = await this.checkInstalled();
      if (verified.installed) {
        this.emit('install:complete', { version: stdout.trim() });
        return { ok: true };
      }

      return { ok: false, error: stderr || 'Install succeeded but version check failed' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async initConfig(): Promise<{ ok: boolean; url?: string; error?: string }> {
    return new Promise((resolve) => {
      let resolved = false;

      runNpxStream(['config', 'init', '--new'], (line) => {
        this.emit('config:output', line);
        if (!resolved) {
          const urlMatch = line.match(/https?:\/\/[^\s]+/);
          if (urlMatch) {
            resolved = true;
            resolve({ ok: true, url: urlMatch[0] });
          }
        }
      }).then(() => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: true });
        }
      }).catch((err) => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: err.message });
        }
      });
    });
  }

  async login(scopes?: string[]): Promise<{ ok: boolean; url?: string; deviceCode?: string; error?: string }> {
    const args = ['auth', 'login', '--recommend', '--no-wait', '--json'];
    if (scopes && scopes.length > 0) {
      args.push('--domain');
      args.push(scopes.join(','));
    }

    try {
      const { stdout } = await runNpx(args);
      const parsed = JSON.parse(stdout);
      // CLI returns fields at root level: { device_code, verification_url, ... }
      // Some versions wrap under parsed.data — support both.
      const payload = parsed.data ?? parsed;
      const verifyUrl = payload.verification_url || payload.url;
      const deviceCode = payload.device_code;
      if (verifyUrl || deviceCode) {
        return { ok: true, url: verifyUrl, deviceCode };
      }
      return { ok: false, error: parsed.error?.message || 'Login failed' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async pollLogin(_deviceCode: string, timeout: number = 120_000): Promise<{ ok: boolean; error?: string }> {
    // auth login --device-code is a blocking call — not suitable for polling.
    // Instead, poll auth status every 3s until user identity becomes ready.
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const { stdout } = await runNpx(['auth', 'status'], 10_000);
        const parsed = JSON.parse(stdout);
        const userIdentity = parsed?.identities?.user;
      // status='ready' 或 'needs_refresh'（token 过期但会自动刷新）都视为已登录
      const isLoggedIn = (userIdentity?.status === 'ready' || userIdentity?.status === 'needs_refresh')
        && userIdentity?.available === true;
      if (isLoggedIn) {
          return { ok: true };
        }
      } catch {
        // ignore transient errors, keep polling
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { ok: false, error: 'Login timeout' };
  }

  async getStatus(): Promise<FeishuCliStatus> {
    try {
      const { stdout } = await runNpx(['auth', 'status']);
      const parsed = JSON.parse(stdout);
      // auth status returns: { identities: { user: { status, available, openId, userName, scope, ... } } }
      const userIdentity = parsed?.identities?.user;
      // 'ready' 或 'needs_refresh'（token 将自动刷新）均视为已登录
      const isLoggedIn = (userIdentity?.status === 'ready' || userIdentity?.status === 'needs_refresh')
        && userIdentity?.available === true;
      if (isLoggedIn) {
        return {
          ok: true,
          error: null,
          data: {
            open_id: userIdentity.openId || '',
            name: userIdentity.userName || '',
            scopes: userIdentity.scope ? userIdentity.scope.split(' ') : [],
          },
        };
      }
      return { ok: false, error: userIdentity?.message || 'Not logged in', data: null };
    } catch (err: any) {
      return { ok: false, error: err.message, data: null };
    }
  }

  async logout(): Promise<{ ok: boolean; error?: string }> {
    try {
      await runNpx(['auth', 'logout']);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async getAgenda(startIso?: string, endIso?: string): Promise<string> {
    try {
      const args = ['calendar', '+agenda', '--format', 'json'];
      if (startIso) args.push('--start', startIso);
      if (endIso) args.push('--end', endIso);
      const { stdout } = await runNpx(args);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to get agenda: ${err.message}`);
    }
  }

  async getTasks(): Promise<string> {
    try {
      const { stdout } = await runNpx(['task', '+get-my-tasks', '--format', 'json']);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to get tasks: ${err.message}`);
    }
  }

  async getDriveDocs(): Promise<string> {
    try {
      // list recent docs from drive (no search:docs:read scope required)
      const { stdout } = await runNpx(['drive', 'files', 'list', '--format', 'json']);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to list drive docs: ${err.message}`);
    }
  }

  async fetchDoc(docUrl: string): Promise<string> {
    try {
      const { stdout } = await runNpx(['docs', '+fetch', '--api-version', 'v2', '--doc', docUrl, '--format', 'json']);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to fetch doc: ${err.message}`);
    }
  }

  async getImChats(): Promise<string> {
    try {
      const { stdout } = await runNpx(['im', '+chat-list', '--format', 'json', '--page-size', '20']);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to list chats: ${err.message}`);
    }
  }

  async getImMessages(chatId: string, startIso?: string): Promise<string> {
    try {
      const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--format', 'json',
        '--page-size', '50', '--sort', 'desc', '--no-reactions'];
      if (startIso) args.push('--start', startIso);
      const { stdout } = await runNpx(args, 30_000);
      return stdout;
    } catch (err: any) {
      throw new Error(`Failed to get messages for chat ${chatId}: ${err.message}`);
    }
  }

  async getFullStatus(): Promise<CliStatus> {
    const [installed, authStatus] = await Promise.all([
      this.checkInstalled(),
      this.getStatus(),
    ]);

    const settings = loadSettings();
    const configured = authStatus.ok || !String(authStatus.error || '').includes('not configured');

    return {
      installed: installed.installed,
      installPath: installed.path,
      configured,
      loggedIn: authStatus.ok,
      user: authStatus.data,
      lastSyncAt: (settings as any).feishuCliLastSyncAt || null,
    };
  }
}
