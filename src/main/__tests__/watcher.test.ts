import { describe, it, expect, afterEach } from 'vitest';
import { FileWatcher, isSupportedWatchFile } from '../watcher';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  function makeTmpDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    return tmpDir;
  }

  afterEach(async () => {
    if (watcher) await watcher.stop();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects supported file extensions', () => {
    expect(isSupportedWatchFile('/path/to/file.wav')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.pdf')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.docx')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.txt')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.md')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.png')).toBe(true);
    expect(isSupportedWatchFile('/path/to/file.xyz')).toBe(false);
  });

  it('should detect new supported files', async () => {
    makeTmpDir();
    const detected: string[] = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detected.push(filePath);
    });
    await watcher.start();

    // Give chokidar a moment to initialize
    await new Promise((r) => setTimeout(r, 500));

    const pdfFile = path.join(tmpDir, 'test.pdf');
    fs.writeFileSync(pdfFile, Buffer.alloc(100));

    // Wait for awaitWriteFinish stabilityThreshold + extra buffer
    await new Promise((r) => setTimeout(r, 4000));

    expect(detected.length).toBe(1);
    expect(detected[0]).toContain('test.pdf');
  }, 10000);

  it('should ignore unsupported files', async () => {
    makeTmpDir();
    const detected: string[] = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detected.push(filePath);
    });
    await watcher.start();

    await new Promise((r) => setTimeout(r, 500));

    fs.writeFileSync(path.join(tmpDir, 'readme.xyz'), 'hello');

    await new Promise((r) => setTimeout(r, 4000));

    expect(detected.length).toBe(0);
  }, 10000);

  it('should stop watching after stop() is called', async () => {
    makeTmpDir();
    const detected: string[] = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detected.push(filePath);
    });
    await watcher.start();
    await watcher.stop();

    fs.writeFileSync(path.join(tmpDir, 'after-stop.wav'), Buffer.alloc(100));

    await new Promise((r) => setTimeout(r, 3000));

    expect(detected.length).toBe(0);
  }, 10000);
});
