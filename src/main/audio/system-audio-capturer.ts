import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { EventEmitter } from 'events';
import { PythonBridge } from '../python-bridge';

let app: { isPackaged: boolean } | undefined;
try {
  app = require('electron').app;
} catch {
  // Not in Electron environment (e.g., testing) — app remains undefined
}

export interface SystemAudioDevice {
  id: number;
  name: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
}

export interface SystemAudioCaptureOptions {
  outputPath: string;
  deviceId?: number; // specific device, or default input
  sampleRate?: number; // default 16000
  channels?: number; // default 1 (mono)
}

/**
 * SystemAudioCapturer — captures system audio (e.g., from Zoom, Teams, WeChat)
 * on macOS using a Python script backed by sounddevice.
 *
 * Requires a virtual audio device (e.g., BlackHole) to route system audio
 * to an input device that sounddevice can record from.
 *
 * Events:
 *   'started'  — capture process launched
 *   'recording' — Python confirmed it is recording { status, device, sampleRate }
 *   'progress' — periodic duration update { duration }
 *   'stopped'  — capture finished { code, totalDuration?, outputPath? }
 *   'error'    — error during capture
 */
export class SystemAudioCapturer extends EventEmitter {
  private bridge: PythonBridge;
  private process: ChildProcess | null = null;
  private _isCapturing = false;

  // Resolved paths for spawning long-running process (same pattern as StreamingTranscriber)
  private scriptsDir: string;
  private pythonExePath: string;

  constructor(pythonDir?: string) {
    super();
    this.bridge = new PythonBridge(pythonDir);

    // Resolve scripts directory — same pattern as PythonBridge/StreamingTranscriber
    const defaultDir = app?.isPackaged
      ? path.join(process.resourcesPath!, 'python')
      : path.join(__dirname, '../../python');
    this.scriptsDir = pythonDir || defaultDir;

    // Use PythonBridge's resolved path (handles bundled/venv/system fallback)
    this.pythonExePath = this.bridge.resolvedPythonPath;
  }

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  /**
   * List available audio input devices.
   * Uses PythonBridge.run() for a one-shot JSON result.
   */
  async listDevices(): Promise<SystemAudioDevice[]> {
    return this.bridge.run('system_audio_capture.py', ['--list-devices']);
  }

  /**
   * Start capturing system audio to a WAV file.
   * The Python process runs until stop() is called.
   */
  async start(options: SystemAudioCaptureOptions): Promise<void> {
    if (this._isCapturing) {
      throw new Error('Already capturing system audio');
    }

    // Ensure output directory exists
    const outputDir = path.dirname(options.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const args = [
      '--output',
      options.outputPath,
      '--sample-rate',
      String(options.sampleRate || 16000),
      '--channels',
      String(options.channels || 1),
    ];
    if (options.deviceId !== undefined) {
      args.push('--device', String(options.deviceId));
    }

    const scriptPath = path.join(this.scriptsDir, 'system_audio_capture.py');
    const pythonExe = fs.existsSync(this.pythonExePath)
      ? this.pythonExePath
      : process.platform === 'win32'
        ? 'python'
        : 'python3';

    this.process = spawn(pythonExe, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._isCapturing = true;
    this.emit('started');

    // Parse stdout JSON lines for status/progress events
    if (this.process.stdout) {
      const rl = readline.createInterface({ input: this.process.stdout });

      rl.on('line', (line: string) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Non-JSON line — ignore
          return;
        }

        if (parsed.error) {
          this.emit('error', new Error(parsed.error as string));
        } else if (parsed.status === 'recording') {
          this.emit('recording', parsed);
        } else if (parsed.status === 'stopped') {
          this.emit('stopped', {
            code: 0,
            totalDuration: parsed.totalDuration as number,
            outputPath: parsed.outputPath as string,
          });
        } else if (parsed.duration) {
          this.emit('progress', parsed);
        }
      });
    }

    // Forward stderr for debug logging
    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.warn('[SystemAudioCapturer:stderr]', msg);
        }
      });
    }

    this.process.on('close', (code) => {
      this._isCapturing = false;
      this.process = null;
      // Only emit 'stopped' from close if we haven't already emitted from JSON
      this.emit('stopped', { code });
    });

    this.process.on('error', (err) => {
      this._isCapturing = false;
      this.process = null;
      this.emit('error', err);
    });
  }

  /**
   * Stop capturing. Sends SIGTERM for graceful shutdown, allowing the
   * Python script to finalize the WAV file properly.
   */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * Forcefully kill the capture process regardless of state.
   * The WAV file may be truncated/corrupted.
   */
  destroy(): void {
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Process may already be dead
      }
      this._isCapturing = false;
      this.process = null;
    }
  }
}
