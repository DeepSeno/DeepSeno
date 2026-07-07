import fs from 'fs';
import path from 'path';
import { getSherpaModelsDir } from '../paths';

// ─── Model Definitions ──────────────────────────────────────

export type ModelMirror = 'modelscope';

export interface SherpaModelInfo {
  id: string;
  name: string;
  description: string;
  /** Approximate bytes used only for stable aggregate progress display. */
  downloadSizeBytes?: number;
  /** Files expected in the model subdirectory. msFilePath is used when ModelScope path differs from local filename. */
  files: { name: string; url?: string; minSize?: number; msFilePath?: string }[];
  /** Subdirectory under sherpa-models/ */
  subdir: string;
  /** If the model is distributed as a tar.bz2 archive on GitHub */
  archive?: {
    url: string;
    /** Top-level directory name inside the archive to strip when extracting */
    stripDir: string;
  };
  /** HuggingFace repo for mirror downloads (individual files, no archive needed) */
  hfRepo?: string;
  /** ModelScope repo for mirror downloads */
  msRepo?: string;
}

const BASE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const HF_MIRROR = 'https://hf-mirror.com';
const MODELSCOPE_API = 'https://modelscope.cn/api/v1/models';
const KiB = 1024;
const MiB = 1024 * KiB;

/** Get the path to bundled sherpa-models in resources (for packaged app). */
function getBundledModelsDir(): string {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'sherpa-models');
    }
  } catch { /* not in Electron */ }
  // Dev mode: resources/sherpa-models relative to project root
  return path.join(__dirname, '../../../resources/sherpa-models');
}

export const SHERPA_MODELS: SherpaModelInfo[] = [
  {
    id: 'sensevoice',
    name: 'SenseVoice (ASR)',
    description: 'Multilingual speech recognition (zh/en/ja/ko/yue)',
    subdir: 'sensevoice',
    downloadSizeBytes: 229 * MiB,
    hfRepo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    msRepo: 'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
    archive: {
      url: `${BASE_URL}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`,
      stripDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    },
    files: [
      { name: 'model.int8.onnx', minSize: 200 * MiB },
      { name: 'tokens.txt' },
    ],
  },
  {
    id: 'silero-vad',
    name: 'Silero VAD',
    description: 'Voice activity detection',
    subdir: 'vad',
    hfRepo: 'csukuangfj/vad',
    msRepo: 'pengzhendong/silero-vad',
    downloadSizeBytes: 700 * KiB,
    files: [
      {
        name: 'silero_vad.onnx',
        msFilePath: 'v4/silero_vad.onnx',
        url: `${BASE_URL}/asr-models/silero_vad.onnx`,
        minSize: 500 * KiB,
      },
    ],
  },
  {
    id: 'pyannote-segmentation',
    name: 'Reverb Diarization V2 (Segmentation)',
    description: 'Speaker segmentation for diarization (Rev.ai reverb-v2)',
    subdir: 'pyannote',
    hfRepo: 'csukuangfj/sherpa-onnx-reverb-diarization-v2',
    downloadSizeBytes: 96 * MiB,
    archive: {
      url: `${BASE_URL}/speaker-segmentation-models/sherpa-onnx-reverb-diarization-v2.tar.bz2`,
      stripDir: 'sherpa-onnx-reverb-diarization-v2',
    },
    files: [
      { name: 'model.int8.onnx', minSize: 80 * MiB },
    ],
  },
  {
    id: '3dspeaker',
    name: '3D-Speaker Large (Embedding)',
    description: 'Speaker voice embedding extraction (large)',
    subdir: 'speaker',
    hfRepo: 'csukuangfj/speaker-embedding-models',
    msRepo: 'lihuoo/3dspeaker-recognition-models',
    downloadSizeBytes: 112 * MiB,
    files: [
      {
        name: '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx',
        url: `${BASE_URL}/speaker-recongition-models/3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx`,
        minSize: 90 * MiB,
      },
    ],
  },
];

// ─── SherpaModelManager ─────────────────────────────────────

export class SherpaModelManager {
  private modelsDir: string;
  private mirror: ModelMirror = 'modelscope';

  constructor(modelsDir?: string) {
    this.modelsDir = modelsDir || getSherpaModelsDir();
  }

  /** Set download source. User-facing downloads are pinned to ModelScope. */
  setMirror(_mirror: ModelMirror): void {
    this.mirror = 'modelscope';
  }

  getMirror(): ModelMirror {
    return this.mirror;
  }

  private estimateModelDownloadBytes(model: SherpaModelInfo): number {
    return model.downloadSizeBytes ?? model.files.reduce((sum, f) => sum + (f.minSize ?? 0), 0);
  }

  /** Get the base models directory. */
  getModelsDir(): string {
    return this.modelsDir;
  }

  /** Get the directory for a specific model. */
  getModelDir(modelId: string): string {
    const model = SHERPA_MODELS.find((m) => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    return path.join(this.modelsDir, model.subdir);
  }

  /** Get the full path to a specific model file. */
  getModelPath(modelId: string, fileName: string): string {
    return path.join(this.getModelDir(modelId), fileName);
  }

  /** Check if a specific model is fully installed. */
  isModelInstalled(modelId: string): boolean {
    const model = SHERPA_MODELS.find((m) => m.id === modelId);
    if (!model) return false;
    const dir = path.join(this.modelsDir, model.subdir);
    for (const f of model.files) {
      const filePath = path.join(dir, f.name);
      try {
        const stat = fs.statSync(filePath);
        if (f.minSize && stat.size < f.minSize) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Check if all required models are installed. */
  areAllModelsReady(): boolean {
    return SHERPA_MODELS.every((m) => this.isModelInstalled(m.id));
  }

  /** Get status of all models. */
  getModelsStatus(): { id: string; name: string; installed: boolean }[] {
    return SHERPA_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      installed: this.isModelInstalled(m.id),
    }));
  }

  /** Get list of missing model files for a specific model. */
  getMissingFiles(modelId: string): string[] {
    const model = SHERPA_MODELS.find((m) => m.id === modelId);
    if (!model) return [];
    const dir = path.join(this.modelsDir, model.subdir);
    const missing: string[] = [];
    for (const f of model.files) {
      const filePath = path.join(dir, f.name);
      try {
        const stat = fs.statSync(filePath);
        if (f.minSize && stat.size < f.minSize) missing.push(f.name);
      } catch {
        missing.push(f.name);
      }
    }
    return missing;
  }

  /** Rename with retry for Windows (antivirus may briefly lock newly written files). */
  private renameWithRetry(src: string, dest: string, maxRetries = 5, delayMs = 500): void {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        fs.renameSync(src, dest);
        return;
      } catch (err: any) {
        const isLockError = err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY';
        if (!isLockError || attempt === maxRetries) throw err;
        // Synchronous delay for retry (only runs during model download, not in hot path)
        const start = Date.now();
        while (Date.now() - start < delayMs) { /* spin wait */ }
      }
    }
  }

  /**
   * Try to copy a model file from bundled resources (resources/sherpa-models/).
   * Returns true if the file was successfully copied, false if not available.
   */
  private tryCopyFromBundled(subdir: string, fileName: string, destPath: string, minSize?: number): boolean {
    const bundledDir = getBundledModelsDir();
    const bundledPath = path.join(bundledDir, subdir, fileName);

    try {
      const stat = fs.statSync(bundledPath);
      if (minSize && stat.size < minSize) {
        console.log(`[SherpaModel] Bundled ${subdir}/${fileName} too small (${stat.size} < ${minSize}), skipping`);
        return false;
      }

      // Copy to destination
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(bundledPath, destPath);
      console.log(`[SherpaModel] Copied bundled ${subdir}/${fileName} (${stat.size} bytes)`);
      return true;
    } catch {
      // File not found in bundled resources
      return false;
    }
  }

  /** Download a file with streaming progress. Returns the path to the downloaded file. */
  private async downloadFile(
    url: string,
    destPath: string,
    signal?: AbortSignal,
    onChunk?: (bytes: number, totalBytes: number) => void,
  ): Promise<void> {
    // Use unique tmp filename to avoid collisions with concurrent downloads
    const tmpPath = destPath + `.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    console.log(`[SherpaDownload] GET ${url}`);
    const res = await fetch(url, { signal, redirect: 'follow' });
    if (!res.ok) {
      const host = new URL(url).hostname;
      const server = res.headers.get('server') || 'unknown';
      console.error(`[SherpaDownload] FAILED ${res.status} from ${host} | Server: ${server} | URL: ${url}`);
      throw new Error(`Failed to download ${path.basename(destPath)}: HTTP ${res.status} from ${host}`);
    }

    // Reject HTML error pages disguised as HTTP 200
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error(`Download returned HTML instead of binary for ${path.basename(destPath)} (proxy error)`);
    }

    const cl = res.headers.get('content-length');
    const totalBytes = cl ? parseInt(cl, 10) : 0;

    const reader = res.body!.getReader();
    const writeStream = fs.createWriteStream(tmpPath);
    let errored = false;

    try {
      // Wait for the file to be opened before writing
      await new Promise<void>((resolve, reject) => {
        writeStream.on('open', () => resolve());
        writeStream.on('error', reject);
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = writeStream.write(Buffer.from(value));
        onChunk?.(value.byteLength, totalBytes);
        // Handle backpressure
        if (!ok) {
          await new Promise<void>((resolve) => writeStream.once('drain', resolve));
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => {
          if (errored) return reject(new Error('Write stream errored'));
          try {
            this.renameWithRetry(tmpPath, destPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        writeStream.on('error', (err) => {
          errored = true;
          reject(err);
        });
      });
    } catch (err) {
      writeStream.destroy();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Extract a tar.bz2 archive to a directory (cross-platform). */
  private extractTarBz2(archivePath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tarStream = require('tar-stream');
      const unbzip2 = require('unbzip2-stream');
      const extract = tarStream.extract();
      const pending: Promise<void>[] = [];

      extract.on('entry', (header: any, stream: any, next: () => void) => {
        const entryPath = path.join(destDir, header.name);
        if (header.type === 'directory') {
          fs.mkdirSync(entryPath, { recursive: true });
          stream.resume();
          next();
        } else if (header.type === 'file') {
          const dir = path.dirname(entryPath);
          fs.mkdirSync(dir, { recursive: true });
          const p = new Promise<void>((res, rej) => {
            const ws = fs.createWriteStream(entryPath);
            stream.pipe(ws);
            ws.on('finish', res);
            ws.on('error', rej);
          });
          pending.push(p);
          stream.on('end', next);
        } else {
          stream.resume();
          next();
        }
      });

      extract.on('finish', () => {
        Promise.all(pending).then(() => resolve()).catch(reject);
      });
      extract.on('error', reject);

      fs.createReadStream(archivePath)
        .pipe(unbzip2())
        .pipe(extract);
    });
  }

  /** Build download URL for a file, respecting mirror setting. */
  private getFileUrl(model: SherpaModelInfo, file: { name: string; url?: string; msFilePath?: string }): string | null {
    if (this.mirror === 'modelscope' && model.msRepo) {
      const filePath = file.msFilePath || file.name;
      return `${MODELSCOPE_API}/${model.msRepo}/repo?Revision=master&FilePath=${filePath}`;
    }
    // Reverb diarization v2 has no confirmed equivalent ModelScope ONNX file yet.
    if (this.mirror === 'modelscope' && model.hfRepo) {
      return `${HF_MIRROR}/${model.hfRepo}/resolve/main/${file.name}`;
    }
    return file.url || null;
  }

  /** Whether to use individual file downloads. */
  private useDirectDownload(model: SherpaModelInfo): boolean {
    if (this.mirror === 'modelscope' && (model.msRepo || model.hfRepo)) return true;
    return !model.archive;
  }

  /** Download a specific model. Calls onProgress with (completed, total) bytes. Set force=true to re-download even if installed. */
  async downloadModel(
    modelId: string,
    onProgress?: (completed: number, total: number, fileName: string) => void,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<void> {
    const model = SHERPA_MODELS.find((m) => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const dir = path.join(this.modelsDir, model.subdir);
    fs.mkdirSync(dir, { recursive: true });

    // Check if already installed (skip check when force re-downloading)
    if (!force && this.isModelInstalled(modelId)) return;

    // When force re-downloading, remove existing files so they get re-fetched
    if (force) {
      for (const f of model.files) {
        try { fs.unlinkSync(path.join(dir, f.name)); } catch { /* ignore */ }
      }
    }

    if (this.useDirectDownload(model)) {
      // ── Individual file downloads (ModelScope, or legacy HF fallback for pyannote) ──
      const missingFiles = model.files.filter((f) => {
        const filePath = path.join(dir, f.name);
        try {
          const stat = fs.statSync(filePath);
          return f.minSize ? stat.size < f.minSize : false;
        } catch {
          return true;
        }
      });

      if (missingFiles.length === 0) return;

      // First, try to copy small files from bundled resources
      const stillMissing = missingFiles.filter((f) => {
        const destPath = path.join(dir, f.name);
        return !this.tryCopyFromBundled(model.subdir, f.name, destPath, f.minSize);
      });

      if (stillMissing.length === 0) return;

      // Resolve all download URLs first
      const fileUrls = new Map<string, string>();
      for (const f of stillMissing) {
        const url = this.getFileUrl(model, f);
        if (url) fileUrls.set(f.name, url);
      }

      // Download files, capturing content-length from GET response (HEAD not supported by ModelScope)
      let overallTotal = 0;
      let overallCompleted = 0;

      for (const f of stillMissing) {
        const url = fileUrls.get(f.name);
        if (!url) continue;
        const destPath = path.join(dir, f.name);
        let fileTotal = 0;
        let fileCompleted = 0;
        let lastProgressTime = 0;
        await this.downloadFile(url, destPath, signal, (bytes, totalBytes) => {
          fileCompleted += bytes;
          overallCompleted += bytes;
          // Capture total from first chunk of each file
          if (fileTotal === 0 && totalBytes > 0) {
            fileTotal = totalBytes;
            overallTotal += totalBytes;
          }
          const now = Date.now();
          if (onProgress && now - lastProgressTime >= 100) {
            lastProgressTime = now;
            onProgress(overallCompleted, overallTotal, f.name);
          }
        });
      }
    } else if (model.archive) {
      // ── Archive download: tar.bz2 → extract → move files ──
      let archiveUrl = model.archive.url;
      const archiveName = path.basename(archiveUrl);
      const archivePath = path.join(dir, archiveName);

      // Get archive size via HEAD (GitHub releases support HEAD)
      let totalSize = 0;
      try {
        const headRes = await fetch(archiveUrl, { method: 'HEAD', signal, redirect: 'follow' });
        const cl = headRes.headers.get('content-length');
        totalSize = cl ? parseInt(cl, 10) : 0;
      } catch { /* will try GET anyway */ }

      // Download archive — capture total from GET if HEAD failed
      let completed = 0;
      let lastProgressTime = 0;
      await this.downloadFile(archiveUrl, archivePath, signal, (bytes, totalBytes) => {
        completed += bytes;
        if (totalSize === 0 && totalBytes > 0) totalSize = totalBytes;
        const now = Date.now();
        if (onProgress && now - lastProgressTime >= 100) {
          lastProgressTime = now;
          onProgress(completed, totalSize || completed, archiveName);
        }
      });

      // Extract archive
      onProgress?.(completed, totalSize || completed, 'extracting...');
      await this.extractTarBz2(archivePath, dir);

      // Move files from extracted subdirectory to model dir
      const extractedDir = path.join(dir, model.archive.stripDir);
      for (const f of model.files) {
        const src = path.join(extractedDir, f.name);
        const dest = path.join(dir, f.name);
        if (fs.existsSync(src)) {
          this.renameWithRetry(src, dest);
        }
      }

      // Clean up archive and extracted directory
      try { fs.unlinkSync(archivePath); } catch { /* ignore */ }
      try { fs.rmSync(extractedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // Final progress
    if (onProgress) {
      onProgress(1, 1, 'done');
    }
  }

  /** Download all missing models with cumulative progress tracking. Set force=true to re-download all. */
  async downloadAllModels(
    onProgress?: (completed: number, total: number, modelId: string, fileName: string) => void,
    signal?: AbortSignal,
    force?: boolean,
  ): Promise<void> {
    const missingModels = force ? SHERPA_MODELS : SHERPA_MODELS.filter((m) => !this.isModelInstalled(m.id));
    if (missingModels.length === 0) return;

    let cumCompleted = 0;
    const plannedTotal = missingModels.reduce((sum, model) => sum + this.estimateModelDownloadBytes(model), 0);
    let cumTotal = plannedTotal;

    for (const model of missingModels) {
      let modelCompleted = 0;
      let modelTotal = 0;
      const modelEstimate = this.estimateModelDownloadBytes(model);
      const baseCompleted = cumCompleted;

      await this.downloadModel(
        model.id,
        (completed, total, fileName) => {
          // Skip per-model 'done' marker
          if (fileName === 'done') return;

          // Set model total once from first non-trivial value when no stable
          // aggregate estimate is available.
          if (cumTotal === 0 && modelTotal === 0 && total > 1024) {
            modelTotal = total;
            cumTotal += total;
          }

          // Update cumulative completed based on this model's progress
          modelCompleted = modelEstimate > 0 ? Math.min(completed, modelEstimate) : completed;
          cumCompleted = baseCompleted + modelCompleted;
          if (cumTotal > 0) {
            cumCompleted = Math.min(cumCompleted, cumTotal);
          }

          onProgress?.(cumCompleted, cumTotal || cumCompleted, model.id, fileName);
        },
        signal,
        force,
      );

      // Ensure cumulative completed includes full model size after download
      cumCompleted = baseCompleted + (modelEstimate || modelTotal || modelCompleted);
      if (cumTotal > 0) {
        cumCompleted = Math.min(cumCompleted, cumTotal);
      }
    }
  }
}
