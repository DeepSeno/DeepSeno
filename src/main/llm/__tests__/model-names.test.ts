import { describe, expect, it } from 'vitest';
import { toLocalModelApiName } from '../model-names';

describe('local model names', () => {
  it('maps deprecated 122B selections to the largest supported UI model', () => {
    expect(toLocalModelApiName('qwen3.5:122b')).toBe('Qwen3.5-35B-A3B-Q4_K_M');
  });
});
