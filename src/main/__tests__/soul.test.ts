import { describe, it, expect } from 'vitest';
import { buildSoulSystemPrompt } from '../agent/soul';

describe('buildSoulSystemPrompt', () => {
  it('returns empty string when no config', () => {
    expect(buildSoulSystemPrompt({ soul: '', rules: '' })).toBe('');
  });

  it('includes soul when provided', () => {
    const result = buildSoulSystemPrompt({ soul: '姓名：王总\n行业：电商', rules: '' });
    expect(result).toContain('用户画像');
    expect(result).toContain('王总');
    expect(result).not.toContain('处理规则');
  });

  it('includes both soul and rules', () => {
    const result = buildSoulSystemPrompt({
      soul: '姓名：王总',
      rules: '金额格式：¥X,XXX',
    });
    expect(result).toContain('用户画像');
    expect(result).toContain('处理规则');
    expect(result).toContain('¥X,XXX');
  });

  it('trims whitespace-only config', () => {
    expect(buildSoulSystemPrompt({ soul: '   ', rules: '  \n  ' })).toBe('');
  });
});
