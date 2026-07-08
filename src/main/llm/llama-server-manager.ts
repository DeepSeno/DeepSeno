import { spawn, execFile, execFileSync, ChildProcess } from 'child_process';
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
  backend: string | null;
}

export interface LlamaServerBackendCandidate {
  id: string;
  label: string;
  binaryPath: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
}

interface ResolveBackendCandidatesOptions {
  platform: NodeJS.Platform | string;
  arch: string;
  resourcesDir: string;
  hasNvidiaGpu?: boolean;
  exists?: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
  pathDelimiter?: string;
}

type LlamaServerLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface NvidiaGpuProbeResult {
  available: boolean;
  method: string;
  reason: string;
  durationMs: number;
  output?: string;
  error?: Record<string, unknown>;
}

interface LlamaServerBinaryProbe {
  id: string;
  label: string;
  binaryPath: string | null;
  workDir: string | null;
  exists: boolean;
  considered: boolean;
  includedInCandidateOrder: boolean;
  reason: string;
}

interface LaunchState {
  spawnError: Error | null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  output: string[];
}

interface LaunchedServer {
  proc: ChildProcess;
  state: LaunchState;
  candidate: LlamaServerBackendCandidate;
}

function mergePathEnv(env: NodeJS.ProcessEnv, dir: string, delimiter: string = path.delimiter): NodeJS.ProcessEnv {
  const next = { ...env };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || 'PATH';
  next[pathKey] = [dir, next[pathKey] || ''].filter(Boolean).join(delimiter);
  return next;
}

function mergeDyldEnv(env: NodeJS.ProcessEnv, dir: string, delimiter: string = path.delimiter): NodeJS.ProcessEnv {
  return {
    ...env,
    DYLD_LIBRARY_PATH: [dir, env.DYLD_LIBRARY_PATH || ''].filter(Boolean).join(delimiter),
  };
}

function truncateDiagnosticText(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}...<truncated ${text.length - max} chars>` : text;
}

function bufferLikeToString(value: unknown): string | undefined {
  if (!value) return undefined;
  if (Buffer.isBuffer(value)) return truncateDiagnosticText(value.toString().trim());
  if (typeof value === 'string') return truncateDiagnosticText(value.trim());
  return undefined;
}

function errorToDiagnostics(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const childError = err as Error & {
      code?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      name: err.name,
      message: err.message,
      code: childError.code,
      signal: childError.signal,
      stdout: bufferLikeToString(childError.stdout),
      stderr: bufferLikeToString(childError.stderr),
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function appendLlamaServerLog(level: LlamaServerLogLevel, message: string, details?: unknown): void {
  try {
    // Lazy require keeps pure unit tests from importing Electron logging plumbing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appendAppLog } = require('../logging/log-bus') as typeof import('../logging/log-bus');
    appendAppLog(level, 'main', 'llama-server', message, details);
  } catch {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
    if (details === undefined) {
      method(`[LlamaServer] ${message}`);
    } else {
      method(`[LlamaServer] ${message}`, details);
    }
  }
}

export function resolveLlamaServerBackendCandidates(
  options: ResolveBackendCandidatesOptions,
): LlamaServerBackendCandidate[] {
  const exists = options.exists || fs.existsSync;
  const env = options.env || process.env;
  const delimiter = options.pathDelimiter || path.delimiter;
  const candidates: LlamaServerBackendCandidate[] = [];

  if (options.platform === 'darwin') {
    const dir = path.join(options.resourcesDir, `darwin-${options.arch}`);
    const binaryPath = path.join(dir, 'llama-server');
    if (exists(binaryPath)) {
      candidates.push({
        id: 'darwin',
        label: `macOS ${options.arch}`,
        binaryPath,
        workDir: dir,
        env: mergeDyldEnv(env, dir, delimiter),
      });
    }
    return candidates;
  }

  if (options.platform !== 'win32' || options.arch !== 'x64') {
    return candidates;
  }

  const root = path.join(options.resourcesDir, 'win32-x64');
  const add = (id: string, label: string, dir: string, fileName = 'llama-server.exe') => {
    const binaryPath = path.join(dir, fileName);
    if (!exists(binaryPath)) return false;
    candidates.push({
      id,
      label,
      binaryPath,
      workDir: dir,
      env: mergePathEnv(env, dir, delimiter),
    });
    return true;
  };

  if (options.hasNvidiaGpu) {
    const addedCuda13 = add('cuda-13.3', 'CUDA 13.3', path.join(root, 'cuda-13.3'));
    const addedCuda12 = add('cuda-12.4', 'CUDA 12.4', path.join(root, 'cuda-12.4'));
    const addedModernCuda = addedCuda13 || addedCuda12;
    if (!addedModernCuda) {
      add('cuda', 'CUDA', root, 'llama-server-cuda.exe');
    }
  }

  if (!add('vulkan', 'Vulkan', path.join(root, 'vulkan'))) {
    add('vulkan', 'Vulkan', root, 'llama-server-vulkan.exe');
  }

  if (!add('cpu', 'CPU', path.join(root, 'cpu'))) {
    add('cpu', 'CPU', root, 'llama-server-cpu.exe');
  }

  return candidates;
}

export function prioritizeLlamaBackendCandidates(
  candidates: LlamaServerBackendCandidate[],
  preferredBackend?: string | null,
): LlamaServerBackendCandidate[] {
  if (!preferredBackend) return candidates;
  const index = candidates.findIndex((candidate) => candidate.id === preferredBackend);
  if (index <= 0) return candidates;
  return [
    candidates[index],
    ...candidates.slice(0, index),
    ...candidates.slice(index + 1),
  ];
}

export class LlamaServerManager {
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private currentModel: string | null = null;
  private mode: 'single' | 'router' = 'single';
  private backend: string | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();

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

  private getPreferredBackend(): string | null {
    try {
      // Lazy require keeps unit tests that only inspect path resolution simple.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadSettings } = require('../settings');
      return loadSettings().llamaServerBackend || null;
    } catch {
      return null;
    }
  }

  private persistPreferredBackend(backend: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { updateSettings } = require('../settings');
      updateSettings({ llamaServerBackend: backend });
      appendLlamaServerLog('info', 'Cached working llama-server backend', { backend });
    } catch (err) {
      // Persisting the optimization must never block inference.
      appendLlamaServerLog('warn', 'Failed to cache working llama-server backend', {
        backend,
        error: errorToDiagnostics(err),
      });
    }
  }

  private getBackendCandidates(): LlamaServerBackendCandidate[] {
    const resourcesDir = this.getResourcesDir();
    const preferredBackend = this.getPreferredBackend();
    const nvidia = this.detectNvidiaGpu();
    const candidates = resolveLlamaServerBackendCandidates({
      platform: process.platform,
      arch: process.arch,
      resourcesDir,
      hasNvidiaGpu: nvidia.available,
    });
    const prioritized = prioritizeLlamaBackendCandidates(candidates, preferredBackend);
    const selectedPaths = new Set(prioritized.map((candidate) => path.normalize(candidate.binaryPath)));
    const probes = this.buildBinaryProbes(resourcesDir, nvidia.available).map((probe) => ({
      ...probe,
      includedInCandidateOrder: probe.binaryPath ? selectedPaths.has(path.normalize(probe.binaryPath)) : false,
    }));

    appendLlamaServerLog(
      prioritized.length > 0 ? 'info' : 'error',
      'llama-server startup diagnostics report',
      {
        platform: process.platform,
        arch: process.arch,
        packaged: Boolean(electronApp?.isPackaged),
        resourcesDir,
        preferredBackend: preferredBackend || null,
        nvidia,
        probes,
        candidateOrder: prioritized.map((candidate, index) => ({
          order: index + 1,
          id: candidate.id,
          label: candidate.label,
          binaryPath: candidate.binaryPath,
          workDir: candidate.workDir,
          cachedPreferred: preferredBackend === candidate.id,
        })),
      },
    );

    return prioritized;
  }

  // ─── GPU detection ───────────────────────────────────────────

  private detectNvidiaGpu(): NvidiaGpuProbeResult {
    const startedAt = Date.now();
    if (process.platform !== 'win32') {
      return {
        available: false,
        method: 'nvidia-smi',
        reason: 'CUDA backends are only considered on Windows builds.',
        durationMs: Date.now() - startedAt,
      };
    }
    if (process.arch !== 'x64') {
      return {
        available: false,
        method: 'nvidia-smi',
        reason: `CUDA backends are only bundled for win32-x64; current arch is ${process.arch}.`,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const output = execFileSync(
        'nvidia-smi',
        ['--query-gpu=name', '--format=csv,noheader'],
        { timeout: 5000, windowsHide: true, encoding: 'utf8' },
      ).trim();
      const available = output.length > 0 && !/not found/i.test(output);
      return {
        available,
        method: 'nvidia-smi',
        reason: available
          ? 'NVIDIA GPU detected; CUDA backends will be considered.'
          : 'nvidia-smi returned no GPU names; CUDA backends will be skipped.',
        durationMs: Date.now() - startedAt,
        output: truncateDiagnosticText(output),
      };
    } catch (err) {
      return {
        available: false,
        method: 'nvidia-smi',
        reason: 'nvidia-smi failed or is not installed; CUDA backends will be skipped.',
        durationMs: Date.now() - startedAt,
        error: errorToDiagnostics(err),
      };
    }
  }

  private buildBinaryProbes(resourcesDir: string, hasNvidiaGpu: boolean): LlamaServerBinaryProbe[] {
    const probe = (
      id: string,
      label: string,
      binaryPath: string,
      considered: boolean,
      reason: string,
    ): LlamaServerBinaryProbe => ({
      id,
      label,
      binaryPath,
      workDir: path.dirname(binaryPath),
      exists: fs.existsSync(binaryPath),
      considered,
      includedInCandidateOrder: false,
      reason,
    });

    if (process.platform === 'darwin') {
      const binaryPath = path.join(resourcesDir, `darwin-${process.arch}`, 'llama-server');
      return [
        probe(
          'darwin',
          `macOS ${process.arch}`,
          binaryPath,
          true,
          fs.existsSync(binaryPath) ? 'macOS backend binary is available.' : 'macOS backend binary is missing.',
        ),
      ];
    }

    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return [
        {
          id: 'unsupported',
          label: `${process.platform}-${process.arch}`,
          binaryPath: null,
          workDir: null,
          exists: false,
          considered: false,
          includedInCandidateOrder: false,
          reason: 'No bundled llama-server backend is available for this platform.',
        },
      ];
    }

    const root = path.join(resourcesDir, 'win32-x64');
    const cudaReason = hasNvidiaGpu
      ? 'NVIDIA GPU detected; CUDA backend is considered.'
      : 'NVIDIA GPU was not detected; CUDA backend is skipped.';
    return [
      probe('cuda-13.3', 'CUDA 13.3', path.join(root, 'cuda-13.3', 'llama-server.exe'), hasNvidiaGpu, cudaReason),
      probe('cuda-12.4', 'CUDA 12.4', path.join(root, 'cuda-12.4', 'llama-server.exe'), hasNvidiaGpu, cudaReason),
      probe('cuda', 'CUDA legacy', path.join(root, 'llama-server-cuda.exe'), hasNvidiaGpu, cudaReason),
      probe('vulkan', 'Vulkan', path.join(root, 'vulkan', 'llama-server.exe'), true, 'Vulkan backend is considered as GPU fallback.'),
      probe('vulkan', 'Vulkan legacy', path.join(root, 'llama-server-vulkan.exe'), true, 'Legacy Vulkan backend is considered as compatibility fallback.'),
      probe('cpu', 'CPU', path.join(root, 'cpu', 'llama-server.exe'), true, 'CPU backend is considered as final fallback.'),
      probe('cpu', 'CPU legacy', path.join(root, 'llama-server-cpu.exe'), true, 'Legacy CPU backend is considered as final compatibility fallback.'),
    ];
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
      if (free) {
        appendLlamaServerLog('debug', 'Selected free llama-server port', {
          port,
          range: `${PORT_START}-${PORT_END}`,
        });
        return port;
      }
    }
    appendLlamaServerLog('error', 'No free llama-server port available', {
      range: `${PORT_START}-${PORT_END}`,
    });
    throw new Error(`No free port found in range ${PORT_START}-${PORT_END}`);
  }

  // ─── Health check ────────────────────────────────────────────

  private formatLaunchOutput(launch: LaunchedServer): string {
    const output = launch.state.output.join('\n').trim();
    if (!output) return '';
    const truncated = output.length > 5000 ? output.slice(-5000) : output;
    return `\nRecent llama-server output (${launch.candidate.label}):\n${truncated}`;
  }

  private describeLaunchFailure(launch: LaunchedServer, reason: string): Error {
    return new Error(`${reason}${this.formatLaunchOutput(launch)}`);
  }

  private async waitForReady(launch: LaunchedServer, port: number, timeoutMs = 60000): Promise<void> {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (launch.state.spawnError) {
        throw this.describeLaunchFailure(
          launch,
          `llama-server ${launch.candidate.label} failed to start: ${launch.state.spawnError.message}`,
        );
      }
      if (launch.state.exitInfo) {
        const { code, signal } = launch.state.exitInfo;
        throw this.describeLaunchFailure(
          launch,
          `llama-server ${launch.candidate.label} exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        );
      }

      attempts += 1;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          console.log(`[LlamaServer] health ready port=${port} attempts=${attempts} elapsedMs=${Date.now() - startedAt}`);
          appendLlamaServerLog('info', 'llama-server health check passed', {
            backend: launch.candidate.id,
            label: launch.candidate.label,
            port,
            attempts,
            elapsedMs: Date.now() - startedAt,
          });
          return;
        }
        if (attempts === 1 || attempts % 10 === 0) {
          console.log(`[LlamaServer] health pending port=${port} attempt=${attempts} status=${res.status} elapsedMs=${Date.now() - startedAt}`);
          appendLlamaServerLog('debug', 'llama-server health check pending', {
            backend: launch.candidate.id,
            label: launch.candidate.label,
            port,
            attempt: attempts,
            status: res.status,
            elapsedMs: Date.now() - startedAt,
          });
        }
      } catch (err: any) {
        if (attempts === 1 || attempts % 10 === 0) {
          console.log(`[LlamaServer] health pending port=${port} attempt=${attempts} error=${err?.message || String(err)} elapsedMs=${Date.now() - startedAt}`);
          appendLlamaServerLog('debug', 'llama-server health check pending', {
            backend: launch.candidate.id,
            label: launch.candidate.label,
            port,
            attempt: attempts,
            error: err?.message || String(err),
            elapsedMs: Date.now() - startedAt,
          });
        }
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error(`[LlamaServer] health failed port=${port} attempts=${attempts} timeoutMs=${timeoutMs}`);
    appendLlamaServerLog('error', 'llama-server health check timed out', {
      backend: launch.candidate.id,
      label: launch.candidate.label,
      port,
      attempts,
      timeoutMs,
      recentOutput: launch.state.output.slice(-20),
    });
    throw this.describeLaunchFailure(
      launch,
      `llama-server ${launch.candidate.label} did not become ready within ${timeoutMs}ms`,
    );
  }

  // ─── Start / Stop ────────────────────────────────────────────

  private enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private launchProcess(candidate: LlamaServerBackendCandidate, args: string[]): LaunchedServer {
    const state: LaunchState = {
      spawnError: null,
      exitInfo: null,
      output: [],
    };

    console.log(`[LlamaServer] Starting (${candidate.label}): ${candidate.binaryPath} ${args.join(' ')}`);

    const proc = spawn(candidate.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      cwd: candidate.workDir,
      env: candidate.env,
    });

    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      state.output.push(`[${stream}] ${text}`);
      if (state.output.length > 80) state.output.splice(0, state.output.length - 80);
      if (stream === 'stdout') {
        console.log(`[LlamaServer] ${text}`);
      } else {
        console.error(`[LlamaServer:err] ${text}`);
      }
    };

    proc.stdout?.on('data', (data: Buffer) => appendOutput('stdout', data));
    proc.stderr?.on('data', (data: Buffer) => appendOutput('stderr', data));

    appendLlamaServerLog('info', 'Spawned llama-server process', {
      backend: candidate.id,
      label: candidate.label,
      pid: proc.pid ?? null,
      binaryPath: candidate.binaryPath,
      workDir: candidate.workDir,
      args,
    });

    proc.once('error', (err) => {
      state.spawnError = err;
      console.error(`[LlamaServer] Process error (${candidate.label}):`, err);
      appendLlamaServerLog('error', 'llama-server process error', {
        backend: candidate.id,
        label: candidate.label,
        binaryPath: candidate.binaryPath,
        error: errorToDiagnostics(err),
      });
    });

    proc.once('exit', (code, signal) => {
      state.exitInfo = { code, signal };
      console.log(`[LlamaServer] Process exited (${candidate.label}) with code ${code}, signal ${signal ?? 'none'}`);
      appendLlamaServerLog(code === 0 ? 'info' : 'warn', 'llama-server process exited', {
        backend: candidate.id,
        label: candidate.label,
        pid: proc.pid ?? null,
        code,
        signal: signal ?? null,
        recentOutput: state.output.slice(-20),
      });
      if (this.process === proc) {
        this.process = null;
        this.port = null;
        this.currentModel = null;
        this.mode = 'single';
        this.backend = null;
      }
    });

    return { proc, state, candidate };
  }

  private async stopInternal(): Promise<void> {
    if (!this.process) return;
    console.log('[LlamaServer] Stopping...');

    const proc = this.process;
    const pid = proc.pid;
    appendLlamaServerLog('info', 'Stopping llama-server process', {
      pid: pid ?? null,
      port: this.port,
      mode: this.mode,
      backend: this.backend,
      model: this.currentModel,
    });
    this.process = null;
    this.port = null;
    this.currentModel = null;
    this.backend = null;

    // Stop direct child model workers before the router exits and they get
    // re-parented. This matters during auto-update because stale workers keep
    // binaries open inside the old .app bundle.
    if (pid) await this.killChildProcesses(pid, 'TERM');

    proc.kill('SIGTERM');
    const killed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pid) void this.killChildProcesses(pid, 'KILL');
        proc.kill('SIGKILL');
        resolve(false);
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    console.log(`[LlamaServer] Stopped (graceful=${killed})`);
    appendLlamaServerLog('info', 'Stopped llama-server process', {
      pid: pid ?? null,
      graceful: killed,
    });
  }

  private getNoBinaryError(): Error {
    return new Error(
      `llama-server binary not found for ${process.platform}-${process.arch}. ` +
      'Run: bash scripts/bundle-llama-server.sh'
    );
  }

  private async startWithFallback(
    buildArgs: (port: number) => string[],
    mode: 'single' | 'router',
    model: string | null,
    describeAttempt: (candidate: LlamaServerBackendCandidate, port: number) => void,
  ): Promise<{ port: number }> {
    await this.stopInternal();

    const startedAt = Date.now();
    const candidates = this.getBackendCandidates();
    if (candidates.length === 0) {
      const err = this.getNoBinaryError();
      appendLlamaServerLog('error', 'Cannot start llama-server because no backend binary is usable', {
        mode,
        model,
        error: errorToDiagnostics(err),
      });
      throw err;
    }

    appendLlamaServerLog('info', 'llama-server backend attempt order', {
      mode,
      model,
      total: candidates.length,
      candidates: candidates.map((candidate, index) => ({
        order: index + 1,
        id: candidate.id,
        label: candidate.label,
        binaryPath: candidate.binaryPath,
        workDir: candidate.workDir,
      })),
    });

    const failures: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      let port: number | null = null;
      let launch: LaunchedServer | null = null;
      try {
        port = await this.findFreePort();
        this.port = port;
        this.mode = mode;
        this.currentModel = model;
        this.backend = candidate.id;
        appendLlamaServerLog('info', 'llama-server backend attempt starting', {
          attempt: index + 1,
          total: candidates.length,
          mode,
          model,
          backend: candidate.id,
          label: candidate.label,
          port,
          binaryPath: candidate.binaryPath,
          workDir: candidate.workDir,
        });
        describeAttempt(candidate, port);

        launch = this.launchProcess(candidate, buildArgs(port));
        this.process = launch.proc;

        await this.waitForReady(launch, port);
        this.persistPreferredBackend(candidate.id);
        console.log(`[LlamaServer] Ready on http://127.0.0.1:${port} via ${candidate.label}`);
        appendLlamaServerLog('info', 'llama-server backend attempt ready', {
          attempt: index + 1,
          total: candidates.length,
          mode,
          model,
          backend: candidate.id,
          label: candidate.label,
          port,
          pid: launch.proc.pid ?? null,
          elapsedMs: Date.now() - startedAt,
        });
        return { port };
      } catch (err: any) {
        const message = err?.message || String(err);
        failures.push(`${candidate.label}: ${message}`);
        console.warn(`[LlamaServer] ${candidate.label} failed, trying next backend if available: ${message}`);
        appendLlamaServerLog('warn', 'llama-server backend attempt failed', {
          attempt: index + 1,
          total: candidates.length,
          mode,
          model,
          backend: candidate.id,
          label: candidate.label,
          port,
          error: errorToDiagnostics(err),
          recentOutput: launch?.state.output.slice(-20) ?? [],
          willTryNextBackend: index < candidates.length - 1,
        });
        await this.stopInternal();
      }
    }

    const err = new Error(`llama-server failed to start with every backend:\n${failures.join('\n\n')}`);
    appendLlamaServerLog('error', 'llama-server startup failed with every backend', {
      mode,
      model,
      elapsedMs: Date.now() - startedAt,
      failures,
      error: errorToDiagnostics(err),
    });
    throw err;
  }

  async start(modelPath: string, options?: {
    contextSize?: number;
    gpuLayers?: number;
    flashAttn?: boolean;
  }): Promise<{ port: number }> {
    return this.enqueueLifecycle(async () => {
      if (!fs.existsSync(modelPath)) {
        appendLlamaServerLog('error', 'Cannot start llama-server because model file is missing', {
          modelPath,
        });
        throw new Error(`Model file not found: ${modelPath}`);
      }

      return this.startWithFallback(
        (port) => {
          const args: string[] = [
            '-m', modelPath,
            '--host', '127.0.0.1',
            '--port', String(port),
            '-ngl', String(options?.gpuLayers ?? 99),
            '-c', String(options?.contextSize ?? 32768),
            '--embeddings',
          ];
          if (options?.flashAttn !== false) {
            args.push('-fa', 'on');
          }
          return args;
        },
        'single',
        modelPath,
        (candidate, port) => {
          console.log(`[LlamaServer] Single launch plan: backend=${candidate.label} port=${port} model=${modelPath}`);
        },
      );
    });
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
    return this.enqueueLifecycle(async () => {
      if (!fs.existsSync(modelsDir)) {
        appendLlamaServerLog('error', 'Cannot start llama-server router because models directory is missing', {
          modelsDir,
        });
        throw new Error(`Models directory not found: ${modelsDir}`);
      }

      return this.startWithFallback(
        (port) => {
          const args: string[] = [
            '--host', '127.0.0.1',
            '--port', String(port),
            '--models-dir', modelsDir,
            '--models-max', String(options?.maxModels ?? 2),
          ];

          if (options?.presetPath && fs.existsSync(options.presetPath)) {
            args.push('--models-preset', options.presetPath);
          }

          if (options?.flashAttn !== false) {
            args.push('-fa', 'on');
          }

          return args;
        },
        'router',
        null,
        (candidate, port) => {
          console.log(`[LlamaServer] Router launch plan: backend=${candidate.label} port=${port} modelsDir=${modelsDir} maxModels=${options?.maxModels ?? 2} flashAttn=${options?.flashAttn !== false} presetPath=${options?.presetPath || '(none)'}`);
        },
      );
    });
  }

  async stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  // ─── Status ──────────────────────────────────────────────────

  getStatus(): LlamaServerStatus {
    return {
      running: this.process !== null && !this.process.killed,
      port: this.port,
      pid: this.process?.pid ?? null,
      model: this.currentModel,
      mode: this.mode,
      backend: this.backend,
    };
  }

  /** Get the base URL for API calls */
  getApiUrl(): string | null {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/v1`;
  }
}
