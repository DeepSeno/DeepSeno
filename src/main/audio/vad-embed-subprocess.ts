/**
 * Speaker diarization subprocess: segment detection + embedding extraction.
 *
 * Uses OfflineSpeakerDiarization for segment detection (its process() returns
 * plain {start, end, speaker} objects — no native Float32Array), then
 * SpeakerEmbeddingExtractor for per-segment embeddings (Array.from() safely
 * converts native Float32Array to plain numbers).
 *
 * This avoids the "External buffers are not allowed" issue that affects
 * Silero VAD's front() method in Electron's forked V8.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── WAV reader ───

function readWavPure(filePath: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numChannels = view.getInt16(22, true);
  const sampleRate = view.getInt32(24, true);
  const bitsPerSample = view.getInt16(34, true);

  if (bitsPerSample !== 16 || numChannels !== 1) {
    throw new Error(`Only 16-bit mono WAV supported, got ${bitsPerSample}-bit ${numChannels}ch`);
  }

  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      const dataOffset = offset + 8;
      const numSamples = chunkSize / 2;
      const samples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768.0;
      }
      return { samples, sampleRate };
    }
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }
  throw new Error('No data chunk found in WAV');
}

// ─── Model path resolution ───

function getModelPath(modelsDir: string, subdir: string, filename: string): string {
  return path.join(modelsDir, subdir, filename);
}

function resolveSegModel(modelsDir: string): string {
  for (const dir of ['pyannote', 'pyannote-segmentation']) {
    const int8 = getModelPath(modelsDir, dir, 'model.int8.onnx');
    if (fs.existsSync(int8)) return int8;
    const fp32 = getModelPath(modelsDir, dir, 'model.onnx');
    if (fs.existsSync(fp32)) return fp32;
  }
  throw new Error('Segmentation model not found');
}

function resolveEmbedModel(modelsDir: string): string {
  for (const dir of ['speaker', '3dspeaker']) {
    const large = getModelPath(modelsDir, dir, '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(large)) return large;
    const base = getModelPath(modelsDir, dir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(base)) return base;
  }
  throw new Error('Speaker embedding model not found');
}

// ─── Cosine similarity ───

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── IPC types ───

interface VadEmbedRequest {
  type: 'vadEmbed';
  audioPath: string;
  modelsDir: string;
  clusteringThreshold?: number;
  minSilence?: number;
  minSpeech?: number;
}

// ─── Main logic ───

function run(request: VadEmbedRequest): void {
  const { audioPath, modelsDir, clusteringThreshold = 0.45 } = request;

  try {
    try {
      require('./patch-module-paths').patchModulePathsForPackagedBuild();
    } catch {
      // Not in packaged build
    }

    const sherpa = require('sherpa-onnx-node');
    const rawWave = readWavPure(audioPath);
    const sampleRate = rawWave.sampleRate;
    // Copy to V8-allocated memory (Electron's V8 rejects fs.readFileSync buffers)
    const samples = new Float32Array(rawWave.samples.length);
    samples.set(rawWave.samples);
    const totalDuration = samples.length / sampleRate;

    console.log(`[vad-embed-subprocess] Audio: ${totalDuration.toFixed(1)}s @ ${sampleRate}Hz`);

    if (samples.length < sampleRate) {
      process.send!({ type: 'error', message: `Audio too short: ${totalDuration.toFixed(1)}s` });
      return;
    }

    // ─── Step 1: Use OfflineSpeakerDiarization for segment detection ───
    // This API returns plain {start, end, speaker} objects (no Float32Array)
    // so it works in Electron's forked V8.
    const diarConfig = {
      segmentation: { pyannote: { model: resolveSegModel(modelsDir) } },
      embedding: { model: resolveEmbedModel(modelsDir) },
      clustering: { numClusters: -1, threshold: clusteringThreshold },
      minDurationOn: 0.2,
      minDurationOff: 0.25,
    };

    const sd = new sherpa.OfflineSpeakerDiarization(diarConfig);

    if (sd.sampleRate !== sampleRate) {
      process.send!({ type: 'error', message: `Sample rate mismatch: model=${sd.sampleRate} audio=${sampleRate}` });
      return;
    }

    const rawSegments = sd.process(samples);

    // Build segments with speaker labels (already clustered by OfflineSpeakerDiarization)
    const segments: Array<{ start: number; end: number; speaker: number }> = rawSegments.map((seg: any) => ({
      start: Number(seg.start),
      end: Number(seg.end),
      speaker: Number(seg.speaker),
    }));

    const uniqueSpeakers = [...new Set(segments.map(s => s.speaker))];
    console.log(`[vad-embed-subprocess] Result: ${segments.length} segments, ${uniqueSpeakers.length} speakers`);

    process.send!({
      type: 'result',
      segments,
      duration: totalDuration,
    });

  } catch (err: any) {
    try {
      process.send!({ type: 'error', message: err.message || String(err) });
    } catch {
      // IPC closed
    }
    process.exit(1);
  }
}

// ─── IPC listener ───

process.on('message', (msg: any) => {
  if (msg?.type === 'vadEmbed') {
    run(msg as VadEmbedRequest);
  }
});

process.send!({ type: 'ready' });
