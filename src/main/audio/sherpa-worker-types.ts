// ─── Worker Thread Message Types for sherpa-onnx inference ──────────────

import type { SherpaTranscribeResult, SherpaDiarSegment } from './sherpa-engine';

// ─── Request types ──────────────────────────────────────────

export interface WorkerRequestBase {
  id: number;
  method: string;
}

export interface TranscribeAudioRequest extends WorkerRequestBase {
  method: 'transcribeAudio';
  args: { audioPath: string };
}

export interface TranscribeSamplesRequest extends WorkerRequestBase {
  method: 'transcribeSamples';
  args: { samplesBuffer: ArrayBuffer; sampleRate: number };
}

export interface DiarizeRequest extends WorkerRequestBase {
  method: 'diarize';
  args: { audioPath: string };
}

export interface VadDetectSegmentsRequest extends WorkerRequestBase {
  method: 'vadDetectSegments';
  args: { audioPath: string };
}

export interface GetDiarizationSampleRateRequest extends WorkerRequestBase {
  method: 'getDiarizationSampleRate';
  args: Record<string, never>;
}

/** Optional overrides for Silero VAD parameters. */
export interface VadConfigOverrides {
  minSilenceDuration?: number;
  minSpeechDuration?: number;
  maxSpeechDuration?: number;
  threshold?: number;
}

export interface CreateVadSessionRequest extends WorkerRequestBase {
  method: 'createVadSession';
  args: { bufferSizeInSeconds: number; vadConfig?: VadConfigOverrides };
}

export interface VadFeedAndDrainRequest extends WorkerRequestBase {
  method: 'vadFeedAndDrain';
  args: { sessionId: number; samplesBuffer: ArrayBuffer };
}

export interface VadFlushAndDrainRequest extends WorkerRequestBase {
  method: 'vadFlushAndDrain';
  args: { sessionId: number };
}

export interface VadDestroyRequest extends WorkerRequestBase {
  method: 'vadDestroy';
  args: { sessionId: number };
}

export interface DisposeRequest extends WorkerRequestBase {
  method: 'dispose';
  args: Record<string, never>;
}

export type WorkerRequest =
  | TranscribeAudioRequest
  | TranscribeSamplesRequest
  | DiarizeRequest
  | VadDetectSegmentsRequest
  | GetDiarizationSampleRateRequest
  | CreateVadSessionRequest
  | VadFeedAndDrainRequest
  | VadFlushAndDrainRequest
  | VadDestroyRequest
  | DisposeRequest;

// ─── Response types ─────────────────────────────────────────

export interface WorkerResponseBase {
  id: number;
}

export interface WorkerSuccessResponse extends WorkerResponseBase {
  success: true;
  result: unknown;
  transfer?: ArrayBuffer[];
}

export interface WorkerErrorResponse extends WorkerResponseBase {
  success: false;
  error: string;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

// ─── VAD result types ───────────────────────────────────────

export interface VadSegmentResult {
  start: number;
  end: number;
  duration: number;
}

export interface VadDetectResult {
  segments: VadSegmentResult[];
  total_speech_seconds: number;
}

/** Transcription result with segment index from VAD drain. */
export interface VadDrainSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Raw Float32 PCM samples for speaker embedding extraction (optional, zero-copy transfer). */
  samplesBuffer?: ArrayBuffer;
}

// ─── Worker initialization data ─────────────────────────────

export interface WorkerInitData {
  mode: 'batch' | 'realtime';
  modelsDir: string;
  /** SenseVoice ASR language: 'auto', 'zh', 'en', 'ja', 'ko', 'yue' */
  language?: string;
}

// Re-export for convenience
export type { SherpaTranscribeResult, SherpaDiarSegment };
