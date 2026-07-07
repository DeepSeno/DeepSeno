import { describe, expect, it } from 'vitest';
import { isModelInstalled, mergeInstalledModelStatuses, toSelectableModelId } from '../model-status';

describe('model status helpers', () => {
  it('matches downloaded model ids with or without latest suffix', () => {
    expect(isModelInstalled(['qwen3.5:4b'], 'qwen3.5:4b')).toBe(true);
    expect(isModelInstalled(['qwen3.5:4b:latest'], 'qwen3.5:4b')).toBe(true);
    expect(isModelInstalled(['qwen3.5:4b'], 'qwen3.5:4b:latest')).toBe(true);
  });

  it('restores downloaded models to done after page remount', () => {
    const statuses = mergeInstalledModelStatuses({}, ['qwen3.5:4b', 'bge-m3'], 'qwen3.5:4b');

    expect(statuses['qwen3.5:4b']).toBe('done');
    expect(statuses['bge-m3']).toBe('done');
    expect(statuses['qwen3.5:9b']).toBe('queued');
  });

  it('does not overwrite active download or testing states', () => {
    const statuses = mergeInstalledModelStatuses(
      {
        'qwen3.5:4b': 'downloading',
        'qwen3.5:9b': 'testing',
      },
      ['qwen3.5:4b', 'qwen3.5:9b'],
      'qwen3.5:4b',
    );

    expect(statuses['qwen3.5:4b']).toBe('downloading');
    expect(statuses['qwen3.5:9b']).toBe('testing');
  });

  it('keeps error state for missing models', () => {
    const statuses = mergeInstalledModelStatuses({ 'qwen3.5:27b': 'error' }, [], 'qwen3.5:4b');

    expect(statuses['qwen3.5:27b']).toBe('error');
  });

  it('maps the deprecated 122B UI selection to 35B', () => {
    expect(toSelectableModelId('qwen3.5:122b')).toBe('qwen3.5:35b');

    const statuses = mergeInstalledModelStatuses({}, [], 'qwen3.5:122b');

    expect(statuses['qwen3.5:122b']).toBeUndefined();
    expect(statuses['qwen3.5:35b']).toBe('queued');
  });
});
