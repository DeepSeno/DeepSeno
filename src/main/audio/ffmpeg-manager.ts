import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getFFmpegDir } from '../paths';
import { getEffectiveMirror } from '../mirror-config';

// ─── Types ───────────────────────────────────────────────────

export type FFmpegProgressCallback = (completed: number, total: number, stage: string) => void;

export interface FFmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

// ─── Platform Constants ──────────────────────────────────────

const GHFAST = 'https://ghfast.top';

// External sources
const WINDOWS_FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const MACOS_FFMPEG_URL = 'https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip';
const MACOS_FFPROBE_URL = 'https://evermeet.cx/ffmpeg/ffprobe-7.1.zip';

/** Get ordered list of Windows FFmpeg URLs to try. */
function getWindowsFFmpegUrls(): string[] {
  const urls: string[] = [];
  if (getEffectiveMirror() === 'china') {
    urls.push(`${GHFAST}/${WINDOWS_FFMPEG_URL}`);
  }
  urls.push(WINDOWS_FFMPEG_URL);
  return urls;
}

/** Get ordered list of macOS FFmpeg URL pairs to try. */
function getMacOSFFmpegUrlSets(): Array<{ ffmpeg: string; ffprobe: string }> {
  const sets: Array<{ ffmpeg: string; ffprobe: string }> = [];
  if (getEffectiveMirror() === 'china') {
    sets.push({ ffmpeg: `${GHFAST}/${MACOS_FFMPEG_URL}`, ffprobe: `${GHFAST}/${MACOS_FFPROBE_URL}` });
  }
  sets.push({ ffmpeg: MACOS_FFMPEG_URL, ffprobe: MACOS_FFPROBE_URL });
  return sets;
}

function getPlatformDir(): string {
  return `${process.platform}-${process.arch}`;
}

// ─── FFmpegManager ───────────────────────────────────────────

export class FFmpegManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || getFFmpegDir();
  }

  /** Directory where downloaded binaries are stored for the current platform. */
  private getDownloadDir(): string {
    return path.join(this.baseDir, getPlatformDir());
  }

  /**
   * Directory where legacy bundled binaries may exist.
   * In packaged mode: process.resourcesPath/ffmpeg/{platform}-{arch}/
   * In dev mode: {projectRoot}/resources/ffmpeg/{platform}-{arch}/
   */
  private getLegacyDirs(): string[] {
    const platformDir = getPlatformDir();
    const dirs: string[] = [];

    // Packaged app location
    let isPackaged = false;
    try {
      const { app } = require('electron');
      isPackaged = app.isPackaged;
    } catch {
      // Not in Electron environment
    }

    if (isPackaged && process.resourcesPath) {
      dirs.push(path.join(process.resourcesPath, 'ffmpeg', platformDir));
    }

    // Dev mode location (__dirname is dist/main/ in build, or src/main/audio/ in dev)
    dirs.push(path.join(__dirname, '../../resources/ffmpeg', platformDir));

    return dirs;
  }

  /** Get binary names for current platform. */
  private getBinaryNames(): { ffmpeg: string; ffprobe: string } {
    const isWindows = process.platform === 'win32';
    return {
      ffmpeg: isWindows ? 'ffmpeg.exe' : 'ffmpeg',
      ffprobe: isWindows ? 'ffprobe.exe' : 'ffprobe',
    };
  }

  /**
   * Check if FFmpeg and ffprobe exist in the given directory.
   * Returns the paths if both are found, null otherwise.
   */
  private checkDir(dir: string): FFmpegPaths | null {
    const bins = this.getBinaryNames();
    const ffmpegPath = path.join(dir, bins.ffmpeg);
    const ffprobePath = path.join(dir, bins.ffprobe);

    try {
      const ffmpegStat = fs.statSync(ffmpegPath);
      const ffprobeStat = fs.statSync(ffprobePath);
      // Sanity check: binaries should be at least 1MB
      if (ffmpegStat.size < 1_000_000 || ffprobeStat.size < 1_000_000) {
        return null;
      }
      return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
    } catch {
      return null;
    }
  }

  /**
   * Find FFmpeg binaries in order of priority:
   * 1. Downloaded location (app data dir)
   * 2. Legacy bundled location (resources/)
   * Returns null if not found anywhere.
   */
  find(): FFmpegPaths | null {
    // 1. Downloaded location
    const downloadDir = this.getDownloadDir();
    const downloaded = this.checkDir(downloadDir);
    if (downloaded) return downloaded;

    // 2. Legacy bundled locations
    for (const dir of this.getLegacyDirs()) {
      const legacy = this.checkDir(dir);
      if (legacy) return legacy;
    }

    return null;
  }

  /** Whether FFmpeg is available (downloaded or bundled). */
  isAvailable(): boolean {
    return this.find() !== null;
  }

  /**
   * Download FFmpeg and ffprobe for the current platform.
   * On macOS: downloads two separate zips from evermeet.cx
   * On Windows: downloads one zip from gyan.dev containing both binaries
   */
  async download(
    onProgress?: FFmpegProgressCallback,
    signal?: AbortSignal,
  ): Promise<FFmpegPaths> {
    // Already available?
    const existing = this.find();
    if (existing) return existing;

    const destDir = this.getDownloadDir();
    fs.mkdirSync(destDir, { recursive: true });

    if (process.platform === 'darwin') {
      await this.downloadMacOS(destDir, onProgress, signal);
    } else if (process.platform === 'win32') {
      await this.downloadWindows(destDir, onProgress, signal);
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    const result = this.checkDir(destDir);
    if (!result) {
      throw new Error('FFmpeg download completed but binaries not found in destination');
    }
    return result;
  }

  // ─── macOS Download ──────────────────────────────────────────

  private async downloadMacOS(
    destDir: string,
    onProgress?: FFmpegProgressCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const urlSets = getMacOSFFmpegUrlSets();
    let lastError: Error | null = null;

    for (const urlSet of urlSets) {
      try {
        let totalSize = 0;
        let completedSize = 0;

        const urls = [
          { url: urlSet.ffmpeg, name: 'ffmpeg' },
          { url: urlSet.ffprobe, name: 'ffprobe' },
        ];

        for (const { url } of urls) {
          try {
            const headRes = await fetch(url, { method: 'HEAD', signal, redirect: 'follow' });
            const cl = headRes.headers.get('content-length');
            totalSize += cl ? parseInt(cl, 10) : 0;
          } catch { /* Will try GET anyway */ }
        }

        for (const { url, name } of urls) {
          signal?.throwIfAborted();
          const zipPath = path.join(destDir, `${name}.zip`);
          onProgress?.(completedSize, totalSize || 1, `downloading ${name}`);

          await this.downloadFile(url, zipPath, signal, (bytes) => {
            completedSize += bytes;
            onProgress?.(completedSize, totalSize || completedSize, `downloading ${name}`);
          });

          onProgress?.(completedSize, totalSize || completedSize, `extracting ${name}`);
          try {
            execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'pipe', timeout: 30_000 });
          } catch (err: any) {
            throw new Error(`Failed to extract ${name}: ${err.message}`);
          }

          const binPath = path.join(destDir, name);
          if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755);
          try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        }

        onProgress?.(totalSize || 1, totalSize || 1, 'done');
        return; // Success — don't try remaining URL sets
      } catch (err: any) {
        lastError = err;
        console.warn(`[FFmpegManager] macOS download failed from ${urlSet.ffmpeg}: ${err.message}, trying next source...`);
        // Clean up partial downloads before retrying
        for (const name of ['ffmpeg', 'ffprobe']) {
          try { fs.unlinkSync(path.join(destDir, `${name}.zip`)); } catch { /* ignore */ }
          try { fs.unlinkSync(path.join(destDir, name)); } catch { /* ignore */ }
        }
      }
    }
    throw lastError || new Error('All FFmpeg download sources failed');
  }

  // ─── Windows Download ────────────────────────────────────────

  private async downloadWindows(
    destDir: string,
    onProgress?: FFmpegProgressCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const urls = getWindowsFFmpegUrls();
    const zipPath = path.join(destDir, 'ffmpeg-win64.zip');
    let lastError: Error | null = null;

    for (const ffmpegUrl of urls) {
      try {
        let completedSize = 0;
        let totalSize = 0;

        console.log(`[FFmpegManager] Downloading from: ${ffmpegUrl}`);
        onProgress?.(0, 1, 'downloading ffmpeg');
        await this.downloadFile(
          ffmpegUrl, zipPath, signal,
          (bytes) => {
            completedSize += bytes;
            onProgress?.(completedSize, totalSize || completedSize, 'downloading ffmpeg');
          },
          (size) => { totalSize = size; },
        );

        // Extract using PowerShell
        onProgress?.(completedSize, totalSize || completedSize, 'extracting ffmpeg');
        const extractDir = path.join(destDir, '_extract');
        try {
          execFileSync('powershell', [
            '-NoProfile', '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
          ], {
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch (err: any) {
          throw new Error(`Failed to extract FFmpeg: ${err.message}`);
        }

        // Find ffmpeg.exe and ffprobe.exe in the nested bin/ directory
        const binDir = this.findWindowsBinDir(extractDir);
        if (!binDir) {
          throw new Error('Could not find ffmpeg.exe in extracted archive');
        }

        // Move binaries to destination
        for (const bin of ['ffmpeg.exe', 'ffprobe.exe']) {
          const src = path.join(binDir, bin);
          const dest = path.join(destDir, bin);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          }
        }

        // Clean up
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }

        onProgress?.(totalSize || 1, totalSize || 1, 'done');
        return; // Success — don't try remaining URLs
      } catch (err: any) {
        lastError = err;
        console.warn(`[FFmpegManager] Windows download failed from ${ffmpegUrl}: ${err.message}, trying next source...`);
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      }
    }
    throw lastError || new Error('All FFmpeg download sources failed');
  }

  /** Recursively find the bin/ directory containing ffmpeg.exe in the Windows archive. */
  private findWindowsBinDir(dir: string): string | null {
    const ffmpegExe = 'ffmpeg.exe';
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === ffmpegExe) {
          return dir;
        }
        if (entry.isDirectory()) {
          const found = this.findWindowsBinDir(full);
          if (found) return found;
        }
      }
    } catch {
      // ignore read errors
    }
    return null;
  }

  // ─── File Download Helper ────────────────────────────────────

  /** Download a file with streaming progress. Calls onStart with totalSize from response headers. */
  private async downloadFile(
    url: string,
    destPath: string,
    signal?: AbortSignal,
    onChunk?: (bytes: number) => void,
    onStart?: (totalSize: number) => void,
  ): Promise<void> {
    const tmpPath = destPath + '.tmp';
    const res = await fetch(url, { signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Failed to download ${path.basename(destPath)}: HTTP ${res.status}`);
    }

    const cl = res.headers.get('content-length');
    onStart?.(cl ? parseInt(cl, 10) : 0);

    const reader = res.body!.getReader();
    const writeStream = fs.createWriteStream(tmpPath);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writeStream.write(Buffer.from(value));
        onChunk?.(value.byteLength);
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => {
          try {
            fs.renameSync(tmpPath, destPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        writeStream.on('error', reject);
      });
    } catch (err) {
      writeStream.end();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _instance: FFmpegManager | null = null;

export function getFFmpegManager(): FFmpegManager {
  if (!_instance) {
    _instance = new FFmpegManager();
  }
  return _instance;
}
