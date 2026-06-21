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

import { AudioPreprocessor } from '../preprocessor';
import { Transcriber } from '../transcriber';
import { Diarizer } from '../diarizer';
import { SherpaEngine } from '../sherpa-engine';
import { SherpaModelManager } from '../sherpa-model-manager';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

describe('Audio module instantiation and interface', () => {
  const engine = new SherpaEngine(new SherpaModelManager(`${TMP_DIR}/fake-models`));

  it('AudioPreprocessor can be instantiated and has expected methods', () => {
    const preprocessor = new AudioPreprocessor(engine);
    expect(preprocessor).toBeDefined();
    expect(typeof preprocessor.convertTo16kMono).toBe('function');
    expect(typeof preprocessor.detectSpeechSegments).toBe('function');
    expect(typeof preprocessor.splitBySegments).toBe('function');
  });

  it('Transcriber can be instantiated and has transcribe method', () => {
    const transcriber = new Transcriber(engine);
    expect(transcriber).toBeDefined();
    expect(typeof transcriber.transcribe).toBe('function');
  });

  it('Diarizer can be instantiated and has diarize method', () => {
    const diarizer = new Diarizer(engine);
    expect(diarizer).toBeDefined();
    expect(typeof diarizer.diarize).toBe('function');
  });
});

describe('SherpaModelManager', () => {
  it('can be instantiated with custom dir', () => {
    const mm = new SherpaModelManager(`${TMP_DIR}/test-models`);
    expect(mm.getModelsDir()).toBe(`${TMP_DIR}/test-models`);
  });

  it('returns false for uninstalled models', () => {
    const mm = new SherpaModelManager(`${TMP_DIR}/nonexistent-models`);
    expect(mm.isModelInstalled('sensevoice')).toBe(false);
    expect(mm.areAllModelsReady()).toBe(false);
  });

  it('returns status for all models', () => {
    const mm = new SherpaModelManager(`${TMP_DIR}/nonexistent-models`);
    const statuses = mm.getModelsStatus();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s.id && s.name && typeof s.installed === 'boolean')).toBe(true);
  });
});

describe('SherpaEngine', () => {
  it('can be instantiated', () => {
    const engine = new SherpaEngine(new SherpaModelManager(`${TMP_DIR}/fake-models`));
    expect(engine).toBeDefined();
    expect(typeof engine.isReady).toBe('function');
    expect(typeof engine.transcribeAudio).toBe('function');
    expect(typeof engine.createVad).toBe('function');
    expect(typeof engine.diarize).toBe('function');
    expect(typeof engine.dispose).toBe('function');
  });

  it('isReady returns false when models not installed', () => {
    const engine = new SherpaEngine(new SherpaModelManager(`${TMP_DIR}/fake-models`));
    expect(engine.isReady()).toBe(false);
  });
});
