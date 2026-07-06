import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import { SUPPORTED_EXTENSIONS } from './pipeline/media-type';

const WATCH_EXTENSIONS = new Set(SUPPORTED_EXTENSIONS);

export function isSupportedWatchFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return WATCH_EXTENSIONS.has(ext);
}

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
      if (isSupportedWatchFile(filePath)) {
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
