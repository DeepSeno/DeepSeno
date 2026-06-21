import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import type { SherpaEngineProxy } from './sherpa-engine-proxy';
import { getFFmpegManager } from './ffmpeg-manager';

/** Configure fluent-ffmpeg paths using FFmpegManager. Returns true if configured. */
function configureFfmpegPath(): boolean {
  try {
    const mgr = getFFmpegManager();
    const paths = mgr.find();

    if (paths) {
      ffmpeg.setFfmpegPath(paths.ffmpeg);
      ffmpeg.setFfprobePath(paths.ffprobe);
      console.log(`[AudioPreprocessor] Using FFmpeg: ${paths.ffmpeg}`);
      return true;
    }
  } catch {
    // FFmpegManager may not be available in test environment
  }

  console.log('[AudioPreprocessor] FFmpeg not available yet, will be downloaded in background');
  return false;
}

let _ffmpegConfigured = configureFfmpegPath();

/** Re-check FFmpeg paths after download completes. Call this after FFmpegManager.download() finishes. */
export function reconfigureFFmpeg(): boolean {
  _ffmpegConfigured = configureFfmpegPath();
  return _ffmpegConfigured;
}

export class AudioPreprocessor {
  private engine: SherpaEngineProxy | null;

  /** Whether FFmpeg binaries are available (downloaded or bundled) */
  static get isBundled(): boolean { return _ffmpegConfigured; }

  constructor(engine?: SherpaEngineProxy) {
    this.engine = engine || null;
  }

  getDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration || 0);
      });
    });
  }

  convertTo16kMono(inputPath: string, outputDir: string): Promise<string> {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(outputDir, `${baseName}_16k_mono.wav`);
    fs.mkdirSync(outputDir, { recursive: true });
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    });
  }

  async detectSpeechSegments(audioPath: string): Promise<{ segments: Array<{ start: number; end: number; duration: number }>; total_speech_seconds: number }> {
    if (!this.engine) {
      throw new Error('SherpaEngine not available for VAD');
    }
    if (!this.engine.isReady()) {
      throw new Error('sherpa-onnx models are not downloaded. Please download models from Settings.');
    }

    return this.engine.vadDetectSegments(audioPath);
  }

  async splitBySegments(inputPath: string, segments: Array<{ start: number; end: number }>, outputDir: string): Promise<string[]> {
    fs.mkdirSync(outputDir, { recursive: true });
    const FFMPEG_CONCURRENCY = 4;
    const outputs: string[] = new Array(segments.length);

    for (let i = 0; i < segments.length; i += FFMPEG_CONCURRENCY) {
      const batch = segments.slice(i, i + FFMPEG_CONCURRENCY);
      await Promise.all(batch.map(async (seg, j) => {
        const idx = i + j;
        const outPath = path.join(outputDir, `segment_${String(idx).padStart(4, '0')}.wav`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(seg.start)
            .setDuration(seg.end - seg.start)
            .audioFrequency(16000)
            .audioChannels(1)
            .output(outPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        });
        outputs[idx] = outPath;
      }));
    }
    return outputs;
  }
}
