import type { SherpaEngineProxy } from './sherpa-engine-proxy';

export interface TranscribeResult {
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
  full_text: string;
}

export class Transcriber {
  private engine: SherpaEngineProxy;

  constructor(engine: SherpaEngineProxy) {
    this.engine = engine;
  }

  /** No-op: sherpa-onnx runs in-process, no subprocess to suspend. */
  suspend(): void { /* no-op */ }

  /** No-op: sherpa-onnx runs in-process, no subprocess to resume. */
  resume(): void { /* no-op */ }

  async transcribe(audioPath: string, _model = 'sensevoice', _hotwords?: string[], language = 'zh'): Promise<TranscribeResult> {
    if (!this.engine.isReady()) {
      throw new Error('Transcription failed: sherpa-onnx models are not downloaded. Please download models from Settings → Data.');
    }
    const result = await this.engine.transcribeAudio(audioPath);
    const fullText = result.text || '';

    // SenseVoice returns full text; build a single-segment result.
    // Timestamps from sherpa-onnx may be token-level (no per-segment text)
    // or may be missing entirely — always use a single segment with the full text.
    const segments = [{ start: 0, end: 0, text: fullText }];

    return {
      language,
      segments,
      full_text: fullText,
    };
  }
}
