/**
 * embed-subprocess.ts — Isolated child process for speaker embedding extraction.
 *
 * Runs sherpa-onnx speaker embedding extraction in a separate process so that
 * native crashes (e.g. ONNX BFCArena assertion failures) do NOT kill the main
 * Electron process. The parent (SherpaEngineProxy) forks this script and
 * communicates via IPC.
 *
 * Protocol:
 *   Parent → Child:  { type: 'extract', samplesBuffer: number[], sampleRate: number, modelsDir: string }
 *   Parent → Child:  { type: 'extractFromFile', audioPath: string, modelsDir: string }
 *   Child  → Parent: { type: 'result', embedding: number[] }
 *   Child  → Parent: { type: 'error', message: string }
 */

import fs from 'fs';
import path from 'path';

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

// ─── Model path helper ──────────────────────────────────────

/** Resolve embedding model with fallback to old (base) model/directory name. */
function resolveEmbedModel(modelsDir: string): string {
  for (const dir of ['speaker', '3dspeaker']) {
    const large = path.join(modelsDir, dir, '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(large)) return large;
    const base = path.join(modelsDir, dir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx');
    if (fs.existsSync(base)) return base;
  }
  return path.join(modelsDir, 'speaker', '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx');
}

// ─── Types ───────────────────────────────────────────────────

interface ExtractRequest {
  type: 'extract';
  samplesArray: number[];
  sampleRate: number;
  modelsDir: string;
}

interface ExtractFromFileRequest {
  type: 'extractFromFile';
  audioPath: string;
  modelsDir: string;
}

type EmbedRequest = ExtractRequest | ExtractFromFileRequest;

// ─── Cached extractor for multiple calls within same process ──

let cachedExtractor: any = null;
let cachedModelsDir: string = '';

function getExtractor(modelsDir: string): any {
  if (cachedExtractor && cachedModelsDir === modelsDir) return cachedExtractor;

  require('./patch-module-paths').patchModulePathsForPackagedBuild();
  const sherpa = require('sherpa-onnx-node');
  const modelPath = resolveEmbedModel(modelsDir);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Embedding model not found: ${modelPath}`);
  }

  cachedExtractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath });
  cachedModelsDir = modelsDir;
  return cachedExtractor;
}

// ─── Main logic ─────────────────────────────────────────────

function runExtract(request: ExtractRequest, reqId?: number): void {
  try {
    const extractor = getExtractor(request.modelsDir);
    const sherpa = require('sherpa-onnx-node');

    const samples = new Float32Array(request.samplesArray);

    // Minimum sample check
    if (samples.length < 1600) { // 0.1s at 16kHz
      process.send!({ type: 'error', reqId, message: `Audio too short for embedding: ${samples.length} samples` });
      return;
    }

    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: request.sampleRate, samples });
    stream.inputFinished();

    if (!extractor.isReady(stream)) {
      process.send!({ type: 'error', reqId, message: 'Extractor not ready after feeding samples' });
      return;
    }

    const embedding = extractor.compute(stream);
    process.send!({ type: 'result', reqId, embedding: Array.from(embedding) });
  } catch (err: any) {
    try {
      process.send!({ type: 'error', reqId, message: err.message || String(err) });
    } catch {
      // IPC channel may already be closed
    }
  }
}

function runExtractFromFile(request: ExtractFromFileRequest, reqId?: number): void {
  try {
    const wave = readWavPure(request.audioPath);
    runExtract({
      type: 'extract',
      samplesArray: Array.from(wave.samples),
      sampleRate: wave.sampleRate,
      modelsDir: request.modelsDir,
    }, reqId);
  } catch (err: any) {
    try {
      process.send!({ type: 'error', reqId, message: err.message || String(err) });
    } catch {}
  }
}

// ─── IPC listener ───────────────────────────────────────────

process.on('message', (msg: any) => {
  if (msg?.type === 'extract') {
    runExtract(msg as ExtractRequest, msg.reqId);
  } else if (msg?.type === 'extractFromFile') {
    runExtractFromFile(msg as ExtractFromFileRequest, msg.reqId);
  } else if (msg?.type === 'dispose') {
    cachedExtractor = null;
    process.exit(0);
  }
});

// Signal ready
process.send!({ type: 'ready' });
