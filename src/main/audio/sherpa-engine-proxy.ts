/**
 * SherpaEngineProxy — Main-thread proxy for sherpa-onnx worker threads.
 *
 * Manages N batch workers (round-robin) + 1 dedicated realtime worker.
 * All methods are async; the actual inference runs in worker threads
 * so the main Electron thread stays responsive.
 */

import { Worker } from 'worker_threads';
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { SherpaModelManager } from './sherpa-model-manager';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerInitData,
  VadDetectResult,
  VadDrainSegment,
  VadConfigOverrides,
  SherpaTranscribeResult,
  SherpaDiarSegment,
} from './sherpa-worker-types';

// Re-export readWavPure from sherpa-engine for local use
import { SherpaEngine } from './sherpa-engine';

// ─── Types ──────────────────────────────────────────────────

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface QueuedCall {
  method: string;
  args: any;
  transfer?: ArrayBuffer[];
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface ManagedWorker {
  worker: Worker;
  pending: Map<number, PendingCall>;
  busy: boolean;
}

// ─── SherpaEngineProxy ──────────────────────────────────────

export class SherpaEngineProxy {
  private batchWorkers: ManagedWorker[] = [];
  private realtimeWorker: ManagedWorker | null = null;
  private idleQueue: ManagedWorker[] = [];
  private waitQueue: QueuedCall[] = [];
  private nextRequestId = 1;
  private modelManager: SherpaModelManager;
  private disposed = false;
  private localEngine: SherpaEngine; // for readWave (pure JS, no worker needed)
  private currentLanguage: string = 'auto';

  constructor(modelManager?: SherpaModelManager) {
    this.modelManager = modelManager || new SherpaModelManager();
    this.localEngine = new SherpaEngine(this.modelManager);
  }

  /** Get the sherpa models directory path. */
  getModelsDir(): string {
    return this.modelManager.getModelsDir();
  }

  /** Check if all required models are downloaded. */
  isReady(): boolean {
    return this.modelManager.areAllModelsReady();
  }

  /** Get the model manager instance. */
  getModelManager(): SherpaModelManager {
    return this.modelManager;
  }

  /**
   * Initialize the worker pool.
   * @param numBatchWorkers Number of batch workers (default 4)
   * @param language ASR language setting (default 'auto')
   */
  async init(numBatchWorkers = 4, language = 'auto'): Promise<void> {
    if (this.batchWorkers.length > 0 || this.realtimeWorker) {
      console.log('[SherpaProxy] Already initialized, skipping');
      return;
    }
    this.currentLanguage = language;
    const modelsDir = this.modelManager.getModelsDir();
    const workerScript = this.resolveWorkerScript();

    console.log(`[SherpaProxy] Initializing ${numBatchWorkers} batch workers + 1 realtime worker (language=${language})`);
    console.log(`[SherpaProxy] Worker script: ${workerScript}`);

    // Start all workers in parallel
    const batchPromises = Array.from({ length: numBatchWorkers }, (_, i) =>
      this.spawnWorker(workerScript, { mode: 'batch', modelsDir, language }, `batch-${i}`)
    );
    const realtimePromise = this.spawnWorker(
      workerScript,
      { mode: 'realtime', modelsDir, language },
      'realtime'
    );

    const results = await Promise.all([...batchPromises, realtimePromise]);

    // Last one is the realtime worker
    this.realtimeWorker = results[results.length - 1];
    this.batchWorkers = results.slice(0, -1);
    this.idleQueue = [...this.batchWorkers];

    console.log(`[SherpaProxy] All workers ready (${numBatchWorkers} batch + 1 realtime)`);
  }

  // ─── Batch API (routed to any idle batch worker) ──────────

  async transcribeAudio(audioPath: string): Promise<SherpaTranscribeResult> {
    return this.callBatch('transcribeAudio', { audioPath });
  }

  async transcribeSamples(samples: Float32Array, sampleRate = 16000): Promise<SherpaTranscribeResult> {
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );
    return this.callBatch('transcribeSamples', { samplesBuffer: buffer, sampleRate }, [buffer]);
  }

  /**
   * Parallel batch transcription — distributes files across workers.
   * Returns results in the same order as input paths.
   *
   * @param onEach Optional per-segment completion callback. Fires once per
   *   finished segment (not necessarily in path order) so callers can report
   *   progress to the UI during long jobs.
   */
  async transcribeAudioBatch(
    paths: string[],
    onEach?: () => void,
  ): Promise<SherpaTranscribeResult[]> {
    const promises = paths.map((audioPath) =>
      this.callBatch('transcribeAudio', { audioPath }).then((r) => {
        if (onEach) {
          try { onEach(); } catch { /* ignore callback errors */ }
        }
        return r;
      }),
    );
    return Promise.all(promises);
  }

  /**
   * Run speaker diarization in an isolated child process.
   * Native crashes (Eigen assertion failures) in the diarization model
   * will only kill the child process, not the main Electron process.
   */
  async diarize(audioPath: string, clusteringThreshold?: number): Promise<SherpaDiarSegment[]> {
    if (this.disposed) throw new Error('SherpaEngineProxy disposed');

    const modelsDir = this.modelManager.getModelsDir();
    const scriptPath = this.resolveDiarizeScript();
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max (chunked diarization for long audio)

    return new Promise<SherpaDiarSegment[]>((resolve, reject) => {
      const child = fork(scriptPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
      });

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`Diarization timed out after ${TIMEOUT_MS / 1000}s`));
        });
      }, TIMEOUT_MS);

      child.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          // Child is ready, send the diarize request
          child.send({ type: 'diarize', audioPath, modelsDir, clusteringThreshold });
        } else if (msg?.type === 'result') {
          settle(() => {
            child.kill();
            resolve(msg.segments || []);
          });
        } else if (msg?.type === 'progress') {
          console.log(`[SherpaProxy] Diarize chunk ${msg.chunk}/${msg.totalChunks} complete`);
        } else if (msg?.type === 'error') {
          settle(() => {
            child.kill();
            reject(new Error(msg.message || 'Diarization failed'));
          });
        }
      });

      child.on('error', (err) => {
        settle(() => reject(new Error(`Diarize subprocess error: ${err.message}`)));
      });

      child.on('exit', (code, signal) => {
        settle(() => {
          if (signal) {
            reject(new Error(`Diarize subprocess killed by signal ${signal} (native crash in sherpa-onnx)`));
          } else if (code !== 0) {
            reject(new Error(`Diarize subprocess exited with code ${code} (native crash in sherpa-onnx)`));
          } else {
            // Normal exit without result message — shouldn't happen, treat as error
            reject(new Error('Diarize subprocess exited without result'));
          }
        });
      });
    });
  }

  async vadDetectSegments(audioPath: string): Promise<VadDetectResult> {
    // Run on main thread via localEngine. Worker threads cannot safely access
    // sherpa-onnx-node's external ArrayBuffers (vad.front().samples), leading
    // to sporadic failures and lost segments. Main-thread access is reliable.
    // VAD is fast (~1-2% CPU of audio duration) so this does not block the UI.
    return this.localEngine.vadDetectSegments(audioPath);
  }

  async getDiarizationSampleRate(): Promise<number> {
    return this.callBatch('getDiarizationSampleRate', {});
  }

  // ─── Realtime API (routed to dedicated realtime worker) ───

  async createVadSession(bufferSizeInSeconds = 60, vadConfig?: VadConfigOverrides): Promise<number> {
    return this.callRealtime('createVadSession', { bufferSizeInSeconds, vadConfig });
  }

  async vadFeedAndDrain(sessionId: number, samples: Float32Array): Promise<VadDrainSegment[]> {
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );
    return this.callRealtime('vadFeedAndDrain', { sessionId, samplesBuffer: buffer }, [buffer]);
  }

  async vadFlushAndDrain(sessionId: number): Promise<VadDrainSegment[]> {
    return this.callRealtime('vadFlushAndDrain', { sessionId });
  }

  async vadDestroy(sessionId: number): Promise<void> {
    return this.callRealtime('vadDestroy', { sessionId });
  }

  /** Update ASR language on all workers (hot-reload, no restart needed). */
  async setLanguage(language: string): Promise<void> {
    this.currentLanguage = language;
    this.localEngine.setLanguage(language);
    const allWorkers = [...this.batchWorkers];
    if (this.realtimeWorker) allWorkers.push(this.realtimeWorker);
    await Promise.all(
      allWorkers.map((mw) => this.sendToWorker(mw, 'setLanguage', { language }, undefined, false))
    );
    console.log(`[SherpaProxy] Language updated to: ${language} (broadcast to ${allWorkers.length} workers)`);
  }

  // ─── Local (no worker) ────────────────────────────────────

  readWave(filePath: string): { samples: Float32Array; sampleRate: number } {
    return this.localEngine.readWave(filePath);
  }

  // ─── Cleanup ──────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Reject all queued calls
    for (const call of this.waitQueue) {
      call.reject(new Error('SherpaEngineProxy disposed'));
    }
    this.waitQueue = [];

    // Terminate all workers
    const allWorkers = [...this.batchWorkers];
    if (this.realtimeWorker) allWorkers.push(this.realtimeWorker);

    await Promise.all(
      allWorkers.map(async (mw) => {
        // Reject pending calls
        for (const [, pending] of mw.pending) {
          pending.reject(new Error('Worker terminated'));
        }
        mw.pending.clear();
        await mw.worker.terminate();
      })
    );

    this.batchWorkers = [];
    this.realtimeWorker = null;
    this.idleQueue = [];
    console.log('[SherpaProxy] Disposed');
  }

  // ─── Internal: worker lifecycle ───────────────────────────

  private resolveWorkerScript(): string {
    // In dev: electron-vite outputs to dist/main/
    // Worker entry is compiled alongside main entry
    const candidates = [
      path.join(__dirname, 'sherpa-engine-worker.js'),
      path.join(__dirname, '../main/sherpa-engine-worker.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // Fallback: assume same directory
    return path.join(__dirname, 'sherpa-engine-worker.js');
  }

  private resolveDiarizeScript(): string {
    const candidates = [
      path.join(__dirname, 'diarize-subprocess.js'),
      path.join(__dirname, '../main/diarize-subprocess.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return path.join(__dirname, 'diarize-subprocess.js');
  }

  private resolveEmbedScript(): string {
    const candidates = [
      path.join(__dirname, 'embed-subprocess.js'),
      path.join(__dirname, '../main/embed-subprocess.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return path.join(__dirname, 'embed-subprocess.js');
  }

  /**
   * Run embedding extraction in an isolated child process.
   * Same pattern as diarize() — native crashes only kill the child.
   */
  private callEmbedSubprocess(request: any): Promise<number[]> {
    const scriptPath = this.resolveEmbedScript();
    const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes max for embedding

    return new Promise<number[]>((resolve, reject) => {
      const child = fork(scriptPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
      });

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`Embedding extraction timed out after ${TIMEOUT_MS / 1000}s`));
        });
      }, TIMEOUT_MS);

      child.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          child.send(request);
        } else if (msg?.type === 'result') {
          settle(() => {
            child.send({ type: 'dispose' });
            resolve(msg.embedding || []);
          });
        } else if (msg?.type === 'error') {
          settle(() => {
            child.kill();
            reject(new Error(msg.message || 'Embedding extraction failed'));
          });
        }
      });

      child.on('error', (err) => {
        settle(() => reject(new Error(`Embed subprocess error: ${err.message}`)));
      });

      child.on('exit', (code, signal) => {
        settle(() => {
          if (signal) {
            reject(new Error(`Embed subprocess killed by signal ${signal} (native crash in sherpa-onnx)`));
          } else if (code !== 0) {
            reject(new Error(`Embed subprocess exited with code ${code} (native crash in sherpa-onnx)`));
          } else {
            // Normal exit after dispose — resolve already called, this is fine
            resolve([]);
          }
        });
      });
    });
  }

  private spawnWorker(
    scriptPath: string,
    initData: WorkerInitData,
    label: string
  ): Promise<ManagedWorker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(scriptPath, {
        workerData: initData,
      });

      const managed: ManagedWorker = {
        worker,
        pending: new Map(),
        busy: false,
      };

      // Wait for 'ready' signal
      const onMessage = (msg: any) => {
        if (msg?.type === 'ready') {
          worker.removeListener('message', onMessage);
          worker.removeListener('error', onError);

          // Set up permanent message handler
          worker.on('message', (response: WorkerResponse) => {
            this.handleWorkerResponse(managed, response);
          });

          // Handle worker crash
          worker.on('error', (err) => {
            console.error(`[SherpaProxy] Worker ${label} error:`, err);
            this.handleWorkerCrash(managed);
          });

          worker.on('exit', (code) => {
            if (code !== 0 && !this.disposed) {
              console.error(`[SherpaProxy] Worker ${label} exited with code ${code}`);
              this.handleWorkerCrash(managed);
            }
          });

          console.log(`[SherpaProxy] Worker ${label} ready`);
          resolve(managed);
        }
      };

      const onError = (err: Error) => {
        worker.removeListener('message', onMessage);
        reject(new Error(`Worker ${label} failed to start: ${err.message}`));
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
    });
  }

  private handleWorkerResponse(managed: ManagedWorker, response: WorkerResponse): void {
    const pending = managed.pending.get(response.id);
    if (!pending) return;
    managed.pending.delete(response.id);

    if (response.success) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  private handleWorkerCrash(managed: ManagedWorker): void {
    // Reject all pending calls
    for (const [, pending] of managed.pending) {
      pending.reject(new Error('Worker crashed'));
    }
    managed.pending.clear();

    // Remove from idle queue
    const idleIdx = this.idleQueue.indexOf(managed);
    if (idleIdx !== -1) this.idleQueue.splice(idleIdx, 1);

    // Remove from batch workers
    const batchIdx = this.batchWorkers.indexOf(managed);
    if (batchIdx !== -1) this.batchWorkers.splice(batchIdx, 1);

    if (managed === this.realtimeWorker) {
      this.realtimeWorker = null;
    }
  }

  // ─── Internal: RPC dispatch ───────────────────────────────

  private callBatch(method: string, args: any, transfer?: ArrayBuffer[]): Promise<any> {
    if (this.disposed) return Promise.reject(new Error('SherpaEngineProxy disposed'));
    if (this.batchWorkers.length === 0) return Promise.reject(new Error('Worker pool not initialized. Call init() first.'));

    // Try to get an idle worker
    const idle = this.idleQueue.shift();
    if (idle) {
      return this.sendToWorker(idle, method, args, transfer, true);
    }

    // No idle workers — queue the request
    return new Promise((resolve, reject) => {
      this.waitQueue.push({ method, args, transfer, resolve, reject });
    });
  }

  private callRealtime(method: string, args: any, transfer?: ArrayBuffer[]): Promise<any> {
    if (this.disposed) return Promise.reject(new Error('SherpaEngineProxy disposed'));
    if (!this.realtimeWorker) return Promise.reject(new Error('Realtime worker not available'));
    return this.sendToWorker(this.realtimeWorker, method, args, transfer, false);
  }

  private sendToWorker(
    managed: ManagedWorker,
    method: string,
    args: any,
    transfer?: ArrayBuffer[],
    isBatchWorker = false
  ): Promise<any> {
    const id = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      managed.pending.set(id, {
        resolve: (value) => {
          if (isBatchWorker) {
            managed.busy = false;
            this.returnToPool(managed);
          }
          resolve(value);
        },
        reject: (reason) => {
          if (isBatchWorker) {
            managed.busy = false;
            this.returnToPool(managed);
          }
          reject(reason);
        },
      });

      managed.busy = true;

      const request: WorkerRequest = { id, method, args } as WorkerRequest;

      if (transfer && transfer.length > 0) {
        managed.worker.postMessage(request, transfer);
      } else {
        managed.worker.postMessage(request);
      }
    });
  }

  private returnToPool(managed: ManagedWorker): void {
    // Check if there are queued calls waiting
    const next = this.waitQueue.shift();
    if (next) {
      this.sendToWorker(managed, next.method, next.args, next.transfer, true)
        .then(next.resolve)
        .catch(next.reject);
    } else {
      // Return to idle queue
      this.idleQueue.push(managed);
    }
  }
}
