import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { VoiceBrainDB } from '../database';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

describe('VoiceBrainDB', () => {
  let db: VoiceBrainDB;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary database file for each test
    dbPath = path.join(
      os.tmpdir(),
      `deepseno-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new VoiceBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    // Clean up temp files (main db + WAL/SHM)
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
  });

  // ─── Schema ────────────────────────────────────────────────

  it('should create all expected tables', () => {
    const tables = db.listTables();
    expect(tables).toContain('recordings');
    expect(tables).toContain('speakers');
    expect(tables).toContain('segments');
    expect(tables).toContain('extracted_items');
    expect(tables).toContain('daily_summaries');
  });

  // ─── Recordings ────────────────────────────────────────────

  it('should insert and retrieve a recording', () => {
    const id = db.insertRecording({
      file_path: '/audio/meeting.wav',
      file_name: 'meeting.wav',
      duration_seconds: 3600,
      recorded_at: '2025-06-15T10:00:00',
    });

    expect(id).toBe(1);

    const rec = db.getRecording(id)!;
    expect(rec).toBeDefined();
    expect(rec.file_path).toBe('/audio/meeting.wav');
    expect(rec.file_name).toBe('meeting.wav');
    expect(rec.duration_seconds).toBe(3600);
    expect(rec.status).toBe('pending');
  });

  it('should update recording status', () => {
    const id = db.insertRecording({
      file_path: '/audio/call.wav',
      file_name: 'call.wav',
    });

    db.updateRecordingStatus(id, 'completed');
    const rec = db.getRecording(id)!;
    expect(rec.status).toBe('completed');
  });

  it('should delete a recording with all recording-scoped related rows', () => {
    const recId = db.insertRecording({
      file_path: '/audio/delete-me.wav',
      file_name: 'delete-me.wav',
    });
    const segId = db.insertSegment({
      recording_id: recId,
      start_time: 0,
      end_time: 1,
      raw_text: 'delete me',
      clean_text: 'delete me',
    });
    const personA = db.insertPerson({ name: 'Alice', source: 'manual' });
    const personB = db.insertPerson({ name: 'Bob', source: 'manual' });
    const speakerA = db.insertSpeaker({ name: 'Speaker A' });
    const speakerB = db.insertSpeaker({ name: 'Speaker B' });

    db.insertExtractedItem({ segment_id: segId, type: 'todo', content: 'cleanup' });
    db.saveMeetingNotes(recId, {
      title: 'Delete test',
      participants: [],
      decisions: [],
      actionItems: [],
      discussionSummary: '',
      keyTopics: [],
    });
    db.insertPersonRelationship({
      person_id: personA,
      related_person_id: personB,
      relationship: 'knows',
      recording_id: recId,
    });
    db.insertCompilationQueueEntry(recId);

    const raw = db.getRawDb();
    raw.prepare(`
      INSERT INTO content_person_links (segment_id, person_id, role, confidence, source)
      VALUES (?, ?, 'mentioned', 1, 'test')
    `).run(segId, personA);
    raw.prepare(`
      INSERT INTO speaker_match_suggestions (new_speaker_id, existing_speaker_id, similarity, recording_id)
      VALUES (?, ?, 0.9, ?)
    `).run(speakerA, speakerB, recId);
    raw.prepare(`
      INSERT INTO speaker_relationships (speaker_id, mentioned_name, relationship, recording_id)
      VALUES (?, 'Bob', 'mentions', ?)
    `).run(speakerA, recId);
    raw.prepare(`
      INSERT INTO person_match_suggestions (new_person_id, existing_person_id, match_type, similarity, recording_id)
      VALUES (?, ?, 'name', 0.9, ?)
    `).run(personA, personB, recId);
    raw.prepare(`
      INSERT INTO recording_chat_messages (recording_id, role, content)
      VALUES (?, 'user', 'question')
    `).run(recId);
    raw.prepare(`
      INSERT INTO task_queue (id, file_path, recording_id, status, progress, created_at, updated_at)
      VALUES ('task_delete_me', '/audio/delete-me.wav', ?, 'failed', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(recId);

    db.deleteRecording(recId);

    expect(db.getRecording(recId)).toBeUndefined();
    expect(db.getSegmentsByRecording(recId)).toHaveLength(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM person_relationships WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM speaker_match_suggestions WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM speaker_relationships WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM person_match_suggestions WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM recording_chat_messages WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM compilation_queue WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM task_queue WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM content_person_links WHERE segment_id = ?').get(segId)).toEqual({ count: 0 });
  });

  it('should rebuild malformed segment FTS data during recording deletion', () => {
    const recId = db.insertRecording({
      file_path: '/audio/delete-corrupt-fts.wav',
      file_name: 'delete-corrupt-fts.wav',
    });
    db.insertSegment({
      recording_id: recId,
      start_time: 0,
      end_time: 1,
      raw_text: 'delete corrupt fts',
      clean_text: 'delete corrupt fts',
    });

    const raw = db.getRawDb();
    raw.enableDefensive(false);
    try {
      raw.prepare('DELETE FROM segments_fts_data').run();
    } finally {
      raw.enableDefensive(true);
    }

    expect(() => db.deleteRecording(recId)).not.toThrow();
    expect(db.getRecording(recId)).toBeUndefined();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM segments WHERE recording_id = ?').get(recId)).toEqual({ count: 0 });
  });

  // ─── Speakers ──────────────────────────────────────────────

  it('should insert and retrieve speakers', () => {
    const id1 = db.insertSpeaker({ name: 'Alice', notes: 'Project manager' });
    const id2 = db.insertSpeaker({ name: 'Bob' });

    expect(db.getSpeaker(id1)!.name).toBe('Alice');
    expect(db.getSpeaker(id2)!.name).toBe('Bob');

    // getAllSpeakers filters to only speakers with segment_count > 0,
    // so we need to insert segments for these speakers first
    const recId = db.insertRecording({
      file_path: '/audio/speaker-test.wav',
      file_name: 'speaker-test.wav',
    });
    db.insertSegment({
      recording_id: recId,
      speaker_id: id1,
      start_time: 0,
      end_time: 5,
      raw_text: 'Alice segment',
    });
    db.insertSegment({
      recording_id: recId,
      speaker_id: id2,
      start_time: 5,
      end_time: 10,
      raw_text: 'Bob segment',
    });

    const all = db.getAllSpeakers();
    expect(all).toHaveLength(2);
  });

  // ─── Persons ──────────────────────────────────────────────

  it('should insert and retrieve persons', () => {
    const id1 = db.insertPerson({ name: 'Alice', company: 'ACME', source: 'manual' });
    const id2 = db.insertPerson({ name: 'Bob', source: 'auto' });

    expect(db.getPerson(id1)!.name).toBe('Alice');
    expect(db.getPerson(id2)!.name).toBe('Bob');

    const all = db.getAllPersons();
    expect(all).toHaveLength(2);
  });

  // ─── Segments + Speakers join ──────────────────────────────

  it('should insert segments and query by recording with speaker name', () => {
    const recId = db.insertRecording({
      file_path: '/audio/test.wav',
      file_name: 'test.wav',
    });
    const spkId = db.insertSpeaker({ name: 'Charlie' });

    const segId = db.insertSegment({
      recording_id: recId,
      speaker_id: spkId,
      start_time: 0.0,
      end_time: 5.5,
      raw_text: 'Hello world',
      clean_text: 'Hello world.',
    });

    expect(segId).toBe(1);

    const seg = db.getSegment(segId)!;
    expect(seg.raw_text).toBe('Hello world');
    expect(seg.start_time).toBe(0.0);
    expect(seg.end_time).toBe(5.5);

    const segments = db.getSegmentsByRecording(recId);
    expect(segments).toHaveLength(1);
    expect(segments[0].speaker_name).toBe('Charlie');
  });

  // ─── FTS5 Full-Text Search ─────────────────────────────────

  it('should support FTS5 full-text search on segments', () => {
    const recId = db.insertRecording({
      file_path: '/audio/fts.wav',
      file_name: 'fts.wav',
    });

    db.insertSegment({
      recording_id: recId,
      start_time: 0,
      end_time: 3,
      raw_text: 'The quarterly revenue report shows growth',
      clean_text: 'The quarterly revenue report shows growth.',
    });

    db.insertSegment({
      recording_id: recId,
      start_time: 3,
      end_time: 6,
      raw_text: 'We need to schedule the team meeting',
      clean_text: 'We need to schedule the team meeting.',
    });

    db.insertSegment({
      recording_id: recId,
      start_time: 6,
      end_time: 9,
      raw_text: 'Budget review for next quarter',
      clean_text: 'Budget review for next quarter.',
    });

    // Search for "revenue"
    const results = db.searchSegments('revenue');
    expect(results).toHaveLength(1);
    expect(results[0].raw_text).toContain('revenue');

    // Search for "quarter" — should match two segments
    const results2 = db.searchSegments('quarter*');
    expect(results2).toHaveLength(2);

    // Search for "meeting"
    const results3 = db.searchSegments('meeting');
    expect(results3).toHaveLength(1);
    expect(results3[0].raw_text).toContain('meeting');
  });

  // ─── Extracted Items ───────────────────────────────────────

  it('should insert and query extracted items by type and status', () => {
    const recId = db.insertRecording({
      file_path: '/audio/items.wav',
      file_name: 'items.wav',
    });
    const segId = db.insertSegment({
      recording_id: recId,
      start_time: 0,
      end_time: 5,
      raw_text: 'TODO: finish the report by Friday',
    });

    db.insertExtractedItem({
      segment_id: segId,
      type: 'todo',
      content: 'Finish the report by Friday',
      due_date: '2025-06-20',
      related_person: 'Alice',
    });

    db.insertExtractedItem({
      segment_id: segId,
      type: 'decision',
      content: 'Approved the new budget',
    });

    db.insertExtractedItem({
      segment_id: segId,
      type: 'todo',
      content: 'Send follow-up email',
      status: 'completed',
    });

    // By type
    const todos = db.getExtractedItemsByType('todo');
    expect(todos).toHaveLength(2);

    const decisions = db.getExtractedItemsByType('decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toBe('Approved the new budget');

    // Active items only (should exclude the completed one)
    const active = db.getActiveExtractedItems();
    expect(active).toHaveLength(2);
    expect(active.every((item: any) => item.status === 'active')).toBe(true);
  });

  // ─── Daily Summaries ───────────────────────────────────────

  it('should insert and retrieve daily summaries', () => {
    const id = db.insertDailySummary({
      date: '2025-06-15',
      summary_text: 'Productive day with 3 meetings.',
      timeline_json: JSON.stringify([
        { time: '09:00', event: 'Stand-up' },
        { time: '14:00', event: 'Review' },
      ]),
      key_events_json: JSON.stringify(['Budget approved', 'New hire confirmed']),
    });

    expect(id).toBe(1);

    const summary = db.getDailySummary('2025-06-15')!;
    expect(summary).toBeDefined();
    expect(summary.summary_text).toBe('Productive day with 3 meetings.');

    const timeline = JSON.parse(summary.timeline_json ?? '[]');
    expect(timeline).toHaveLength(2);

    const keyEvents = JSON.parse(summary.key_events_json ?? '[]');
    expect(keyEvents).toContain('Budget approved');
  });

  // ─── Meeting Notes ──────────────────────────────────────────
  describe('Meeting Notes', () => {
    it('should save and retrieve meeting notes for a recording', () => {
      const recId = db.insertRecording({
        file_path: `${TMP_DIR}/test.wav`,
        file_name: 'test.wav',
        duration_seconds: 120,
      });

      const notes = {
        title: '产品战略讨论',
        participants: [{ name: '张伟', speakingTime: 60 }],
        decisions: ['Q2 做 iOS'],
        actionItems: [{ assignee: '李明', task: '出排期', dueDate: '2026-03-01' }],
        discussionSummary: '讨论了方向',
        keyTopics: ['iOS', '招聘'],
      };

      db.saveMeetingNotes(recId, notes);
      const retrieved = db.getMeetingNotes(recId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('产品战略讨论');
      expect(retrieved!.decisions).toHaveLength(1);
      expect(retrieved!.actionItems[0].assignee).toBe('李明');
      expect(retrieved!.keyTopics).toContain('iOS');
    });

    it('should return null for recording without meeting notes', () => {
      const recId = db.insertRecording({
        file_path: `${TMP_DIR}/no-notes.wav`,
        file_name: 'no-notes.wav',
      });
      const result = db.getMeetingNotes(recId);
      expect(result).toBeNull();
    });

    it('should overwrite existing meeting notes', () => {
      const recId = db.insertRecording({
        file_path: `${TMP_DIR}/overwrite.wav`,
        file_name: 'overwrite.wav',
      });

      db.saveMeetingNotes(recId, {
        title: 'First',
        participants: [],
        decisions: [],
        actionItems: [],
        discussionSummary: '',
        keyTopics: [],
      });

      db.saveMeetingNotes(recId, {
        title: 'Second',
        participants: [],
        decisions: ['new decision'],
        actionItems: [],
        discussionSummary: 'updated',
        keyTopics: [],
      });

      const result = db.getMeetingNotes(recId);
      expect(result!.title).toBe('Second');
      expect(result!.decisions).toHaveLength(1);
    });
  });

  // ─── Monthly Summaries ─────────────────────────────────────

  describe('Monthly Summaries', () => {
    it('creates the monthly_summaries table', () => {
      expect(db.listTables()).toContain('monthly_summaries');
    });

    it('upserts and retrieves a monthly summary', () => {
      const json = JSON.stringify({ summary: '本月概要', highlights: [], todos_summary: [], decisions: [], next_month_focus: [] });
      db.upsertMonthlySummary('2026-05-01', '2026-05-31', json);

      const row = db.getMonthlySummary('2026-05-01', '2026-05-31');
      expect(row).toBeDefined();
      expect(row!.summary_json).toBe(json);
    });

    it('overwrites on conflict (same start/end)', () => {
      db.upsertMonthlySummary('2026-05-01', '2026-05-31', '{"summary":"v1"}');
      db.upsertMonthlySummary('2026-05-01', '2026-05-31', '{"summary":"v2"}');

      const all = db.getAllMonthlySummaries();
      expect(all).toHaveLength(1);
      expect(all[0].summary_json).toBe('{"summary":"v2"}');
    });

    it('deletes a monthly summary', () => {
      db.upsertMonthlySummary('2026-05-01', '2026-05-31', '{}');
      db.deleteMonthlySummary('2026-05-01', '2026-05-31');
      expect(db.getMonthlySummary('2026-05-01', '2026-05-31')).toBeUndefined();
    });
  });

  // ─── Pushed Insight Dedup ──────────────────────────────────

  describe('Pushed Insight Dedup', () => {
    it('creates the pushed_insights table', () => {
      expect(db.listTables()).toContain('pushed_insights');
    });

    it('records keys and reports them as recently pushed', () => {
      db.recordPushedInsights(['insight|todo|a', 'insight|todo|b']);
      const recent = db.getRecentlyPushedInsightKeys(20);
      expect(recent.has('insight|todo|a')).toBe(true);
      expect(recent.has('insight|todo|b')).toBe(true);
      expect(recent.has('insight|todo|c')).toBe(false);
    });

    it('prunes keys older than the cutoff', () => {
      db.recordPushedInsights(['old|key']);
      // Force the timestamp far into the past, then prune anything older than 1h.
      (db as any).db.prepare("UPDATE pushed_insights SET pushed_at = '2000-01-01T00:00:00.000Z' WHERE insight_key = 'old|key'").run();
      db.prunePushedInsights(1);
      expect(db.getRecentlyPushedInsightKeys(99999999).has('old|key')).toBe(false);
    });
  });
});
