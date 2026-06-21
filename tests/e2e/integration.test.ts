import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VoiceBrainDB } from '../../src/main/db/database';
import { MarkdownGenerator } from '../../src/main/output/markdown-generator';
import { VectorStore } from '../../src/main/rag/vector-store';
import { mergeTranscriptWithDiarization, MergedSegment } from '../../src/main/audio/merge-transcript';
import {
  buildCleanPrompt,
  buildExtractPrompt,
  buildDailySummaryPrompt,
  buildSentimentPrompt,
} from '../../src/main/llm/text-optimizer';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('Full Integration Pipeline', () => {
  const TMP_DIR = os.tmpdir().replace(/\\/g, '/');
  let dbPath: string;
  let db: VoiceBrainDB;
  let outputDir: string;
  let testId: string;

  beforeEach(() => {
    testId = `vb-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    dbPath = path.join(os.tmpdir(), `${testId}.db`);
    outputDir = path.join(os.tmpdir(), `${testId}-output`);
    fs.mkdirSync(outputDir, { recursive: true });
    db = new VoiceBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('should simulate full pipeline: merge → DB → vector → markdown → obsidian', () => {
    // ─── Step 1: Simulate transcription + diarization merge ───
    const transcript = {
      text: 'Today we discussed ProjectAlpha progress. The backend API still needs work. Testing deadline is next Monday.',
      segments: [
        { start: 0, end: 15, text: 'Today we discussed ProjectAlpha progress.' },
        { start: 15, end: 30, text: 'The backend API still needs work.' },
        { start: 30, end: 50, text: 'Testing deadline is next Monday.' },
      ],
      language: 'en',
    };
    const diarization = {
      segments: [
        { start: 0, end: 20, speaker: 'SPEAKER_00' },
        { start: 20, end: 50, speaker: 'SPEAKER_01' },
      ],
    };

    const merged = mergeTranscriptWithDiarization(transcript, diarization);
    expect(merged).toHaveLength(3);
    expect(merged[0].speaker).toBe('SPEAKER_00'); // mid=7.5, in SPEAKER_00 range (0-20)
    expect(merged[1].speaker).toBe('SPEAKER_01'); // mid=22.5, in SPEAKER_01 range (20-50)
    expect(merged[2].speaker).toBe('SPEAKER_01'); // mid=40, in SPEAKER_01 range (20-50)

    // ─── Step 2: Insert into database ───
    const recordingId = db.insertRecording({
      file_path: `${TMP_DIR}/meeting-2026-02-18.wav`,
      file_name: 'meeting-2026-02-18.wav',
      duration_seconds: 50,
    });

    // Create speaker mappings
    const uniqueSpeakers = [...new Set(merged.map((s) => s.speaker))];
    const speakerMap = new Map<string, number>();
    for (const spkLabel of uniqueSpeakers) {
      const spkId = db.insertSpeaker({ name: spkLabel });
      speakerMap.set(spkLabel, spkId);
    }

    // Insert segments
    const segmentIds: number[] = [];
    for (const seg of merged) {
      const segId = db.insertSegment({
        recording_id: recordingId,
        speaker_id: speakerMap.get(seg.speaker),
        start_time: seg.start,
        end_time: seg.end,
        raw_text: seg.text,
        clean_text: seg.text, // Simulate clean (no LLM in test)
      });
      segmentIds.push(segId);
    }
    expect(segmentIds).toHaveLength(3);

    // Verify FTS search
    const searchResults = db.searchSegments('backend');
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].raw_text).toContain('backend');

    // ─── Step 3: Vector store indexing ───
    const vecDbPath = dbPath.replace('.db', '-vec.db');
    const vecDb = new DatabaseSync(vecDbPath, { allowExtension: true });
    const vectorStore = new VectorStore(vecDb, 4);

    // Simulate embedding (4D vectors)
    vectorStore.insert(segmentIds[0], [0.9, 0.1, 0.0, 0.0]);
    vectorStore.insert(segmentIds[1], [0.7, 0.3, 0.0, 0.0]);
    vectorStore.insert(segmentIds[2], [0.1, 0.1, 0.8, 0.0]);

    // Search for "project related" vector
    const vecResults = vectorStore.search([1.0, 0.0, 0.0, 0.0], 5);
    expect(vecResults.length).toBe(3);
    expect(vecResults[0].segment_id).toBe(segmentIds[0]); // Most similar

    // Cross-reference: vector result → DB segment → recording
    const foundSeg = db.getSegment(vecResults[0].segment_id);
    expect(foundSeg).not.toBeNull();
    expect(foundSeg.recording_id).toBe(recordingId);

    // ─── Step 4: Markdown generation with wikilinks ───
    const mdGen = new MarkdownGenerator(outputDir, true);
    const transcriptMd = mdGen.buildTranscript({
      date: '2026-02-18',
      title: 'meeting-2026-02-18',
      segments: merged.map((s) => ({ ...s, clean_text: s.text })),
    });
    expect(transcriptMd).toContain('meeting-2026-02-18');
    expect(transcriptMd).toContain('SPEAKER_00');
    expect(transcriptMd).toContain('[[daily/2026-02-18|2026-02-18 日报]]'); // Wikilink backlink
    expect(transcriptMd).toContain('---'); // YAML frontmatter

    const filePath = mdGen.writeTranscript('2026-02-18', 'meeting-2026-02-18', transcriptMd);
    expect(fs.existsSync(filePath)).toBe(true);

    // Daily summary
    const dailyMd = mdGen.buildDailySummary({
      date: '2026-02-18',
      weekday: '星期二',
      summary: '讨论了项目A进度，确认了测试截止日期。',
      timeline: [
        { time: '09:00', event: '项目A进度会议', transcriptLink: 'transcripts/2026-02-18/meeting-2026-02-18' },
      ],
      todos: [
        { content: '完成接口开发', person: 'SPEAKER_01' },
        { content: '编写测试', due_date: '下周一', person: 'SPEAKER_01' },
      ],
      decisions: ['延期两周'],
    });
    expect(dailyMd).toContain('[[transcripts/2026-02-18/meeting-2026-02-18|详情]]'); // Wikilink
    expect(dailyMd).toContain('- [ ] 完成接口开发');

    const dailyPath = mdGen.writeDailySummary('2026-02-18', dailyMd);
    expect(fs.existsSync(dailyPath)).toBe(true);

    // ─── Step 5: MOC generation ───
    const mocPath = mdGen.updateMOC([
      { type: 'daily-summary', date: '2026-02-18', title: '2026-02-18 日报', relativePath: 'daily/2026-02-18.md' },
      { type: 'transcript', date: '2026-02-18', title: 'meeting-2026-02-18', relativePath: 'transcripts/2026-02-18/meeting-2026-02-18.md' },
    ]);
    expect(fs.existsSync(mocPath)).toBe(true);
    const mocContent = fs.readFileSync(mocPath, 'utf-8');
    expect(mocContent).toContain('[[daily/2026-02-18.md|2026-02-18 日报]]');
    expect(mocContent).toContain('## 转录记录');

    // ─── Step 6: Obsidian vault sync ───
    const vaultDir = path.join(os.tmpdir(), `${testId}-vault`);
    fs.mkdirSync(vaultDir, { recursive: true });

    const syncCount = MarkdownGenerator.syncAllToVault(outputDir, vaultDir);
    expect(syncCount).toBeGreaterThanOrEqual(3); // transcript + daily + MOC

    const vbDir = path.join(vaultDir, 'DeepSeno');
    expect(fs.existsSync(path.join(vbDir, 'daily', '2026-02-18.md'))).toBe(true);
    expect(fs.existsSync(path.join(vbDir, 'transcripts', '2026-02-18', 'meeting-2026-02-18.md'))).toBe(true);
    expect(fs.existsSync(path.join(vbDir, 'DeepSeno MOC.md'))).toBe(true);

    // Clean up vault
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vecDb.close();
    if (fs.existsSync(vecDbPath)) fs.unlinkSync(vecDbPath);
  });

  it('should correctly build all LLM prompt types', () => {
    // Verify prompt construction doesn't throw and produces expected content
    const cleanPrompt = buildCleanPrompt('嗯嗯那个就是说今天我们开了个会');
    expect(cleanPrompt).toContain('语音识别');
    expect(cleanPrompt).toContain('嗯嗯那个');
    expect(cleanPrompt).toContain('简体中文');

    const extractPrompt = buildExtractPrompt('明天下午三点和张三开项目评审会');
    expect(extractPrompt).toContain('待办事项');
    expect(extractPrompt).toContain('JSON');

    const summaryPrompt = buildDailySummaryPrompt('2026-02-18', [
      { start: 0, end: 30, speaker: 'Alice', text: '项目进度怎么样了？' },
      { start: 30, end: 60, speaker: 'Bob', text: '基本完成了。' },
    ]);
    expect(summaryPrompt).toContain('00:00:00 - 00:00:30');
    expect(summaryPrompt).toContain('Alice');
    expect(summaryPrompt).toContain('2026-02-18');

    const sentimentPrompt = buildSentimentPrompt('太棒了，这个功能终于上线了！');
    expect(sentimentPrompt).toContain('情绪');
    expect(sentimentPrompt).toContain('positive');
  });

  it('should handle chat session and message persistence correctly', () => {
    // Create session
    const sessionId = db.createSession('测试对话');
    expect(sessionId).toBeGreaterThan(0);

    // Verify session list
    const sessions = db.getAllSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.find((s) => s.id === sessionId)?.title).toBe('测试对话');

    // Save messages to session
    const id1 = db.saveChatMessage(sessionId, 'user', '昨天讨论了什么？');
    const id2 = db.saveChatMessage(sessionId, 'assistant', '根据录音记录，昨天讨论了项目A的进度。', JSON.stringify([
      { segment_id: 1, text: '项目A进度', speaker: 'Alice', time: '09:00' },
    ]));
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);

    // Retrieve messages by session
    const messages = db.getSessionMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].sources_json).toContain('segment_id');

    // Rename session
    db.renameSession(sessionId, '重命名对话');
    const renamed = db.getAllSessions().find((s) => s.id === sessionId);
    expect(renamed?.title).toBe('重命名对话');

    // Clear session messages
    db.clearSessionMessages(sessionId);
    const afterClear = db.getSessionMessages(sessionId);
    expect(afterClear).toHaveLength(0);

    // Delete session
    db.deleteSession(sessionId);
    const afterDelete = db.getAllSessions().find((s) => s.id === sessionId);
    expect(afterDelete).toBeUndefined();
  });

  it('should handle daily summary CRUD operations', () => {
    // Insert
    db.insertDailySummary({
      date: '2026-02-17',
      summary_text: '项目进度讨论',
      timeline_json: JSON.stringify([{ time: '09:00', event: '开会' }]),
    });
    db.insertDailySummary({
      date: '2026-02-18',
      summary_text: '代码评审',
      timeline_json: JSON.stringify([{ time: '14:00', event: '评审' }]),
    });

    // List all
    const all = db.getAllDailySummaries();
    expect(all).toHaveLength(2);
    expect(all[0].date).toBe('2026-02-18'); // DESC order

    // Get single
    const single = db.getDailySummary('2026-02-17');
    expect(single).not.toBeNull();
    expect(single.summary_text).toBe('项目进度讨论');

    // Delete
    db.deleteDailySummary('2026-02-17');
    const afterDelete = db.getAllDailySummaries();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].date).toBe('2026-02-18');
  });

  it('should generate markdown without wikilinks when disabled', () => {
    const mdGen = new MarkdownGenerator(outputDir, false);
    const content = mdGen.buildTranscript({
      date: '2026-02-18',
      title: 'test',
      segments: [{ start: 0, end: 10, speaker: 'A', text: 'hello', clean_text: 'hello' }],
    });
    expect(content).not.toContain('[['); // No wikilinks
    expect(content).toContain('hello');
  });

  it('should handle bookmark operations', () => {
    const recId = db.insertRecording({
      file_path: `${TMP_DIR}/test.wav`,
      file_name: 'test.wav',
    });
    const segId = db.insertSegment({
      recording_id: recId,
      start_time: 0,
      end_time: 10,
      raw_text: 'bookmarkable content',
    });

    // Toggle bookmark on
    const bookmarked = db.toggleSegmentBookmark(segId);
    expect(bookmarked).toBe(true);

    // Get bookmarked segments
    const bookmarks = db.getBookmarkedSegments();
    expect(bookmarks.length).toBe(1);

    // Toggle bookmark off
    const unbookmarked = db.toggleSegmentBookmark(segId);
    expect(unbookmarked).toBe(false);

    const emptyBookmarks = db.getBookmarkedSegments();
    expect(emptyBookmarks.length).toBe(0);
  });
});
