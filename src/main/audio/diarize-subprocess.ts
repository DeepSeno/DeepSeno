/**
 * diarize-subprocess.ts — Isolated child process for speaker diarization.
 *
 * Runs sherpa-onnx speaker diarization in a separate process so that
 * native crashes (e.g. Eigen assertion failures in pyannote) do NOT
 * kill the main Electron process. The parent (SherpaEngineProxy) forks
 * this script and communicates via IPC.
 *
 * For long audio (>15 min), uses chunked diarization: splits audio into
 * 10-minute chunks, diarizes each independently, then merges speaker
 * identities across chunks using embedding similarity.
 *
 * Protocol:
 *   Parent → Child:  { type: 'diarize', audioPath, modelsDir, clusteringThreshold? }
 *   Child  → Parent: { type: 'progress', chunk, totalChunks }
 *   Child  → Parent: { type: 'result', segments: [...] }
 *   Child  → Parent: { type: 'error', message: string }
 */

import fs from 'fs';
import path from 'path';

// ─── Chunking constants ─────────────────────────────────────

const CHUNK_THRESHOLD_SEC = 15 * 60;  // below this, single-pass
const CHUNK_DURATION_SEC = 5 * 60;    // 5-minute chunks (clustering is O(n²), smaller = much faster)
const CHUNK_OVERLAP_SEC = 30;         // 30s overlap between chunks
const SPEAKER_MERGE_THRESHOLD = 0.55; // cosine similarity for cross-chunk merge
const MAX_EMBED_SEC = 30;             // max audio per speaker for embedding

// ─── WAV reader (standalone copy to avoid cross-bundle imports) ───

function readWavPure(filePath: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a valid WAV file: ${filePath}`);
  }

  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let numChannels = 1;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (dataOffset === 0 || dataSize === 0) {
    throw new Error(`No data chunk found in WAV file: ${filePath}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample * numChannels;
    if (sampleOffset + bytesPerSample > buf.length) break;

    if (bitsPerSample === 16) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readInt16LE(sampleOffset + ch * bytesPerSample);
      }
      samples[i] = (sum / numChannels) / 32768.0;
    } else if (bitsPerSample === 32) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readFloatLE(sampleOffset + ch * bytesPerSample * numChannels);
      }
      samples[i] = sum / numChannels;
    }
  }

  return { samples, sampleRate };
}

// ─── Model path helpers ─────────────────────────────────────

function getModelPath(modelsDir: string, modelSet: string, fileName: string): string {
  return path.join(modelsDir, modelSet, fileName);
}

/** Resolve segmentation model with fallback to old model/directory name. */
function resolveSegModel(modelsDir: string): string {
  for (const dir of ['pyannote', 'pyannote-segmentation']) {
    const int8 = getModelPath(modelsDir, dir, 'model.int8.onnx');
    if (fs.existsSync(int8)) return int8;
    const fp32 = getModelPath(modelsDir, dir, 'model.onnx');
    if (fs.existsSync(fp32)) return fp32;
  }
  return getModelPath(modelsDir, 'pyannote', 'model.int8.onnx');
}

/** Resolve embedding model with fallback to old (base) model/directory name. */
function resolveEmbedModel(modelsDir: string): string {
  for (const dir of ['speaker', '3dspeaker']) {
    const large = getModelPath(modelsDir, dir, '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(large)) return large;
    const base = getModelPath(modelsDir, dir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(base)) return base;
  }
  return getModelPath(modelsDir, 'speaker', '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
}

// ─── Cosine similarity ──────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Types ──────────────────────────────────────────────────

interface DiarizeRequest {
  type: 'diarize';
  audioPath: string;
  modelsDir: string;
  clusteringThreshold?: number;
}

interface Segment {
  start: number;
  end: number;
  speaker: number;
}

interface ChunkDef {
  startSample: number;
  endSample: number;
  startTimeSec: number;
  endTimeSec: number;
}

// ─── Chunked diarization ────────────────────────────────────

function buildChunks(totalSamples: number, sampleRate: number): ChunkDef[] {
  const chunkSamples = CHUNK_DURATION_SEC * sampleRate;
  const overlapSamples = CHUNK_OVERLAP_SEC * sampleRate;
  const step = chunkSamples - overlapSamples;
  const chunks: ChunkDef[] = [];

  for (let start = 0; start < totalSamples; start += step) {
    let end = start + chunkSamples;
    if (end >= totalSamples) end = totalSamples;
    // If remaining tail is < 60s, merge into previous chunk
    if (end < totalSamples && totalSamples - end < 60 * sampleRate) {
      end = totalSamples;
    }
    chunks.push({
      startSample: start,
      endSample: end,
      startTimeSec: start / sampleRate,
      endTimeSec: end / sampleRate,
    });
    if (end === totalSamples) break;
  }
  return chunks;
}

function extractSpeakerEmbedding(
  sherpa: any,
  extractor: any,
  wave: { samples: Float32Array; sampleRate: number },
  segments: Segment[],
  chunkStartSample: number,
): number[] {
  // Collect up to MAX_EMBED_SEC of audio for this speaker
  const maxSamples = MAX_EMBED_SEC * wave.sampleRate;
  const parts: Float32Array[] = [];
  let collected = 0;

  for (const seg of segments) {
    if (collected >= maxSamples) break;
    const segStartSample = chunkStartSample + Math.floor(seg.start * wave.sampleRate);
    const segEndSample = chunkStartSample + Math.floor(seg.end * wave.sampleRate);
    const clampEnd = Math.min(segEndSample, wave.samples.length);
    if (clampEnd <= segStartSample) continue;
    const need = Math.min(clampEnd - segStartSample, maxSamples - collected);
    parts.push(wave.samples.subarray(segStartSample, segStartSample + need));
    collected += need;
  }

  if (collected < 1600) return []; // too short (< 0.1s)

  // Concatenate
  const combined = new Float32Array(collected);
  let off = 0;
  for (const p of parts) {
    combined.set(p, off);
    off += p.length;
  }

  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: combined });
  stream.inputFinished();
  if (!extractor.isReady(stream)) return [];
  return Array.from(extractor.compute(stream));
}

function mergeChunkResults(
  sherpa: any,
  chunkResults: { segments: Segment[]; chunk: ChunkDef }[],
  wave: { samples: Float32Array; sampleRate: number },
  modelsDir: string,
): Segment[] {
  if (chunkResults.length === 0) return [];
  if (chunkResults.length === 1) {
    // Single chunk — just offset times
    return chunkResults[0].segments.map(s => ({
      start: s.start + chunkResults[0].chunk.startTimeSec,
      end: s.end + chunkResults[0].chunk.startTimeSec,
      speaker: s.speaker,
    }));
  }

  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: resolveEmbedModel(modelsDir),
  });

  const globalSpeakers: { id: number; embedding: number[]; count: number }[] = [];
  const allSegments: Segment[] = [];

  for (let ci = 0; ci < chunkResults.length; ci++) {
    const { segments, chunk } = chunkResults[ci];

    // Determine keep boundary for overlap dedup
    const keepStart = ci === 0 ? 0 : (chunkResults[ci - 1].chunk.endTimeSec - CHUNK_OVERLAP_SEC / 2);
    const keepEnd = ci === chunkResults.length - 1
      ? Infinity
      : (chunk.endTimeSec - CHUNK_OVERLAP_SEC / 2);

    // Group segments by local speaker
    const bySpeaker = new Map<number, Segment[]>();
    for (const seg of segments) {
      let arr = bySpeaker.get(seg.speaker);
      if (!arr) { arr = []; bySpeaker.set(seg.speaker, arr); }
      arr.push(seg);
    }

    // Map local speaker → global speaker
    const localToGlobal = new Map<number, number>();

    for (const [localId, segs] of bySpeaker) {
      const emb = extractSpeakerEmbedding(sherpa, extractor, wave, segs, chunk.startSample);

      if (emb.length === 0) {
        // Can't extract embedding — assign new global ID
        const newId = globalSpeakers.length;
        globalSpeakers.push({ id: newId, embedding: [], count: 0 });
        localToGlobal.set(localId, newId);
        continue;
      }

      // Find best matching global speaker
      let bestGlobal: typeof globalSpeakers[0] | null = null;
      let bestSim = 0;
      for (const g of globalSpeakers) {
        if (g.embedding.length === 0) continue;
        const sim = cosineSimilarity(emb, g.embedding);
        if (sim > bestSim) { bestSim = sim; bestGlobal = g; }
      }

      if (bestGlobal && bestSim >= SPEAKER_MERGE_THRESHOLD) {
        localToGlobal.set(localId, bestGlobal.id);
        // Running average of embedding
        const n = bestGlobal.count;
        for (let i = 0; i < emb.length; i++) {
          bestGlobal.embedding[i] = (bestGlobal.embedding[i] * n + emb[i]) / (n + 1);
        }
        bestGlobal.count++;
      } else {
        const newId = globalSpeakers.length;
        globalSpeakers.push({ id: newId, embedding: emb, count: 1 });
        localToGlobal.set(localId, newId);
      }
    }

    // Remap and filter by keep boundary
    for (const seg of segments) {
      const absStart = seg.start + chunk.startTimeSec;
      const absEnd = seg.end + chunk.startTimeSec;
      if (absStart >= keepStart && absStart < keepEnd) {
        allSegments.push({
          start: absStart,
          end: absEnd,
          speaker: localToGlobal.get(seg.speaker) ?? seg.speaker,
        });
      }
    }
  }

  // Sort by start time
  allSegments.sort((a, b) => a.start - b.start);

  console.log(`[Diarize-Chunked] Merged ${chunkResults.length} chunks → ${allSegments.length} segments, ${globalSpeakers.length} speakers`);
  return allSegments;
}

// ─── Main logic ─────────────────────────────────────────────

function run(request: DiarizeRequest): void {
  const { audioPath, modelsDir } = request;

  try {
    require('./patch-module-paths').patchModulePathsForPackagedBuild();
    const sherpa = require('sherpa-onnx-node');
    const wave = readWavPure(audioPath);

    // Minimum audio length check
    const MIN_SAMPLES = 16000; // 1 second at 16kHz
    if (wave.samples.length < MIN_SAMPLES) {
      process.send!({ type: 'error', message: `Audio too short for diarization: ${wave.samples.length} samples (need >= ${MIN_SAMPLES})` });
      process.exit(0);
      return;
    }

    const durationSec = wave.samples.length / wave.sampleRate;
    const threshold = request.clusteringThreshold ?? 0.45;

    const config = {
      segmentation: { pyannote: { model: resolveSegModel(modelsDir) } },
      embedding: { model: resolveEmbedModel(modelsDir) },
      clustering: { numClusters: -1, threshold },
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    };

    // Decide single-pass vs chunked
    if (durationSec < CHUNK_THRESHOLD_SEC) {
      // ── Single-pass (existing behavior) ──
      console.log(`[Diarize] Single-pass mode (${Math.round(durationSec)}s)`);
      const sd = new sherpa.OfflineSpeakerDiarization(config);

      if (sd.sampleRate !== wave.sampleRate) {
        process.send!({ type: 'error', message: `Sample rate mismatch: model expects ${sd.sampleRate}, got ${wave.sampleRate}` });
        process.exit(0);
        return;
      }

      const segments = sd.process(wave.samples);
      process.send!({
        type: 'result',
        segments: segments.map((seg: any) => ({ start: seg.start, end: seg.end, speaker: seg.speaker })),
      });
    } else {
      // ── Chunked mode ──
      const chunks = buildChunks(wave.samples.length, wave.sampleRate);
      console.log(`[Diarize] Chunked mode: ${Math.round(durationSec)}s → ${chunks.length} chunks of ~${CHUNK_DURATION_SEC / 60}min`);

      // Create ONE diarization instance and reuse across all chunks
      // (model loading takes tens of seconds, must not repeat per chunk)
      const sd = new sherpa.OfflineSpeakerDiarization(config);

      if (sd.sampleRate !== wave.sampleRate) {
        process.send!({ type: 'error', message: `Sample rate mismatch: model expects ${sd.sampleRate}, got ${wave.sampleRate}` });
        process.exit(0);
        return;
      }

      const chunkResults: { segments: Segment[]; chunk: ChunkDef }[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkSamples = wave.samples.subarray(chunk.startSample, chunk.endSample);
        const chunkDurSec = chunkSamples.length / wave.sampleRate;

        console.log(`[Diarize] Chunk ${i + 1}/${chunks.length}: ${Math.round(chunk.startTimeSec)}s–${Math.round(chunk.endTimeSec)}s (${Math.round(chunkDurSec)}s)`);
        try { process.send!({ type: 'progress', chunk: i + 1, totalChunks: chunks.length }); } catch {}

        const rawSegs = sd.process(chunkSamples);

        const segments: Segment[] = rawSegs.map((seg: any) => ({
          start: seg.start,
          end: seg.end,
          speaker: seg.speaker,
        }));

        console.log(`[Diarize] Chunk ${i + 1}: ${segments.length} segments, ${new Set(segments.map(s => s.speaker)).size} speakers`);
        chunkResults.push({ segments, chunk });
      }

      // Merge speaker identities across chunks
      console.log('[Diarize] Merging speaker identities across chunks...');
      const merged = mergeChunkResults(sherpa, chunkResults, wave, modelsDir);

      process.send!({
        type: 'result',
        segments: merged.map(s => ({ start: s.start, end: s.end, speaker: s.speaker })),
      });
    }

    process.exit(0);
  } catch (err: any) {
    try {
      process.send!({ type: 'error', message: err.message || String(err) });
    } catch {
      // IPC channel may already be closed
    }
    process.exit(1);
  }
}

// ─── IPC listener ───────────────────────────────────────────

process.on('message', (msg: any) => {
  if (msg?.type === 'diarize') {
    run(msg as DiarizeRequest);
  }
});

// Signal ready
process.send!({ type: 'ready' });
