import { describe, expect, it } from 'vitest';
import { getLocalModelTestButtonClass, shouldRestartLocalServerAfterTest, toLocalModelApiName } from '../local-model-test';

describe('local model smoke test helpers', () => {
  it('maps product model ids to llama-server aliases', () => {
    expect(toLocalModelApiName('qwen3.5:4b')).toBe('Qwen3.5-4B-Q4_K_M');
    expect(toLocalModelApiName('qwen3.5:35b')).toBe('Qwen3.5-35B-A3B-Q4_K_M');
  });

  it('keeps custom aliases usable', () => {
    expect(toLocalModelApiName('Custom-Model.gguf')).toBe('Custom-Model');
  });

  it('only restarts local server after testing a non-selected model', () => {
    expect(shouldRestartLocalServerAfterTest('qwen3.5:4b', 'qwen3.5:4b')).toBe(false);
    expect(shouldRestartLocalServerAfterTest('qwen3.5:9b', 'qwen3.5:4b')).toBe(true);
  });

  it('marks the whole button as green after a successful smoke test', () => {
    expect(getLocalModelTestButtonClass('qwen3.5:4b', 'qwen3.5:4b', false)).toContain('kz-btn--success');
    expect(getLocalModelTestButtonClass('qwen3.5:4b', 'qwen3.5:4b', true)).not.toContain('kz-btn--success');
    expect(getLocalModelTestButtonClass('qwen3.5:4b', 'qwen3.5:9b', false)).not.toContain('kz-btn--success');
  });
});
