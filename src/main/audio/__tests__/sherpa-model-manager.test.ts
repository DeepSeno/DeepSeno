import { describe, expect, it } from 'vitest';
import { SherpaModelManager, SHERPA_MODELS } from '../sherpa-model-manager';

describe('SherpaModelManager download sources', () => {
  it('downloads Silero VAD from the verified ModelScope v4 path and keeps the local filename', () => {
    const manager = new SherpaModelManager('/tmp/deepseno-test-sherpa');
    manager.setMirror('modelscope');
    const model = SHERPA_MODELS.find((m) => m.id === 'silero-vad');
    expect(model).toBeTruthy();

    const file = model!.files[0];
    const url = (manager as any).getFileUrl(model, file);

    expect(file.name).toBe('silero_vad.onnx');
    expect(url).toContain('modelscope.cn/api/v1/models/pengzhendong/silero-vad/repo');
    expect(url).toContain('FilePath=v4/silero_vad.onnx');
  });

  it('keeps pyannote reverb-v2 on the legacy URL until an equivalent ModelScope file is confirmed', () => {
    const manager = new SherpaModelManager('/tmp/deepseno-test-sherpa');
    manager.setMirror('modelscope');
    const model = SHERPA_MODELS.find((m) => m.id === 'pyannote-segmentation');
    expect(model).toBeTruthy();

    const url = (manager as any).getFileUrl(model, model!.files[0]);

    expect(url).toContain('hf-mirror.com/csukuangfj/sherpa-onnx-reverb-diarization-v2');
  });
});
