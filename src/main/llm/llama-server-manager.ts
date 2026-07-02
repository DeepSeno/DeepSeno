import { spawn, execFile, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronApp = (() => {
  try { return require('electron').app; } catch { return null; }
})();

/** Port range to try for llama-server */
const PORT_START = 8080;
const PORT_END = 8100;

export interface LlamaServerStatus {
  running: boolean;
  port: number | null;
  pid: number | null;
  model: string | null;  // null in router mode
  mode: 'single' | 'router';
}

export class LlamaServerManager {
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private currentModel: string | null = null;
  private mode: 'single' | 'router' = 'single';

  private listChildPids(pid: number): Promise<number[]> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`,
          ],
          { windowsHide: true },
          (_err, stdout) => {
            resolve(stdout.split(/\s+/).map(Number).filter(Boolean));
          },
        );
        return;
      }

      execFile('pgrep', ['-P', String(pid)], (_err, stdout) => {
        resolve(stdout.split(/\s+/).map(Number).filter(Boolean));
      });
    });
  }

  private killProcess(pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'KILL') args.push('/F');
        execFile('taskkill', args, { windowsHide: true }, () => resolve());
        return;
      }

      try {
        process.kill(pid, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL');
      } catch {
        // Process already exited.
      }
      resolve();
    });
  }

  private async killProcessTree(pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    const children = await this.listChildPids(pid);
    await Promise.all(children.map((childPid) => this.killProcessTree(childPid, signal)));
    await this.killProcess(pid, signal);
  }

  private async killChildProcesses(pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    const children = await this.listChildPids(pid);
    await Promise.all(children.map((childPid) => this.killProcessTree(childPid, signal)));
  }

  // ─── Binary path resolution ──────────────────────────────────

  /** Get the directory where llama-server binaries are stored */
  private getResourcesDir(): string {
    if (electronApp?.isPackaged) {
      return path.join(process.resourcesPath, 'llama-server');
    }
    return path.join(__dirname, '..', '..', 'resources', 'llama-server');
  }

  /** Get the platform-specific binary name and path */
  private getBinaryPath(): string | null {
    const platform = process.platform;  // darwin | win32
    const arch = process.arch;         // arm64 | x64
    const resourcesDir = this.getResourcesDir();

    if (platform === 'darwin') {
      const dir = path.join(resourcesDir, `darwin-${arch}`);
      const bin = path.join(dir, 'llama-server');
      if (fs.existsSync(bin)) {
        // Set DYLD_LIBRARY_PATH so llama-server can find its .dylib files
        process.env.DYLD_LIBRARY_PATH = dir;
        return bin;
      }
      return null;
    }

    if (platform === 'win32' && arch === 'x64') {
      const dir = path.join(resourcesDir, 'win32-x64');

      // NVIDIA GPU → prefer CUDA
      if (this.hasNvidiaGpu()) {
        const cudaPath = path.join(dir, 'llama-server-cuda.exe');
        if (fs.existsSync(cudaPath)) return cudaPath;
      }

      // Fallback: Vulkan (works on AMD, Intel, and NVIDIA)
      const vulkanPath = path.join(dir, 'llama-server-vulkan.exe');
      if (fs.existsSync(vulkanPath)) return vulkanPath;

      // Last resort: CPU only
      const cpuPath = path.join(dir, 'llama-server-cpu.exe');
      if (fs.existsSync(cpuPath)) return cpuPath;

      return null;
    }

    return null;
  }

  // ─── GPU detection ───────────────────────────────────────────

  private hasNvidiaGpu(): boolean {
    // Best-effort NVIDIA detection on Windows
    // In production, check for nvidia-smi or dxgi output
    try {
      if (process.platform !== 'win32') return false;
      const result = require('child_process').execSync(
        'nvidia-smi --query-gpu=name --format=csv,noheader 2>nul',
        { timeout: 5000, windowsHide: true }
      ).toString().trim();
      return result.length > 0 && !result.includes('not found');
    } catch {
      return false;
    }
  }

  // ─── Port selection ──────────────────────────────────────────

  private async findFreePort(): Promise<number> {
    for (let port = PORT_START; port <= PORT_END; port++) {
      const free = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(true));
        });
      });
      if (free) return port;
    }
    throw new Error(`No free port found in range ${PORT_START}-${PORT_END}`);
  }

  // ─── Health check ────────────────────────────────────────────

  private async waitForReady(port: number, timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`llama-server did not become ready within ${timeoutMs}ms`);
  }

  // ─── Start / Stop ────────────────────────────────────────────

  async start(modelPath: string, options?: {
    contextSize?: number;
    gpuLayers?: number;
    flashAttn?: boolean;
  }): Promise<{ port: number }> {
    if (this.process) {
      await this.stop();
    }

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw new Error(
        `llama-server binary not found for ${process.platform}-${process.arch}. ` +
        'Run: bash scripts/bundle-llama-server.sh'
      );
    }

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`);
    }

    this.port = await this.findFreePort();
    this.currentModel = modelPath;

    const args: string[] = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-ngl', String(options?.gpuLayers ?? 99),
      '-c', String(options?.contextSize ?? 32768),
      '--embeddings',
    ];

    if (options?.flashAttn !== false) {
      args.push('-fa', 'on');
    }

    console.log(`[LlamaServer] Starting: ${binaryPath} ${args.join(' ')}`);

    this.process = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,       // No console window on Windows
      detached: false,         // Kill with parent
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[LlamaServer] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[LlamaServer:err] ${data.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      console.log(`[LlamaServer] Process exited with code ${code}`);
      if (this.process?.pid === (this.process as ChildProcess)?.pid) {
        this.process = null;
        this.port = null;
        this.currentModel = null;
      }
    });

    // Wait for server to be ready
    await this.waitForReady(this.port);

    console.log(`[LlamaServer] Ready on http://127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  /**
   * Start in router mode — serves multiple models from a directory.
   * Models are loaded on-demand per request via the `model` field.
   */
  async startRouter(modelsDir: string, options?: {
    maxModels?: number;
    flashAttn?: boolean;
    presetPath?: string;
  }): Promise<{ port: number }> {
    if (this.process) {
      await this.stop();
    }

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw new Error(
        `llama-server binary not found for ${process.platform}-${process.arch}. ` +
        'Run: bash scripts/bundle-llama-server.sh'
      );
    }

    if (!fs.existsSync(modelsDir)) {
      throw new Error(`Models directory not found: ${modelsDir}`);
    }

    this.port = await this.findFreePort();
    this.mode = 'router';
    this.currentModel = null;

    const args: string[] = [
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--models-dir', modelsDir,
      '--models-max', String(options?.maxModels ?? 2),
      '--embeddings',
    ];

    if (options?.presetPath && fs.existsSync(options.presetPath)) {
      args.push('--models-preset', options.presetPath);
    }

    if (options?.flashAttn !== false) {
      args.push('-fa', 'on');
    }

    console.log(`[LlamaServer] Starting router: ${binaryPath} ${args.join(' ')}`);

    this.process = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[LlamaServer] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[LlamaServer:err] ${data.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      console.log(`[LlamaServer] Process exited with code ${code}`);
      if (this.process?.pid === (this.process as ChildProcess)?.pid) {
        this.process = null;
        this.port = null;
        this.currentModel = null;
        this.mode = 'single';
      }
    });

    await this.waitForReady(this.port);

    console.log(`[LlamaServer] Router ready on http://127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    console.log('[LlamaServer] Stopping...');

    const proc = this.process;
    const pid = proc.pid;
    this.process = null;
    this.port = null;
    this.currentModel = null;

    // Stop direct child model workers before the router exits and they get
    // re-parented. This matters during auto-update because stale workers keep
    // binaries open inside the old .app bundle.
    if (pid) await this.killChildProcesses(pid, 'TERM');

    // Send SIGTERM, then force kill after 5s
    proc.kill('SIGTERM');
    const killed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pid) void this.killChildProcesses(pid, 'KILL');
        proc.kill('SIGKILL');
        resolve(false);
      }, 5000);
      proc.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    console.log(`[LlamaServer] Stopped (graceful=${killed})`);
  }

  // ─── Status ──────────────────────────────────────────────────

  getStatus(): LlamaServerStatus {
    return {
      running: this.process !== null && !this.process.killed,
      port: this.port,
      pid: this.process?.pid ?? null,
      model: this.currentModel,
      mode: this.mode,
    };
  }

  /** Get the base URL for API calls */
  getApiUrl(): string | null {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/v1`;
  }
}
