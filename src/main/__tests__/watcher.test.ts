import { describe, it, expect, afterEach } from 'vitest';
import { FileWatcher } from '../watcher';
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

  it('should detect new audio files', async () => {
    makeTmpDir();
    const detected: string[] = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detected.push(filePath);
    });
    await watcher.start();

    // Give chokidar a moment to initialize
    await new Promise((r) => setTimeout(r, 500));

    // Write a .wav file
    const wavFile = path.join(tmpDir, 'test.wav');
    fs.writeFileSync(wavFile, Buffer.alloc(100));

    // Wait for awaitWriteFinish stabilityThreshold + extra buffer
    await new Promise((r) => setTimeout(r, 4000));

    expect(detected.length).toBe(1);
    expect(detected[0]).toContain('test.wav');
  }, 10000);

  it('should ignore non-audio files', async () => {
    makeTmpDir();
    const detected: string[] = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detected.push(filePath);
    });
    await watcher.start();

    await new Promise((r) => setTimeout(r, 500));

    // Write a .txt file — should be ignored
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello');

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
