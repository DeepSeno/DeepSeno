import { BrowserWindow } from 'electron';
import { getFFmpegManager } from './audio/ffmpeg-manager';
import { reconfigureFFmpeg } from './audio/preprocessor';
import { SherpaModelManager } from './audio/sherpa-model-manager';
import { loadSettings } from './settings';

// ─── Types ───────────────────────────────────────────────────

export type DownloadItemId = 'ffmpeg' | 'sherpa-models' | 'llm-model' | 'embed-model';

export interface DownloadItem {
  id: DownloadItemId;
  label: string;
  status: 'pending' | 'downloading' | 'done' | 'error' | 'skipped';
  progress: number; // 0-100
  error?: string;
}

export interface DownloadManagerState {
  items: DownloadItem[];
  active: boolean;
  overallProgress: number; // 0-100 based on completed items
}

// ─── BackgroundDownloadManager ───────────────────────────────

/**
 * Orchestrates all post-install background downloads in sequence:
 * FFmpeg → sherpa-onnx models → LLM model → Embed model.
 *
 * Emits `bgdownload:state` to the renderer via IPC whenever state changes.
 * Auto-skips items that are already installed.
 * If llmProvider is 'openai', LLM + embed model are skipped.
 */
export class BackgroundDownloadManager {
  private items: Map<DownloadItemId, DownloadItem> = new Map();
  private win: BrowserWindow | null = null;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(private sherpaModelManager: SherpaModelManager) {
    this.initItems();
  }

  private initItems(): void {
    const settings = loadSettings();
    const llmModel = settings.llmModel || 'qwen3.5:4b';

    const items: DownloadItem[] = [
      { id: 'ffmpeg', label: 'FFmpeg', status: 'pending', progress: 0 },
      { id: 'sherpa-models', label: 'ASR Models (~406 MB)', status: 'pending', progress: 0 },
      { id: 'llm-model', label: `${llmModel} (LLM)`, status: 'pending', progress: 0 },
      { id: 'embed-model', label: 'bge-m3 (Embeddings)', status: 'pending', progress: 0 },
    ];

    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  /** Set the window to send IPC state updates to. */
  setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  /** Get a snapshot of the current download state. */
  getState(): DownloadManagerState {
    const items = Array.from(this.items.values());
    const total = items.length;
    const doneCount = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
    return {
      items,
      active: this.running,
      overallProgress: total > 0 ? Math.round((doneCount / total) * 100) : 0,
    };
  }

  /** Start all downloads sequentially in background. Resolves when all steps complete. */
  async startAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.emit();

    try {
      await this.downloadFFmpeg(signal);
      await this.downloadSherpaModels(signal);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('[BackgroundDownloadManager] Unexpected error:', err);
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.emit();
    }
  }

  /** Abort all in-progress downloads. */
  cancel(): void {
    this.abortController?.abort();
  }

  /** Reset specific items to pending and restart downloads.
   *  For sherpa-models, deletes existing model files so they re-download. */
  async restartItems(ids: DownloadItemId[]): Promise<void> {
    if (this.running) {
      this.cancel();
      // Wait briefly for abort to propagate
      await new Promise(r => setTimeout(r, 500));
    }
    for (const id of ids) {
      // Delete sherpa model files so they actually re-download
      if (id === 'sherpa-models') {
        const fs = require('fs');
        const modelsDir = this.sherpaModelManager.getModelsDir();
        if (fs.existsSync(modelsDir)) {
          fs.rmSync(modelsDir, { recursive: true, force: true });
          console.log(`[BgDownload] Deleted sherpa models dir for re-download: ${modelsDir}`);
        }
      }
      this.update(id, { status: 'pending', progress: 0, error: undefined });
    }
    // Re-run startAll — pending items will be re-processed
    return this.startAll();
  }

  // ─── Internal helpers ──────────────────────────────────────

  /** Update a single item and broadcast state. */
  private update(id: DownloadItemId, partial: Partial<DownloadItem>): void {
    const item = this.items.get(id);
    if (item) Object.assign(item, partial);
    this.emit();
  }

  /** Broadcast current state to renderer. */
  private emit(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('bgdownload:state', this.getState());
    }
  }

  // ─── Step 1: FFmpeg ────────────────────────────────────────

  private async downloadFFmpeg(signal: AbortSignal): Promise<void> {
    const mgr = getFFmpegManager();
    if (mgr.isAvailable()) {
      this.update('ffmpeg', { status: 'done', progress: 100 });
      return;
    }

    this.update('ffmpeg', { status: 'downloading', progress: 0 });
    try {
      await mgr.download(
        (completed, total) => {
          const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
          this.update('ffmpeg', { progress: pct });
        },
        signal,
      );
      reconfigureFFmpeg();
      this.update('ffmpeg', { status: 'done', progress: 100 });
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      this.update('ffmpeg', { status: 'error', error: err.message });
    }
  }

  // ─── Step 2: Sherpa-ONNX Models ────────────────────────────

  private async downloadSherpaModels(signal: AbortSignal): Promise<void> {
    // Skip if models are already installed
    if (this.sherpaModelManager.areAllModelsReady()) {
      this.update('sherpa-models', { status: 'done', progress: 100 });
      return;
    }

    this.update('sherpa-models', { status: 'downloading', progress: 0 });

    const progressCb = (completed: number, total: number) => {
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      this.update('sherpa-models', { progress: pct });
    };

    // Default: modelscope → hf-mirror → ghfast → direct
    const sources: Array<{ mirror: import('./audio/sherpa-model-manager').ModelMirror; label: string }> = [
      { mirror: 'modelscope', label: 'ModelScope' },
      { mirror: 'hf-mirror', label: 'hf-mirror' },
      { mirror: 'ghfast', label: 'ghfast' },
      { mirror: '', label: 'direct' },
    ];

    const errors: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      this.sherpaModelManager.setMirror(src.mirror);
      try {
        console.log(`[BgDownload] Trying ${src.label} (mirror=${src.mirror})...`);
        await this.sherpaModelManager.downloadAllModels(progressCb, signal);
        this.update('sherpa-models', { status: 'done', progress: 100 });
        return;
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        errors.push(`${src.label}: ${err.message}`);
        if (i < sources.length - 1) {
          console.log(`[BgDownload] ${src.label} failed: ${err.message}, trying ${sources[i + 1].label}...`);
        } else {
          // Show all sources that failed, not just the last one
          const allErrors = errors.join(' | ');
          console.error(`[BgDownload] All sources failed: ${allErrors}`);
          this.update('sherpa-models', { status: 'error', error: allErrors });
        }
      }
    }
  }
}
