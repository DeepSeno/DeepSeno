import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue, QueueTask } from '../../src/main/pipeline/task-queue';
import { VoiceBrainDB } from '../../src/main/db/database';
import { MarkdownGenerator } from '../../src/main/output/markdown-generator';
import { VectorStore } from '../../src/main/rag/vector-store';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('E2E Pipeline Integration', () => {
  const TMP_DIR = os.tmpdir().replace(/\\/g, '/');
  let dbPath: string;
  let db: VoiceBrainDB;
  let outputDir: string;

  beforeEach(() => {
    const testId = `deepseno-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    dbPath = path.join(os.tmpdir(), `${testId}.db`);
    outputDir = path.join(os.tmpdir(), `${testId}-output`);
    fs.mkdirSync(outputDir, { recursive: true });
    db = new VoiceBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    // Clean up DB files (main + WAL/SHM)
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('should process a complete recording workflow through the database', () => {
    // 1. Insert a recording
    const recordingId = db.insertRecording({
      file_path: `${TMP_DIR}/test-recording.wav`,
      file_name: 'test-recording.wav',
      duration_seconds: 120,
    });
    expect(recordingId).toBeGreaterThan(0);

    // 2. Insert a speaker
    const speakerId = db.insertSpeaker({ name: 'Zhang San', notes: 'Project manager' });
    expect(speakerId).toBeGreaterThan(0);

    // 3. Insert segments with speaker reference
    const seg1Id = db.insertSegment({
      recording_id: recordingId,
      speaker_id: speakerId,
      start_time: 0,
      end_time: 30,
      raw_text: 'The project progress update from Zhang San',
      clean_text: 'The project progress update from Zhang San.',
    });
    const seg2Id = db.insertSegment({
      recording_id: recordingId,
      speaker_id: undefined,
      start_time: 30,
      end_time: 60,
      raw_text: 'We still have a budget problem to resolve',
      clean_text: 'We still have a budget problem to resolve.',
    });
    expect(seg1Id).toBeGreaterThan(0);
    expect(seg2Id).toBeGreaterThan(0);

    // 4. Insert extracted items
    db.insertExtractedItem({
      segment_id: seg1Id,
      type: 'todo',
      content: '确认项目预算',
      due_date: '2026-02-20',
      related_person: 'Zhang San',
    });
    db.insertExtractedItem({
      segment_id: seg2Id,
      type: 'decision',
      content: '项目延期两周',
    });

    // 5. Verify FTS search works
    const searchResults = db.searchSegments('budget');
    expect(searchResults.length).toBeGreaterThan(0);

    // 6. Verify segment retrieval with speaker name
    const segment = db.getSegment(seg1Id);
    expect(segment.speaker_name).toBe('Zhang San');

    // 7. Verify extracted items
    const todos = db.getExtractedItemsByType('todo');
    expect(todos.length).toBe(1);
    expect(todos[0].content).toBe('确认项目预算');

    // 8. Update recording status
    db.updateRecordingStatus(recordingId, 'completed');
    const recording = db.getRecording(recordingId);
    expect(recording.status).toBe('completed');

    // 9. Insert daily summary
    db.insertDailySummary({
      date: '2026-02-17',
      summary_text: 'Discussed project progress and budget issues',
      timeline_json: JSON.stringify([{ time: '09:30', event: 'Project discussion' }]),
    });
    const summary = db.getDailySummary('2026-02-17');
    expect(summary).not.toBeNull();
    expect(summary.summary_text).toContain('project progress');
  });

  it('should generate Markdown output correctly', () => {
    const generator = new MarkdownGenerator(outputDir);

    const transcript = generator.buildTranscript({
      date: '2026-02-17',
      title: 'Test Meeting',
      segments: [
        { start: 0, end: 30, speaker: 'Zhang San', text: '项目进度怎么样了？', clean_text: '项目进度怎么样了？' },
        { start: 30, end: 60, speaker: 'Me', text: '基本差不多了。', clean_text: '基本差不多了。' },
      ],
    });
    expect(transcript).toContain('Zhang San');
    expect(transcript).toContain('项目进度');

    // Write and verify file exists
    generator.writeTranscript('2026-02-17', 'test-meeting', transcript);
    const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
    expect(files.length).toBeGreaterThan(0);
  });

  it('should integrate VectorStore with the database for RAG workflow', () => {
    // Insert recording + segments first
    const recordingId = db.insertRecording({
      file_path: `${TMP_DIR}/test.wav`,
      file_name: 'test.wav',
    });
    const segId = db.insertSegment({
      recording_id: recordingId,
      start_time: 0,
      end_time: 30,
      raw_text: 'test content',
      clean_text: 'test content cleaned',
    });

    // Create vector store on a separate DB connection
    const vecDbPath = dbPath.replace('.db', '-vec.db');
    const vecDb = new DatabaseSync(vecDbPath, { allowExtension: true });
    const vectorStore = new VectorStore(vecDb, 4);

    // Index the segment
    vectorStore.insert(segId, [0.9, 0.1, 0.0, 0.0]);

    // Search and verify
    const results = vectorStore.search([1.0, 0.0, 0.0, 0.0], 5);
    expect(results.length).toBe(1);
    expect(results[0].segment_id).toBe(segId);

    // Verify we can look up the segment from DB
    const segment = db.getSegment(results[0].segment_id);
    expect(segment).not.toBeNull();
    expect(segment.clean_text).toBe('test content cleaned');

    vecDb.close();
    if (fs.existsSync(vecDbPath)) fs.unlinkSync(vecDbPath);
  });

  it('should process tasks through the TaskQueue', async () => {
    const queue = new TaskQueue();
    const processedFiles: string[] = [];
    const completedTasks: QueueTask[] = [];

    queue.setProcessor(async (task) => {
      processedFiles.push(task.filePath);
      queue.updateTask(task.id, { status: 'transcribing', progress: 50 });
    });

    queue.on('task:completed', (t: QueueTask) => completedTasks.push(t));

    queue.add(`${TMP_DIR}/file1.wav`);
    queue.add(`${TMP_DIR}/file2.wav`);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 200));

    expect(processedFiles).toContain(`${TMP_DIR}/file1.wav`);
    // getAll() now filters out completed/failed tasks, so completed tasks won't appear
    // Verify completion via events instead
    expect(completedTasks.length).toBeGreaterThanOrEqual(1);
    expect(completedTasks[0].status).toBe('completed');
  });
});
