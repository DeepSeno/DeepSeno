import { describe, it, expect } from 'vitest';
import { chunkText } from '../text-chunker';

describe('chunkText', () => {
  it('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const result = chunkText('Hello world', 512);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
    expect(result[0].index).toBe(0);
  });

  it('splits by paragraph boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const result = chunkText(text, 30);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Each chunk should contain complete paragraphs
    for (const chunk of result) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('handles oversized paragraphs by splitting at sentences', () => {
    const longPara = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
    const result = chunkText(longPara, 40);
    expect(result.length).toBeGreaterThan(1);
  });

  it('assigns sequential indices', () => {
    const text = 'A.\n\nB.\n\nC.\n\nD.';
    const result = chunkText(text, 5);
    for (let i = 0; i < result.length; i++) {
      expect(result[i].index).toBe(i);
    }
  });

  it('handles CJK text', () => {
    const text = '这是第一段中文内容。\n\n这是第二段中文内容。';
    const result = chunkText(text, 100);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].text).toContain('中文');
  });
});
