import { ChildProcess, spawn } from 'child_process';
import path from 'path';

let app: { isPackaged: boolean } | undefined;
try {
  app = require('electron').app;
} catch {
  // Not in Electron environment (e.g., testing) — app remains undefined
}

export class PythonBridge {
  private pythonPath: string;
  private scriptsDir: string;
  private currentProc: ChildProcess | null = null;

  constructor(pythonDir?: string) {
    // 开发时用项目内的 python 目录，打包后用 resources 下的
    const defaultDir = app?.isPackaged
      ? path.join(process.resourcesPath!, 'python')
      : path.join(__dirname, '../../python');
    this.scriptsDir = pythonDir || defaultDir;

    // Priority: bundled standalone → venv → system
    this.pythonPath = this.findPython();
  }

  /** Check if using bundled standalone Python */
  get isBundled(): boolean {
    return this.pythonPath.includes('python-standalone');
  }

  /** Get the resolved Python executable path (for diagnostics) */
  get resolvedPythonPath(): string {
    return this.pythonPath;
  }

  /**
   * Find the best available Python executable.
   * Search order: bundled standalone → project venv → system Python
   */
  private findPython(): string {
    const fs = require('fs');
    const platform = process.platform;
    const arch = process.arch;

    // 1. Bundled standalone Python (from python-build-standalone)
    if (app?.isPackaged) {
      // Packaged app: python-standalone is in resources/
      const bundledBin = platform === 'win32'
        ? path.join(process.resourcesPath!, 'python-standalone', 'python', 'python.exe')
        : path.join(process.resourcesPath!, 'python-standalone', 'python', 'bin', 'python3');
      if (fs.existsSync(bundledBin)) return bundledBin;
    } else {
      // Dev mode: check resources directory with platform-arch subfolder
      const devBundledBin = platform === 'win32'
        ? path.join(__dirname, '../../resources/python-standalone', `${platform}-${arch}`, 'python', 'python.exe')
        : path.join(__dirname, '../../resources/python-standalone', `${platform}-${arch}`, 'python', 'bin', 'python3');
      if (fs.existsSync(devBundledBin)) return devBundledBin;
    }

    // 2. Project venv (existing behavior)
    const venvPython = platform === 'win32'
      ? path.join(this.scriptsDir, 'venv', 'Scripts', 'python.exe')
      : path.join(this.scriptsDir, 'venv', 'bin', 'python3');
    if (fs.existsSync(venvPython)) return venvPython;

    // 3. System Python (fallback)
    return this.getSystemPython();
  }

  /** 获取系统 Python (未建虚拟环境时的 fallback) */
  private getSystemPython(): string {
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  /** Suspend the currently running Python subprocess (SIGSTOP). macOS/Linux only. */
  suspendCurrent(): void {
    if (process.platform === 'win32') return;
    if (this.currentProc && !this.currentProc.killed) {
      try {
        this.currentProc.kill('SIGSTOP');
      } catch { /* process may have exited */ }
    }
  }

  /** Resume a suspended Python subprocess (SIGCONT). macOS/Linux only. */
  resumeCurrent(): void {
    if (process.platform === 'win32') return;
    if (this.currentProc && !this.currentProc.killed) {
      try {
        this.currentProc.kill('SIGCONT');
      } catch { /* process may have exited */ }
    }
  }

  /** 运行 Python 脚本，返回 JSON 解析后的结果 */
  run(scriptName: string, args: string[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptsDir, scriptName);
      const proc = spawn(this.pythonPath, [scriptPath, ...args]);
      this.currentProc = proc;
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (this.currentProc === proc) this.currentProc = null;
        if (code !== 0) {
          reject(new Error(`Python script failed (code ${code}): ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(stdout.trim());
        }
      });

      proc.on('error', (err: Error) => {
        if (this.currentProc === proc) this.currentProc = null;
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      });
    });
  }

  /** 运行长时间任务，逐行返回进度 */
  runWithProgress(
    scriptName: string,
    args: string[],
    onProgress: (data: any) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptsDir, scriptName);
      const proc = spawn(this.pythonPath, [scriptPath, ...args]);
      this.currentProc = proc;
      let lastLine = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        const lines = data
          .toString()
          .split('\n')
          .filter(Boolean);
        for (const line of lines) {
          lastLine = line;
          try {
            const parsed = JSON.parse(line);
            if (parsed._progress) onProgress(parsed);
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (this.currentProc === proc) this.currentProc = null;
        if (code !== 0) {
          reject(new Error(`Python script failed (code ${code}): ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(lastLine));
        } catch {
          resolve(lastLine);
        }
      });

      proc.on('error', (err) => {
        if (this.currentProc === proc) this.currentProc = null;
        reject(err);
      });
    });
  }

  /** 检查 Python 是否可用（bundled、venv 或 system） */
  isVenvReady(): boolean {
    const fs = require('fs');
    // If using system Python (fallback), we can't verify by file existence
    if (this.pythonPath === this.getSystemPython()) {
      return false;
    }
    return fs.existsSync(this.pythonPath);
  }
}
