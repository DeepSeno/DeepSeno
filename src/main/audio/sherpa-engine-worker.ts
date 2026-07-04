/**
 * sherpa-engine-worker.ts — Worker thread for sherpa-onnx inference.
 *
 * Runs in a dedicated Worker thread. Loads sherpa-onnx models based on
 * workerData.mode:
 *   - 'batch'    → full: Recognizer + VAD + Diarization + EmbeddingExtractor
 *   - 'realtime' → light: Recognizer + VAD only (saves ~25MB)
 *
 * Communicates with SherpaEngineProxy via postMessage / parentPort.
 */

import { parentPort, workerData } from 'worker_threads';
import { SherpaEngine } from './sherpa-engine';
import { SherpaModelManager } from './sherpa-model-manager';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerInitData,
  VadDetectResult,
  VadDrainSegment,
} from './sherpa-worker-types';

// ─── Initialization ─────────────────────────────────────────

const initData = workerData as WorkerInitData;
const modelManager = new SherpaModelManager(initData.modelsDir);
const engine = new SherpaEngine(modelManager);
const isBatch = initData.mode === 'batch';

// Apply language setting from init data
if (initData.language) {
  engine.setLanguage(initData.language);
}

// ─── VAD Constants (same as preprocessor.ts) ────────────────

const VAD_SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;

// Cap pending-audio fallback buffer to a rolling window so it cannot grow
// unbounded when VAD stays silent (or emits only empty/non-speech segments)
// for long stretches. 60s covers maxSpeechDuration(30s) + generous margin —
// beyond that, audio is too stale for SenseVoice (context ~30s) to transcribe.
const MAX_PENDING_SAMPLES = 60 * VAD_SAMPLE_RATE;

// ─── Realtime VAD sessions ──────────────────────────────────

let nextSessionId = 1;
const vadSessions = new Map<number, {
  vad: any;
  segmentIndex: number;
  /** Accumulated audio for fallback when vad.front() throws (external buffer issue). */
  pendingAudio: Float32Array[];
  pendingSampleCount: number;
  /** Total samples fed so far (for computing timestamps). */
  totalSamplesFed: number;
}>();

// ─── Helpers ────────────────────────────────────────────────

function sendResponse(res: WorkerResponse, transfer?: ArrayBuffer[]): void {
  if (transfer && transfer.length > 0) {
    parentPort!.postMessage(res, transfer);
  } else {
    parentPort!.postMessage(res);
  }
}

function sendSuccess(id: number, result: unknown, transfer?: ArrayBuffer[]): void {
  sendResponse({ id, success: true, result }, transfer);
}

function sendError(id: number, error: string): void {
  sendResponse({ id, success: false, error });
}

// ─── VAD full detection (batch) ─────────────────────────────
// NOTE: The batch VAD path now runs on the main thread (via SherpaEngineProxy)
// to avoid N-API external-buffer restrictions in Worker threads. The worker-side
// implementation here is kept as a fallback for any legacy callers that still
// route through `callBatch('vadDetectSegments', ...)`.

function vadDetectSegments(audioPath: string): Promise<VadDetectResult> {
  return engine.vadDetectSegments(audioPath);
}

// ─── Realtime VAD session helpers ───────────────────────────

/**
 * Trim pendingAudio chunks from the front until pendingSampleCount fits within
 * MAX_PENDING_SAMPLES. Keeps the newest audio (most useful for fallback).
 */
function trimPendingAudio(session: {
  pendingAudio: Float32Array[];
  pendingSampleCount: number;
}): void {
  while (session.pendingSampleCount > MAX_PENDING_SAMPLES && session.pendingAudio.length > 0) {
    const dropped = session.pendingAudio.shift()!;
    session.pendingSampleCount -= dropped.length;
  }
  if (session.pendingSampleCount < 0) session.pendingSampleCount = 0;
}

function clearPendingAudio(session: {
  pendingAudio: Float32Array[];
  pendingSampleCount: number;
}): void {
  session.pendingAudio = [];
  session.pendingSampleCount = 0;
}

function createVadSession(bufferSizeInSeconds: number, vadConfig?: {
  minSilenceDuration?: number;
  minSpeechDuration?: number;
  maxSpeechDuration?: number;
  threshold?: number;
}): number {
  const sessionId = nextSessionId++;
  const vad = engine.createVad(bufferSizeInSeconds, vadConfig);
  vadSessions.set(sessionId, { vad, segmentIndex: 0, pendingAudio: [], pendingSampleCount: 0, totalSamplesFed: 0 });
  return sessionId;
}

function vadFeedAndDrain(sessionId: number, samples: Float32Array): VadDrainSegment[] {
  const session = vadSessions.get(sessionId);
  if (!session) throw new Error(`VAD session ${sessionId} not found`);

  const { vad } = session;
  const results: VadDrainSegment[] = [];

  // Accumulate audio for fallback transcription (bounded rolling window)
  session.pendingAudio.push(new Float32Array(samples));
  session.pendingSampleCount += samples.length;
  trimPendingAudio(session);

  // Feed in windowSize chunks
  for (let i = 0; i + VAD_WINDOW_SIZE <= samples.length; i += VAD_WINDOW_SIZE) {
    const chunk = samples.subarray(i, i + VAD_WINDOW_SIZE);
    vad.acceptWaveform(chunk);
    session.totalSamplesFed += VAD_WINDOW_SIZE;

    // Drain detected segments
    while (!vad.isEmpty()) {
      let segSamples: Float32Array;
      let segStart: number;
      let usedFallback = false;
      try {
        // Pass `false` so sherpa-onnx returns a V8-owned Float32Array copy
        // instead of calling napi_create_external_arraybuffer (Electron's V8
        // rejects that with "External buffers are not allowed").
        const front = vad.front(false);
        segStart = Number(front.start);
        segSamples = front.samples;
      } catch {
        // Defensive fallback if a future Electron tightens buffer rules further.
        console.warn('[Worker] vad.front(false) failed in realtime, using pending audio fallback');
        usedFallback = true;
        try { vad.pop(); } catch { /* ignore */ }
        // Concatenate pending audio into a single buffer
        if (session.pendingSampleCount === 0) continue;
        segSamples = new Float32Array(session.pendingSampleCount);
        let offset = 0;
        for (const buf of session.pendingAudio) {
          segSamples.set(buf, offset);
          offset += buf.length;
        }
        segStart = Math.max(0, session.totalSamplesFed - session.pendingSampleCount);
        // Clear pending buffer after use
        clearPendingAudio(session);
      }
      // Only pop if we didn't already pop in catch
      if (!usedFallback) {
        try { vad.pop(); } catch { /* ignore */ }
      }

      if (segSamples.length === 0) {
        // VAD consumed audio but produced an empty segment — pending buffer is stale
        clearPendingAudio(session);
        continue;
      }

      // Transcribe detected speech
      const result = engine.transcribeSamples(segSamples, VAD_SAMPLE_RATE);
      const text = result.text.trim();

      // Filter non-speech events (Laughter, Music, Applause, etc.)
      if (result.event && result.event !== 'Speech') {
        console.log(`[Worker] Non-speech event filtered: event=${result.event}, text="${text.substring(0, 30)}"`);
        // VAD has already consumed this audio — drop pending to avoid unbounded growth
        clearPendingAudio(session);
        continue;
      }

      if (text) {
        if (result.lang || result.emotion || result.event) {
          console.log(`[Worker] Segment ${session.segmentIndex}: lang=${result.lang || '?'}, emotion=${result.emotion || '?'}, event=${result.event || '?'}`);
        }
        const startSec = segStart / VAD_SAMPLE_RATE;
        const durationSec = segSamples.length / VAD_SAMPLE_RATE;
        // Copy segment audio for speaker embedding extraction (transferred zero-copy)
        const samplesBuffer = segSamples.buffer.slice(
          segSamples.byteOffset,
          segSamples.byteOffset + segSamples.byteLength,
        ) as ArrayBuffer;
        results.push({
          index: session.segmentIndex++,
          start: startSec,
          end: startSec + durationSec,
          text,
          samplesBuffer,
        });
        // Clear pending buffer after successful transcription
        clearPendingAudio(session);
      } else {
        // VAD segment transcribed to empty text — drop pending (VAD already consumed it)
        clearPendingAudio(session);
      }
    }
  }

  return results;
}

function vadFlushAndDrain(sessionId: number): VadDrainSegment[] {
  const session = vadSessions.get(sessionId);
  if (!session) throw new Error(`VAD session ${sessionId} not found`);

  const { vad } = session;
  vad.flush();

  const results: VadDrainSegment[] = [];
  while (!vad.isEmpty()) {
    let segSamples: Float32Array;
    let segStart: number;
    let usedFallback = false;
    try {
      // Pass `false` so sherpa-onnx returns a V8-owned Float32Array copy
      // (see vadFeedAndDrain for the external-buffer rationale).
      const front = vad.front(false);
      segStart = Number(front.start);
      segSamples = front.samples;
    } catch {
      // Defensive fallback if a future Electron tightens buffer rules further.
      console.warn('[Worker] vad.front(false) failed in flush, using pending audio fallback');
      usedFallback = true;
      try { vad.pop(); } catch { /* ignore */ }
      if (session.pendingSampleCount === 0) continue;
      segSamples = new Float32Array(session.pendingSampleCount);
      let offset = 0;
      for (const buf of session.pendingAudio) {
        segSamples.set(buf, offset);
        offset += buf.length;
      }
      segStart = Math.max(0, session.totalSamplesFed - session.pendingSampleCount);
      clearPendingAudio(session);
    }
    if (!usedFallback) {
      try { vad.pop(); } catch { /* ignore */ }
    }

    if (segSamples.length === 0) {
      clearPendingAudio(session);
      continue;
    }

    const result = engine.transcribeSamples(segSamples, VAD_SAMPLE_RATE);
    const text = result.text.trim();

    // Filter non-speech events
    if (result.event && result.event !== 'Speech') {
      console.log(`[Worker:flush] Non-speech event filtered: event=${result.event}`);
      clearPendingAudio(session);
      continue;
    }

    if (text) {
      const startSec = segStart / VAD_SAMPLE_RATE;
      const durationSec = segSamples.length / VAD_SAMPLE_RATE;
      const samplesBuffer = segSamples.buffer.slice(
        segSamples.byteOffset,
        segSamples.byteOffset + segSamples.byteLength,
      ) as ArrayBuffer;
      results.push({
        index: session.segmentIndex++,
        start: startSec,
        end: startSec + durationSec,
        text,
        samplesBuffer,
      });
      clearPendingAudio(session);
    } else {
      clearPendingAudio(session);
    }
  }

  return results;
}

function vadDestroy(sessionId: number): void {
  vadSessions.delete(sessionId);
}

// ─── Message handler ────────────────────────────────────────

parentPort!.on('message', (msg: WorkerRequest) => {
  const { id, method, args } = msg;

  try {
    switch (method) {
      case 'transcribeAudio': {
        const result = engine.transcribeAudio(args.audioPath);
        sendSuccess(id, result);
        break;
      }

      case 'transcribeSamples': {
        const samples = new Float32Array(args.samplesBuffer);
        const result = engine.transcribeSamples(samples, args.sampleRate);
        sendSuccess(id, result);
        break;
      }

      case 'diarize': {
        if (!isBatch) {
          sendError(id, 'diarize is only available in batch mode');
          break;
        }
        const result = engine.diarize(args.audioPath);
        sendSuccess(id, result);
        break;
      }

      case 'vadDetectSegments': {
        vadDetectSegments(args.audioPath)
          .then(result => sendSuccess(id, result))
          .catch(err => sendError(id, err.message || String(err)));
        break;
      }

      case 'getDiarizationSampleRate': {
        if (!isBatch) {
          sendError(id, 'getDiarizationSampleRate is only available in batch mode');
          break;
        }
        const result = engine.getDiarizationSampleRate();
        sendSuccess(id, result);
        break;
      }

      case 'createVadSession': {
        const sessionId = createVadSession(args.bufferSizeInSeconds, args.vadConfig);
        sendSuccess(id, sessionId);
        break;
      }

      case 'vadFeedAndDrain': {
        const samples = new Float32Array(args.samplesBuffer);
        const segments = vadFeedAndDrain(args.sessionId, samples);
        // Transfer segment audio buffers zero-copy
        const transfer = segments
          .map(s => s.samplesBuffer)
          .filter((b): b is ArrayBuffer => !!b);
        sendSuccess(id, segments, transfer);
        break;
      }

      case 'vadFlushAndDrain': {
        const segments = vadFlushAndDrain(args.sessionId);
        const transfer = segments
          .map(s => s.samplesBuffer)
          .filter((b): b is ArrayBuffer => !!b);
        sendSuccess(id, segments, transfer);
        break;
      }

      case 'vadDestroy': {
        vadDestroy(args.sessionId);
        sendSuccess(id, null);
        break;
      }

      case 'setLanguage': {
        engine.setLanguage(args.language);
        sendSuccess(id, null);
        break;
      }

      case 'dispose': {
        // Cleanup all VAD sessions
        vadSessions.clear();
        engine.dispose();
        sendSuccess(id, null);
        break;
      }

      default:
        sendError(id, `Unknown method: ${method}`);
    }
  } catch (err: any) {
    sendError(id, err.message || String(err));
  }
});

// Signal to parent that worker is ready
parentPort!.postMessage({ type: 'ready' });
