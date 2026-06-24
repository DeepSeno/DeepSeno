import { describe, expect, it } from 'vitest';
import { GGUFDownloadStateStore } from '../gguf-download-state';

describe('GGUFDownloadStateStore', () => {
  it('keeps progress isolated per model', () => {
    const store = new GGUFDownloadStateStore();

    store.update('qwen3.5:9b', {
      status: 'downloading',
      completed: 100,
      total: 1000,
    });
    store.update('qwen3.5:27b', {
      status: 'downloading',
      completed: 20,
      total: 2000,
    });
    store.update('qwen3.5:9b', {
      completed: 300,
    });

    expect(store.get('qwen3.5:9b')).toMatchObject({
      model: 'qwen3.5:9b',
      status: 'downloading',
      completed: 300,
      total: 1000,
    });
    expect(store.get('qwen3.5:27b')).toMatchObject({
      model: 'qwen3.5:27b',
      status: 'downloading',
      completed: 20,
      total: 2000,
    });
  });

  it('returns a full snapshot for page remount recovery', () => {
    const store = new GGUFDownloadStateStore();

    store.update('qwen3.5:9b', {
      status: 'downloading',
      completed: 100,
      total: 1000,
    });
    store.update('bge-m3', {
      status: 'success',
      completed: 1200,
      total: 1200,
    });

    expect(store.snapshot().map((state) => state.model)).toEqual([
      'qwen3.5:9b',
      'bge-m3',
    ]);
  });

  it('does not move an active download backwards', () => {
    const store = new GGUFDownloadStateStore();

    store.update('qwen3.5:9b', {
      status: 'downloading',
      completed: 500,
      total: 1000,
    });
    store.update('qwen3.5:9b', {
      status: 'downloading',
      completed: 200,
      total: 800,
    });

    expect(store.get('qwen3.5:9b')).toMatchObject({
      completed: 500,
      total: 1000,
    });
  });
});
