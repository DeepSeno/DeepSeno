import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TMP_DIR = require('os').tmpdir().replace(/\\/g, '/');
const VB_TEST_BASE = `${TMP_DIR}/vb-test`;

// ── Mock all external dependencies BEFORE importing Processor ──

// Mock node:sqlite
vi.mock('node:sqlite', () => {
  const stmt = { get: vi.fn(() => ({ user_version: 0 })), all: vi.fn(() => []), run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })) };
  return { DatabaseSync: vi.fn(() => ({ exec: vi.fn(), prepare: vi.fn(() => stmt), close: vi.fn() })) };
});

// Mock electron (safeStorage used by settings.ts)
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => `${TMP_DIR}/deepseno-test`, isPackaged: false },
}));

// Mock paths module (used by settings.ts)
vi.mock('../paths', () => ({
  getSharedSettingsPath: () => `${VB_TEST_BASE}/settings-shared.json`,
  getLocalSettingsPath: () => `${VB_TEST_BASE}/settings-local.json`,
  getSettingsPath: () => `${VB_TEST_BASE}/settings.json`,
  getOutputDir: () => `${VB_TEST_BASE}/output`,
  getDbPath: () => `${VB_TEST_BASE}/deepseno.db`,
  getLocalDataDir: () => VB_TEST_BASE,
  getEffectiveDataDir: () => VB_TEST_BASE,
}));

// Mock settings — inline to avoid hoisting issues
vi.mock('../settings', () => ({
  loadSettings: vi.fn(() => ({
    language: 'zh',
    whisperModel: 'sensevoice',
    llmModel: 'qwen2.5:14b',
    embedModel: 'bge-m3',
    hfToken: 'test-token',
    llmProvider: 'local',
    cloudApiUrl: '',
    cloudApiKey: '',
    cloudModel: '',
    cloudEmbedModel: '',
    realtimeDailySummary: false,
    autoReportDaily: false,
    autoReportDailyTime: '22:00',
    autoReportWeekly: false,
    autoReportWeeklyDay: 5,
    autoReportWeeklyTime: '22:00',
    obsidianAutoExport: false,
    obsidianWikilinks: false,
    feishuAppId: '',
    feishuAppSecret: '',
    feishuEnabled: false,
    feishuNotifyOnComplete: false,
    feishuNotifyDailyDigest: false,
    feishuAdminOpenId: '',
    wechatCorpId: '',
    wechatAgentId: '',
    wechatSecret: '',
    wechatEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramEnabled: false,
    soulConfig: '',
    agentsRules: '',
    setupComplete: true,
    watchDir: `${TMP_DIR}/watch`,
    outputDir: `${VB_TEST_BASE}/output`,
    obsidianVaultDir: '',
    recordingShortcut: 'Alt+,',
    autoPasteAfterRecording: true,
    clipboardContinuous: true,
    llmCleanBeforePaste: true,
    llmCleanPrompt: '',
    hotwords: [],
    streamingModel: 'base',
    showAllFeatures: true,
    firstLaunchTime: 0,
    licenseKey: '',
  })),
  saveSettings: vi.fn(),
  updateSettings: vi.fn(),
  clearSettingsCache: vi.fn(),
}));

// Mock soul module
vi.mock('../agent/soul', () => ({
  loadSoulContext: vi.fn(() => ({ soul: '', rules: '' })),
  buildSoulSystemPrompt: vi.fn(() => ''),
}));

// Mock MemoryExtractor — use function class pattern for constructor
vi.mock('../agent/memory-extractor', () => ({
  MemoryExtractor: function MemoryExtractor() {
    return { extract: vi.fn(async () => []) };
  },
}));

// Mock LLM create-client — needs to return mockLLMClient accessible for assertions
// We declare it inside the factory to avoid hoisting issues, then re-export via module
vi.mock('../llm/create-client', () => {
  const client = {
    generate: vi.fn(async () => 'optimized text'),
    generateStream: vi.fn(async () => ''),
    generateJSON: vi.fn(async () => ({
      items: [
        { type: 'todo', content: 'Follow up with team', related_person: 'Alice' },
      ],
      relationships: [],
    })),
    embed: vi.fn(async () => new Array(1024).fill(0)),
    isAvailable: vi.fn(async () => true),
    listModels: vi.fn(async () => ['qwen2.5:14b']),
  };
  return {
    createLLMClient: vi.fn(() => client),
    getLLMModel: vi.fn(() => 'qwen2.5:14b'),
    getEmbedModel: vi.fn(() => 'bge-m3'),
    __mockLLMClient: client,
  };
});

// Mock VoiceBrainDB — use function class pattern
vi.mock('../db/database', () => {
  const mockRawDb = {
    prepare: vi.fn(() => ({ run: vi.fn() })),
    exec: vi.fn(),
  };
  const db = {
    insertRecording: vi.fn(() => 1),
    updateRecordingStatus: vi.fn(),
    updateRecordingDuration: vi.fn(),
    getRecording: vi.fn(() => ({
      id: 1,
      file_path: `${TMP_DIR}/test.wav`,
      file_name: 'test.wav',
      duration_seconds: 15,
      recorded_at: '2026-02-27T10:00:00',
      status: 'processing',
    })),
    insertSpeaker: vi.fn(() => 1),
    insertPerson: vi.fn(() => 1),
    insertPersonIdentifier: vi.fn(),
    insertSegment: vi.fn(() => 1),
    insertExtractedItem: vi.fn(),
    insertPersonRelationship: vi.fn(),
    getPersonByName: vi.fn(() => ({ id: 1, name: 'Person 1' })),
    upsertDailySummary: vi.fn(),
    getSegmentsByDate: vi.fn(() => []),
    getSegmentIdsByRecording: vi.fn(() => []),
    clearRecordingData: vi.fn(),
    getSpeaker: vi.fn(() => ({ id: 1, name: 'Speaker 1' })),
    getPerson: vi.fn(() => ({ id: 1, name: 'Person 1' })),
    getSegment: vi.fn(() => null),
    saveMeetingNotes: vi.fn(),
    updateRecordingAutoTitle: vi.fn(),
    updateRecordingImportance: vi.fn(),
    findActiveCaptureSession: vi.fn(() => null),
    updateSegmentSentiment: vi.fn(),
    getAllRecordings: vi.fn(() => []),
    getRecordingByPath: vi.fn(() => undefined),
    getRawDb: vi.fn(() => mockRawDb),
    setRecordingTags: vi.fn(),
    updateRecordingFilePath: vi.fn(),
    buildVocabularyPromptBlock: vi.fn(() => ''),
  };
  return {
    VoiceBrainDB: function VoiceBrainDB() { return db; },
    __mockDb: db,
  };
});

// Mock AudioPreprocessor — use function class pattern
vi.mock('../audio/preprocessor', () => {
  const preprocessor = {
    convertTo16kMono: vi.fn(async () => `${TMP_DIR}/test_16k_mono.wav`),
    getDuration: vi.fn(async () => 15), // <30s triggers fast mode
    detectSpeechSegments: vi.fn(async () => ({
      segments: [{ start: 0, end: 10, duration: 10 }],
      total_speech_seconds: 10,
    })),
    splitBySegments: vi.fn(async () => [`${TMP_DIR}/segment_0000.wav`]),
  };
  return {
    AudioPreprocessor: function AudioPreprocessor() { return preprocessor; },
    __mockPreprocessor: preprocessor,
  };
});

vi.mock('../audio/ffmpeg-manager', () => ({
  getFFmpegManager: vi.fn(() => ({
    find: vi.fn(() => null),
  })),
}));

// Mock Transcriber — use function class pattern
vi.mock('../audio/transcriber', () => {
  const mockTranscribeResult = {
    language: 'zh',
    segments: [
      { start: 0, end: 5, text: 'Hello this is a test of the transcription system' },
      { start: 5, end: 10, text: 'We need to follow up with the client tomorrow about the project' },
    ],
    full_text: 'Hello this is a test. We need to follow up.',
  };
  const transcribeFn = vi.fn(async () => mockTranscribeResult);
  return {
    Transcriber: function Transcriber() {
      return { transcribe: transcribeFn };
    },
    __mockTranscribeFn: transcribeFn,
  };
});

// Mock Diarizer — use function class pattern
vi.mock('../audio/diarizer', () => ({
  Diarizer: function Diarizer() {
    return {
      diarize: vi.fn(async () => ({
        segments: [
          { start: 0, end: 5, speaker: 'SPEAKER_00' },
          { start: 5, end: 10, speaker: 'SPEAKER_01' },
        ],
      })),
    };
  },
}));

// Mock mergeTranscriptWithDiarization
vi.mock('../audio/merge-transcript', () => ({
  mergeTranscriptWithDiarization: vi.fn(() => [
    { start: 0, end: 5, speaker: 'SPEAKER_00', text: 'Hello this is a test of the transcription system' },
    { start: 5, end: 10, speaker: 'SPEAKER_01', text: 'We need to follow up with the client tomorrow about the project' },
  ]),
}));


// Mock PersonMatcher
vi.mock('../person/person-matcher', () => ({
  PersonMatcher: function PersonMatcher() {
    return {
      matchOrCreate: vi.fn(() => ({ personId: 1, isNew: true, confidence: 1.0 })),
      linkContentToPerson: vi.fn(),
    };
  },
}));

// Mock MarkdownGenerator — use function class pattern
vi.mock('../output/markdown-generator', () => ({
  MarkdownGenerator: function MarkdownGenerator() {
    return {
      buildTranscript: vi.fn(() => '# Test Transcript\n\nContent here'),
      writeTranscript: vi.fn(() => `${TMP_DIR}/output/transcripts/2026-02-27/test.md`),
    };
  },
}));

// Mock fluent-ffmpeg (imported by preprocessor)
vi.mock('fluent-ffmpeg', () => {
  const mockFfmpeg: any = vi.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const chain: any = {
      noVideo: vi.fn(() => chain),
      videoCodec: vi.fn(() => chain),
      addOption: vi.fn(() => chain),
      audioFrequency: vi.fn(() => chain),
      audioChannels: vi.fn(() => chain),
      audioCodec: vi.fn(() => chain),
      output: vi.fn(() => chain),
      setStartTime: vi.fn(() => chain),
      setDuration: vi.fn(() => chain),
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
        return chain;
      }),
      run: vi.fn(() => {
        setTimeout(() => handlers.end?.(), 0);
        return chain;
      }),
    };
    return chain;
  });
  mockFfmpeg.ffprobe = vi.fn();
  mockFfmpeg.setFfmpegPath = vi.fn();
  mockFfmpeg.setFfprobePath = vi.fn();
  return { default: mockFfmpeg };
});

// Mock sqlite-vec
vi.mock('sqlite-vec', () => ({
  load: vi.fn(),
}));

// Mock fs — override statSync for file timestamp extraction in processor
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && (p.includes('test') || p.includes('vb-test'))) return true;
        return actual.existsSync(p);
      }),
      statSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('test')) {
          return { mtime: new Date('2026-02-27T10:00:00'), size: 1024 };
        }
        return actual.statSync(p);
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: actual.readFileSync,
      copyFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      renameSync: vi.fn(),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && (p.includes('test') || p.includes('vb-test'))) return true;
      return actual.existsSync(p);
    }),
    statSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('test')) {
        return { mtime: new Date('2026-02-27T10:00:00'), size: 1024 };
      }
      return actual.statSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: actual.readFileSync,
    copyFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    renameSync: vi.fn(),
  };
});

// ── Now import Processor and access mock internals ──
import { Processor, ProcessorConfig } from '../pipeline/processor';
import type { QueueTask } from '../pipeline/task-queue';

// Access mock objects through the mock modules
const { __mockDb: mockDb } = await import('../db/database') as any;
const { __mockPreprocessor: mockPreprocessor } = await import('../audio/preprocessor') as any;
const { __mockLLMClient: mockLLMClient } = await import('../llm/create-client') as any;
const { __mockTranscribeFn: mockTranscribeFn } = await import('../audio/transcriber') as any;

// ── Helper: wait for task completion or failure ──

function waitForTask(queue: import('../pipeline/task-queue').TaskQueue, timeoutMs = 10000): Promise<QueueTask> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for task')), timeoutMs);
    queue.on('task:completed', (t: QueueTask) => {
      clearTimeout(timeout);
      resolve(t);
    });
    queue.on('task:failed', (t: QueueTask) => {
      clearTimeout(timeout);
      resolve(t); // resolve (not reject) so caller can inspect
    });
  });
}

// ── Test suite ──

describe('Processor', () => {
  let processor: Processor;
  const testConfig: ProcessorConfig = {
    dbPath: `${VB_TEST_BASE}/deepseno.db`,
    outputDir: `${VB_TEST_BASE}/output`,
    tempDir: `${VB_TEST_BASE}/temp`,
    whisperModel: 'sensevoice',
    llmModel: 'qwen2.5:14b',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock behaviors after clearAllMocks
    mockDb.insertRecording.mockReturnValue(1);
    mockDb.insertSpeaker.mockReturnValue(1);
    mockDb.insertPerson.mockReturnValue(1);
    mockDb.insertSegment.mockReturnValue(1);
    mockDb.getSpeaker.mockReturnValue({ id: 1, name: 'Speaker 1' });
    mockDb.getPerson.mockReturnValue({ id: 1, name: 'Person 1' });
    mockDb.getSegmentsByDate.mockReturnValue([]);
    mockDb.getSegmentIdsByRecording.mockReturnValue([]);
    mockDb.getAllRecordings.mockReturnValue([]);
    mockDb.getRecording.mockReturnValue({
      id: 1, file_path: `${TMP_DIR}/test.wav`, file_name: 'test.wav',
      duration_seconds: 15, recorded_at: '2026-02-27T10:00:00', status: 'processing',
    });
    mockPreprocessor.convertTo16kMono.mockResolvedValue(`${TMP_DIR}/test_16k_mono.wav`);
    mockPreprocessor.getDuration.mockResolvedValue(15);
    mockLLMClient.generate.mockResolvedValue('optimized text');
    mockLLMClient.generateJSON.mockResolvedValue({
      items: [{ type: 'todo', content: 'Follow up with team', related_person: 'Alice' }],
      relationships: [],
    });
    mockLLMClient.embed.mockResolvedValue(new Array(1024).fill(0));
    mockTranscribeFn.mockResolvedValue({
      language: 'zh',
      segments: [
        { start: 0, end: 5, text: 'Hello this is a test of the transcription system' },
        { start: 5, end: 10, text: 'We need to follow up with the client tomorrow about the project' },
      ],
      full_text: 'Hello this is a test. We need to follow up.',
    });

    processor = new Processor(testConfig);
  });

  afterEach(() => {
    processor.getTaskQueue().removeAllListeners();
  });

  // ── Test 1: Constructor ──

  describe('constructor', () => {
    it('creates Processor instance successfully with mocked deps', () => {
      expect(processor).toBeDefined();
      expect(processor.getTaskQueue()).toBeDefined();
    });

    it('uses provided db instance if given', () => {
      const customDb = { insertRecording: vi.fn(), buildVocabularyPromptBlock: vi.fn(() => '') } as any;
      const proc = new Processor({ ...testConfig, db: customDb });
      expect(proc).toBeDefined();
      proc.getTaskQueue().removeAllListeners();
    });
  });

  // ── Test 2: Enqueue + Process pipeline ──

  describe('enqueue and process', () => {
    it('enqueue returns a QueueTask with correct fields', () => {
      const task = processor.enqueue(`${TMP_DIR}/test.wav`);
      expect(task).toBeDefined();
      expect(task.filePath).toBe(`${TMP_DIR}/test.wav`);
      // Task may already be processing since processNext() fires immediately
      expect(['pending', 'preprocessing']).toContain(task.status);
      expect(task.id).toMatch(/^task_/);
    });

    it('processes file through the full pipeline (fast mode for short audio)', async () => {
      const events: string[] = [];
      const queue = processor.getTaskQueue();

      queue.on('task:added', () => events.push('added'));
      queue.on('task:progress', () => events.push('progress'));
      queue.on('task:completed', () => events.push('completed'));

      processor.enqueue(`${TMP_DIR}/test.wav`);

      const result = await waitForTask(queue);
      expect(result.status).toBe('completed');

      // Verify DB calls (may be called more than once due to test ordering)
      expect(mockDb.insertRecording).toHaveBeenCalled();
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'processing');
      expect(mockDb.updateRecordingDuration).toHaveBeenCalledWith(1, 15);
      expect(mockDb.insertSegment).toHaveBeenCalled();

      // Verify pipeline step calls
      expect(mockPreprocessor.convertTo16kMono).toHaveBeenCalledWith(
        `${TMP_DIR}/test.wav`,
        `${VB_TEST_BASE}/temp`,
      );
      expect(mockPreprocessor.getDuration).toHaveBeenCalledWith(`${TMP_DIR}/test.wav`);

      // In fast mode (duration <30s), VAD/split/diarize are SKIPPED
      expect(mockPreprocessor.detectSpeechSegments).not.toHaveBeenCalled();

      // LLM text optimization (generate called for cleanText on segments >= 10 chars)
      expect(mockLLMClient.generate).toHaveBeenCalled();

      // Info extraction via generateJSON
      expect(mockLLMClient.generateJSON).toHaveBeenCalled();

      // Final status should be completed
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'completed');

      // Events should include added and completed
      expect(events).toContain('added');
      expect(events).toContain('completed');
    });

    it('deduplicates enqueue for the same file path', () => {
      const task1 = processor.enqueue(`${TMP_DIR}/test_dedup.wav`);
      const task2 = processor.enqueue(`${TMP_DIR}/test_dedup.wav`);
      expect(task1.id).toBe(task2.id);
    });
  });

  // ── Test 3: Status transitions ──

  describe('status transitions', () => {
    it('recording transitions from processing → completed', async () => {
      const statusCalls: Array<[number, string]> = [];
      mockDb.updateRecordingStatus.mockImplementation((id: number, status: string) => {
        statusCalls.push([id, status]);
      });

      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_status.wav`);

      const result = await waitForTask(queue);
      expect(result.status).toBe('completed');

      // Should see processing then completed
      expect(statusCalls).toContainEqual([1, 'processing']);
      expect(statusCalls).toContainEqual([1, 'completed']);

      // processing should come before completed
      const processingIdx = statusCalls.findIndex(([, s]) => s === 'processing');
      const completedIdx = statusCalls.findIndex(([, s]) => s === 'completed');
      expect(processingIdx).toBeLessThan(completedIdx);
    });
  });

  // ── Test 4: TaskQueue events ──

  describe('TaskQueue events', () => {
    it('fires task:added when enqueuing', () => {
      const addedTasks: QueueTask[] = [];
      processor.getTaskQueue().on('task:added', (t: QueueTask) => addedTasks.push(t));

      processor.enqueue(`${TMP_DIR}/test_events.wav`);

      expect(addedTasks).toHaveLength(1);
      expect(addedTasks[0].filePath).toBe(`${TMP_DIR}/test_events.wav`);
    });

    it('fires task:progress during processing', async () => {
      const progressEvents: QueueTask[] = [];
      const queue = processor.getTaskQueue();
      queue.on('task:progress', (t: QueueTask) => progressEvents.push({ ...t }));

      processor.enqueue(`${TMP_DIR}/test_progress.wav`);

      const result = await waitForTask(queue);
      expect(result.status).toBe('completed');

      // Should have multiple progress events with increasing progress values
      expect(progressEvents.length).toBeGreaterThan(0);

      // Progress values should generally increase
      const progressValues = progressEvents.map((e) => e.progress);
      const maxProgress = Math.max(...progressValues);
      expect(maxProgress).toBeGreaterThanOrEqual(60);
    });

    it('fires task:completed after successful processing', async () => {
      const completedTasks: QueueTask[] = [];
      const queue = processor.getTaskQueue();
      queue.on('task:completed', (t: QueueTask) => completedTasks.push(t));

      processor.enqueue(`${TMP_DIR}/test_complete.wav`);

      await waitForTask(queue);

      expect(completedTasks).toHaveLength(1);
      expect(completedTasks[0].status).toBe('completed');
      expect(completedTasks[0].progress).toBe(100);
    });
  });

  // ── Test 5: Error handling ──

  describe('error handling', () => {
    it('marks recording as failed when preprocessing throws', async () => {
      mockPreprocessor.convertTo16kMono.mockRejectedValueOnce(
        new Error('FFmpeg not found'),
      );

      const failedTasks: QueueTask[] = [];
      const queue = processor.getTaskQueue();
      queue.on('task:failed', (t: QueueTask) => failedTasks.push(t));

      processor.enqueue(`${TMP_DIR}/test_error.wav`);

      const result = await waitForTask(queue);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Preprocessing failed');
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'failed');
    });

    it('marks recording as failed when transcription throws', async () => {
      // Make the transcribe function throw for this test
      mockTranscribeFn.mockRejectedValueOnce(new Error('ASR model not found'));

      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_asr_error.wav`);

      const result = await waitForTask(queue);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Transcription failed');
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'failed');
    });

    it('continues pipeline when text optimization fails (graceful fallback)', async () => {
      // Make generate fail for cleanText — the optimizer catches this and uses raw text
      mockLLMClient.generate.mockRejectedValue(new Error('LLM offline'));

      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_llm_fail.wav`);

      const result = await waitForTask(queue);

      // Pipeline should still complete — text optimization failure is non-fatal (uses raw text fallback)
      expect(result.status).toBe('completed');
      expect(mockDb.insertSegment).toHaveBeenCalled();
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'completed');
    });

    it('processes video through the audio pipeline and completes as the original video task', async () => {
      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_video_success.mp4`);

      const result = await waitForTask(queue);

      expect(result.status).toBe('completed');
      expect(result.filePath).toBe(`${TMP_DIR}/test_video_success.mp4`);
      expect(result.mediaType).toBe('video');
      expect(mockDb.insertRecording).toHaveBeenCalledWith(expect.objectContaining({
        file_name: 'test_video_success.mp4',
        media_type: 'video',
      }));
      expect(mockDb.updateRecordingFilePath).toHaveBeenCalledWith(
        1,
        `${VB_TEST_BASE}/output/videos/test_video_success.mp4`,
      );
      expect(mockPreprocessor.convertTo16kMono).toHaveBeenCalledWith(
        `${VB_TEST_BASE}/temp/test_video_success-audio.wav`,
        `${VB_TEST_BASE}/temp`,
      );
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'completed');
    });

    it('marks video task failed when delegated audio pipeline fails', async () => {
      mockTranscribeFn.mockRejectedValueOnce(new Error('ASR model not found'));

      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_video.mp4`);

      const result = await waitForTask(queue);

      expect(result.status).toBe('failed');
      expect(result.filePath).toBe(`${TMP_DIR}/test_video.mp4`);
      expect(result.mediaType).toBe('video');
      expect(result.error).toContain('Video processing failed');
      expect(result.error).toContain('Transcription failed');
      expect(mockDb.insertRecording).toHaveBeenCalledWith(expect.objectContaining({
        file_name: 'test_video.mp4',
        media_type: 'video',
      }));
      expect(mockDb.updateRecordingStatus).toHaveBeenCalledWith(1, 'failed');
    });
  });

  // ── Test 6: QueryEngine integration ──

  describe('setQueryEngine', () => {
    it('indexes segments into vector store when queryEngine is set', async () => {
      const mockIndexSegment = vi.fn();
      const mockQueryEngine = {
        indexSegment: mockIndexSegment,
        deleteSegments: vi.fn(),
      } as any;

      processor.setQueryEngine(mockQueryEngine);

      const queue = processor.getTaskQueue();
      processor.enqueue(`${TMP_DIR}/test_vector.wav`);

      const result = await waitForTask(queue);
      expect(result.status).toBe('completed');

      // indexSegment should have been called for segments with clean_text
      expect(mockIndexSegment).toHaveBeenCalled();
    });
  });
});
