import { describe, expect, it } from 'vitest';
import { getDownloadedGGUFModelIds, isCompleteGGUFFile } from '../gguf-model-files';

describe('GGUF model file detection', () => {
  it('detects the downloaded Qwen 4B and bge-m3 files used by the app', () => {
    const fileSizes = new Map([
      ['Qwen3.5-4B-Q4_K_M.gguf', 2_740_937_888],
      ['bge-m3-Q8_0.gguf', 634_553_760],
    ]);

    expect(getDownloadedGGUFModelIds((fileName) => fileSizes.get(fileName) ?? null)).toEqual([
      'qwen3.5:4b',
      'bge-m3',
    ]);
  });

  it('rejects obviously incomplete files', () => {
    expect(isCompleteGGUFFile(100, 1_000)).toBe(false);
  });
});
