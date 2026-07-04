import fs from 'fs';
import { SherpaModelManager } from './sherpa-model-manager';
import { patchModulePathsForPackagedBuild } from './patch-module-paths';
import type { VadDetectResult } from './sherpa-worker-types';

// ─── VAD detection constants (shared between main-thread and worker calls) ───
const VAD_SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const VAD_MIN_SEGMENT_DURATION = 1.0;
const VAD_MAX_GAP_TO_MERGE = 1.5;
const VAD_MAX_SEGMENT_DURATION = 45.0;

// Lazy-import sherpa-onnx-node to avoid crash if native addon not available
let sherpa_onnx: any = null;
function getSherpa(): any {
  if (!sherpa_onnx) {
    patchModulePathsForPackagedBuild();
    sherpa_onnx = require('sherpa-onnx-node');
  }
  return sherpa_onnx;
}

/**
 * Read a WAV file using pure JS (avoids native addon's external buffer issue).
 * Supports 16-bit PCM WAV files. Returns Float32Array samples normalized to [-1, 1].
 */
function readWavPure(filePath: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(filePath);

  // Validate RIFF header
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a valid WAV file: ${filePath}`);
  }

  // Find fmt chunk
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let numChannels = 1;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    // Align to 2-byte boundary
    if (chunkSize % 2 !== 0) offset++;
  }

  if (dataOffset === 0 || dataSize === 0) {
    throw new Error(`No data chunk found in WAV file: ${filePath}`);
  }

  // Read PCM samples
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample * numChannels;
    if (sampleOffset + bytesPerSample > buf.length) break;

    if (bitsPerSample === 16) {
      // Average channels if stereo
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readInt16LE(sampleOffset + ch * bytesPerSample);
      }
      samples[i] = (sum / numChannels) / 32768.0;
    } else if (bitsPerSample === 32) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readFloatLE(sampleOffset + ch * bytesPerSample * numChannels);
      }
      samples[i] = sum / numChannels;
    }
  }

  return { samples, sampleRate };
}

// ─── Types ──────────────────────────────────────────────────

export interface SherpaTranscribeResult {
  text: string;
  timestamps?: { start: number; end: number; text: string }[];
  /** Detected language (from SenseVoice tag, e.g. 'zh', 'en', 'ja') */
  lang?: string;
  /** Detected emotion (from SenseVoice tag, e.g. 'HAPPY', 'SAD', 'NEUTRAL') */
  emotion?: string;
  /** Detected event (from SenseVoice tag, e.g. 'Speech', 'Laughter', 'Music') */
  event?: string;
}

export interface SherpaVadSegment {
  start: number;
  samples: Float32Array;
}

export interface SherpaDiarSegment {
  start: number;
  end: number;
  speaker: number;
}

/**
 * Parse SenseVoice output tags like <|zh|><|NEUTRAL|><|Speech|><|woitn|>
 * and extract metadata (lang, emotion, event) while cleaning the text.
 */
function parseSenseVoiceResult(result: any): SherpaTranscribeResult {
  const rawText: string = result.text || '';
  let lang: string | undefined;
  let emotion: string | undefined;
  let event: string | undefined;

  // SenseVoice tags pattern: <|tag|>
  const tagRegex = /<\|([^|]+)\|>/g;
  let cleaned = rawText;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(rawText)) !== null) {
    const tag = match[1];
    // Language tags
    if (['zh', 'en', 'ja', 'ko', 'yue', 'auto'].includes(tag)) {
      lang = tag;
    }
    // Emotion tags
    else if (['NEUTRAL', 'HAPPY', 'SAD', 'ANGRY', 'FEARFUL', 'DISGUSTED', 'SURPRISED'].includes(tag)) {
      emotion = tag;
    }
    // Event tags
    else if (['Speech', 'Laughter', 'Music', 'Applause', 'BGM', 'Noise'].includes(tag)) {
      event = tag;
    }
  }

  // Remove all SenseVoice tags from text
  cleaned = cleaned.replace(/<\|[^|]+\|>/g, '').trim();

  return {
    text: cleaned,
    timestamps: result.timestamps,
    lang,
    emotion,
    event,
  };
}

// ─── SherpaEngine ───────────────────────────────────────────

export class SherpaEngine {
  private modelManager: SherpaModelManager;
  private recognizer: any = null;
  private speakerDiarization: any = null;
  private language: string = 'auto';

  constructor(modelManager?: SherpaModelManager) {
    this.modelManager = modelManager || new SherpaModelManager();
  }

  /** Set the ASR language. Rebuilds recognizer on next use if changed. */
  setLanguage(lang: string): void {
    if (lang !== this.language) {
      this.language = lang;
      // Force re-creation of recognizer with new language setting
      this.recognizer = null;
      console.log(`[SherpaEngine] Language updated to: ${lang}`);
    }
  }

  /** Check if all required models are downloaded. */
  isReady(): boolean {
    return this.modelManager.areAllModelsReady();
  }

  /** Get the model manager instance. */
  getModelManager(): SherpaModelManager {
    return this.modelManager;
  }

  /** Initialize recognizer (lazy, called on first use). */
  private getRecognizer(): any {
    if (!this.recognizer) {
      const sherpa = getSherpa();
      const mm = this.modelManager;
      const config = {
        featConfig: {
          sampleRate: 16000,
          featureDim: 80,
        },
        modelConfig: {
          senseVoice: {
            model: mm.getModelPath('sensevoice', 'model.int8.onnx'),
            useInverseTextNormalization: 1,
            language: this.language || 'auto',
          },
          tokens: mm.getModelPath('sensevoice', 'tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
      };
      this.recognizer = new sherpa.OfflineRecognizer(config);
      console.log(`[SherpaEngine] OfflineRecognizer initialized (language=${this.language})`);
    }
    return this.recognizer;
  }

  /** Resolve the actual segmentation model path, falling back to old model if new one missing. */
  private resolveSegmentationModel(): string {
    const mm = this.modelManager;
    const newModel = mm.getModelPath('pyannote-segmentation', 'model.int8.onnx');
    if (fs.existsSync(newModel)) return newModel;
    // Fallback: old pyannote-segmentation-3.0 model
    const oldModel = mm.getModelPath('pyannote-segmentation', 'model.onnx');
    if (fs.existsSync(oldModel)) {
      console.warn('[SherpaEngine] model.int8.onnx not found, falling back to model.onnx');
      return oldModel;
    }
    throw new Error('Segmentation model not found: neither model.int8.onnx nor model.onnx exist. Please download models first.');
  }

  /** Resolve the actual embedding model path, falling back to base if large missing. */
  private resolveEmbeddingModel(): string {
    const mm = this.modelManager;
    const newModel = mm.getModelPath('3dspeaker', '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(newModel)) return newModel;
    // Fallback: old eres2net base model
    const oldModel = mm.getModelPath('3dspeaker', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(oldModel)) {
      console.warn('[SherpaEngine] eres2net_large not found, falling back to eres2net_base');
      return oldModel;
    }
    throw new Error('Speaker embedding model not found. Please download models first.');
  }

  /** Initialize speaker diarization (lazy). */
  private getSpeakerDiarization(): any {
    if (!this.speakerDiarization) {
      const sherpa = getSherpa();
      const config = {
        segmentation: {
          pyannote: {
            model: this.resolveSegmentationModel(),
          },
        },
        embedding: {
          model: this.resolveEmbeddingModel(),
        },
        clustering: {
          numClusters: -1, // auto-detect number of speakers
          threshold: 0.45,
        },
        minDurationOn: 0.2,
        minDurationOff: 0.5,
      };
      this.speakerDiarization = new sherpa.OfflineSpeakerDiarization(config);
      console.log('[SherpaEngine] OfflineSpeakerDiarization initialized');
    }
    return this.speakerDiarization;
  }

  /** Read a WAV file. Uses pure JS parser to avoid native addon external buffer issues. */
  readWave(filePath: string): { samples: Float32Array; sampleRate: number } {
    return readWavPure(filePath);
  }

  /**
   * Transcribe a WAV audio file.
   * Returns the full recognized text.
   */
  transcribeAudio(audioPath: string): SherpaTranscribeResult {
    const recognizer = this.getRecognizer();

    const wave = this.readWave(audioPath);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);

    return parseSenseVoiceResult(result);
  }

  /**
   * Transcribe raw PCM samples (Float32Array, 16kHz mono).
   */
  transcribeSamples(samples: Float32Array, sampleRate: number = 16000): SherpaTranscribeResult {
    const recognizer = this.getRecognizer();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: Float32Array.from(samples) });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);

    return parseSenseVoiceResult(result);
  }

  /**
   * Create a VAD instance for processing audio.
   * Returns the Vad object with acceptWaveform/isDetected/front/pop methods.
   */
  createVad(bufferSizeInSeconds: number = 60, vadOverrides?: {
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    maxSpeechDuration?: number;
    threshold?: number;
  }): any {
    const sherpa = getSherpa();
    const mm = this.modelManager;
    const config = {
      sileroVad: {
        model: mm.getModelPath('silero-vad', 'silero_vad.onnx'),
        threshold: vadOverrides?.threshold ?? 0.5,
        minSpeechDuration: vadOverrides?.minSpeechDuration ?? 0.25,
        minSilenceDuration: vadOverrides?.minSilenceDuration ?? 0.5,
        maxSpeechDuration: vadOverrides?.maxSpeechDuration ?? 30,
        windowSize: 512,
      },
      sampleRate: 16000,
      debug: false,
      numThreads: 1,
    };
    return new sherpa.Vad(config, bufferSizeInSeconds);
  }

  /**
   * Run offline VAD on a WAV file and return merged/capped speech segments.
   *
   * Pass `false` to `vad.front()` so sherpa-onnx copies samples into a V8-owned
   * Float32Array instead of calling `napi_create_external_arraybuffer`. Electron's
   * V8 rejects external buffer creation with `External buffers are not allowed`
   * once enough are alive (long recordings → many VAD segments), regardless of
   * thread. We only need `.length` and `.start` from each segment, so the copy
   * cost is negligible and the call is now crash-free.
   */
  async vadDetectSegments(audioPath: string): Promise<VadDetectResult> {
    const wave = this.readWave(audioPath);
    // Copy samples into fresh V8-allocated memory
    const samples = new Float32Array(wave.samples.length);
    samples.set(wave.samples);

    const vad = this.createVad(Math.ceil(samples.length / wave.sampleRate) + 10);

    // Feed audio to VAD, yielding to the event loop every ~5s of audio so the
    // Electron main thread stays responsive during long-file processing.
    const YIELD_INTERVAL_SAMPLES = 5 * VAD_SAMPLE_RATE;
    let samplesSinceYield = 0;
    for (let i = 0; i + VAD_WINDOW_SIZE <= samples.length; i += VAD_WINDOW_SIZE) {
      const chunk = samples.subarray(i, i + VAD_WINDOW_SIZE);
      vad.acceptWaveform(chunk);
      samplesSinceYield += VAD_WINDOW_SIZE;
      if (samplesSinceYield >= YIELD_INTERVAL_SAMPLES) {
        samplesSinceYield = 0;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    vad.flush();

    const rawSegments: { start: number; end: number }[] = [];
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      const startSec = Number(segment.start) / VAD_SAMPLE_RATE;
      const durationSec = segment.samples.length / VAD_SAMPLE_RATE;
      rawSegments.push({ start: startSec, end: startSec + durationSec });
      vad.pop();
    }

    if (rawSegments.length === 0) {
      console.warn('[SherpaEngine] VAD produced no segments, using full audio as single segment');
      const totalDuration = samples.length / wave.sampleRate;
      rawSegments.push({ start: 0, end: totalDuration });
    }

    // Merge adjacent segments
    const merged: { start: number; end: number }[] = [];
    for (const seg of rawSegments) {
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        if (seg.start - last.end < VAD_MAX_GAP_TO_MERGE) {
          last.end = seg.end;
          continue;
        }
      }
      merged.push({ ...seg });
    }

    // Split oversized segments using original VAD boundaries when possible
    const capped: { start: number; end: number }[] = [];
    for (const seg of merged) {
      const dur = seg.end - seg.start;
      if (dur <= VAD_MAX_SEGMENT_DURATION) {
        capped.push(seg);
      } else {
        const innerBoundaries = rawSegments
          .filter(rs => rs.start >= seg.start && rs.end <= seg.end)
          .map(rs => rs.start)
          .filter(b => b > seg.start);

        if (innerBoundaries.length > 0) {
          let cursor = seg.start;
          for (const boundary of innerBoundaries) {
            if (boundary - cursor >= VAD_MAX_SEGMENT_DURATION) {
              capped.push({ start: cursor, end: boundary });
              cursor = boundary;
            }
          }
          capped.push({ start: cursor, end: seg.end });
        } else {
          let cursor = seg.start;
          while (cursor < seg.end) {
            const chunkEnd = Math.min(cursor + VAD_MAX_SEGMENT_DURATION, seg.end);
            capped.push({ start: cursor, end: chunkEnd });
            cursor = chunkEnd;
          }
        }
      }
    }

    const segments = capped
      .filter(s => s.end - s.start >= VAD_MIN_SEGMENT_DURATION)
      .map(s => ({ start: s.start, end: s.end, duration: s.end - s.start }));

    const total_speech_seconds = segments.reduce((sum, s) => sum + s.duration, 0);
    return { segments, total_speech_seconds };
  }

  /**
   * Run speaker diarization on a WAV file.
   * Returns array of segments with speaker labels.
   */
  diarize(audioPath: string): SherpaDiarSegment[] {
    const sd = this.getSpeakerDiarization();
    const wave = this.readWave(audioPath);

    if (sd.sampleRate !== wave.sampleRate) {
      throw new Error(
        `Sample rate mismatch: model expects ${sd.sampleRate}, got ${wave.sampleRate}`
      );
    }

    const segments = sd.process(wave.samples);
    return segments.map((seg: any) => ({
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker,
    }));
  }

  /** Get the sample rate expected by the diarization model. */
  getDiarizationSampleRate(): number {
    return this.getSpeakerDiarization().sampleRate;
  }

  /**
   * Release references to sherpa-onnx native handles.
   * sherpa-onnx-node relies on napi finalizers (no explicit free API), so
   * dropping JS references is the only available path — native memory is
   * reclaimed on the next GC cycle.
   */
  dispose(): void {
    this.recognizer = null;
    this.speakerDiarization = null;
    if (typeof global.gc === 'function') global.gc();
  }
}
