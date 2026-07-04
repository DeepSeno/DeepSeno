import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';

const MEDIA_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4', '.mov', '.mkv', '.avi', '.wmv']);

export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private watchDir: string,
    private onNewFile: (filePath: string) => void,
    private ignoreDirs: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 1000 },
      ignored: this.ignoreDirs.map(d => path.join(d, '**')),
    });
    this.watcher.on('add', (filePath: string) => {
      const ext = path.extname(filePath).toLowerCase();
      if (MEDIA_EXTENSIONS.has(ext)) {
        try {
          this.onNewFile(filePath);
        } catch (err) {
          console.error(`[FileWatcher] Error processing ${filePath}:`, err);
        }
      }
    });
    this.watcher.on('error', (err: unknown) => {
      console.error('[FileWatcher] Watcher error:', err);
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
