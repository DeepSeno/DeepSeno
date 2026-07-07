import { describe, expect, it } from 'vitest';
import { findModel, GGUF_CATALOG, getDownloadUrl, getModelIds } from '../gguf-model-catalog';

describe('GGUF model catalog', () => {
  it('uses ModelScope URLs even if an old mirror preference is passed', () => {
    for (const entry of GGUF_CATALOG) {
      const url = getDownloadUrl(entry, 'hf-mirror');
      expect(url).toContain('modelscope.cn');
      expect(url).not.toContain('hf-mirror.com');
      expect(url).not.toContain('huggingface.co');
    }
  });

  it('keeps verified ModelScope file sizes for single-file downloads', () => {
    expect(findModel('qwen3.5:4b')?.fileSizeBytes).toBe(2_740_937_888);
    expect(findModel('qwen3.5:9b')?.fileSizeBytes).toBe(5_680_522_464);
    expect(findModel('qwen3.5:27b')?.fileSizeBytes).toBe(16_740_812_704);
    expect(findModel('qwen3.5:35b')?.fileSizeBytes).toBe(22_016_023_168);
    expect(findModel('bge-m3')?.fileSizeBytes).toBe(634_553_760);
  });

  it('does not expose the deprecated 122B model for download or selection', () => {
    expect(findModel('qwen3.5:122b')).toBeUndefined();
    expect(getModelIds()).not.toContain('qwen3.5:122b');
  });
});
