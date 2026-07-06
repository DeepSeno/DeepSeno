import { describe, expect, it, vi } from 'vitest';
import { openDirectoryPath } from '../open-directory';

describe('openDirectoryPath', () => {
  it('opens local directories through openPath', async () => {
    const api = { openPath: vi.fn().mockResolvedValue(undefined) };

    await openDirectoryPath(api, 'D:\\Deepseno_record');

    expect(api.openPath).toHaveBeenCalledWith('D:\\Deepseno_record');
  });

  it('trims empty values and does not call openPath', async () => {
    const api = { openPath: vi.fn().mockResolvedValue(undefined) };

    await openDirectoryPath(api, '   ');

    expect(api.openPath).not.toHaveBeenCalled();
  });
});
