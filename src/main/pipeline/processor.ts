import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { VoiceBrainDB } from '../db/database';
import { AudioPreprocessor } from '../audio/preprocessor';
import { Transcriber } from '../audio/transcriber';
import { Diarizer } from '../audio/diarizer';
import { EmbeddingDiarizer } from '../audio/embedding-diarizer';
import { postProcessDiarization } from '../audio/diarization-postprocess';
import { mergeTranscriptWithDiarization } from '../audio/merge-transcript';
import { TextOptimizer } from '../llm/text-optimizer';
import { MarkdownGenerator } from '../output/markdown-generator';
import { QueryEngine } from '../rag/query-engine';
import { TaskQueue, QueueTask } from './task-queue';
import { loadSettings } from '../settings';
import { createLLMClient, getLLMModel } from '../llm/create-client';
import { MemoryExtractor } from '../agent/memory-extractor';
import { resolvePasteCleanModel } from '../llm/paste-clean-model';
import { runWithPriority } from '../llm/llm-scheduler';
import { ProgressReporter } from './progress-reporter';
import { formatLocalDate } from '../utils/date';
// PersonMatcher import retained for future "claim speaker" feature
// import { PersonMatcher } from '../person/person-matcher';
import { detectMediaType, isDocumentType, isVideoType, isImageType } from './media-type';
import { extractText } from './text-extractor';
import { chunkText } from './text-chunker';
import { getFFmpegManager } from '../audio/ffmpeg-manager';
import { getPipelinePrompt } from '../llm/default-prompts';
import type { LLMClient } from '../llm/llm-client';
import type { MemoryManager } from '../agent/memory-manager';
import type { KnowledgeCompiler } from '../agent/knowledge-compiler';
import type { AgentEventBus } from '../agent/event-bus';
import type { TodoTracker } from '../agent/todo-tracker';
import type { SherpaEngineProxy } from '../audio/sherpa-engine-proxy';
import type { LicenseManager } from '../licensing/license-manager';

/** Maximum allowed audio file size: 500 MB */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** Maximum pixel count for cloud LLM image input (Volcengine limit: 36M pixels). */
const MAX_IMAGE_PIXELS = 33_000_000; // Leave some margin below 36M

/**
 * Read an image file and return a base64-encoded JPEG string suitable for LLM input.
 * If the image exceeds MAX_IMAGE_PIXELS, it is downscaled using ffmpeg.
 */
function readImageAsBase64(imagePath: string): string {
  const ffmpegPaths = getFFmpegManager().find();
  if (!ffmpegPaths) {
    // Fallback: send raw without resize
    return fs.readFileSync(imagePath).toString('base64');
  }

  // Probe image dimensions
  try {
    const probeOut = execFileSync(ffmpegPaths.ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      imagePath,
    ], { timeout: 10_000 }).toString().trim();

    const [wStr, hStr] = probeOut.split(',');
    const w = parseInt(wStr, 10);
    const h = parseInt(hStr, 10);

    if (!w || !h || w * h <= MAX_IMAGE_PIXELS) {
      // Image is within limits, just read and encode
      return fs.readFileSync(imagePath).toString('base64');
    }

    // Calculate scale factor to fit within MAX_IMAGE_PIXELS
    const scale = Math.sqrt(MAX_IMAGE_PIXELS / (w * h));
    const newW = Math.floor(w * scale / 2) * 2; // ensure even
    const newH = Math.floor(h * scale / 2) * 2;
    console.log(`[Processor] Resizing image ${w}x${h} (${(w * h / 1e6).toFixed(1)}M px) → ${newW}x${newH} for LLM`);

    // Use ffmpeg to resize and output JPEG to stdout
    const resized = execFileSync(ffmpegPaths.ffmpeg, [
      '-i', imagePath,
      '-vf', `scale=${newW}:${newH}`,
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      '-q:v', '2',
      '-y',
      'pipe:1',
    ], { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 });

    return resized.toString('base64');
  } catch (err: any) {
    console.warn(`[Processor] Image resize failed, using original: ${err.message}`);
    return fs.readFileSync(imagePath).toString('base64');
  }
}

export interface ProcessorConfig {
  db?: VoiceBrainDB; // Use shared DB instance if provided
  dbPath: string;
  outputDir: string; // Markdown output directory
  tempDir: string; // Temporary file directory
  whisperModel: string; // Whisper model size
  llmModel: string; // Local LLM model name
  sherpaEngine?: SherpaEngineProxy; // sherpa-onnx engine instance
  licenseManager?: LicenseManager;
}

export class Processor {
  private db: VoiceBrainDB;
  private preprocessor: AudioPreprocessor;
  private transcriber: Transcriber;
  private diarizer: Diarizer;
  private embeddingDiarizer: EmbeddingDiarizer;
  private optimizer: TextOptimizer;
  private markdown: MarkdownGenerator;
  private queryEngine: QueryEngine | null = null;
  private taskQueue: TaskQueue;
  private memoryManager: MemoryManager | null = null;
  private knowledgeCompiler?: KnowledgeCompiler;
  private eventBus: AgentEventBus | null = null;
  private todoTracker: TodoTracker | null = null;
  private sherpaEngine: SherpaEngineProxy | null;
  private licenseManager: LicenseManager | null;
  private llmClient: import('../llm/llm-client').LLMClient;
  private llmModel: string;

  constructor(private config: ProcessorConfig) {
    this.db = config.db || new VoiceBrainDB(config.dbPath);
    this.sherpaEngine = config.sherpaEngine || null;
    this.licenseManager = config.licenseManager || null;
    this.preprocessor = new AudioPreprocessor(this.sherpaEngine || undefined);
    this.transcriber = new Transcriber(this.sherpaEngine!);
    this.diarizer = new Diarizer(this.sherpaEngine!);
    this.embeddingDiarizer = new EmbeddingDiarizer(this.sherpaEngine!);
    const settings = loadSettings();
    const llmClient = createLLMClient(settings);
    this.llmClient = llmClient;
    this.llmModel = config.llmModel;
    this.optimizer = new TextOptimizer(llmClient, config.llmModel);
    this.optimizer.setVocabularyBlock(this.db.buildVocabularyPromptBlock(settings.vocabularyContext));
    this.markdown = new MarkdownGenerator(config.outputDir);
    this.taskQueue = new TaskQueue();

    // All file/recording processing is background work — de-prioritise its LLM
    // calls so an interactive RAG/chat query can jump ahead (see llm-scheduler).
    this.taskQueue.setProcessor((task) => runWithPriority('background', () => this.processFile(task)));
  }

  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  setQueryEngine(queryEngine: QueryEngine): void {
    this.queryEngine = queryEngine;
  }

  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  setKnowledgeCompiler(kc: KnowledgeCompiler): void {
    this.knowledgeCompiler = kc;
  }

  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
  }

  setTodoTracker(tracker: TodoTracker): void {
    this.todoTracker = tracker;
  }

  /** No-op: sherpa-onnx runs in-process, no subprocess to suspend. */
  suspendPipeline(): void { /* no-op */ }

  /** No-op: sherpa-onnx runs in-process, no subprocess to resume. */
  resumePipeline(): void { /* no-op */ }

  /** Hot-swap the internal LLM client (called when LLM provider changes in settings). */
  updateLLMClient(client: LLMClient, model: string): void {
    this.llmClient = client;
    this.llmModel = model;
    this.optimizer = new TextOptimizer(client, model);
    const settings = loadSettings();
    this.optimizer.setVocabularyBlock(this.db.buildVocabularyPromptBlock(settings.vocabularyContext));
  }

  /** Validate file size before enqueuing. Throws if file exceeds MAX_FILE_SIZE (500 MB). */
  private validateFileSize(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large (${(stat.size / 1024 / 1024).toFixed(0)}MB). Maximum is 500MB.`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('File too large')) throw err;
      throw new Error(`Cannot access file: ${filePath}`);
    }
  }

  /** Add a file to the processing queue. If a recording already exists in DB, reprocess it instead of creating a duplicate. */
  enqueue(filePath: string): QueueTask {
    this.validateFileSize(filePath);
    const existing = this.db.getRecordingByPath(filePath);
    if (existing) {
      // Recording already in DB — reprocess instead of creating a duplicate
      return this.enqueueReprocess(filePath, existing.id);
    }
    return this.taskQueue.add(filePath);
  }

  /** Reprocess an existing recording: clear old data, reuse recording ID. */
  enqueueReprocess(filePath: string, recordingId: number): QueueTask {
    this.validateFileSize(filePath);
    // Clean vector store entries for old segments before clearing DB data
    if (this.queryEngine) {
      const oldSegIds = this.db.getSegmentIdsByRecording(recordingId);
      if (oldSegIds.length > 0) {
        this.queryEngine.deleteSegments(oldSegIds);
      }
    }
    this.db.clearRecordingData(recordingId);
    this.db.updateRecordingStatus(recordingId, 'pending');
    return this.taskQueue.addReprocess(filePath, recordingId);
  }

  /** Wait until a file's size stops changing (file copy complete). */
  private async waitForFileStable(filePath: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    let lastSize = -1;
    while (Date.now() - start < timeoutMs) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size === lastSize && stat.size > 0) return; // Size stable
        lastSize = stat.size;
      } catch {
        throw new Error(`File not found: ${filePath}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Timed out but file exists — proceed anyway (user might be waiting)
    console.warn(`[Processor] File stability check timed out for ${path.basename(filePath)}, proceeding anyway`);
  }

  /** Get localized default speaker label prefix. */
  private getSpeakerPrefix(): string {
    const settings = loadSettings();
    return settings.language === 'zh' ? '说话人' : 'Speaker';
  }

  /**
   * Resolve and apply the cleanup model (used by TextOptimizer for mechanical
   * cleanup tasks — cleanText, batchClean, analyzeSentiment). When the main
   * model is heavy (e.g. qwen3.5:35b), this falls back to qwen3.5:4b for batch
   * work so a long recording's per-segment cleanup fits within reasonable time.
   * Semantic tasks (extractInfo, meetingNotes, Q&A) stay on the main model.
   */
  private async applyCleanupModel(): Promise<void> {
    try {
      const settings = loadSettings();
      const spec = await resolvePasteCleanModel(settings);
      if (spec.model !== this.llmModel) {
        this.optimizer.setCleanupModel(spec.model, spec.keepAlive);
        console.log(`[Processor] Cleanup model → ${spec.model} (main: ${this.llmModel})`);
      } else {
        this.optimizer.setCleanupModel(undefined);
      }
    } catch (err: any) {
      console.warn(`[Processor] Failed to resolve cleanup model: ${err?.message}`);
    }
  }

  /** Core processing pipeline. */
  private async processFile(task: QueueTask): Promise<void> {
    const { filePath } = task;
    const fileName = path.basename(filePath);
    console.log(`[Processor] Starting pipeline for: ${fileName}${task.recordingId ? ` (reprocess #${task.recordingId})` : ''}`);

    // Route bulk cleanup (per-segment clean/sentiment) to a lighter model when
    // the main model is heavy — picks up settings changes between tasks.
    await this.applyCleanupModel();

    // Check if this is a multi-image group (directory)
    try {
      if (fs.statSync(filePath).isDirectory()) {
        return this.processImageGroup(task);
      }
    } catch {}

    // Route by media type — each handler has its own try/catch for graceful failure
    const mediaType = detectMediaType(filePath);
    if (mediaType && isDocumentType(mediaType)) {
      return this.processDocument(task, mediaType);
    }
    if (mediaType && isVideoType(mediaType)) {
      return this.processVideo(task);
    }
    if (mediaType && isImageType(mediaType)) {
      return this.processImage(task);
    }

    // 0. Wait for file to stabilize (in case it's still being copied)
    await this.waitForFileStable(filePath);

    // 1. Insert recording into database (or reuse existing for reprocess)
    let recordingId: number;
    if (task.recordingId) {
      // Reprocessing: reuse existing recording ID (data already cleared by enqueueReprocess)
      recordingId = task.recordingId;
    } else {
      // Guard: check DB for existing recording to prevent duplicates
      const existingRec = this.db.getRecordingByPath(filePath);
      if (existingRec) {
        recordingId = existingRec.id;
        this.db.clearRecordingData(recordingId);
        console.log(`[Processor] Reusing existing recording #${recordingId} for ${fileName}`);
      } else {
        // Try to extract recorded_at from filename (e.g. R20260218-083551.WAV)
        let recordedAt: string | undefined;
        const match = fileName.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
        if (match) {
          recordedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
        } else {
          // Fallback: use file modification time
          try {
            const stat = fs.statSync(filePath);
            recordedAt = stat.mtime.toISOString();
          } catch {
            // ignore
          }
        }
        recordingId = this.db.insertRecording({
          file_path: filePath,
          file_name: fileName,
          recorded_at: recordedAt,
        });
      }
    }
    this.db.updateRecordingStatus(recordingId, 'processing');

    try {
      // 2. Preprocessing: format conversion
      this.taskQueue.updateTask(task.id, {
        status: 'preprocessing',
        progress: 10,
        notes: '格式转换（16k 单声道）...',
      });
      console.log(`[Processor] Step 2: Converting to 16k mono...`);
      let convertedPath: string;
      try {
        convertedPath = await this.preprocessor.convertTo16kMono(
          filePath,
          this.config.tempDir
        );
      } catch (err: any) {
        throw new Error(`Preprocessing failed: ${err.message}. Check that FFmpeg is installed and the audio file is valid.`);
      }

      // Get and store audio duration
      let duration = 0;
      try {
        duration = await this.preprocessor.getDuration(filePath);
        if (duration > 0) {
          this.db.updateRecordingDuration(recordingId, duration);
          console.log(`[Processor] Duration: ${duration.toFixed(1)}s`);
        }
      } catch {
        // ffprobe not critical, continue pipeline
      }

      // Fast mode: skip VAD/split/diarization for short audio (<30s)
      if (duration === 0) {
        console.warn('[Processor] Could not determine duration, using full pipeline');
      }
      const fastMode = duration > 0 && duration < 30;
      let allMergedSegments: any[] = [];

      // Load hotwords and language from settings for ASR
      const pipelineSettings0 = loadSettings();
      const pipelineHotwords = pipelineSettings0.hotwords || [];
      const pipelineLang = pipelineSettings0.asrLanguage || 'auto';

      if (fastMode) {
        // Short audio: send entire file to Whisper directly
        console.log(`[Processor] Fast mode: skipping VAD/diarization for ${duration.toFixed(1)}s audio`);
        this.taskQueue.updateTask(task.id, {
          status: 'transcribing',
          progress: 30,
        });

        let transcript: any;
        try {
          transcript = await this.transcriber.transcribe(
            convertedPath,
            this.config.whisperModel,
            pipelineHotwords,
            pipelineLang
          );
        } catch (err: any) {
          throw new Error(`Transcription failed: ${err.message}. Check that the ASR model is available and Python environment is configured.`);
        }

        if (transcript.segments.length === 0 || !transcript.full_text?.trim()) {
          console.log('[Processor] No speech detected, marking as completed');
          this.db.updateRecordingStatus(recordingId, 'completed');
          return;
        }

        // SenseVoice returns single segment with start:0, end:0 — use actual duration
        // Use SPEAKER_00 format so the localization logic (SPEAKER_00 → "说话人 1") works uniformly
        allMergedSegments = transcript.segments.map((s) => ({
          start: s.start,
          end: s.end || duration || 0,
          text: s.text,
          speaker: 'SPEAKER_00',
        }));
      } else {
        // Full pipeline: VAD → split → transcribe + diarize
        console.log(`[Processor] Step 3: Running VAD segmentation...`);
        this.taskQueue.updateTask(task.id, {
          notes: `语音活动检测中（${Math.round(duration || 0)}s 音频）...`,
        });

        // 3. VAD segmentation
        const vadResult =
          await this.preprocessor.detectSpeechSegments(convertedPath);
        console.log(`[Processor] VAD found ${vadResult.segments.length} segments, ${vadResult.total_speech_seconds}s speech`);
        this.taskQueue.updateTask(task.id, {
          progress: 20,
          notes: `VAD 检测到 ${vadResult.segments.length} 段语音（共 ${Math.round(vadResult.total_speech_seconds)}s）`,
        });

        // 4. If speech segments exist, split and process each one
        if (vadResult.segments.length === 0) {
          // No speech detected, mark as completed
          this.db.updateRecordingStatus(recordingId, 'completed');
          return;
        }

        // Split audio by VAD segments
        const segmentFiles = await this.preprocessor.splitBySegments(
          convertedPath,
          vadResult.segments,
          path.join(this.config.tempDir, `recording_${recordingId}`)
        );

        // 5. Per-segment transcription + speaker diarization
        this.taskQueue.updateTask(task.id, {
          status: 'transcribing',
          progress: 30,
        });
        console.log(`[Processor] Step 5: Transcribing ${segmentFiles.length} segments...`);
        const totalSegments = segmentFiles.length;

        // Parallel batch transcription via worker pool
        console.log(`[Processor] Transcribing ${segmentFiles.length} segments in parallel via worker pool...`);
        const engine = this.sherpaEngine as import('../audio/sherpa-engine-proxy').SherpaEngineProxy;
        const asrReporter = new ProgressReporter({
          label: '转写',
          total: segmentFiles.length,
          onTick: (note) => {
            console.log(`[Processor] ${note}`);
            this.taskQueue.updateTask(task.id, { notes: note });
          },
          step: Math.max(1, Math.floor(segmentFiles.length / 20)),
        });
        let transcriptResults: any[];
        try {
          transcriptResults = await engine.transcribeAudioBatch(segmentFiles, () => asrReporter.advance());
        } catch (err: any) {
          throw new Error(`Batch transcription failed: ${err.message}. Check that the ASR model is available.`);
        }

        // Global diarization: check settings for method preference
        this.taskQueue.updateTask(task.id, {
          status: 'diarizing',
          progress: 40,
        });

        const diarSettings = loadSettings();
        const diarizationMethod = diarSettings.diarizationMethod || 'embedding';
        console.log(`[Processor] Step 5b: Diarization (method=${diarizationMethod})...`);
        const diarStart = Date.now();
        this.taskQueue.updateTask(task.id, {
          notes: `说话人分离中（${diarizationMethod} 模式，这一步无逐段进度，预计 3–5 分钟）...`,
        });

        let globalDiarResult: import('../audio/diarizer').DiarizeResult | null = null;

        if (diarizationMethod === 'embedding') {
          // New embedding-based diarization (subprocess handles its own VAD)
          try {
            globalDiarResult = await this.embeddingDiarizer.diarize(
              convertedPath,
              [], // subprocess runs its own VAD internally
              {
                numSpeakers: -1,
                clusteringThreshold: 0.45,
                totalDuration: duration,
                llmCorrect: async (input) => {
                  const { correctSpeakersWithLLM } = await import('../audio/llm-speaker-corrector');
                  return correctSpeakersWithLLM(this.llmClient, this.llmModel, input);
                },
              },
            );
            const uniqueSpeakerIds = [...new Set(globalDiarResult.segments.map(s => s.speaker))];
            console.log(`[Processor] Embedding diarization: ${globalDiarResult.segments.length} segments, ${uniqueSpeakerIds.length} speakers: ${uniqueSpeakerIds.join(', ')}`);
            // Light post-processing: only merge adjacent same-speaker segments
            // (embedding diarizer already does its own internal post-processing)
            if (globalDiarResult) {
              globalDiarResult.segments = postProcessDiarization(globalDiarResult.segments, { light: true });
            }
          } catch (diarErr: any) {
            console.warn(`[Processor] Embedding diarization failed, falling back to legacy: ${diarErr.message}`);
            try {
              globalDiarResult = await this.diarizer.diarize(convertedPath);
              console.log(`[Processor] Legacy diarization (fallback): ${globalDiarResult.segments.length} segments`);
            } catch (legacyErr: any) {
              console.warn(`[Processor] Legacy diarization also failed: ${legacyErr.message}`);
            }
          }
        } else {
          // Legacy OfflineSpeakerDiarization
          try {
            globalDiarResult = await this.diarizer.diarize(convertedPath);
            console.log(`[Processor] Legacy diarization: ${globalDiarResult.segments.length} segments`);
          } catch (legacyErr: any) {
            console.warn(`[Processor] Legacy diarization failed: ${legacyErr.message}`);
          }
        }

        const diarElapsed = Math.round((Date.now() - diarStart) / 1000);
        const diarSpeakerCount = globalDiarResult
          ? new Set(globalDiarResult.segments.map(s => s.speaker)).size
          : 0;
        this.taskQueue.updateTask(task.id, {
          progress: 50,
          notes: globalDiarResult
            ? `说话人分离完成（${diarSpeakerCount} 位说话人，用时 ${diarElapsed}s）`
            : `说话人分离失败，将使用单一说话人（用时 ${diarElapsed}s）`,
        });

        // Merge transcription + global diarization results
        for (let i = 0; i < segmentFiles.length; i++) {
          const vadSeg = vadResult.segments[i];
          const asrResult = transcriptResults[i];
          const fullText = asrResult.text || '';

          if (!fullText.trim()) continue;

          let speaker = 'SPEAKER_00';
          if (globalDiarResult && globalDiarResult.segments.length > 0) {
            // Find diarization segments that overlap this VAD segment's time range
            const overlapping = globalDiarResult.segments.filter(d =>
              d.start < vadSeg.end && d.end > vadSeg.start
            );

            if (overlapping.length > 0) {
              // Calculate overlap duration per speaker to find dominant speaker
              const speakerDurations: Record<string, number> = {};
              for (const d of overlapping) {
                const overlapStart = Math.max(d.start, vadSeg.start);
                const overlapEnd = Math.min(d.end, vadSeg.end);
                const overlap = Math.max(0, overlapEnd - overlapStart);
                speakerDurations[d.speaker] = (speakerDurations[d.speaker] || 0) + overlap;
              }

              let maxDur = 0;
              for (const [spk, dur] of Object.entries(speakerDurations)) {
                if (dur > maxDur) {
                  maxDur = dur;
                  speaker = spk;
                }
              }
            }
          }

          allMergedSegments.push({
            start: vadSeg.start,
            end: vadSeg.end,
            text: fullText,
            speaker,
          });
        }
      }

      // 5.5a. LLM speaker attribution correction
      if (allMergedSegments.length >= 3) {
        const correctionSpeakers = [...new Set(allMergedSegments.map(s => s.speaker))];
        if (correctionSpeakers.length > 1) {
          try {
            console.log(`[Processor] Step 5.5a: LLM speaker attribution correction (${allMergedSegments.length} segments, ${correctionSpeakers.length} speakers)...`);
            allMergedSegments = await this.optimizer.correctSpeakerAttribution(allMergedSegments);
          } catch (err: any) {
            console.warn(`[Processor] Speaker correction skipped: ${err.message?.slice(0, 100)}`);
          }
        }
      }

      // 5.5. Localize speaker labels + extract embeddings + match-first speaker assignment
      // Collect original speaker label → time ranges for embedding extraction
      const originalSpeakerSegments: { [label: string]: { start: number; end: number }[] } = {};
      for (const seg of allMergedSegments) {
        if (seg.speaker) {
          if (!originalSpeakerSegments[seg.speaker]) {
            originalSpeakerSegments[seg.speaker] = [];
          }
          originalSpeakerSegments[seg.speaker].push({ start: seg.start, end: seg.end });
        }
      }

      const prefix = this.getSpeakerPrefix();
      const spkLabelMap = new Map<string, string>();
      for (const seg of allMergedSegments) {
        if (seg.speaker && !spkLabelMap.has(seg.speaker)) {
          // SPEAKER_00 → "说话人 1" / "Speaker 1"
          const match = seg.speaker.match(/(\d+)$/);
          const num = match ? parseInt(match[1], 10) + 1 : spkLabelMap.size + 1;
          spkLabelMap.set(seg.speaker, `${prefix} ${num}`);
        }
        seg.speaker = spkLabelMap.get(seg.speaker) || seg.speaker;
      }
      const uniqueSpeakers = [...new Set(allMergedSegments.map((s) => s.speaker).filter(Boolean))];

      // 5.6. Person auto-creation disabled — persons are now managed manually.
      // Speaker diarization labels (说话人 1/2/3) are preserved in segments but
      // no persons or content_person_links are created automatically.

      // Filter out segments with empty text before optimization
      allMergedSegments = allMergedSegments.filter(s => s.text?.trim());
      if (allMergedSegments.length === 0) {
        console.log('[Processor] All segments had empty text, marking as completed');
        this.db.updateRecordingStatus(recordingId, 'completed');
        return;
      }

      // 6. LLM text optimization (batch mode for better context)
      this.taskQueue.updateTask(task.id, {
        status: 'optimizing',
        progress: 60,
      });

      // Batch clean: send full text to LLM for context-aware optimization
      const fullRawText = allMergedSegments
        .map(s => s.text || '')
        .filter(t => t.trim())
        .join('\n');

      let batchCleanedLines: string[] | null = null;
      if (fullRawText.length >= 10) {
        this.taskQueue.updateTask(task.id, {
          notes: `批量文本清洗中（${fullRawText.length} 字符）...`,
        });
        try {
          const batchCleanStart = Date.now();
          const batchCleaned = await this.optimizer.batchClean(fullRawText);
          console.log(`[Processor] batchClean done in ${Math.round((Date.now() - batchCleanStart) / 1000)}s`);
          const lines = batchCleaned.split('\n').filter(l => l.trim());
          const rawSegCount = allMergedSegments.filter(s => s.text?.trim()).length;
          if (lines.length === rawSegCount) {
            batchCleanedLines = lines;
            console.log(`[Processor] Batch optimization: ${fullRawText.length} → ${batchCleaned.length} chars, ${lines.length} lines matched`);
          } else {
            console.warn(`[Processor] Batch optimization line count mismatch: expected ${rawSegCount}, got ${lines.length}. Falling back to per-segment.`);
          }
        } catch (err: any) {
          console.warn(`[Processor] Batch optimization failed, falling back to per-segment: ${err.message?.slice(0, 100)}`);
          this.taskQueue.updateTask(task.id, {
            notes: `文本优化失败，将使用原始文本: ${err.message?.slice(0, 80)}`,
          });
        }
      }

      this.taskQueue.updateTask(task.id, { progress: 70 });

      // Filter out segments with no meaningful text (only punctuation/whitespace)
      const hasMeaningfulText = (t: string | undefined) => t && t.replace(/[\s\p{P}\p{S}]/gu, '').length > 0;
      const meaningfulSegments = allMergedSegments.filter(s => hasMeaningfulText(s.text));
      const rawSegs = meaningfulSegments.filter(s => s.text?.trim());
      const totalSegs = meaningfulSegments.length;
      if (totalSegs < allMergedSegments.length) {
        console.log(`[Processor] Filtered out ${allMergedSegments.length - totalSegs} empty/punctuation-only segment(s)`);
      }
      // Only report per-segment progress when we're actually calling the LLM
      // (batch-cleaned path is fast — DB inserts only).
      const usingPerSegmentLLM = !batchCleanedLines;
      const cleanReporter = usingPerSegmentLLM
        ? new ProgressReporter({
            label: '文本清洗',
            total: totalSegs,
            onTick: (note) => {
              console.log(`[Processor] ${note}`);
              this.taskQueue.updateTask(task.id, { notes: note });
            },
            step: Math.max(1, Math.floor(totalSegs / 20)),
          })
        : null;
      for (let si = 0; si < totalSegs; si++) {
        const seg = meaningfulSegments[si];
        let cleanText: string;

        // Try to use batch-cleaned result; fall back to per-segment
        const rawIdx = rawSegs.indexOf(seg);
        if (batchCleanedLines && rawIdx >= 0 && rawIdx < batchCleanedLines.length) {
          cleanText = batchCleanedLines[rawIdx];
        } else {
          // Per-segment fallback
          try {
            cleanText = await this.optimizer.cleanText(seg.text);
          } catch (err: any) {
            console.warn(`[Processor] Text optimization failed, using raw text: ${err.message?.slice(0, 100)}`);
            this.taskQueue.updateTask(task.id, {
              notes: `段落优化失败，使用原始文本: ${err.message?.slice(0, 60)}`,
            });
            cleanText = seg.text || '';
          }
        }

        const segId = this.db.insertSegment({
          recording_id: recordingId,
          speaker_id: undefined,
          start_time: seg.start,
          end_time: seg.end,
          raw_text: seg.text,
          clean_text: cleanText,
          speaker_label: seg.speaker || undefined,
        });
        seg.segment_id = segId;
        seg.clean_text = cleanText;
        // Sub-step progress: 70 → 80 across segments
        this.taskQueue.updateTask(task.id, {
          progress: Math.round(70 + ((si + 1) / totalSegs) * 10),
        });
        cleanReporter?.advance();
      }

      // 6.5. Sentiment analysis
      if (this.licenseManager && !this.licenseManager.isPro()) {
        console.log('[Processor] Step 6.5: Skipped (Pro feature: emotion_analysis)');
      } else {
        const SENTIMENT_CONCURRENCY = 4;
        const sentimentSegs = allMergedSegments.filter(seg => (seg.clean_text || seg.text || '').length >= 10 && seg.segment_id);
        console.log(`[Processor] Step 6.5: Analyzing sentiment for ${sentimentSegs.length} segments (concurrency=${SENTIMENT_CONCURRENCY})...`);
        const sentReporter = sentimentSegs.length > 0
          ? new ProgressReporter({
              label: '情绪分析',
              total: sentimentSegs.length,
              onTick: (note) => {
                console.log(`[Processor] ${note}`);
                this.taskQueue.updateTask(task.id, { notes: note });
              },
              step: Math.max(1, Math.floor(sentimentSegs.length / 20)),
            })
          : null;
        for (let i = 0; i < sentimentSegs.length; i += SENTIMENT_CONCURRENCY) {
          const batch = sentimentSegs.slice(i, i + SENTIMENT_CONCURRENCY);
          await Promise.all(batch.map(async (seg) => {
            try {
              const text = seg.clean_text || seg.text || '';
              const sentimentResult = await this.optimizer.analyzeSentiment(text);
              this.db.updateSegmentSentiment(seg.segment_id!, sentimentResult.sentiment);
            } catch (err) {
              console.warn(`[Processor] Sentiment analysis skipped for segment ${seg.segment_id}:`, err);
            } finally {
              sentReporter?.advance();
            }
          }));
        }
      }

      // 7. Information extraction
      this.taskQueue.updateTask(task.id, {
        status: 'extracting',
        progress: 75,
      });

      const fullCleanText = allMergedSegments
        .map((s) => s.clean_text)
        .join('\n');

      // 6.1. Check for auto-completion of existing todos
      if (this.todoTracker && fullCleanText) {
        try {
          await this.todoTracker.checkAutoComplete(fullCleanText);
        } catch (err) {
          console.warn('[Processor] TodoTracker auto-complete check failed:', err);
        }
      }

      let extracted: any = { items: [] };
      try {
        const extractStart = Date.now();
        this.taskQueue.updateTask(task.id, {
          notes: `信息抽取中（${fullCleanText.length} 字符，主模型 ${this.llmModel}）...`,
        });
        extracted = await this.optimizer.extractInfo(fullCleanText);
        const extractElapsed = Math.round((Date.now() - extractStart) / 1000);
        console.log(`[Processor] extractInfo done in ${extractElapsed}s`);
        this.taskQueue.updateTask(task.id, {
          notes: `信息抽取完成（用时 ${extractElapsed}s）`,
        });
      } catch (err: any) {
        console.warn(`[Processor] Info extraction failed (non-fatal), skipping: ${err.message?.slice(0, 100)}`);
      }

      // Items auto-extraction disabled — items are created on-demand via agent/manual only
      // (relationships from extractInfo are still used below for relationship graph)

      // 7.1. Store extracted relationships (into person_relationships table)
      if (this.licenseManager && !this.licenseManager.isPro()) {
        console.log('[Processor] Step 7.1: Skipped (Pro feature: relationship_graph)');
      } else {
        if (extracted.relationships && extracted.relationships.length > 0) {
          let stored = 0;
          for (const rel of extracted.relationships) {
            // Only link relationships to existing persons — no auto-creation
            const person = this.db.getPersonByName(rel.person1 ?? rel.person2);
            if (!person) continue;

            const relatedPerson = rel.person2 && rel.person2 !== (rel.person1 ?? rel.person2)
              ? this.db.getPersonByName(rel.person2)
              : undefined;

            this.db.insertPersonRelationship({
              person_id: person.id,
              related_person_id: relatedPerson?.id,
              mentioned_name: rel.person2,
              relationship: rel.relationship,
              context: rel.context,
              recording_id: recordingId,
            });
            stored++;
          }
          console.log(`[Processor] Step 7.1: Extracted ${extracted.relationships.length} relationship(s), stored ${stored} (only existing persons)`);
        }
      }

      // 7.4. AI title generation — cheap single-call summarization for ALL
      // recordings with segments (dictation, notes, short audio that won't
      // get full meeting_notes). Runs on cleanup-spec model so it's fast.
      try {
        if (allMergedSegments.length >= 1) {
          const fullText = allMergedSegments
            .map((s) => (s.clean_text || s.text || '').trim())
            .filter(Boolean)
            .join(' ');
          if (fullText.length >= 8) {
            const titleStart = Date.now();
            const aiTitle = await this.optimizer.generateTitle(fullText);
            if (aiTitle) {
              this.db.updateRecordingAutoTitle(recordingId, aiTitle);
              console.log(
                `[Processor] Step 7.4: auto_title generated in ${Math.round((Date.now() - titleStart) / 1000)}s: "${aiTitle}"`,
              );
            }
          }
        }
      } catch (err) {
        console.warn('[Processor] Step 7.4: auto_title generation failed (non-fatal):', err);
      }

      // 7.4.5. Importance scoring — every recording with segments gets a
      // 0-10 score driving TODAY dashboard filtering. Cleanup-spec tier,
      // ~200-500ms. Non-fatal.
      try {
        if (allMergedSegments.length >= 1) {
          const fullText = allMergedSegments
            .map((s) => (s.clean_text || s.text || '').trim())
            .filter(Boolean)
            .join(' ');
          if (fullText.length >= 8) {
            const recording = this.db.getRecording(recordingId);
            const speakerCount = new Set(allMergedSegments.map((s) => s.speaker).filter(Boolean)).size;
            const { score, reason } = await this.optimizer.scoreImportance(fullText, {
              durationSec: recording?.duration_seconds || 0,
              speakerCount,
              mediaType: recording?.media_type || 'audio',
            });
            this.db.updateRecordingImportance(recordingId, score);
            console.log(`[Processor] Step 7.4.5: importance=${score} (${reason})`);
          }
        }
      } catch (err) {
        console.warn('[Processor] Step 7.4.5: importance scoring failed (non-fatal):', err);
      }

      // 7.5. Meeting notes generation
      let meetingNotesResult: any = null;
      if (this.licenseManager && !this.licenseManager.isPro()) {
        console.log('[Processor] Step 7.5: Skipped (Pro feature: meeting_notes)');
      } else if (allMergedSegments.length >= 2) {
        try {
          this.taskQueue.updateTask(task.id, {
            status: 'generating notes',
            progress: 78,
            notes: `生成会议纪要中（${allMergedSegments.length} 段，主模型 ${this.llmModel}）...`,
          });
          console.log('[Processor] Step 7.5: Generating meeting notes...');
          const notesStart = Date.now();
          const meetingSegments = allMergedSegments.map(s => ({
            speaker: s.speaker || 'Unknown',
            startTime: s.start,
            endTime: s.end,
            cleanText: s.clean_text || s.text || '',
          }));
          const recording = this.db.getRecording(recordingId);
          const notes = await this.optimizer.generateMeetingNotes(meetingSegments, {
            date: formatLocalDate(recording?.recorded_at ? new Date(recording.recorded_at) : new Date()),
            duration: recording?.duration_seconds || 0,
          });
          this.db.saveMeetingNotes(recordingId, notes);
          meetingNotesResult = notes;
          const notesElapsed = Math.round((Date.now() - notesStart) / 1000);
          console.log(`[Processor] Meeting notes generated in ${notesElapsed}s: "${notes.title}" (${notes.decisions.length} decisions, ${notes.actionItems.length} action items)`);
          this.taskQueue.updateTask(task.id, {
            notes: `会议纪要完成（用时 ${notesElapsed}s，${notes.decisions.length} 项决策，${notes.actionItems.length} 项待办）`,
          });
        } catch (err) {
          console.warn('[Processor] Meeting notes generation failed (non-fatal):', err);
          // Non-fatal — continue pipeline
        }
      }

      // 7.6. Session assembly — group consecutive related dictations
      // into per-day sessions so Dashboard TODAY shows themes, not chatter.
      try {
        const rec = this.db.getRecording(recordingId);
        if (rec && allMergedSegments.length >= 1) {
          const fullText = allMergedSegments
            .map((s) => (s.clean_text || s.text || '').trim())
            .filter(Boolean)
            .join(' ');
          const recDate = rec.recorded_at || rec.processed_at;
          if (recDate && fullText.length >= 8) {
            const { assembleSession } = await import('../rag/session-assembly');
            await assembleSession(this.db, this.optimizer, {
              recordingId,
              transcript: fullText,
              durationSec: rec.duration_seconds || 0,
              captureScene: rec.capture_scene || 'dictation',
              date: recDate.slice(0, 10),
              recordedAt: recDate,
              mediaType: rec.media_type || 'audio',
            });
            console.log(`[Processor] Step 7.6: session assembly done for recording ${recordingId}`);
          }
        }
      } catch (err) {
        console.warn('[Processor] Step 7.6: session assembly failed (non-fatal):', err);
      }

      // 8. Vector indexing
      this.taskQueue.updateTask(task.id, {
        status: 'indexing',
        progress: 85,
      });

      if (!this.queryEngine) {
        console.warn('[Processor] Step 8: Vector indexing skipped — queryEngine not initialized (non-fatal)');
      } else {
        const indexReporter = new ProgressReporter({
          label: '向量索引',
          total: allMergedSegments.length,
          onTick: (note) => {
            console.log(`[Processor] ${note}`);
            this.taskQueue.updateTask(task.id, { notes: note });
          },
          step: Math.max(1, Math.floor(allMergedSegments.length / 10)),
        });
        let indexed = 0;
        for (let vi = 0; vi < allMergedSegments.length; vi++) {
          const seg = allMergedSegments[vi];
          if (seg.segment_id && seg.clean_text) {
            await this.queryEngine.indexSegment(
              seg.segment_id,
              seg.clean_text
            );
            indexed++;
          }
          // Sub-step progress: 85 → 95 across segments
          this.taskQueue.updateTask(task.id, {
            progress: Math.round(85 + ((vi + 1) / allMergedSegments.length) * 10),
        });
        indexReporter.advance();
        }
        console.log(`[Processor] Step 8: Indexed ${indexed}/${allMergedSegments.length} segments into vector store`);
      }

      // 9. Generate Markdown output + Obsidian sync
      const today = formatLocalDate();
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const settings = loadSettings();
      // Rebuild markdown generator with wikilinks preference
      const mdGen = new MarkdownGenerator(this.config.outputDir, settings.obsidianWikilinks);
      const rec = this.db.getRecording(recordingId);
      const transcriptMd = mdGen.buildTranscript({
        date: today,
        title: baseName,
        recordedAt: rec?.recorded_at || undefined,
        segments: allMergedSegments,
      });
      mdGen.writeTranscript(today, baseName, transcriptMd);

      // Auto-sync to Obsidian vault if configured
      if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
        try {
          MarkdownGenerator.syncToVault(
            this.config.outputDir,
            settings.obsidianVaultDir,
            path.join('transcripts', today, `${baseName}.md`)
          );
          console.log(`[Processor] Synced transcript to Obsidian vault`);
        } catch (err) {
          console.error('[Processor] Failed to sync to Obsidian vault:', err);
        }
      }


      // Enqueue knowledge compilation (async, non-blocking)
      try {
        this.knowledgeCompiler?.enqueue(recordingId);
      } catch (err) {
        console.warn(`[Processor] Knowledge compilation enqueue failed:`, err);
      }

      // 12. Emit pipeline:completed event for downstream notifications
      if (this.eventBus) {
        const extractedTodos = extracted?.items?.filter((i: any) => i.type === 'todo') || [];
        this.eventBus.emit('pipeline:completed', {
          fileName,
          recordingId,
          meetingNotes: meetingNotesResult ? { title: meetingNotesResult.title } : undefined,
          extractedTodos,
        });
      }

      // Core deliverables (transcript, vector index, Markdown) are written —
      // mark the recording completed NOW. The enrichment steps below are
      // non-critical and used to run synchronously between vector indexing
      // (progress 95) and completion (100). On a heavy day generateDailySummary
      // alone re-summarises every segment of the day (e.g. 18 LLM chunks), which
      // froze the progress bar at "向量索引 95%" for many minutes. Run them
      // detached so they never block the queue or stall the UI.
      this.db.updateRecordingStatus(recordingId, 'completed');
      this.taskQueue.updateTask(task.id, {
        status: 'completed',
        progress: 100,
      });

      // ─── Background enrichment (non-critical, post-completion) ─────────
      void (async () => {
        // 11. Memory extraction
        try {
          const settings11 = loadSettings();
          const llmClient11 = createLLMClient(settings11);
          const memoryExtractor = new MemoryExtractor(llmClient11, getLLMModel(settings11));
          const allCleanText = allMergedSegments.map(s => s.clean_text).filter(Boolean).join('\n');
          const facts = await memoryExtractor.extract(allCleanText);

          if (facts.length > 0 && this.memoryManager) {
            for (const fact of facts) {
              await this.memoryManager.addFact(fact.fact, fact.category, fact.confidence, [recordingId]);
            }
            console.log(`[Processor] Step 11: Extracted ${facts.length} memories from recording ${recordingId}`);
          }
        } catch (err) {
          console.warn('[Processor] Memory extraction failed (non-critical):', err);
        }

        // 11.5. Daily summary is no longer regenerated per-recording. Doing so
        // re-summarised the entire day (dozens of LLM chunks) after every single
        // recording. It now runs once/day via the scheduled `daily_report` task
        // (action_params { today: true }, default 22:00). See seed-tasks.ts.

        // 12.5. Auto-classify recording tags
        if (this.licenseManager && !this.licenseManager.isPro()) {
          console.log('[Processor] Step 12.5: Skipped (Pro feature: insights)');
        } else {
          try {
            const combinedText = allMergedSegments.map((s) => s.clean_text || s.raw_text || '').join(' ');
            if (combinedText.length > 20) {
              const tags = await this.optimizer.classifyRecording(combinedText);
              if (tags.length > 0) {
                this.db.setRecordingTags(recordingId, tags);
                console.log(`[Processor] Step 12.5: Auto-tagged recording ${recordingId}: [${tags.join(', ')}]`);
              }
            }
          } catch (err) {
            console.warn('[Processor] Auto-classification failed (non-critical):', err);
          }
        }
      })();
    } catch (err) {
      this.db.updateRecordingStatus(recordingId, 'failed');
      throw err;
    }
  }

  // ─── Document Pipeline ─────────────────────────────────────────

  /**
   * Process a document file (PDF, DOCX, or plain text).
   * Extracts text → chunks → LLM optimization → info extraction → vector indexing.
   */
  private async processDocument(task: QueueTask, mediaType: 'pdf' | 'docx' | 'text'): Promise<void> {
    const filePath = task.filePath;
    const fileName = path.basename(filePath);
    console.log(`[Processor] Document pipeline for: ${fileName} (${mediaType})${task.recordingId ? ` (reprocess #${task.recordingId})` : ''}`);

    await this.waitForFileStable(filePath);

    // Validate document file size (50 MB limit)
    const MAX_DOC_SIZE = 50 * 1024 * 1024;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DOC_SIZE) {
      throw new Error(`Document too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_DOC_SIZE / 1024 / 1024} MB)`);
    }

    // 1. Insert or reuse recording
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 5 });
    let recordingId: number;
    if (task.recordingId) {
      recordingId = task.recordingId;
      this.db.clearRecordingData(recordingId);
      console.log(`[Processor] Reusing existing recording #${recordingId} for ${fileName}`);
    } else {
      const existingRec = this.db.getRecordingByPath(filePath);
      if (existingRec) {
        recordingId = existingRec.id;
        this.db.clearRecordingData(recordingId);
        console.log(`[Processor] Reusing existing recording #${recordingId} for ${fileName}`);
      } else {
        recordingId = this.db.insertRecording({
          file_path: filePath,
          file_name: fileName,
          media_type: mediaType,
        });
      }
    }
    this.db.updateRecordingStatus(recordingId, 'processing');

    try {
      // 2. Extract text
      this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 15, notes: 'Extracting text...' });
      console.log(`[Processor] Doc step 2: Extracting text from ${mediaType}...`);
      const extracted = await extractText(filePath, mediaType);
      this.db.updateRecording(recordingId, {
        page_count: extracted.pageCount,
        word_count: extracted.wordCount,
      });

      if (!extracted.text.trim()) {
        console.log('[Processor] Empty document, marking completed');
        this.db.updateRecordingStatus(recordingId, 'completed');
        this.taskQueue.updateTask(task.id, { status: 'completed', progress: 100, notes: 'Empty document' });
        return;
      }

      // 3. Chunk text into segments
      this.taskQueue.updateTask(task.id, { status: 'optimizing', progress: 25, notes: 'Chunking text...' });
      const chunks = chunkText(extracted.text, 512);
      console.log(`[Processor] Doc step 3: Split into ${chunks.length} chunks`);

      // 4. Insert raw segments
      const segmentIds: number[] = [];
      for (const chunk of chunks) {
        const segId = this.db.insertSegment({
          recording_id: recordingId,
          raw_text: chunk.text,
          start_time: 0,
          end_time: 0,
          source: 'document',
        });
        segmentIds.push(segId);
      }

      // 5. LLM batch clean
      this.taskQueue.updateTask(task.id, { status: 'optimizing', progress: 40, notes: 'Optimizing text...' });
      try {
        const fullText = chunks.map((c) => c.text).join('\n');
        const cleanedFull = await this.optimizer.batchClean(fullText);
        const cleanedChunks = chunkText(cleanedFull, 512);
        for (let i = 0; i < segmentIds.length; i++) {
          const cleanText = i < cleanedChunks.length ? cleanedChunks[i].text : chunks[i].text;
          this.db.updateSegmentCleanText(segmentIds[i], cleanText);
        }
        console.log(`[Processor] Doc step 5: LLM text optimization done`);
      } catch (err) {
        console.warn('[Processor] Document batchClean failed, using raw text:', err);
        for (let i = 0; i < segmentIds.length; i++) {
          this.db.updateSegmentCleanText(segmentIds[i], chunks[i].text);
        }
      }

      // 6. Information extraction — disabled (items are created on-demand via agent/manual)

      // 7. Vector indexing
      if (this.queryEngine) {
        this.taskQueue.updateTask(task.id, { status: 'indexing', progress: 75, notes: 'Indexing vectors...' });
        let indexed = 0;
        for (const segId of segmentIds) {
          const seg = this.db.getSegment(segId);
          const text = seg?.clean_text || seg?.raw_text || '';
          if (text.length > 10) {
            await this.queryEngine.indexSegment(segId, text);
            indexed++;
          }
        }
        console.log(`[Processor] Doc step 7: Indexed ${indexed}/${segmentIds.length} chunks`);
      }

      // 8. Memory extraction
      this.taskQueue.updateTask(task.id, { status: 'extracting memories', progress: 85, notes: 'Extracting memories...' });
      try {
        const settings = loadSettings();
        const llmClient = createLLMClient(settings);
        const memoryExtractor = new MemoryExtractor(llmClient, getLLMModel(settings));
        const allCleanText = segmentIds.map((id) => {
          const seg = this.db.getSegment(id);
          return seg?.clean_text || seg?.raw_text || '';
        }).join('\n');
        const facts = await memoryExtractor.extract(allCleanText);
        if (facts.length > 0 && this.memoryManager) {
          for (const fact of facts) {
            await this.memoryManager.addFact(fact.fact, fact.category, fact.confidence, [recordingId]);
          }
          console.log(`[Processor] Doc step 8: Extracted ${facts.length} memories`);
        }
      } catch (err) {
        console.warn('[Processor] Document memory extraction failed:', err);
      }

      // Enqueue knowledge compilation (async, non-blocking)
      try {
        this.knowledgeCompiler?.enqueue(recordingId);
      } catch (err) {
        console.warn(`[Processor] Knowledge compilation enqueue failed:`, err);
      }

      // 9. Markdown output
      this.taskQueue.updateTask(task.id, { status: 'generating notes', progress: 92, notes: 'Generating markdown...' });
      try {
        const settings = loadSettings();
        const mdGen = new MarkdownGenerator(this.config.outputDir, settings.obsidianWikilinks);
        const today = formatLocalDate();
        const baseName = fileName.replace(/\.[^.]+$/, '');
        const segments = segmentIds.map((id) => {
          const seg = this.db.getSegment(id);
          return {
            start: 0, end: 0, speaker: '',
            text: seg?.raw_text || '',
            clean_text: seg?.clean_text || '',
            source: 'document',
          };
        });
        const transcriptMd = mdGen.buildTranscript({
          date: today, title: baseName,
          captureScene: mediaType,
          segments,
        });
        mdGen.writeTranscript(today, baseName, transcriptMd);

        if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
          MarkdownGenerator.syncToVault(
            this.config.outputDir, settings.obsidianVaultDir,
            path.join('transcripts', today, `${baseName}.md`),
          );
        }
      } catch (err) {
        console.warn('[Processor] Document markdown generation failed:', err);
      }

      // 10. Auto-classify tags
      if (!this.licenseManager || this.licenseManager.isPro()) {
        try {
          const combinedText = segmentIds.map((id) => {
            const seg = this.db.getSegment(id);
            return seg?.clean_text || seg?.raw_text || '';
          }).join(' ');
          if (combinedText.length > 20) {
            const tags = await this.optimizer.classifyRecording(combinedText);
            if (tags.length > 0) this.db.setRecordingTags(recordingId, tags);
          }
        } catch (err) {
          console.warn('[Processor] Document auto-classification failed:', err);
        }
      }

      this.db.updateRecordingStatus(recordingId, 'completed');
      this.taskQueue.updateTask(task.id, { status: 'completed', progress: 100 });
      console.log(`[Processor] Document pipeline completed for: ${fileName}`);
    } catch (err) {
      this.db.updateRecordingStatus(recordingId, 'failed');
      throw err;
    }
  }

  // ─── Video Pipeline ───────────────────────────────────────────

  /**
   * Process a video file: extract audio track via ffmpeg, then run audio pipeline.
   * Pre-creates the recording with media_type='video', extracts audio to a temp .wav,
   * then delegates to processFile which handles it as normal audio.
   */
  private async processVideo(task: QueueTask): Promise<void> {
    const originalPath = task.filePath;
    const fileName = path.basename(originalPath);
    console.log(`[Processor] Video pipeline for: ${fileName} — extracting audio + keyframes`);

    try {
    await this.waitForFileStable(originalPath);

    // 1. Extract audio track via ffmpeg
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 2, notes: 'Extracting audio from video...' });
    const audioPath = path.join(
      this.config.tempDir,
      `${path.basename(originalPath, path.extname(originalPath))}-audio.wav`,
    );

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg');
      ffmpeg(originalPath)
        .noVideo()
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .output(audioPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
    console.log(`[Processor] Audio extracted to: ${audioPath}`);

    // 1.5. Transcode video to H.264 MP4 for web playback (Chromium doesn't support HEVC)
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 3, notes: 'Transcoding video for playback...' });
    const videoOutDir = path.join(this.config.outputDir, 'videos');
    fs.mkdirSync(videoOutDir, { recursive: true });
    const webVideoPath = path.join(videoOutDir, `${path.basename(originalPath, path.extname(originalPath))}.mp4`);

    const needsTranscode = await this.videoNeedsTranscode(originalPath);
    if (needsTranscode) {
      console.log(`[Processor] Transcoding video to H.264 for web playback...`);
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');
        ffmpeg(originalPath)
          .videoCodec('libx264')
          .addOption('-preset', 'fast')
          .addOption('-crf', '23')
          .addOption('-movflags', '+faststart')
          .audioCodec('aac')
          .output(webVideoPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });
      console.log(`[Processor] Video transcoded to: ${webVideoPath}`);
    } else {
      // Already H.264 — copy to output directory
      if (originalPath !== webVideoPath) {
        fs.copyFileSync(originalPath, webVideoPath);
      }
      console.log(`[Processor] Video already H.264, copied to: ${webVideoPath}`);
    }

    // 2. Pre-create recording with video media_type so audio pipeline reuses it
    let recordedAt: string | undefined;
    let recordingId: number;
    if (task.recordingId) {
      recordingId = task.recordingId;
      this.db.clearRecordingData(recordingId);
    } else {
      const existingRec = this.db.getRecordingByPath(originalPath);
      if (existingRec) {
        recordingId = existingRec.id;
        this.db.clearRecordingData(recordingId);
      } else {
        try {
          const stat = fs.statSync(originalPath);
          recordedAt = stat.mtime.toISOString();
        } catch { /* ignore */ }
        recordingId = this.db.insertRecording({
          file_path: webVideoPath,
          file_name: fileName,
          media_type: 'video',
          recorded_at: recordedAt,
        });
      }
    }
    // Update file_path to transcoded version for playback
    this.db.updateRecordingFilePath(recordingId, webVideoPath);
    this.db.updateRecordingStatus(recordingId, 'processing');

    // 3. Extract keyframes and analyze with multimodal LLM
    const frameSegmentIds: number[] = [];
    try {
      this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 5, notes: 'Extracting keyframes...' });
      const framePaths = await this.extractKeyframes(originalPath, this.config.tempDir);

      if (framePaths.length > 0) {
        this.taskQueue.updateTask(task.id, { status: 'transcribing', progress: 10, notes: 'Analyzing keyframes with AI...' });
        // Limit to 5 frames max and cap each at 1MB base64 to prevent OOM
        const MAX_FRAME_BASE64 = 1_000_000; // ~750KB raw
        const base64Frames: string[] = [];
        for (const fp of framePaths.slice(0, 5)) {
          try {
            const b64 = readImageAsBase64(fp);
            if (b64.length <= MAX_FRAME_BASE64) {
              base64Frames.push(b64);
            } else {
              console.log(`[Processor] Skipping oversized keyframe (${(b64.length / 1024).toFixed(0)}KB base64): ${path.basename(fp)}`);
            }
          } catch (err) {
            console.warn(`[Processor] Failed to encode keyframe ${path.basename(fp)}:`, err);
          }
        }
        console.log(`[Processor] Encoded ${base64Frames.length}/${framePaths.length} keyframes for LLM analysis`);

        const settings = loadSettings();

        interface VideoFrameAnalysis {
          scene_description: string;
          ocr_text: string;
        }

        let analysis: VideoFrameAnalysis = { scene_description: '', ocr_text: '' };
        try {
          const result = await this.llmClient.generateJSON<VideoFrameAnalysis>({
            model: this.llmModel,
            prompt: getPipelinePrompt('videoAnalysis', settings.language),
            images: base64Frames,
            temperature: 0.1,
            num_ctx: 8192,
            num_predict: 2048,
          });
          analysis = {
            scene_description: result.scene_description || '',
            ocr_text: result.ocr_text || '',
          };
          console.log(`[Processor] Video keyframe analysis done — scene: ${analysis.scene_description.length} chars, OCR: ${analysis.ocr_text.length} chars`);
        } catch (err) {
          console.warn('[Processor] Video keyframe AI analysis failed:', err);
        }

        // Insert frame analysis segments
        if (analysis.scene_description?.trim()) {
          const descSegId = this.db.insertSegment({
            recording_id: recordingId,
            raw_text: analysis.scene_description.trim(),
            clean_text: analysis.scene_description.trim(),
            start_time: 0,
            end_time: 0,
            source: 'video_frame',
          });
          frameSegmentIds.push(descSegId);
        }

        if (analysis.ocr_text?.trim()) {
          const ocrSegId = this.db.insertSegment({
            recording_id: recordingId,
            raw_text: analysis.ocr_text.trim(),
            clean_text: analysis.ocr_text.trim(),
            start_time: 0,
            end_time: 0,
            source: 'video_frame',
          });
          frameSegmentIds.push(ocrSegId);
        }

        // Items auto-extraction disabled — items are created on-demand via agent/manual

        // Clean up temp frame files
        for (const fp of framePaths) {
          try { fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.warn('[Processor] Video keyframe extraction/analysis failed, continuing with audio only:', err);
    }

    // 4. Delegate to audio pipeline
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 15, notes: 'Processing audio track...' });
    task.filePath = audioPath;
    task.recordingId = recordingId;

    // Run audio pipeline
    await this.processFile(task);

    // 5. Index frame analysis segments (after audio pipeline, which sets up queryEngine indexing)
    if (frameSegmentIds.length > 0 && this.queryEngine) {
      for (const segId of frameSegmentIds) {
        const seg = this.db.getSegment(segId);
        const text = seg?.clean_text || seg?.raw_text || '';
        if (text.length > 10) {
          await this.queryEngine.indexSegment(segId, text);
        }
      }
      console.log(`[Processor] Video: indexed ${frameSegmentIds.length} frame analysis segments`);
    }
    } catch (err: any) {
      console.error(`[Processor] Video pipeline fatal error for ${fileName}:`, err);
      this.taskQueue.updateTask(task.id, {
        status: 'failed',
        error: `Video processing failed: ${err.message || err}`,
      });
      try { this.db.updateRecordingStatus(task.recordingId || 0, 'failed'); } catch { /* ignore */ }
    }
  }

  /**
   * Extract keyframes from a video file using ffmpeg.
   * Returns an array of JPEG file paths in the output directory.
   */
  private async extractKeyframes(videoPath: string, outputDir: string): Promise<string[]> {
    const ffmpegPaths = getFFmpegManager().find();
    if (!ffmpegPaths) {
      console.warn('[Processor] ffmpeg/ffprobe not found, skipping keyframe extraction');
      return [];
    }

    // Probe video duration
    let durationSec = 0;
    try {
      const probeOut = execFileSync(ffmpegPaths.ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        videoPath,
      ], { timeout: 15_000 }).toString().trim();
      durationSec = parseFloat(probeOut) || 0;
    } catch (err) {
      console.warn('[Processor] Could not probe video duration:', err);
    }

    // Determine number of frames based on duration
    let maxFrames: number;
    if (durationSec <= 0) {
      maxFrames = 3; // Unknown duration, extract a few
    } else if (durationSec < 60) {
      maxFrames = 3; // Short video: beginning, middle, end
    } else if (durationSec < 600) {
      maxFrames = Math.min(8, Math.max(5, Math.ceil(durationSec / 60))); // 1-10min: 5-8 frames
    } else {
      maxFrames = 10; // Long video: cap at 10
    }

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const framePattern = path.join(outputDir, `${baseName}-frame-%03d.jpg`);

    // Calculate fps filter: extract evenly spaced frames
    const interval = durationSec > 0 ? Math.max(1, Math.floor(durationSec / maxFrames)) : 10;

    try {
      execFileSync(ffmpegPaths.ffmpeg, [
        '-i', videoPath,
        '-vf', `fps=1/${interval}`,
        '-frames:v', String(maxFrames),
        '-q:v', '3',
        '-y',
        framePattern,
      ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    } catch (err: any) {
      console.warn('[Processor] Keyframe extraction failed:', err.message);
      return [];
    }

    // Collect extracted frame files
    const framePaths: string[] = [];
    for (let i = 1; i <= maxFrames; i++) {
      const fp = path.join(outputDir, `${baseName}-frame-${String(i).padStart(3, '0')}.jpg`);
      if (fs.existsSync(fp)) framePaths.push(fp);
    }

    console.log(`[Processor] Extracted ${framePaths.length} keyframes from video (duration: ${Math.round(durationSec)}s, interval: ${interval}s)`);
    return framePaths;
  }

  /**
   * Check if a video needs transcoding to H.264 for web playback.
   * Returns true if the codec is not H.264 (e.g. HEVC, VP9, etc).
   */
  private async videoNeedsTranscode(videoPath: string): Promise<boolean> {
    const ffmpegPaths = getFFmpegManager().find();
    if (!ffmpegPaths) return false; // Can't probe, assume it's fine

    try {
      const probeOut = execFileSync(ffmpegPaths.ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        videoPath,
      ], { timeout: 10_000 }).toString().trim();

      const codec = probeOut.toLowerCase();
      const webSafe = ['h264', 'vp8', 'vp9', 'av1'];
      const safe = webSafe.some((c) => codec.includes(c));
      console.log(`[Processor] Video codec: ${codec}, web-safe: ${safe}`);
      return !safe;
    } catch (err) {
      console.warn('[Processor] Could not probe video codec, will transcode:', err);
      return true; // Transcode to be safe
    }
  }

  /**
   * Full image processing pipeline: insert recording, copy file, multimodal LLM analysis
   * (description + OCR + key info extraction), vector indexing, memory extraction, markdown output.
   */
  private async processImage(task: QueueTask): Promise<void> {
    const originalPath = task.filePath;
    const fileName = path.basename(originalPath);
    console.log(`[Processor] Image pipeline for: ${fileName}${task.recordingId ? ` (reprocess #${task.recordingId})` : ''}`);

    await this.waitForFileStable(originalPath);

    // Validate image file size (20 MB limit)
    const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
    const stat = fs.statSync(originalPath);
    if (stat.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)`);
    }

    // 1. Insert or reuse recording
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 5 });
    let recordingId: number;
    if (task.recordingId) {
      recordingId = task.recordingId;
      this.db.clearRecordingData(recordingId);
      console.log(`[Processor] Reusing existing recording #${recordingId} for ${fileName}`);
    } else {
      const existingRec = this.db.getRecordingByPath(originalPath);
      if (existingRec) {
        recordingId = existingRec.id;
        this.db.clearRecordingData(recordingId);
        console.log(`[Processor] Reusing existing recording #${recordingId} for ${fileName}`);
      } else {
        recordingId = this.db.insertRecording({
          file_path: originalPath,
          file_name: fileName,
          media_type: 'image',
        });
      }
    }
    this.db.updateRecordingStatus(recordingId, 'processing');

    try {
      // 2. Copy file to output/images directory
      this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 10, notes: 'Copying image...' });
      const destDir = path.join(this.config.outputDir, 'images');
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, fileName);
      if (originalPath !== destPath) {
        fs.copyFileSync(originalPath, destPath);
      }
      console.log(`[Processor] Image copied to: ${destPath}`);

      // Update file_path to output location (original temp file may be cleaned up)
      this.db.updateRecordingFilePath(recordingId, destPath);

      // 3. Read image, resize if needed, and encode to base64
      this.taskQueue.updateTask(task.id, { status: 'transcribing', progress: 20, notes: 'Analyzing image with AI...' });
      const base64Image = readImageAsBase64(originalPath);
      console.log(`[Processor] Image step 3: Encoded ${(base64Image.length / 1024).toFixed(0)} KB base64`);

      // 4. Multimodal LLM analysis (description + OCR + key info)
      const settings = loadSettings();

      interface ImageAnalysis {
        description: string;
        ocr_text: string;
      }

      let analysis: ImageAnalysis = { description: '', ocr_text: '' };
      try {
        const result = await this.llmClient.generateJSON<ImageAnalysis>({
          model: this.llmModel,
          prompt: getPipelinePrompt('imageAnalysis', settings.language),
          images: [base64Image],
          temperature: 0.1,
          num_ctx: 4096,
        });
        analysis = {
          description: result.description || '',
          ocr_text: result.ocr_text || '',
        };
        console.log(`[Processor] Image step 4: LLM analysis done — description: ${analysis.description.length} chars, OCR: ${analysis.ocr_text.length} chars`);
      } catch (err) {
        console.warn('[Processor] Image AI analysis failed, continuing with empty results:', err);
      }

      // 5. Insert segments (description + OCR)
      this.taskQueue.updateTask(task.id, { status: 'optimizing', progress: 40, notes: 'Saving analysis results...' });
      const segmentIds: number[] = [];

      if (analysis.description?.trim()) {
        const descSegId = this.db.insertSegment({
          recording_id: recordingId,
          raw_text: analysis.description.trim(),
          clean_text: analysis.description.trim(),
          start_time: 0,
          end_time: 0,
          source: 'image_description',
        });
        segmentIds.push(descSegId);
        console.log(`[Processor] Image step 5a: Inserted description segment #${descSegId}`);
      }

      if (analysis.ocr_text?.trim()) {
        const ocrSegId = this.db.insertSegment({
          recording_id: recordingId,
          raw_text: analysis.ocr_text.trim(),
          clean_text: analysis.ocr_text.trim(),
          start_time: 0,
          end_time: 0,
          source: 'image_ocr',
        });
        segmentIds.push(ocrSegId);
        console.log(`[Processor] Image step 5b: Inserted OCR segment #${ocrSegId}`);
      }

      // 6. Items auto-extraction disabled — items are created on-demand via agent/manual

      // 7. Vector indexing
      if (this.queryEngine) {
        this.taskQueue.updateTask(task.id, { status: 'indexing', progress: 70, notes: 'Indexing vectors...' });
        let indexed = 0;
        for (const segId of segmentIds) {
          const seg = this.db.getSegment(segId);
          const text = seg?.clean_text || seg?.raw_text || '';
          if (text.length > 10) {
            await this.queryEngine.indexSegment(segId, text);
            indexed++;
          }
        }
        console.log(`[Processor] Image step 7: Indexed ${indexed}/${segmentIds.length} segments`);
      }

      // 8. Memory extraction
      this.taskQueue.updateTask(task.id, { status: 'extracting memories', progress: 80, notes: 'Extracting memories...' });
      try {
        const llmClient = createLLMClient(settings);
        const memoryExtractor = new MemoryExtractor(llmClient, getLLMModel(settings));
        const allText = segmentIds.map((id) => {
          const seg = this.db.getSegment(id);
          return seg?.clean_text || seg?.raw_text || '';
        }).join('\n');
        const facts = await memoryExtractor.extract(allText);
        if (facts.length > 0 && this.memoryManager) {
          for (const fact of facts) {
            await this.memoryManager.addFact(fact.fact, fact.category, fact.confidence, [recordingId]);
          }
          console.log(`[Processor] Image step 8: Extracted ${facts.length} memories`);
        }
      } catch (err) {
        console.warn('[Processor] Image memory extraction failed:', err);
      }

      // Enqueue knowledge compilation (async, non-blocking)
      try {
        this.knowledgeCompiler?.enqueue(recordingId);
      } catch (err) {
        console.warn(`[Processor] Knowledge compilation enqueue failed:`, err);
      }

      // 9. Markdown output
      this.taskQueue.updateTask(task.id, { status: 'generating notes', progress: 90, notes: 'Generating markdown...' });
      try {
        const mdGen = new MarkdownGenerator(this.config.outputDir, settings.obsidianWikilinks);
        const today = formatLocalDate();
        const baseName = fileName.replace(/\.[^.]+$/, '');
        const segments = segmentIds.map((id) => {
          const seg = this.db.getSegment(id);
          return {
            start: 0, end: 0, speaker: '',
            text: seg?.raw_text || '',
            clean_text: seg?.clean_text || '',
            source: 'image',
          };
        });
        const transcriptMd = mdGen.buildTranscript({
          date: today, title: baseName,
          captureScene: 'image',
          segments,
        });
        mdGen.writeTranscript(today, baseName, transcriptMd);

        if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
          MarkdownGenerator.syncToVault(
            this.config.outputDir, settings.obsidianVaultDir,
            path.join('transcripts', today, `${baseName}.md`),
          );
        }
      } catch (err) {
        console.warn('[Processor] Image markdown generation failed:', err);
      }

      // 10. Auto-classify tags (Pro feature)
      if (!this.licenseManager || this.licenseManager.isPro()) {
        try {
          const combinedText = segmentIds.map((id) => {
            const seg = this.db.getSegment(id);
            return seg?.clean_text || seg?.raw_text || '';
          }).join(' ');
          if (combinedText.length > 20) {
            const tags = await this.optimizer.classifyRecording(combinedText);
            if (tags.length > 0) this.db.setRecordingTags(recordingId, tags);
          }
        } catch (err) {
          console.warn('[Processor] Image auto-classification failed:', err);
        }
      }

      // 11. Mark completed
      this.db.updateRecordingStatus(recordingId, 'completed');
      this.taskQueue.updateTask(task.id, { status: 'completed', progress: 100 });
      console.log(`[Processor] Image pipeline completed for: ${fileName}`);
    } catch (err) {
      this.db.updateRecordingStatus(recordingId, 'failed');
      throw err;
    }
  }

  /**
   * Process a directory of images as a single multi-image group recording.
   * Lists image files, creates one recording, analyzes each image via multimodal LLM,
   * inserts segments per image, vector indexes, memory extraction, and markdown output.
   */
  private async processImageGroup(task: QueueTask): Promise<void> {
    const dirPath = task.filePath;
    const groupName = path.basename(dirPath);
    console.log(`[Processor] Image group pipeline for: ${groupName}${task.recordingId ? ` (reprocess #${task.recordingId})` : ''}`);

    // 1. List image files in the directory
    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);
    const allFiles = fs.readdirSync(dirPath);
    const imageFiles = allFiles
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();

    if (imageFiles.length === 0) {
      throw new Error(`No image files found in directory: ${dirPath}`);
    }
    console.log(`[Processor] Image group: found ${imageFiles.length} images`);

    // 2. Insert or reuse recording
    this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 5 });
    let recordingId: number;
    if (task.recordingId) {
      recordingId = task.recordingId;
      this.db.clearRecordingData(recordingId);
      console.log(`[Processor] Reusing existing recording #${recordingId} for ${groupName}`);
    } else {
      const existingRec = this.db.getRecordingByPath(dirPath);
      if (existingRec) {
        recordingId = existingRec.id;
        this.db.clearRecordingData(recordingId);
        console.log(`[Processor] Reusing existing recording #${recordingId} for ${groupName}`);
      } else {
        recordingId = this.db.insertRecording({
          file_path: dirPath,
          file_name: groupName,
          media_type: 'image',
        });
      }
    }
    this.db.updateRecordingStatus(recordingId, 'processing');

    try {
      // 3. Copy images to output/images/{groupName}/
      this.taskQueue.updateTask(task.id, { status: 'preprocessing', progress: 8, notes: 'Copying images...' });
      const destDir = path.join(this.config.outputDir, 'images', groupName);
      fs.mkdirSync(destDir, { recursive: true });
      for (const imgFile of imageFiles) {
        const srcPath = path.join(dirPath, imgFile);
        const destPath = path.join(destDir, imgFile);
        if (srcPath !== destPath) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
      console.log(`[Processor] Image group: copied ${imageFiles.length} images to ${destDir}`);

      // Update file_path to output directory (temp dir may be cleaned up)
      this.db.updateRecordingFilePath(recordingId, destDir);

      // 4. Analyze each image with multimodal LLM
      const settings = loadSettings();

      interface ImageAnalysis {
        description: string;
        ocr_text: string;
      }

      const totalImages = imageFiles.length;
      const allSegmentIds: number[] = [];
      const perImageResults: Array<{ file: string; description: string; ocr: string }> = [];

      for (let i = 0; i < totalImages; i++) {
        const imgFile = imageFiles[i];
        const imgPath = path.join(dirPath, imgFile);
        const imgLabel = `image ${i + 1}/${totalImages}`;
        const progressBase = 10 + Math.round((i / totalImages) * 70); // 10% to 80%

        this.taskQueue.updateTask(task.id, {
          status: 'transcribing',
          progress: progressBase,
          notes: `Analyzing ${imgLabel}: ${imgFile}...`,
        });

        // Validate image file size (20 MB limit per image)
        const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
        const stat = fs.statSync(imgPath);
        if (stat.size > MAX_IMAGE_SIZE) {
          console.warn(`[Processor] Skipping oversized image (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${imgFile}`);
          perImageResults.push({ file: imgFile, description: '[Image too large to analyze]', ocr: '' });
          continue;
        }

        // Read, resize if needed, and base64 encode
        const base64Image = readImageAsBase64(imgPath);

        // Multimodal LLM analysis
        let analysis: ImageAnalysis = { description: '', ocr_text: '' };
        try {
          const result = await this.llmClient.generateJSON<ImageAnalysis>({
            model: this.llmModel,
            prompt: getPipelinePrompt('imageAnalysis', settings.language),
            images: [base64Image],
            temperature: 0.1,
            num_ctx: 4096,
          });
          analysis = {
            description: result.description || '',
            ocr_text: result.ocr_text || '',
          };
          console.log(`[Processor] Image group ${imgLabel}: LLM analysis done — desc: ${analysis.description.length} chars, OCR: ${analysis.ocr_text.length} chars`);
        } catch (err) {
          console.warn(`[Processor] Image group ${imgLabel}: AI analysis failed, continuing:`, err);
        }

        perImageResults.push({
          file: imgFile,
          description: analysis.description,
          ocr: analysis.ocr_text,
        });

        // Insert segments for this image
        if (analysis.description?.trim()) {
          const descSegId = this.db.insertSegment({
            recording_id: recordingId,
            raw_text: `[${imgLabel}] ${analysis.description.trim()}`,
            clean_text: `[${imgLabel}] ${analysis.description.trim()}`,
            start_time: 0,
            end_time: 0,
            source: 'image_description',
          });
          allSegmentIds.push(descSegId);
        }

        if (analysis.ocr_text?.trim()) {
          const ocrSegId = this.db.insertSegment({
            recording_id: recordingId,
            raw_text: `[${imgLabel}] ${analysis.ocr_text.trim()}`,
            clean_text: `[${imgLabel}] ${analysis.ocr_text.trim()}`,
            start_time: 0,
            end_time: 0,
            source: 'image_ocr',
          });
          allSegmentIds.push(ocrSegId);
        }

      }

      // 5. Items auto-extraction disabled — items are created on-demand via agent/manual

      // 6. Vector indexing
      if (this.queryEngine) {
        this.taskQueue.updateTask(task.id, { status: 'indexing', progress: 85, notes: 'Indexing vectors...' });
        let indexed = 0;
        for (const segId of allSegmentIds) {
          const seg = this.db.getSegment(segId);
          const text = seg?.clean_text || seg?.raw_text || '';
          if (text.length > 10) {
            await this.queryEngine.indexSegment(segId, text);
            indexed++;
          }
        }
        console.log(`[Processor] Image group: indexed ${indexed}/${allSegmentIds.length} segments`);
      }

      // 7. Memory extraction
      this.taskQueue.updateTask(task.id, { status: 'extracting memories', progress: 88, notes: 'Extracting memories...' });
      try {
        const llmClient = createLLMClient(settings);
        const memoryExtractor = new MemoryExtractor(llmClient, getLLMModel(settings));
        const allText = allSegmentIds.map((id) => {
          const seg = this.db.getSegment(id);
          return seg?.clean_text || seg?.raw_text || '';
        }).join('\n');
        if (allText.trim().length > 10) {
          const facts = await memoryExtractor.extract(allText);
          if (facts.length > 0 && this.memoryManager) {
            for (const fact of facts) {
              await this.memoryManager.addFact(fact.fact, fact.category, fact.confidence, [recordingId]);
            }
            console.log(`[Processor] Image group: extracted ${facts.length} memories`);
          }
        }
      } catch (err) {
        console.warn('[Processor] Image group memory extraction failed:', err);
      }

      // Enqueue knowledge compilation (async, non-blocking)
      try {
        this.knowledgeCompiler?.enqueue(recordingId);
      } catch (err) {
        console.warn(`[Processor] Knowledge compilation enqueue failed:`, err);
      }

      // 8. Markdown output (one section per image)
      this.taskQueue.updateTask(task.id, { status: 'generating notes', progress: 92, notes: 'Generating markdown...' });
      try {
        const mdGen = new MarkdownGenerator(this.config.outputDir, settings.obsidianWikilinks);
        const today = formatLocalDate();

        // Build segments with per-image sections
        const segments = perImageResults.map((img, idx) => {
          const parts: string[] = [];
          if (img.description) parts.push(img.description);
          if (img.ocr) parts.push(`OCR: ${img.ocr}`);
          const text = parts.join('\n') || '[No analysis available]';
          return {
            start: 0, end: 0, speaker: '',
            text: `### Image ${idx + 1}/${totalImages}: ${img.file}\n${text}`,
            clean_text: `### Image ${idx + 1}/${totalImages}: ${img.file}\n${text}`,
            source: 'image',
          };
        });

        const transcriptMd = mdGen.buildTranscript({
          date: today, title: groupName,
          captureScene: 'image',
          segments,
        });
        mdGen.writeTranscript(today, groupName, transcriptMd);

        if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
          MarkdownGenerator.syncToVault(
            this.config.outputDir, settings.obsidianVaultDir,
            path.join('transcripts', today, `${groupName}.md`),
          );
        }
      } catch (err) {
        console.warn('[Processor] Image group markdown generation failed:', err);
      }

      // 9. Auto-classify tags (Pro feature)
      if (!this.licenseManager || this.licenseManager.isPro()) {
        try {
          const combinedText = allSegmentIds.map((id) => {
            const seg = this.db.getSegment(id);
            return seg?.clean_text || seg?.raw_text || '';
          }).join(' ');
          if (combinedText.length > 20) {
            const tags = await this.optimizer.classifyRecording(combinedText);
            if (tags.length > 0) this.db.setRecordingTags(recordingId, tags);
          }
        } catch (err) {
          console.warn('[Processor] Image group auto-classification failed:', err);
        }
      }

      // 10. Mark completed
      this.db.updateRecordingStatus(recordingId, 'completed');
      this.taskQueue.updateTask(task.id, { status: 'completed', progress: 100 });
      console.log(`[Processor] Image group pipeline completed for: ${groupName} (${totalImages} images)`);
    } catch (err) {
      this.db.updateRecordingStatus(recordingId, 'failed');
      throw err;
    }
  }

  /**
   * Re-run text optimization only for an existing recording.
   * Skips ASR, diarization, vector indexing, and Markdown — just re-cleans raw_text.
   */
  async reoptimizeRecording(recordingId: number): Promise<void> {
    const segments = this.db.getSegmentsByRecording(recordingId);
    if (segments.length === 0) {
      throw new Error(`No segments found for recording ${recordingId}`);
    }

    const rawLines = segments
      .map(s => s.raw_text || '')
      .filter(t => t.trim());

    if (rawLines.length === 0) {
      throw new Error(`Recording ${recordingId} has no raw text to optimize`);
    }

    const fullRawText = rawLines.join('\n');
    let batchCleaned: string;
    try {
      batchCleaned = await this.optimizer.batchClean(fullRawText);
    } catch (err: any) {
      throw new Error(`batchClean failed: ${err.message}`);
    }

    const cleanedLines = batchCleaned.split('\n').filter(l => l.trim());
    const rawSegs = segments.filter(s => s.raw_text?.trim());

    if (cleanedLines.length !== rawSegs.length) {
      console.warn(`[Processor] reoptimize line count mismatch: expected ${rawSegs.length}, got ${cleanedLines.length}. Falling back to per-segment.`);
      // Fall back to per-segment optimization
      for (const seg of rawSegs) {
        try {
          const cleaned = await this.optimizer.cleanText(seg.raw_text || '');
          this.db.updateSegmentCleanText(seg.id, cleaned);
        } catch {
          // Keep existing clean_text
        }
      }
    } else {
      for (let i = 0; i < rawSegs.length; i++) {
        this.db.updateSegmentCleanText(rawSegs[i].id, cleanedLines[i]);
      }
    }

    console.log(`[Processor] reoptimizeRecording: updated ${rawSegs.length} segments for recording ${recordingId}`);
  }
}
