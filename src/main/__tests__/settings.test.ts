import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPaths = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('../paths', () => ({
  getSharedSettingsPath: () => path.join(mockPaths.dir, 'settings-shared.json'),
  getLocalSettingsPath: () => path.join(mockPaths.dir, 'settings-local.json'),
  getSettingsPath: () => path.join(mockPaths.dir, 'settings.json'),
  getOutputDir: () => path.join(mockPaths.dir, 'output'),
  getDefaultWatchDir: () => path.join(mockPaths.dir, 'watch'),
}));

describe('settings migrations', () => {
  beforeEach(() => {
    mockPaths.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseno-settings-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(mockPaths.dir, { recursive: true, force: true });
  });

  it('migrates the fragile old dictation shortcut default', async () => {
    fs.writeFileSync(
      path.join(mockPaths.dir, 'settings-local.json'),
      JSON.stringify({ sceneShortcuts: { dictation: 'Alt+,' } }),
    );

    const { loadSettings } = await import('../settings');
    const settings = loadSettings();

    expect(settings.sceneShortcuts.dictation).toBe('CommandOrControl+Shift+D');
  });

  it('does not overwrite a user-customized dictation shortcut', async () => {
    fs.writeFileSync(
      path.join(mockPaths.dir, 'settings-local.json'),
      JSON.stringify({ sceneShortcuts: { dictation: 'CommandOrControl+Alt+R' } }),
    );

    const { loadSettings } = await import('../settings');
    const settings = loadSettings();

    expect(settings.sceneShortcuts.dictation).toBe('CommandOrControl+Alt+R');
  });
});
