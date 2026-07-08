import { ipcMain, BrowserWindow, Notification } from 'electron';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { IpcContext } from './context';
import { VoiceBrainDB } from '../db/database';
import { StreamingTranscriber, type LiveSegment } from '../audio/streaming-transcriber';
import { type RecordingScene, type AudioSource, getSceneConfig } from '../audio/recording-scene';
import { loadSettings, AppSettings } from '../settings';
import { getOutputDir, getVecDbPath } from '../paths';
import { getStr } from '../i18n';
import { runWithPriority } from '../llm/llm-scheduler';


// ─── Deferred post-processing ────────────────────────────────
let deferredPostProcess: (() => void) | null = null;

/**
 * Trigger deferred post-processing. Called by electron/main.ts
 * AFTER paste-clean finishes, so paste-clean gets LLM priority.
 */
export function triggerPostProcessing(): void {
  if (deferredPostProcess) {
    const fn = deferredPostProcess;
    deferredPostProcess = null;
    fn();
  }
}

// ─── Real-time streaming state ──────────────────────────────
let streamingTranscriber: StreamingTranscriber | null = null;
let prewarmedTranscriber: StreamingTranscriber | null = null;
let liveRecordingId: number | null = null;
let liveWavStream: fs.WriteStream | null = null;
let liveTotalSamples = 0;
let startupAudioBuffer: Buffer[] = [];
let lastLiveSegmentText = '';
let feedChunkCount = 0;
let currentScene: RecordingScene = 'dictation';
let systemTranscriber: StreamingTranscriber | null = null;
let systemWavStream: fs.WriteStream | null = null;
let systemTotalSamples = 0;
let systemWavPath = '';
let lastSystemSegmentText = '';


// ─── Session context & vocabulary accumulation ──────────────
let recentSegmentContext: { text: string; speaker?: string }[] = [];
let sessionVocabulary: Set<string> = new Set();
const CONTEXT_WINDOW_SIZE = 5;

// ─── Per-segment streaming LLM optimization ─────────────────
let liveDb: VoiceBrainDB | null = null;
const segOptList: { segId: number; rawText: string; promise: Promise<string> }[] = [];
let segOptimizerReady: Promise<{ optimizer: any; keepAlive?: string }> | null = null;
let segOptActive = 0;
const SEG_OPT_MAX_CONCURRENT = 2;
const segOptQueue: (() => void)[] = [];

// ─── Batched LLM optimization (dictation only, replaces per-segment) ────
const BATCH_OPT_SIZE = 5;          // flush every N segments
const BATCH_OPT_INTERVAL = 20_000; // or every 20 seconds
let batchOptBuffer: { segId: number; text: string; resolve: (v: string) => void }[] = [];
let batchOptTimer: ReturnType<typeof setTimeout> | null = null;
let batchOptSettings: AppSettings | null = null;

function segOptAcquire(): Promise<void> {
  if (segOptActive < SEG_OPT_MAX_CONCURRENT) {
    segOptActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => segOptQueue.push(resolve));
}

function segOptRelease(): void {
  segOptActive--;
  if (segOptQueue.length > 0) {
    segOptActive++;
    segOptQueue.shift()!();
  }
}

function getOrCreateSegOptimizer(settings: AppSettings): Promise<{ optimizer: any; keepAlive?: string }> {
  if (!segOptimizerReady) {
    segOptimizerReady = (async () => {
      const { createLLMClient: createClient } = await import('../llm/create-client');
      const { resolvePasteCleanModel } = await import('../llm/paste-clean-model');
      const { TextOptimizer } = await import('../llm/text-optimizer');
      const { model, keepAlive } = await resolvePasteCleanModel(settings);
      const llmClient = createClient(settings);
      return { optimizer: new TextOptimizer(llmClient, model), keepAlive };
    })();
  }
  return segOptimizerReady;
}

function buildContextPrompt(_rawText: string, customPrompt: string | undefined): string {
  // If no context or vocabulary accumulated, use original behavior
  if (recentSegmentContext.length === 0 && sessionVocabulary.size === 0) {
    return customPrompt || '';
  }

  const parts: string[] = [];

  if (sessionVocabulary.size > 0) {
    const terms = [...sessionVocabulary].slice(0, 30).join('、');
    parts.push(`【已知术语】${terms}`);
  }

  if (recentSegmentContext.length > 0) {
    const ctx = recentSegmentContext
      .slice(-CONTEXT_WINDOW_SIZE)
      .map(s => {
        const prefix = s.speaker ? `[${s.speaker}] ` : '';
        return prefix + s.text;
      })
      .join('\n');
    parts.push(`【近期上下文】\n${ctx}`);
  }

  if (customPrompt) {
    parts.push(customPrompt);
  }

  parts.push('请根据上下文优化以下转录文字，保持术语和人名一致。如果发现新的专有名词或术语，在文末用 ##TERMS: 词1,词2 的格式标注。');

  return parts.join('\n');
}

function extractTermsFromResponse(text: string): { cleanText: string; terms: string[] } {
  const termsMatch = text.match(/##TERMS:\s*(.+)$/m);
  if (termsMatch) {
    const cleanText = text.replace(/##TERMS:\s*.+$/m, '').trim();
    const terms = termsMatch[1].split(/[,，、]/).map(t => t.trim()).filter(Boolean);
    return { cleanText, terms };
  }
  return { cleanText: text, terms: [] };
}

/**
 * Batched optimization for dictation scene.
 * Accumulates segments and flushes them in a single LLM call
 * (every BATCH_OPT_SIZE segments or BATCH_OPT_INTERVAL ms).
 * Reduces LLM call count by ~80% vs per-segment approach.
 */
function startBatchedOptimization(segId: number, rawText: string, settings: AppSettings): void {
  if (!rawText.trim()) return;

  batchOptSettings = settings;
  const promise = new Promise<string>((resolve) => {
    batchOptBuffer.push({ segId, text: rawText, resolve });
  });
  segOptList.push({ segId, rawText, promise });

  if (batchOptBuffer.length >= BATCH_OPT_SIZE) {
    flushBatchOptimization();
  } else if (!batchOptTimer) {
    batchOptTimer = setTimeout(() => flushBatchOptimization(), BATCH_OPT_INTERVAL);
  }
}

async function flushBatchOptimization(): Promise<void> {
  if (batchOptTimer) { clearTimeout(batchOptTimer); batchOptTimer = null; }
  if (batchOptBuffer.length === 0) return;

  const batch = [...batchOptBuffer];
  batchOptBuffer = [];
  const settings = batchOptSettings!;

  await segOptAcquire();
  const t0 = Date.now();
  try {
    const { optimizer, keepAlive } = await getOrCreateSegOptimizer(settings);
    const combined = batch.map(b => b.text).join('\n');
    const customPrompt = settings.llmCleanPrompt?.trim() || undefined;
    const contextPrompt = buildContextPrompt(combined, customPrompt);
    const cleanResponse = await optimizer.cleanText(combined, contextPrompt || customPrompt, keepAlive);

    const { cleanText, terms } = extractTermsFromResponse(cleanResponse);
    for (const term of terms) sessionVocabulary.add(term);

    // Map cleaned lines back to individual segments
    const cleanLines = cleanText.split('\n').filter(Boolean);

    for (let i = 0; i < batch.length; i++) {
      const seg = batch[i];
      let segClean: string;

      if (cleanLines.length === batch.length) {
        segClean = cleanLines[i]; // perfect 1:1 mapping
      } else if (batch.length === 1) {
        segClean = cleanText;
      } else {
        // LLM merged/split text — assign full text to first, raw to rest
        segClean = i === 0 ? cleanText : seg.text;
      }

      if (liveDb && segClean.trim()) {
        try { liveDb.updateSegmentCleanText(seg.segId, segClean); } catch { /* ignore */ }
      }

      recentSegmentContext.push({ text: segClean || seg.text });
      seg.resolve(segClean);

      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('live:segmentOptimized', { segId: seg.segId, cleanText: segClean });
        }
      }
    }

    if (recentSegmentContext.length > CONTEXT_WINDOW_SIZE * 2) {
      recentSegmentContext = recentSegmentContext.slice(-CONTEXT_WINDOW_SIZE);
    }

    console.log(`[realtime] Batch optimized ${batch.length} segments in 1 LLM call (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.warn('[realtime] Batch optimization failed:', err);
    for (const seg of batch) {
      recentSegmentContext.push({ text: seg.text });
      seg.resolve(seg.text); // fallback to raw
    }
  } finally {
    segOptRelease();
  }
}

/** Returns true if there are any pending or in-progress segment optimizations. */
export function hasPendingSegmentOptimizations(): boolean {
  return segOptList.length > 0 || batchOptBuffer.length > 0;
}

/**
 * Merge consecutive short text fragments into adjacent longer texts.
 * Short fragments (< 10 chars) are prepended to the next long text.
 * Trailing short fragments append to the last long text.
 */
function mergeShortSegments(texts: string[], continuous: boolean): string {
  if (texts.length <= 1) return texts.join('');

  const merged: string[] = [];
  let pendingShort = '';

  for (const t of texts) {
    if (t.length < 10) {
      pendingShort += t;
    } else {
      if (pendingShort) {
        merged.push(pendingShort + t);
        pendingShort = '';
      } else {
        merged.push(t);
      }
    }
  }

  // Trailing short fragments — append to last long text or push as-is
  if (pendingShort) {
    if (merged.length > 0) {
      merged[merged.length - 1] += pendingShort;
    } else {
      merged.push(pendingShort);
    }
  }

  return continuous ? merged.join('') : merged.join('\n');
}

/**
 * Await streaming segment optimizations with a timeout.
 * Returns merged text using clean_text where available, raw_text as fallback.
 * Pending optimizations continue in background — results written to DB for markdown/RAG.
 */
export async function awaitAndMergeSegmentOptimizations(
  recordingId: number,
  timeoutMs = 3000,
): Promise<string> {
  const settings = loadSettings();
  const t0 = Date.now();

  if (segOptList.length === 0) {
    // No optimizations were queued — read all segments raw from DB
    if (liveDb) {
      const segments = liveDb.getSegmentsByRecording(recordingId);
      const texts = segments
        .map(s => s.clean_text || s.raw_text || '')
        .filter(Boolean);
      const hasClean = segments.some(s => s.clean_text && s.clean_text !== s.raw_text);
      console.log(`[realtime] awaitMerge: no segOptList, ${segments.length} segs from DB, hasCleanText=${hasClean} (${Date.now() - t0}ms)`);
      return mergeShortSegments(texts, !!settings.clipboardContinuous);
    }
    console.log(`[realtime] awaitMerge: no segOptList, no liveDb`);
    return '';
  }

  // Race: wait for all optimizations OR timeout (whichever comes first)
  console.log(`[realtime] awaitMerge: waiting for ${segOptList.length} optimizations (timeout=${timeoutMs}ms)...`);
  const allDone = Promise.allSettled(segOptList.map(o => o.promise));
  await Promise.race([allDone, new Promise(r => setTimeout(r, timeoutMs))]);
  const elapsed = Date.now() - t0;

  // Read from DB — includes all segments (optimized, short, and still-pending)
  // Already-completed optimizations have clean_text written to DB.
  // Still-pending ones have clean_text = NULL → falls back to raw_text.
  if (liveDb) {
    const segments = liveDb.getSegmentsByRecording(recordingId);
    const cleanCount = segments.filter(s => s.clean_text && s.clean_text !== s.raw_text).length;
    console.log(`[realtime] awaitMerge: done in ${elapsed}ms, ${segments.length} segs, ${cleanCount} optimized`);
    const texts = segments
      .map(s => s.clean_text || s.raw_text || '')
      .filter(Boolean);
    return mergeShortSegments(texts, !!settings.clipboardContinuous);
  }

  // Fallback: use segOptList (missing short segments — should rarely happen)
  const results = await Promise.allSettled(segOptList.map(o => o.promise));
  const texts = segOptList.map((o, i) => {
    const r = results[i];
    return r.status === 'fulfilled' ? r.value : o.rawText;
  }).filter(Boolean);
  return mergeShortSegments(texts, !!settings.clipboardContinuous);
}

/**
 * Full-text paste-clean: run the complete merged text through LLM
 * with DEFAULT_PASTE_CLEAN_PROMPT for coherent paragraph output.
 * Removes filler words, merges fragments, fixes punctuation.
 */
export async function pasteClean(text: string, settings: AppSettings): Promise<string> {
  if (!text.trim() || text.trim().length < 10) return text;

  const { TextOptimizer, DEFAULT_PASTE_CLEAN_PROMPT } = await import('../llm/text-optimizer');
  const { createLLMClient } = await import('../llm/create-client');
  const { resolvePasteCleanModel } = await import('../llm/paste-clean-model');

  const client = createLLMClient(settings);
  const { model, keepAlive } = await resolvePasteCleanModel(settings);
  const optimizer = new TextOptimizer(client, model);

  return optimizer.cleanText(text, DEFAULT_PASTE_CLEAN_PROMPT, keepAlive);
}

function clearSegmentOptimizations(): void {
  segOptList.length = 0;
  segOptimizerReady = null;
  segOptActive = 0;
  segOptQueue.length = 0;
  // Clear batch state
  if (batchOptTimer) { clearTimeout(batchOptTimer); batchOptTimer = null; }
  batchOptBuffer = [];
  batchOptSettings = null;
  liveDb = null;
  recentSegmentContext = [];
  sessionVocabulary.clear();
}

// ─── WAV Header Helpers ─────────────────────────────────────

function createWavHeader(
  dataSize: number,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);                          // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);            // ChunkSize
  header.write('WAVE', 8);                           // Format
  header.write('fmt ', 12);                          // Subchunk1ID
  header.writeUInt32LE(16, 16);                      // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                       // AudioFormat (PCM = 1)
  header.writeUInt16LE(channels, 22);                // NumChannels
  header.writeUInt32LE(sampleRate, 24);              // SampleRate
  header.writeUInt32LE(byteRate, 28);                // ByteRate
  header.writeUInt16LE(blockAlign, 32);              // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);           // BitsPerSample
  header.write('data', 36);                          // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);                // Subchunk2Size

  return header;
}

function fixWavHeader(filePath: string, dataSize: number): void {
  try {
    const fd = fs.openSync(filePath, 'r+');
    const header = createWavHeader(dataSize);
    fs.writeSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
  } catch (err) {
    console.error('[realtime] Failed to fix WAV header:', err);
  }
}

/**
 * Get the speaker label for "Me" — used for LIVE recordings to label mic segments.
 */
function getSelfSpeakerLabel(lang: string): string {
  return lang === 'zh' ? '我' : 'Me';
}

/**
 * Determine if diarization should be skipped for this recording.
 * - dictation scene: always skip — it's the user speaking
 * - Legacy LIVE- prefix without scene info: skip
 * - File recordings < 60s: skip — likely single speaker
 */
export function shouldSkipDiarization(recording: { file_name: string; duration_seconds: number | null; capture_scene?: string | null }): boolean {
  if (recording.capture_scene === 'dictation') return true;
  // Legacy: skip LIVE- prefix without scene info
  if (recording.file_name.startsWith('LIVE-') && !recording.capture_scene) return true;
  if (recording.duration_seconds && recording.duration_seconds < 60) return true;
  return false;
}

async function diarizeAudioForRecording(
  recordingId: number,
  audioPath: string,
  database: VoiceBrainDB,
  settings: AppSettings,
  ctx: IpcContext,
  source: AudioSource,
): Promise<void> {
  const engine = ctx.getSherpaEngine();
  const { loadSettings } = await import('../settings');
  const appSettings = loadSettings();
  const diarizationMethod = (appSettings as any).diarizationMethod || 'embedding';

  let diarResult: import('../audio/diarizer').DiarizeResult;

  if (diarizationMethod === 'embedding') {
    // New: VAD + embedding via subprocess (avoids Worker external buffer issues)
    const { EmbeddingDiarizer } = await import('../audio/embedding-diarizer');
    const embDiarizer = new EmbeddingDiarizer(engine);

    // EmbeddingDiarizer runs its own VAD in a subprocess — no need to call
    // engine.vadDetectSegments() (which fails with external buffer errors in Workers)
    // Adaptive threshold: higher for short audio (less data = more conservative)
    let threshold = 0.55;
    try {
      const stats = require('fs').statSync(audioPath);
      const estDuration = stats.size / 32000; // 16kHz * 2 bytes/sample
      threshold = estDuration < 60 ? 0.50 : estDuration < 300 ? 0.55 : 0.60;
    } catch { /* use default */ }

    diarResult = await embDiarizer.diarize(audioPath, [], {
      numSpeakers: -1,
      clusteringThreshold: threshold,
      boundaryExpansion: 0,    // don't expand — we only need speaker labels for merge
      maxGapToFill: 0.5,       // reduce gap fill to avoid wrong speaker matching
    });
  } else {
    // Legacy: OfflineSpeakerDiarization subprocess
    const { Diarizer } = await import('../audio/diarizer');
    const diarizer = new Diarizer(engine);
    diarResult = await diarizer.diarize(audioPath);
  }

  if (!diarResult.segments || diarResult.segments.length === 0) {
    console.warn(`[realtime] No diarization segments for ${source} audio`);
    return;
  }

  const segments = database.getSegmentsByRecording(recordingId)
    .filter(s => (s as any).source === source || (!source && true));
  const speakerPrefix = settings.language === 'zh' ? '说话人' : 'Speaker';

  // Collect diarization label → time ranges for embedding extraction
  const speakerSegmentsMap: { [label: string]: { start: number; end: number }[] } = {};
  for (const ds of diarResult.segments) {
    if (!speakerSegmentsMap[ds.speaker]) {
      speakerSegmentsMap[ds.speaker] = [];
    }
    speakerSegmentsMap[ds.speaker].push({ start: ds.start, end: ds.end });
  }

  // Map diarization labels to user-facing speaker labels (no person auto-creation)
  const labelMap = new Map<string, string>();
  for (const origLabel of Object.keys(speakerSegmentsMap)) {
    const label = `${speakerPrefix} ${labelMap.size + 1}`;
    labelMap.set(origLabel, label);
  }

  // Assign speaker_label to segments based on diarization overlap
  for (const seg of segments) {
    let bestSpeaker = '';
    let bestOverlap = 0;
    for (const ds of diarResult.segments) {
      const segStart = seg.start_time ?? 0;
      const segEnd = seg.end_time ?? segStart;
      const overlap = Math.min(segEnd, ds.end) - Math.max(segStart, ds.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = ds.speaker;
      }
    }
    if (bestSpeaker && labelMap.has(bestSpeaker)) {
      const label = labelMap.get(bestSpeaker)!;
      database.getRawDb().prepare('UPDATE segments SET speaker_label = ? WHERE id = ?').run(label, seg.id);
    }
  }

  console.log(`[realtime] Diarization (${source}): ${labelMap.size} speaker labels assigned`);
}

async function postProcessLiveRecording(
  recordingId: number,
  database: VoiceBrainDB,
  settings: AppSettings,
  ctx: IpcContext,
  scene: RecordingScene = 'dictation',
  sysWavPath?: string,
): Promise<void> {
  console.log(`[realtime] Starting post-processing for recording ${recordingId}`);
  const ppStart = Date.now();
  const timer = (label: string) => console.log(`[realtime] ${label}: ${((Date.now() - ppStart) / 1000).toFixed(1)}s`);

  const segments = database.getSegmentsByRecording(recordingId);
  const recording = database.getRecording(recordingId);
  if (!recording || segments.length === 0) {
    database.updateRecordingStatus(recordingId, 'completed');
    return;
  }

  const config = getSceneConfig(scene);

  // Speaker labeling: mic segments (no person auto-creation)
  if (config.micSpeakerStrategy === 'auto_me') {
    const selfLabel = getSelfSpeakerLabel(settings.language);
    const micSegs = segments.filter(s => (s as any).source === 'mic' || !(s as any).source);
    for (const seg of micSegs) {
      database.getRawDb().prepare('UPDATE segments SET speaker_label = ? WHERE id = ?').run(selfLabel, seg.id);
    }
    console.log(`[realtime] Mic segments labeled as "${selfLabel}"`);
    timer('1a. Mic speaker labeling');
  } else if (config.micSpeakerStrategy === 'diarize') {
    if (recording) {
      try {
        await diarizeAudioForRecording(recordingId, recording.file_path, database, settings, ctx, 'mic');
        timer('1a. Mic diarization');
      } catch (err) {
        console.warn('[realtime] Mic diarization failed, labeling as "Me":', err);
        const selfLabel = getSelfSpeakerLabel(settings.language);
        const micSegs = segments.filter(s => (s as any).source === 'mic' || !(s as any).source);
        for (const seg of micSegs) {
          database.getRawDb().prepare('UPDATE segments SET speaker_label = ? WHERE id = ?').run(selfLabel, seg.id);
        }
      }
    }
  }

  // Speaker labeling: system segments (no person auto-creation)
  if (config.systemSpeakerStrategy === 'diarize' && sysWavPath) {
    try {
      await diarizeAudioForRecording(recordingId, sysWavPath, database, settings, ctx, 'system');
      timer('1b. System diarization');
    } catch (err) {
      console.warn('[realtime] System diarization failed:', err);
      const otherLabel = settings.language === 'zh' ? '对方' : 'Others';
      const sysSegs = segments.filter(s => (s as any).source === 'system');
      for (const seg of sysSegs) {
        database.getRawDb().prepare('UPDATE segments SET speaker_label = ? WHERE id = ?').run(otherLabel, seg.id);
      }
    }
  } else if (config.systemSpeakerStrategy === 'auto_system') {
    const sysLabel = settings.language === 'zh' ? '系统' : 'System';
    const sysSegs = segments.filter(s => (s as any).source === 'system');
    for (const seg of sysSegs) {
      database.getRawDb().prepare('UPDATE segments SET speaker_label = ? WHERE id = ?').run(sysLabel, seg.id);
    }
    console.log(`[realtime] System segments labeled as "${sysLabel}"`);
    timer('1b. System speaker labeling');
  }

  // 2. LLM text optimization + 3. Info extraction
  const llmTask = (async () => {
    try {
      const { createLLMClient: createClient, getLLMModel: getModel } = await import('../llm/create-client');
      const { TextOptimizer } = await import('../llm/text-optimizer');
      const llmClient = createClient(settings);
      const optimizer = new TextOptimizer(llmClient, getModel(settings));

      // 2a. Batch clean: optimize ALL segments together for better context
      const fullRawText = segments
        .map(s => s.raw_text || '')
        .filter(t => t.trim())
        .join('\n');

      if (fullRawText.length >= 10) {
        try {
          console.log(`[realtime] 2. Batch LLM optimization: ${fullRawText.length} chars, ${segments.length} segments`);
          const batchCleaned = await optimizer.batchClean(fullRawText);
          timer('2. LLM batch optimization');

          // Map batch-cleaned text back to segments
          // Strategy: split by newline, assign to segments; if line count doesn't match, use proportional mapping
          const cleanedLines = batchCleaned.split('\n').filter(l => l.trim());
          const rawSegs = segments.filter(s => s.raw_text?.trim());

          if (cleanedLines.length === rawSegs.length) {
            // Line count matches — assign 1:1
            for (let i = 0; i < rawSegs.length; i++) {
              database.updateSegmentCleanText(rawSegs[i].id, cleanedLines[i]);
            }
          } else if (cleanedLines.length === 1 || rawSegs.length <= 3) {
            // LLM merged everything into one paragraph — store full text on first segment,
            // store relevant portions on remaining segments
            database.updateSegmentCleanText(rawSegs[0].id, batchCleaned);
            for (let i = 1; i < rawSegs.length; i++) {
              database.updateSegmentCleanText(rawSegs[i].id, '');
            }
          } else {
            // Fallback: proportional mapping
            let lineIdx = 0;
            for (let i = 0; i < rawSegs.length; i++) {
              if (lineIdx < cleanedLines.length) {
                database.updateSegmentCleanText(rawSegs[i].id, cleanedLines[lineIdx]);
                lineIdx++;
              } else {
                database.updateSegmentCleanText(rawSegs[i].id, '');
              }
            }
          }
          console.log(`[realtime] Batch optimization: ${fullRawText.length} → ${batchCleaned.length} chars`);
        } catch (err) {
          console.warn('[realtime] Batch optimization failed, falling back to per-segment:', err);
          // Fallback: per-segment optimization
          for (const seg of segments) {
            if (!seg.raw_text) continue;
            try {
              const cleanText = await optimizer.cleanText(seg.raw_text);
              database.updateSegmentCleanText(seg.id, cleanText);
            } catch (segErr) {
              console.warn(`[realtime] LLM clean failed for segment ${seg.id}:`, segErr);
              try { database.updateSegmentCleanText(seg.id, seg.raw_text!); } catch { /* ignore */ }
            }
          }
          timer('2. LLM per-segment optimization (fallback)');
        }
      }

      // 2b. Information extraction
      if (!config.extractInfo) {
        console.log(`[realtime] Skipping info extraction (scene: ${scene})`);
      }
      const updatedSegments = database.getSegmentsByRecording(recordingId);
      const fullCleanText = updatedSegments
        .map((s) => s.clean_text || s.raw_text || '')
        .filter(Boolean)
        .join('\n');

      if (config.extractInfo && fullCleanText.length > 10) {
        try {
          const extracted = await optimizer.extractInfo(fullCleanText);
          if (extracted.items) {
            for (const item of extracted.items) {
              database.insertExtractedItem({
                segment_id: updatedSegments[0]?.id || null,
                type: item.type,
                content: item.content,
                due_date: item.due_date || undefined,
                related_person: item.related_person || undefined,
              });
            }
          }
          console.log(`[realtime] Extracted ${extracted.items?.length || 0} items`);
          timer('3. Info extraction');
        } catch (err) {
          console.warn('[realtime] Extraction failed:', err);
        }
      }

      // 2c. Memory extraction (fire-and-forget, only for personal scenes)
      if (config.extractMemory && fullCleanText.length > 20) {
        const memMgr = ctx.getMemoryManager();
        if (memMgr) {
          (async () => {
            try {
              const { MemoryExtractor } = await import('../agent/memory-extractor');
              const { createLLMClient: createClient2, getLLMModel: getModel2 } = await import('../llm/create-client');
              const llmClient = createClient2(settings);
              const llmModel = getModel2(settings);
              const extractor = new MemoryExtractor(llmClient, llmModel);
              const facts = await extractor.extract(fullCleanText);
              for (const fact of facts) {
                await memMgr.addFact(fact.fact, fact.category, fact.confidence, [recordingId]);
              }
              if (facts.length > 0) {
                console.log(`[realtime] Extracted ${facts.length} memories from recording ${recordingId}`);
              }
            } catch (err) {
              console.warn('[realtime] Memory extraction failed:', err);
            }
          })();
        }
      } else if (!config.extractMemory) {
        console.log(`[realtime] Skipping memory extraction (scene: ${scene})`);
      }
    } catch (err) {
      console.warn('[realtime] LLM processing skipped:', err);
    }
  })();

  // Wait for LLM tasks (diarization already done above, or skipped)
  await llmTask;

  // 4. Vector indexing (embed segments in parallel, insert sequentially)
  try {
    const updatedSegments = database.getSegmentsByRecording(recordingId);
    const { createEmbedClient: createEmbed, getEmbedModel: getEmbed } = await import('../llm/create-client');
    const embedClient = createEmbed(settings);
    const embedModel = getEmbed(settings);
    const vecDb = new DatabaseSync(getVecDbPath(), { allowExtension: true });
    vecDb.exec('PRAGMA journal_mode = WAL');
    const { VectorStore } = await import('../rag/vector-store');
    const vs = new VectorStore(vecDb);

    // Filter segments with valid text
    const validSegs = updatedSegments.filter((seg) => {
      const text = seg.clean_text || seg.raw_text || '';
      return text.length >= 5;
    });

    // Embed in parallel with concurrency limit of 3
    const CONCURRENCY = 3;
    const embedResults: { segId: number; embedding: number[] }[] = [];
    for (let i = 0; i < validSegs.length; i += CONCURRENCY) {
      const batch = validSegs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (seg) => {
          const text = seg.clean_text || seg.raw_text || '';
          const embedding = await embedClient.embed(embedModel, text);
          return { segId: seg.id, embedding };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          embedResults.push(r.value);
        } else {
          console.warn(`[realtime] Embedding failed:`, r.reason);
        }
      }
    }

    // Insert sequentially into sqlite-vec
    for (const { segId, embedding } of embedResults) {
      vs.insert(segId, embedding);
    }
    vecDb.close();
    console.log(`[realtime] Indexed ${embedResults.length}/${updatedSegments.length} segments`);
    timer('4. Vector indexing');
  } catch (err) {
    console.warn('[realtime] Vector indexing skipped:', err);
  }

  // 5. Markdown generation
  try {
    const updatedSegments = database.getSegmentsByRecording(recordingId);
    const { MarkdownGenerator } = await import('../output/markdown-generator');
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir, settings.obsidianWikilinks);
    const { formatLocalDate } = await import('../utils/date');
    const today = formatLocalDate();
    const baseName = recording.file_name.replace(/\.[^.]+$/, '');

    const transcriptMd = mdGen.buildTranscript({
      date: today,
      title: baseName,
      recordedAt: recording.recorded_at || undefined,
      segments: updatedSegments.map((s) => ({
        start: s.start_time ?? 0,
        end: s.end_time ?? s.start_time ?? 0,
        speaker: s.speaker_name || 'Unknown',
        text: s.raw_text || '',
        clean_text: s.clean_text || '',
      })),
    });
    mdGen.writeTranscript(today, baseName, transcriptMd);

    if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
      try {
        MarkdownGenerator.syncToVault(outputDir, settings.obsidianVaultDir, path.join('transcripts', today, `${baseName}.md`));
      } catch (err) {
        console.error('[realtime] Obsidian sync failed:', err);
      }
    }
    console.log(`[realtime] Markdown generated for ${baseName}`);
    timer('5. Markdown generation');
  } catch (err) {
    console.warn('[realtime] Markdown generation failed:', err);
  }

  // 6. Mark recording complete
  database.updateRecordingStatus(recordingId, 'completed');
  timer('TOTAL');
  console.log(`[realtime] Post-processing complete for recording ${recordingId}`);

  if (Notification.isSupported()) {
    new Notification({
      title: getStr('notify.live_complete') as string,
      body: (getStr('notify.live_complete_body') as Function)(recordingId) as string,
    }).show();
  }

  // 7. Broadcast post-processing complete
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('live:post_complete', { recordingId });
    }
  }
}

// ─── Public API Functions ────────────────────────────────────

/** Pre-warm a StreamingTranscriber so the next recording starts instantly. */
export function prewarmTranscriber(ctx?: IpcContext): void {
  if (prewarmedTranscriber) return; // already pre-warming or ready
  if (!ctx) return; // Need context for SherpaEngine

  const engine = ctx.getSherpaEngine();
  const t = new StreamingTranscriber(engine);
  prewarmedTranscriber = t;
  t.start().then(() => {
    console.log('[prewarm] StreamingTranscriber ready — next recording will start instantly');
  }).catch((err) => {
    console.warn('[prewarm] Failed to prewarm transcriber:', err.message);
    if (prewarmedTranscriber === t) prewarmedTranscriber = null;
  });
}

export async function startRealtimeTranscription(
  ctx: IpcContext,
  scene: RecordingScene = 'dictation',
  activeSources?: AudioSource[],
): Promise<{ success: boolean; recordingId?: number; error?: string }> {
  if (liveRecordingId !== null) {
    return { success: false, error: 'Already recording' };
  }

  try {
    const settings = loadSettings();
    currentScene = scene;
    const baseConfig = getSceneConfig(scene);
    const activeSourceSet = activeSources?.length ? new Set(activeSources) : null;
    const config = activeSourceSet ? {
      ...baseConfig,
      useMic: baseConfig.useMic && activeSourceSet.has('mic'),
      useSystem: baseConfig.useSystem && activeSourceSet.has('system'),
      micSpeakerStrategy: activeSourceSet.has('mic') ? baseConfig.micSpeakerStrategy : 'none' as const,
      systemSpeakerStrategy: activeSourceSet.has('system') ? baseConfig.systemSpeakerStrategy : 'none' as const,
    } : baseConfig;
    if (!config.useMic && !config.useSystem) {
      return { success: false, error: 'No active audio sources' };
    }
    console.log(`[realtime] Starting scene=${scene}, sources=${[
      config.useMic ? 'mic' : '',
      config.useSystem ? 'system' : '',
    ].filter(Boolean).join('+')}`);
    const database = ctx.getDb();
    const engine = ctx.getSherpaEngine();

    // 0. Disk space check — abort if < 500 MB free
    const saveDir = settings.watchDir || getOutputDir();
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    try {
      const stat = fs.statfsSync(saveDir);
      const freeBytes = stat.bavail * stat.bsize;
      const MIN_FREE = 500 * 1024 * 1024; // 500 MB
      if (freeBytes < MIN_FREE) {
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        return { success: false, error: `Insufficient disk space: ${freeMB} MB free (need 500 MB)` };
      }
    } catch (e) {
      console.warn('[realtime] Disk space check failed, proceeding anyway:', e);
    }

    // 1. Create DB record and WAV file FIRST so audio capture starts immediately
    const isDual = config.useMic && config.useSystem;
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const baseFileName = isDual ? `LIVE-${timestamp}_mic.wav` : `LIVE-${timestamp}.wav`;
    const wavPath = path.join(saveDir, baseFileName);

    const recordingId = database.insertRecording({
      file_path: wavPath,
      source_file_path: wavPath,
      file_name: baseFileName,
      recorded_at: new Date().toISOString(),
      status: 'recording',
      capture_scene: scene,
    });
    liveRecordingId = recordingId;
    liveTotalSamples = 0;
    feedChunkCount = 0;
    systemTotalSamples = 0;
    systemWavPath = '';
    lastSystemSegmentText = '';

    // Store DB reference and clear previous optimization state
    liveDb = database;
    clearSegmentOptimizations();
    liveDb = database; // re-set after clear

    // Open mic WAV file and write placeholder header
    if (config.useMic) {
      liveWavStream = fs.createWriteStream(wavPath);
      liveWavStream.write(createWavHeader(0)); // placeholder 44-byte header
    }

    // Open system WAV file if needed
    if (config.useSystem) {
      const sysFileName = isDual ? `LIVE-${timestamp}_system.wav` : `LIVE-${timestamp}.wav`;
      systemWavPath = path.join(saveDir, sysFileName);
      systemWavStream = fs.createWriteStream(systemWavPath);
      systemWavStream.write(createWavHeader(0));
      systemTotalSamples = 0;
      lastSystemSegmentText = '';
    }

    // 2. Use pre-warmed transcriber if available, otherwise create new one
    let usePrewarmed = false;
    if (prewarmedTranscriber?.isRunning()) {
      usePrewarmed = true;
    }

    // Scene-aware VAD config: meetings need shorter silence threshold to split between speakers
    const needsDiarize = config.micSpeakerStrategy === 'diarize' || config.systemSpeakerStrategy === 'diarize';
    const meetingVadConfig = needsDiarize ? {
      minSilenceDuration: 0.25,   // 250ms silence → split (vs default 500ms)
      minSpeechDuration: 0.15,    // Accept shorter speech segments
      maxSpeechDuration: 20,      // Force split at 20s (vs default 30s)
    } : undefined;

    if (usePrewarmed && !meetingVadConfig) {
      // Use pre-warmed transcriber only for non-meeting scenes (default VAD is fine)
      streamingTranscriber = prewarmedTranscriber!;
      prewarmedTranscriber = null;
      console.log('[realtime] Using pre-warmed transcriber — instant start');
    } else {
      // For meeting scenes or when no pre-warmed available: create new transcriber
      if (usePrewarmed) {
        // Discard the pre-warmed one — it has default VAD which is too aggressive for meetings
        prewarmedTranscriber!.destroy();
        prewarmedTranscriber = null;
        usePrewarmed = false;
      }
      streamingTranscriber = new StreamingTranscriber(engine);
      if (meetingVadConfig) {
        streamingTranscriber.setVadConfig(meetingVadConfig);
      }
      console.log(`[realtime] Creating new transcriber${meetingVadConfig ? ' (meeting VAD: minSilence=0.25s)' : ''}`);
    }


    // Wire segment/error events
    streamingTranscriber.on('segment', (seg: LiveSegment) => {
      try {
        const text = seg.text.trim();
        if (!text) return;

        // Dedup: skip if new text is contained in previous segment or vice versa
        if (lastLiveSegmentText) {
          if (lastLiveSegmentText.includes(text)) return;
          const shorter = text.length <= lastLiveSegmentText.length ? text : lastLiveSegmentText;
          const longer = text.length > lastLiveSegmentText.length ? text : lastLiveSegmentText;
          if (shorter.length > 5 && longer.includes(shorter)) return;
        }
        lastLiveSegmentText = text;
        console.log(`[realtime] Segment ${seg.index}: "${text.substring(0, 40)}" (${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s)`);

        const segId = database.insertSegment({
          recording_id: recordingId,
          start_time: seg.start,
          end_time: seg.end,
          raw_text: text,
          source: 'mic',
        });
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('live:segment', {
              id: segId,
              index: seg.index,
              start: seg.start,
              end: seg.end,
              text,
              recordingId,
              source: 'mic',
            });
          }
        }

        // Scene-aware LLM optimization during recording:
        // - dictation: batched optimization (every 5 segments or 20s, 1 LLM call per batch)
        // - meeting/media: skip entirely — post-processing batchClean handles it
        const currentSettings = loadSettings();
        if (currentSettings.llmCleanBeforePaste && currentScene === 'dictation') {
          startBatchedOptimization(segId, text, currentSettings);
        }

        // Live speaker identification removed — post-processing diarization handles speaker separation
      } catch (err) {
        console.error('[realtime] Failed to insert segment:', err);
      }
    });

    streamingTranscriber.on('error', (err: Error) => {
      console.error('[realtime] StreamingTranscriber error:', err);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('live:error', { message: err.message });
        }
      }
    });

    // Set up system transcriber if needed
    if (config.useSystem) {
      systemTranscriber = new StreamingTranscriber(engine);
      if (meetingVadConfig) {
        systemTranscriber.setVadConfig(meetingVadConfig);
      }

      systemTranscriber.on('segment', (seg: LiveSegment) => {
        try {
          const text = seg.text.trim();
          if (!text) return;

          // Dedup
          if (lastSystemSegmentText) {
            if (lastSystemSegmentText.includes(text)) return;
            const shorter = text.length <= lastSystemSegmentText.length ? text : lastSystemSegmentText;
            const longer = text.length > lastSystemSegmentText.length ? text : lastSystemSegmentText;
            if (shorter.length > 5 && longer.includes(shorter)) return;
          }
          lastSystemSegmentText = text;
          console.log(`[realtime:sys] Segment ${seg.index}: "${text.substring(0, 40)}" (${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s)`);

          const segId = database.insertSegment({
            recording_id: recordingId,
            start_time: seg.start,
            end_time: seg.end,
            raw_text: text,
            source: 'system',
          });
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('live:segment', {
                id: segId, index: seg.index, start: seg.start, end: seg.end,
                text, recordingId, source: 'system',
              });
            }
          }

          // System audio only exists in meeting/media scenes — skip per-segment LLM.
          // Post-processing batchClean will handle text optimization.

          // Live speaker identification removed — post-processing diarization handles speaker separation
        } catch (err) {
          console.error('[realtime:sys] Failed to insert segment:', err);
        }
      });

      systemTranscriber.on('error', (err: Error) => {
        console.error('[realtime:sys] StreamingTranscriber error:', err);
      });

      systemTranscriber.start().catch((err) => {
        console.error('[realtime:sys] Failed to start system transcriber:', err);
        systemTranscriber = null;
      });
    }

    // 3. If pre-warmed, transcriber is already running; otherwise start in background
    if (!usePrewarmed) {
      streamingTranscriber.start().then(() => {
        console.log('[realtime] StreamingTranscriber ready — live transcription active');
        // Flush any buffered audio
        if (streamingTranscriber && startupAudioBuffer.length > 0) {
          for (const buffered of startupAudioBuffer) {
            try { streamingTranscriber.feedAudio(buffered); } catch { /* ignore */ }
          }
          console.log(`[realtime] Flushed ${startupAudioBuffer.length} buffered chunks`);
          startupAudioBuffer = [];
        }
      }).catch((err) => {
        console.error('[realtime] StreamingTranscriber failed to start:', err);
        streamingTranscriber = null;
        startupAudioBuffer = [];
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('live:error', { message: `Transcriber failed: ${err.message}` });
          }
        }
      });
    }

    // Broadcast started immediately (WAV recording is active)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('live:started', { recordingId });
      }
    }

    return { success: true, recordingId };
  } catch (err: any) {
    // Clean up on failure
    if (streamingTranscriber) { streamingTranscriber.destroy(); streamingTranscriber = null; }
    if (systemTranscriber) { systemTranscriber.destroy(); systemTranscriber = null; }
    liveRecordingId = null;
    if (liveWavStream) { liveWavStream.end(); liveWavStream = null; }
    if (systemWavStream) { systemWavStream.end(); systemWavStream = null; }
    systemTotalSamples = 0;
    systemWavPath = '';
    startupAudioBuffer = [];
    lastLiveSegmentText = '';
    lastSystemSegmentText = '';
    return { success: false, error: err.message || 'Failed to start real-time recording' };
  }
}

export async function stopRealtimeTranscription(ctx: IpcContext): Promise<{ success: boolean; recordingId?: number; duration?: number; error?: string }> {
  if (liveRecordingId === null) {
    return { success: false, error: 'Not recording' };
  }
  const stopT0 = Date.now();
  const stopTimer = (label: string) => console.log(`[realtime] stop: ${label} (${((Date.now() - stopT0) / 1000).toFixed(1)}s)`);

  try {
    // Stop transcriber — use short timeout, don't block UI
    let transcriberDuration: number | undefined;
    if (streamingTranscriber) {
      if (streamingTranscriber.isRunning()) {
        try {
          const result = await streamingTranscriber.stop(3000); // 3s timeout (was 10s)
          transcriberDuration = result.duration;
        } catch (err) {
          console.warn('[realtime] Transcriber stop timeout, force killing');
          streamingTranscriber.destroy();
        }
      } else {
        streamingTranscriber.destroy();
      }
      streamingTranscriber = null;
    }
    stopTimer('mic transcriber stopped');

    // Stop system transcriber
    if (systemTranscriber) {
      if (systemTranscriber.isRunning()) {
        try {
          await systemTranscriber.stop(3000);
        } catch {
          systemTranscriber.destroy();
        }
      } else {
        systemTranscriber.destroy();
      }
      systemTranscriber = null;
    }
    lastSystemSegmentText = '';


    startupAudioBuffer = [];
    lastLiveSegmentText = '';

    // Fix WAV header with correct data size
    const dataSize = liveTotalSamples * 2; // 16-bit = 2 bytes/sample
    const database = ctx.getDb();
    const recording = database.getRecording(liveRecordingId!);

    if (liveWavStream) {
      await new Promise<void>((resolve) => {
        liveWavStream!.end(() => resolve());
      });
      liveWavStream = null;
    }

    if (recording) {
      fixWavHeader(recording.file_path, dataSize);
    }

    // Fix system WAV header
    if (systemWavStream) {
      const sysDataSize = systemTotalSamples * 2;
      await new Promise<void>((resolve) => {
        systemWavStream!.end(() => resolve());
      });
      systemWavStream = null;
      if (systemWavPath) {
        fixWavHeader(systemWavPath, sysDataSize);
      }
    }
    stopTimer('WAV headers fixed');

    // Update recording duration and status
    const duration = transcriberDuration || (liveTotalSamples / 16000);
    database.updateRecordingDuration(liveRecordingId!, duration);
    database.updateRecordingStatus(liveRecordingId!, 'post_processing');
    // Flush any remaining batched segments (dictation) so their promises resolve
    if (batchOptBuffer.length > 0) {
      flushBatchOptimization(); // async — promises tracked in segOptList
    }
    const pendingOpts = segOptList.length;
    console.log(`[realtime] stop: pending segment optimizations: ${pendingOpts}`);

    // Broadcast stopped
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('live:stopped', { recordingId: liveRecordingId });
      }
    }

    const recordingId = liveRecordingId!;
    liveRecordingId = null;
    liveTotalSamples = 0;
    systemTotalSamples = 0;

    // Defer post-processing — electron/main.ts calls triggerPostProcessing()
    // AFTER paste-clean finishes, so paste-clean gets LLM priority.
    const settings = loadSettings();
    deferredPostProcess = () => {
      // Post-processing is background work — its LLM calls yield to interactive
      // RAG/chat queries (mid-recording paste-clean already ran at interactive
      // priority before this point). See llm-scheduler.
      runWithPriority('background', () =>
        postProcessLiveRecording(recordingId, database, settings, ctx, currentScene, systemWavPath || undefined),
      ).catch((err) => {
        console.error('[realtime] Post-processing failed:', err);
        try {
          database.updateRecordingStatus(recordingId, 'failed');
        } catch { /* ignore */ }
      });
    };
    // Safety net: if triggerPostProcessing is never called (e.g. no paste flow),
    // start post-processing after 10s anyway
    setTimeout(() => {
      if (deferredPostProcess) {
        console.log('[realtime] Post-processing auto-triggered (safety net)');
        triggerPostProcessing();
      }
    }, 10_000);

    // Pre-warm next transcriber in background for instant next start
    prewarmTranscriber(ctx);

    return { success: true, recordingId, duration };
  } catch (err: any) {
    if (streamingTranscriber) { streamingTranscriber.destroy(); streamingTranscriber = null; }
    if (systemTranscriber) { systemTranscriber.destroy(); systemTranscriber = null; }
    liveRecordingId = null;
    liveTotalSamples = 0;
    systemTotalSamples = 0;
    startupAudioBuffer = [];
    lastLiveSegmentText = '';
    lastSystemSegmentText = '';
    if (liveWavStream) { liveWavStream.end(); liveWavStream = null; }
    if (systemWavStream) { systemWavStream.end(); systemWavStream = null; }
    systemWavPath = '';
    return { success: false, error: err.message || 'Failed to stop recording' };
  }
}

/** Return the current recording scene (used by main.ts for paste timeout). */
export function getCurrentScene(): RecordingScene {
  return currentScene;
}

export function cleanupRealtime(): { streamingTranscriber: StreamingTranscriber | null; prewarmedTranscriber: StreamingTranscriber | null; liveWavStream: fs.WriteStream | null } {
  const result = { streamingTranscriber, prewarmedTranscriber, liveWavStream };
  streamingTranscriber = null;
  prewarmedTranscriber = null;
  liveWavStream = null;
  systemTranscriber?.destroy();
  systemTranscriber = null;
  if (systemWavStream) { systemWavStream.end(); systemWavStream = null; }
  systemTotalSamples = 0;
  systemWavPath = '';
  lastSystemSegmentText = '';
  liveRecordingId = null;
  liveTotalSamples = 0;
  startupAudioBuffer = [];
  lastLiveSegmentText = '';
  clearSegmentOptimizations();
  return result;
}

// ─── IPC Handler Registration ────────────────────────────────

export function registerRealtimeHandlers(ctx: IpcContext): void {
  // ─── Real-time Transcription ──────────────────────────────

  ipcMain.handle('realtime:start', async (_event, scene?: RecordingScene) => {
    return startRealtimeTranscription(ctx, scene || 'dictation');
  });

  // Fire-and-forget: use ipcMain.on (NOT handle)
  ipcMain.on('realtime:chunk', (_event, buffer: ArrayBuffer, source: AudioSource = 'mic') => {
    // No active recording — skip
    if (liveRecordingId === null) return;

    const pcm = Buffer.from(buffer);

    if (source === 'mic') {
      // Write to mic WAV
      if (liveWavStream) {
        liveWavStream.write(pcm);
      }
      liveTotalSamples += pcm.length / 2;

      // Feed to mic transcriber (existing logic for streamingTranscriber)
      if (streamingTranscriber) {
        if (streamingTranscriber.isRunning()) {
          if (startupAudioBuffer.length > 0) {
            for (const buffered of startupAudioBuffer) {
              try { streamingTranscriber.feedAudio(buffered); } catch { /* ignore */ }
            }
            startupAudioBuffer = [];
          }
          try {
            streamingTranscriber.feedAudio(pcm);
            feedChunkCount++;
            if (feedChunkCount === 1 || feedChunkCount === 10 || feedChunkCount % 500 === 0) {
              const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
              let maxAbs = 0;
              for (let i = 0; i < samples.length; i++) {
                const abs = Math.abs(samples[i]);
                if (abs > maxAbs) maxAbs = abs;
              }
              console.log(`[realtime:mic] Chunk #${feedChunkCount} (${(liveTotalSamples / 16000).toFixed(1)}s) — ${pcm.length}B, max=${maxAbs}`);
            }
          } catch (err) {
            console.error('[realtime:mic] feedAudio error:', err);
          }
        } else {
          startupAudioBuffer.push(pcm);
        }
      }
    } else if (source === 'system') {
      // Write to system WAV
      if (systemWavStream) {
        systemWavStream.write(pcm);
      }
      systemTotalSamples += pcm.length / 2;

      // Feed to system transcriber
      if (systemTranscriber?.isRunning()) {
        try {
          systemTranscriber.feedAudio(pcm);
          const sysChunkNum = systemTotalSamples / (pcm.length / 2);
          if (sysChunkNum <= 1 || Math.floor(sysChunkNum) === 10 || Math.floor(sysChunkNum) % 500 === 0) {
            const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
            let maxAbs = 0;
            for (let i = 0; i < samples.length; i++) {
              const abs = Math.abs(samples[i]);
              if (abs > maxAbs) maxAbs = abs;
            }
            console.log(`[realtime:sys] Chunk #${Math.floor(sysChunkNum)} (${(systemTotalSamples / 16000).toFixed(1)}s) — ${pcm.length}B, max=${maxAbs}`);
          }
        } catch (err) {
          console.error('[realtime:sys] feedAudio error:', err);
        }
      }
    }
  });

  ipcMain.handle('realtime:stop', async () => {
    return stopRealtimeTranscription(ctx);
  });

  ipcMain.handle('realtime:status', () => {
    return {
      recording: liveRecordingId !== null,
      recordingId: liveRecordingId,
    };
  });

  // ─── System Audio Capture (deprecated — replaced by desktopCapturer) ──
  ipcMain.handle('systemAudio:listDevices', async () => []);
  ipcMain.handle('systemAudio:start', async () => ({ success: false, error: 'Deprecated: use scene-based recording' }));
  ipcMain.handle('systemAudio:stop', () => ({ success: false, error: 'Deprecated' }));
  ipcMain.handle('systemAudio:status', () => ({ capturing: false }));
}
