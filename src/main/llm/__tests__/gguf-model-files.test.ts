import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getDownloadedGGUFModelIds,
  hasGGUFMagic,
  isCompleteGGUFFile,
  validateGGUFFilePath,
} from '../gguf-model-files';

describe('GGUF model file detection', () => {
  it('detects the downloaded Qwen 4B and bge-m3 files used by the app', () => {
    const fileSizes = new Map([
      ['Qwen3.5-4B-Q4_K_M.gguf', 2_740_937_888],
      ['Qwen3.5-9B-Q4_K_M.gguf', 5_680_522_464],
      ['Qwen3.5-35B-A3B-Q4_K_M.gguf', 22_016_023_168],
      ['bge-m3-Q8_0.gguf', 634_553_760],
    ]);

    expect(getDownloadedGGUFModelIds((fileName) => fileSizes.get(fileName) ?? null)).toEqual([
      'qwen3.5:4b',
      'qwen3.5:9b',
      'qwen3.5:35b',
      'bge-m3',
    ]);
  });

  it('rejects obviously incomplete files', () => {
    expect(isCompleteGGUFFile(100, 1_000)).toBe(false);
  });

  it('rejects near-complete truncated files', () => {
    expect(isCompleteGGUFFile(960, 1_000)).toBe(false);
  });

  it('rejects files with valid size but non-GGUF header', () => {
    expect(getDownloadedGGUFModelIds(() => ({
      size: 2_740_937_888,
      header: Buffer.from('{"Co'),
    }))).toEqual([]);
  });

  it('validates GGUF magic before accepting a downloaded file', () => {
    expect(hasGGUFMagic(Buffer.from('GGUF'))).toBe(true);
    expect(hasGGUFMagic(Buffer.from('HTML'))).toBe(false);
  });

  it('returns a validation error for a downloaded error page', () => {
    const filePath = path.join(os.tmpdir(), `deepseno-invalid-gguf-${Date.now()}.gguf`);
    fs.writeFileSync(filePath, '{"Code":6000,"Message":"download error"}');
    try {
      const result = validateGGUFFilePath(filePath, 1);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not a valid GGUF');
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});
