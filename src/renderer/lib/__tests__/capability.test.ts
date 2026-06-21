import { describe, expect, it } from 'vitest';
import { getPluginKind, getMarketItemKind, isHybridPlugin } from '../capability';

describe('capability classification', () => {
  it('classifies prompt-only plugin as skill', () => {
    expect(getPluginKind({ hasInstructions: true, hasMCP: false })).toBe('skill');
  });

  it('classifies mcp-only plugin as mcp', () => {
    expect(getPluginKind({ hasInstructions: false, hasMCP: true })).toBe('mcp');
  });

  it('classifies hybrid plugin as mcp and marks hybrid', () => {
    const plugin = { hasInstructions: true, hasMCP: true };
    expect(getPluginKind(plugin)).toBe('mcp');
    expect(isHybridPlugin(plugin)).toBe(true);
  });

  it('classifies market skill by tags', () => {
    expect(getMarketItemKind({ tags: ['skill', 'meeting'], sourceUri: '' })).toBe('skill');
  });

  it('classifies market mcp by tags', () => {
    expect(getMarketItemKind({ tags: ['mcp', 'file'], sourceUri: '' })).toBe('mcp');
  });

  it('classifies market mcp by sourceUri', () => {
    expect(getMarketItemKind({ tags: [], sourceUri: '@modelcontextprotocol/server-filesystem' })).toBe('mcp');
  });

  it('defaults unknown market item to mcp', () => {
    expect(getMarketItemKind({ tags: [], sourceUri: '' })).toBe('mcp');
  });
});
