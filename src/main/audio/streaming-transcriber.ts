import { EventEmitter } from 'events';
import type { SherpaEngineProxy } from './sherpa-engine-proxy';
import type { VadConfigOverrides } from './sherpa-worker-types';

/** A single transcription segment emitted during real-time streaming. */
export interface LiveSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Raw Float32 PCM samples for speaker embedding extraction. */
  samples?: Float32Array;
}

/** Summary returned when streaming stops. */
interface DoneSummary {
  total_segments: number;
  duration: number;
}

/**
 * StreamingTranscriber — real-time VAD + SenseVoice ASR via worker thread.
 *
 * Uses a dedicated realtime worker (via SherpaEngineProxy) for VAD and ASR.
 * The main thread only does int16→float32 conversion (trivial CPU cost).
 *
 * Events:
 *   'ready'   — Engine loaded and ready for audio
 *   'segment' — LiveSegment { index, start, end, text }
 *   'done'    — DoneSummary { total_segments, duration }
 *   'error'   — Error
 */
export class StreamingTranscriber extends EventEmitter {
  private engine: SherpaEngineProxy;
  private sessionId: number | null = null;
  private running = false;
  private segmentIndex = 0;
  private totalSamples = 0;
  private sampleRate = 16000;
  private windowSize = 512;
  /** Small buffer for accumulating audio until we have 512 samples for VAD window. */
  private pendingSamples = new Float32Array(0);
  /** In-flight feed promise — prevents overlapping feeds. */
  private feedPromise: Promise<void> | null = null;
  /** Optional VAD config overrides (e.g. shorter silence threshold for meetings). */
  private vadConfig?: VadConfigOverrides;

  constructor(engine: SherpaEngineProxy, _model: string = 'sensevoice', _hotwords: string[] = [], _language: string = 'zh') {
    super();
    this.engine = engine;
  }

  /** Set VAD config overrides before calling start(). */
  setVadConfig(config: VadConfigOverrides): void {
    this.vadConfig = config;
  }

  /** Returns true if the transcriber is running and ready for audio. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the streaming transcription session.
   * Creates a VAD session in the realtime worker.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('StreamingTranscriber is already running');
    }

    if (!this.engine.isReady()) {
      throw new Error('sherpa-onnx models are not downloaded. Please download models from Settings.');
    }

    // Create VAD session in the realtime worker (60-second buffer)
    this.sessionId = await this.engine.createVadSession(60, this.vadConfig);
    this.running = true;
    this.segmentIndex = 0;
    this.totalSamples = 0;
    this.pendingSamples = new Float32Array(0);
    this.feedPromise = null;

    this.emit('ready');
  }

  /**
   * Feed raw PCM audio data (16kHz, mono, int16 LE) to the transcriber.
   * Internally converts to Float32 and sends to the realtime worker.
   * When speech is detected, the worker runs ASR and returns segments.
   *
   * This method is fire-and-forget: it queues the audio and returns immediately.
   * Results arrive as 'segment' events.
   */
  feedAudio(pcmBuffer: Buffer): void {
    if (!this.running || this.sessionId === null) {
      throw new Error('StreamingTranscriber is not running. Call start() first.');
    }

    // Convert int16 LE PCM to Float32 samples (trivial, main thread)
    const int16 = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2
    );
    const newSamples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      newSamples[i] = int16[i] / 32768.0;
    }

    this.totalSamples += int16.length;

    // Combine with pending samples from previous calls
    const combined = new Float32Array(this.pendingSamples.length + newSamples.length);
    combined.set(this.pendingSamples);
    combined.set(newSamples, this.pendingSamples.length);

    // Accumulate at least windowSize samples before sending
    if (combined.length < this.windowSize) {
      this.pendingSamples = combined;
      return;
    }

    // Extract samples that are a multiple of windowSize
    const usable = Math.floor(combined.length / this.windowSize) * this.windowSize;
    const toSend = combined.subarray(0, usable);
    this.pendingSamples = usable < combined.length
      ? combined.slice(usable)
      : new Float32Array(0);

    // Fire-and-forget: send to worker, emit results asynchronously
    const sessionId = this.sessionId;
    const prevPromise = this.feedPromise;

    this.feedPromise = (async () => {
      // Wait for previous feed to complete (serialize feeds)
      if (prevPromise) {
        try { await prevPromise; } catch { /* ignore */ }
      }
      try {
        const segments = await this.engine.vadFeedAndDrain(sessionId, toSend);
        for (const seg of segments) {
          this.emit('segment', {
            index: seg.index,
            start: seg.start,
            end: seg.end,
            text: seg.text,
            samples: seg.samplesBuffer ? new Float32Array(seg.samplesBuffer) : undefined,
          } satisfies LiveSegment);
        }
        // Update our segmentIndex to match worker's
        if (segments.length > 0) {
          this.segmentIndex = segments[segments.length - 1].index + 1;
        }
      } catch (err) {
        this.emit('error', err);
      }
    })();
  }

  /**
   * Stop the transcription session.
   * Flushes remaining VAD buffer, transcribes any final segments.
   */
  async stop(_timeoutMs = 3000): Promise<DoneSummary> {
    if (!this.running || this.sessionId === null) {
      throw new Error('StreamingTranscriber is not running');
    }

    this.running = false;

    // Wait for any in-flight feed to complete
    if (this.feedPromise) {
      try { await this.feedPromise; } catch { /* ignore */ }
    }

    try {
      // Feed remaining pending samples (pad to windowSize)
      if (this.pendingSamples.length > 0) {
        const padded = new Float32Array(this.windowSize);
        padded.set(this.pendingSamples);
        const lastSegments = await this.engine.vadFeedAndDrain(this.sessionId, padded);
        for (const seg of lastSegments) {
          this.emit('segment', {
            index: seg.index,
            start: seg.start,
            end: seg.end,
            text: seg.text,
            samples: seg.samplesBuffer ? new Float32Array(seg.samplesBuffer) : undefined,
          } satisfies LiveSegment);
          this.segmentIndex = seg.index + 1;
        }
        this.pendingSamples = new Float32Array(0);
      }

      // Flush remaining audio in VAD
      const flushSegments = await this.engine.vadFlushAndDrain(this.sessionId);
      for (const seg of flushSegments) {
        this.emit('segment', {
          index: seg.index,
          start: seg.start,
          end: seg.end,
          text: seg.text,
          samples: seg.samplesBuffer ? new Float32Array(seg.samplesBuffer) : undefined,
        } satisfies LiveSegment);
        this.segmentIndex = seg.index + 1;
      }

      const duration = this.totalSamples / this.sampleRate;
      const summary: DoneSummary = {
        total_segments: this.segmentIndex,
        duration,
      };

      this.emit('done', summary);

      // Destroy the VAD session in the worker
      await this.engine.vadDestroy(this.sessionId);
      this.sessionId = null;

      return summary;
    } catch (err: any) {
      // Cleanup on error
      if (this.sessionId !== null) {
        try { await this.engine.vadDestroy(this.sessionId); } catch { /* ignore */ }
        this.sessionId = null;
      }
      throw err;
    }
  }

  /** Forcefully terminate regardless of state. */
  destroy(): void {
    this.running = false;
    if (this.sessionId !== null) {
      // Best-effort cleanup
      this.engine.vadDestroy(this.sessionId).catch(() => {});
      this.sessionId = null;
    }
    this.pendingSamples = new Float32Array(0);
  }
}
