import { describe, it, expect, vi } from 'vitest';
import os from 'os';

// Mock sherpa-onnx-node to avoid loading native addon in tests
vi.mock('sherpa-onnx-node', () => ({
  OfflineRecognizer: vi.fn(),
  Vad: vi.fn(),
  OfflineSpeakerDiarization: vi.fn(),
  SpeakerEmbeddingExtractor: vi.fn(),
  readWave: vi.fn(),
}));

import { StreamingTranscriber } from '../streaming-transcriber';
import { SherpaEngine } from '../sherpa-engine';
import { SherpaModelManager } from '../sherpa-model-manager';
import type { SherpaEngineProxy } from '../sherpa-engine-proxy';

describe('StreamingTranscriber', () => {
  const TMP_DIR = os.tmpdir().replace(/\\/g, '/');
  const engine = new SherpaEngine(new SherpaModelManager(`${TMP_DIR}/fake-models`)) as unknown as SherpaEngineProxy;

  it('should instantiate with SherpaEngine', () => {
    const st = new StreamingTranscriber(engine);
    expect(st).toBeDefined();
    expect(st).toBeInstanceOf(StreamingTranscriber);
  });

  it('should report isRunning() as false initially', () => {
    const st = new StreamingTranscriber(engine);
    expect(st.isRunning()).toBe(false);
  });

  it('should throw when feedAudio called before start', () => {
    const st = new StreamingTranscriber(engine);
    const pcm = Buffer.alloc(1024);
    expect(() => st.feedAudio(pcm)).toThrowError(
      'StreamingTranscriber is not running. Call start() first.',
    );
  });

  it('should have start, stop, and feedAudio methods', () => {
    const st = new StreamingTranscriber(engine);
    expect(typeof st.start).toBe('function');
    expect(typeof st.stop).toBe('function');
    expect(typeof st.feedAudio).toBe('function');
    expect(typeof st.isRunning).toBe('function');
  });

  it('should be an EventEmitter with on/emit/once methods', () => {
    const st = new StreamingTranscriber(engine);
    expect(typeof st.on).toBe('function');
    expect(typeof st.emit).toBe('function');
    expect(typeof st.once).toBe('function');
    expect(typeof st.removeListener).toBe('function');
  });
});
