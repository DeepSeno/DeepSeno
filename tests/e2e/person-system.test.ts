/**
 * End-to-end test: Person System (Speaker → Person migration)
 *
 * Tests the full person lifecycle with simulated real data:
 * 1. DB tables creation & person CRUD
 * 2. Identifier management (voiceprint, phone, wechat, email)
 * 3. PersonMatcher: voiceprint matching, exact identifier matching, name matching
 * 4. Content-person linking (speaker, sender, mentioned roles)
 * 5. Match suggestions (auto-merge high confidence, suggestions for medium)
 * 6. Person merge
 * 7. Obsidian Markdown export
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { VoiceBrainDB } from '../../src/main/db/database';
import { PersonMatcher } from '../../src/main/person/person-matcher';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

// ─── Helpers ────────────────────────────────────────────────

function createTestDb(): VoiceBrainDB {
  const dbPath = path.join(os.tmpdir(), `person-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return new VoiceBrainDB(dbPath);
}

/** Generate a fake voiceprint embedding (192-dim float array) */
function fakeEmbedding(seed: number, dim = 192): number[] {
  const emb: number[] = [];
  for (let i = 0; i < dim; i++) {
    // Deterministic pseudo-random based on seed
    emb.push(Math.sin(seed * 1000 + i * 0.1) * 0.5 + Math.cos(seed * 500 + i * 0.3) * 0.5);
  }
  // Normalize to unit vector
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
  return emb.map(v => v / norm);
}

// perturbEmbedding and cosineSim removed — voiceprint matching was removed

// ─── Tests ──────────────────────────────────────────────────

describe('Person System E2E', () => {
  let db: VoiceBrainDB;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    try { db.close(); } catch {}
  });

  // ─── Phase 1: DB Tables & Person CRUD ───────────────────

  describe('Phase 1: Database tables and CRUD', () => {
    it('should have all new person tables', () => {
      const tables = db.getRawDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('persons');
      expect(tables).toContain('person_identifiers');
      expect(tables).toContain('content_person_links');
      expect(tables).toContain('person_match_suggestions');
      expect(tables).toContain('person_relationships');
    });

    it('should have primary_person_id column on segments', () => {
      const cols = (db.getRawDb()
        .prepare('PRAGMA table_info(segments)')
        .all() as any[])
        .map((c: any) => c.name);
      expect(cols).toContain('primary_person_id');
    });

    it('should insert and retrieve a person', () => {
      const id = db.insertPerson({
        name: '张明',
        company: '某科技公司',
        title: '技术总监',
        gender: 'male',
        tags: ['客户', '技术'],
        profile_markdown: '# 张明\n\n性格急躁，喜欢在会议上打断别人。',
        source: 'manual',
      });
      expect(id).toBeGreaterThan(0);

      const person = db.getPerson(id);
      expect(person).toBeDefined();
      expect(person!.name).toBe('张明');
      expect(person!.company).toBe('某科技公司');
      expect(person!.title).toBe('技术总监');
      expect(person!.gender).toBe('male');
      expect(JSON.parse(person!.tags!)).toEqual(['客户', '技术']);
      expect(person!.profile_markdown).toContain('性格急躁');
      expect(person!.source).toBe('manual');
    });

    it('should get person by name', () => {
      const person = db.getPersonByName('张明');
      expect(person).toBeDefined();
      expect(person!.name).toBe('张明');
    });

    it('should update person fields', () => {
      const person = db.getPersonByName('张明')!;
      db.updatePerson(person.id, {
        company: '新科技公司',
        title: 'CTO',
        tags: ['客户', '技术', '高管'],
      });
      const updated = db.getPerson(person.id)!;
      expect(updated.company).toBe('新科技公司');
      expect(updated.title).toBe('CTO');
      expect(JSON.parse(updated.tags!)).toContain('高管');
    });

    it('should list all persons with stats', () => {
      // Create a second person
      db.insertPerson({ name: '李四', source: 'auto' });
      const all = db.getAllPersons();
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(all[0]).toHaveProperty('content_count');
      expect(all[0]).toHaveProperty('total_duration');
    });
  });

  // ─── Phase 2: Identifier Management ─────────────────────

  describe('Phase 2: Identifier management', () => {
    it('should add identifiers to a person', () => {
      const person = db.getPersonByName('张明')!;

      db.insertPersonIdentifier({ person_id: person.id, type: 'phone', value: '00000000000', source: 'manual' });
      db.insertPersonIdentifier({ person_id: person.id, type: 'wechat', value: 'zhangming_wx', source: 'manual' });
      db.insertPersonIdentifier({ person_id: person.id, type: 'email', value: 'test@example.com', source: 'manual' });
      db.insertPersonIdentifier({ person_id: person.id, type: 'name_alias', value: '张总', source: 'manual' });

      const ids = db.getPersonIdentifiers(person.id);
      expect(ids.length).toBe(4);
      expect(ids.map(i => i.type).sort()).toEqual(['email', 'name_alias', 'phone', 'wechat']);
    });

    it('should find person by exact identifier', () => {
      const found = db.findPersonByIdentifier('phone', '00000000000');
      expect(found).toBeDefined();
      expect(found!.name).toBe('张明');
    });

    it('should add voiceprint identifier', () => {
      const person = db.getPersonByName('张明')!;
      const emb = fakeEmbedding(1);
      db.insertPersonIdentifier({
        person_id: person.id,
        type: 'voiceprint',
        blob_value: Buffer.from(new Float32Array(emb).buffer),
        model: '3dspeaker-eres2net',
        source: 'audio_pipeline',
      });

      const ids = db.getPersonIdentifiers(person.id);
      expect(ids.some(i => i.type === 'voiceprint')).toBe(true);
    });

    it('should delete an identifier', () => {
      const person = db.getPersonByName('张明')!;
      const ids = db.getPersonIdentifiers(person.id);
      const emailId = ids.find(i => i.type === 'email')!;
      db.deletePersonIdentifier(emailId.id);

      const after = db.getPersonIdentifiers(person.id);
      expect(after.some(i => i.type === 'email')).toBe(false);
    });
  });

  // ─── Phase 3: PersonMatcher ──────────────────────────────

  describe('Phase 3: PersonMatcher matching engine', () => {
    let matcher: PersonMatcher;

    beforeAll(() => {
      matcher = new PersonMatcher(db);
    });

    it('should match by exact phone identifier', () => {
      const match = matcher.matchByIdentifier('phone', '00000000000');
      expect(match).not.toBeNull();
      expect(match!.personName).toBe('张明');
      expect(match!.similarity).toBe(1.0);
    });

    it('should return null for unknown phone', () => {
      const match = matcher.matchByIdentifier('phone', '99999999999');
      expect(match).toBeNull();
    });

    it('should match by name', () => {
      const match = matcher.matchByName('张明');
      expect(match).not.toBeNull();
      expect(match!.matchType).toBe('name');
    });

    it('should match by name alias', () => {
      const match = matcher.matchByName('张总');
      expect(match).not.toBeNull();
      expect(match!.matchType).toBe('name_alias');
      expect(match!.personName).toBe('张明');
    });

    // Voiceprint matching tests removed — voiceprint matching was removed in the
    // PersonMatcher simplification (matchByVoiceprint, matchOrCreateFromVoiceprint removed)

    it('should match from exact identifier without auto-creating persons', () => {
      const missing = matcher.matchFromIdentifier({
        type: 'phone',
        value: '00000000001',
      });
      expect(missing).toBeNull();

      const wangwuId = db.insertPerson({ name: '王五', source: 'manual' });
      db.insertPersonIdentifier({
        person_id: wangwuId,
        type: 'phone',
        value: '00000000001',
        source: 'manual',
      });

      const result = matcher.matchFromIdentifier({
        type: 'phone',
        value: '00000000001',
      });
      expect(result).not.toBeNull();
      expect(result!.isNew).toBe(false);
      expect(result!.personId).toBe(wangwuId);
      expect(result!.confidence).toBe(1.0);
    });
  });

  // ─── Phase 4: Content-Person Linking ─────────────────────

  describe('Phase 4: Content-person linking', () => {
    let recordingId: number;
    let segmentIds: number[];

    beforeAll(() => {
      // Create a recording with segments
      recordingId = db.insertRecording({
        file_path: `${TMP_DIR}/test-meeting.wav`,
        file_name: 'test-meeting.wav',
        status: 'done',
      });

      segmentIds = [];
      // Segment 1: 张明 speaking
      segmentIds.push(db.insertSegment({
        recording_id: recordingId,
        start_time: 0,
        end_time: 15.5,
        raw_text: '我觉得这个项目应该加快进度，下周之前必须完成第一版。',
        clean_text: '我觉得这个项目应该加快进度，下周之前必须完成第一版。',
      }));
      // Segment 2: 李四 speaking
      segmentIds.push(db.insertSegment({
        recording_id: recordingId,
        start_time: 15.5,
        end_time: 28.0,
        raw_text: '好的，张总，我会安排团队加班。另外，王五那边的接口文档还没给。',
        clean_text: '好的，张总，我会安排团队加班。另外，王五那边的接口文档还没给。',
      }));
      // Segment 3: 张明 again
      segmentIds.push(db.insertSegment({
        recording_id: recordingId,
        start_time: 28.0,
        end_time: 35.0,
        raw_text: '你催一下王五，另外把进度表发到微信群里。',
        clean_text: '你催一下王五，另外把进度表发到微信群里。',
      }));
    });

    it('should link segments to persons with roles', () => {
      const zhangming = db.getPersonByName('张明')!;
      const lisi = db.getPersonByName('李四')!;
      const wangwu = db.getPersonByName('王五')!;
      const matcher = new PersonMatcher(db);

      // 张明 is the speaker of segments 1 and 3
      matcher.linkContentToPerson(segmentIds[0], zhangming.id, 'speaker');
      matcher.linkContentToPerson(segmentIds[2], zhangming.id, 'speaker');

      // 李四 is the speaker of segment 2
      matcher.linkContentToPerson(segmentIds[1], lisi.id, 'speaker');

      // 王五 is mentioned in segments 2 and 3
      matcher.linkContentToPerson(segmentIds[1], wangwu.id, 'mentioned');
      matcher.linkContentToPerson(segmentIds[2], wangwu.id, 'mentioned');

      // Set primary_person_id
      const rawDb = db.getRawDb();
      rawDb.prepare('UPDATE segments SET primary_person_id = ? WHERE id = ?').run(zhangming.id, segmentIds[0]);
      rawDb.prepare('UPDATE segments SET primary_person_id = ? WHERE id = ?').run(lisi.id, segmentIds[1]);
      rawDb.prepare('UPDATE segments SET primary_person_id = ? WHERE id = ?').run(zhangming.id, segmentIds[2]);
    });

    it('should retrieve content by person', () => {
      const zhangming = db.getPersonByName('张明')!;
      const content = db.getContentByPerson(zhangming.id);
      expect(content.length).toBe(2); // segments 1 and 3
      expect(content.every(c => c.role === 'speaker')).toBe(true);
    });

    it('should retrieve mentions for a person', () => {
      const wangwu = db.getPersonByName('王五')!;
      const content = db.getContentByPerson(wangwu.id);
      expect(content.length).toBe(2); // mentioned in segments 2 and 3
      expect(content.every(c => c.role === 'mentioned')).toBe(true);
    });

    it('should get persons for a segment', () => {
      const persons = db.getPersonsForSegment(segmentIds[1]);
      // Segment 2: 李四 (speaker) + 王五 (mentioned)
      expect(persons.length).toBe(2);
      const roles = persons.map(p => p.role).sort();
      expect(roles).toEqual(['mentioned', 'speaker']);
    });

    it('should show correct stats in getAllPersons', () => {
      const all = db.getAllPersons();
      const zhangming = all.find(p => p.name === '张明')!;
      expect(zhangming.content_count).toBe(2); // 2 speaker links
      expect(zhangming.total_duration).toBeCloseTo(22.5, 0); // (0→15.5) + (28→35) = 15.5 + 7 = 22.5
    });

    it('should get co-occurrences', () => {
      const cooc = db.getPersonCoOccurrences();
      // 李四 and 王五 co-occur in segment 2
      // 张明 and 王五 co-occur in segment 3
      expect(cooc.length).toBeGreaterThanOrEqual(2);
    });

    it('should get voice sample segment', () => {
      const zhangming = db.getPersonByName('张明')!;
      const sample = db.getPersonSampleSegment(zhangming.id);
      expect(sample).toBeDefined();
      expect(sample!.recording_id).toBe(recordingId);
      expect(sample!.text).toContain('项目'); // Longest segment
    });
  });

  // ─── Phase 5: Person Merge ───────────────────────────────

  describe('Phase 5: Person merge', () => {
    it('should merge two persons and consolidate data', () => {
      // Create a duplicate person (simulates auto-detected from another recording)
      const dupId = db.insertPerson({
        name: '张总',
        profile_markdown: '从第二次会议识别出的说话人。',
        source: 'auto',
      });
      const dupEmb = fakeEmbedding(1.01); // Very similar to person 1
      db.insertPersonIdentifier({
        person_id: dupId,
        type: 'voiceprint',
        blob_value: Buffer.from(new Float32Array(dupEmb).buffer),
        model: '3dspeaker-eres2net',
        source: 'audio_pipeline',
      });
      db.insertPersonIdentifier({
        person_id: dupId,
        type: 'name_alias',
        value: '老张',
        source: 'llm_extract',
      });

      // Create a segment linked to the dup
      const recId = db.insertRecording({
        file_path: `${TMP_DIR}/meeting2.wav`,
        file_name: 'meeting2.wav',
        status: 'done',
      });
      const segId = db.insertSegment({
        recording_id: recId,
        start_time: 0,
        end_time: 10,
        raw_text: '明天的报告我来写。',
      });
      db.insertContentPersonLink({
        segment_id: segId,
        person_id: dupId,
        role: 'speaker',
      });
      db.getRawDb().prepare('UPDATE segments SET primary_person_id = ? WHERE id = ?').run(dupId, segId);

      const zhangming = db.getPersonByName('张明')!;
      const beforeCount = db.getContentByPerson(zhangming.id).length;

      // Merge: 张总 → 张明
      db.mergePersons(dupId, zhangming.id);

      // Verify: dup person deleted
      expect(db.getPerson(dupId)).toBeUndefined();

      // Verify: content links migrated
      const afterContent = db.getContentByPerson(zhangming.id);
      expect(afterContent.length).toBe(beforeCount + 1);

      // Verify: identifiers migrated
      const ids = db.getPersonIdentifiers(zhangming.id);
      expect(ids.some(i => i.type === 'name_alias' && i.value === '老张')).toBe(true);

      // Verify: profile markdown merged
      const merged = db.getPerson(zhangming.id)!;
      expect(merged.profile_markdown).toContain('性格急躁');
      expect(merged.profile_markdown).toContain('第二次会议');

      // Verify: primary_person_id updated
      const seg = db.getRawDb().prepare('SELECT primary_person_id FROM segments WHERE id = ?').get(segId) as any;
      expect(seg.primary_person_id).toBe(zhangming.id);
    });
  });

  // Phase 6: Match suggestion workflow — removed (match suggestions feature was removed)

  // ─── Phase 7: Obsidian Export ────────────────────────────

  describe('Phase 7: Obsidian person file generation', () => {
    it('should generate correct person Markdown file', async () => {
      const { MarkdownGenerator } = await import('../../src/main/output/markdown-generator');
      const gen = new MarkdownGenerator({ useWikilinks: true });

      const zhangming = db.getPersonByName('张明')!;
      const identifiers = db.getPersonIdentifiers(zhangming.id);
      const content = db.getContentByPerson(zhangming.id, 5);

      const md = gen.generatePersonFile(
        zhangming,
        identifiers.map(i => ({ type: i.type, value: i.value })),
        content.map(c => ({ role: c.role, file_name: c.file_name })),
      );

      // Verify YAML frontmatter
      expect(md).toContain('---');
      expect(md).toContain('title: "张明"');
      expect(md).toContain('phone: "00000000000"');
      expect(md).toContain('wechat: "zhangming_wx"');
      expect(md).toContain('company: "新科技公司"');
      expect(md).toContain('title_role: "CTO"');

      // Verify aliases
      expect(md).toContain('aliases:');
      expect(md).toContain('张总');

      // Verify body
      expect(md).toContain('# 张明');
      expect(md).toContain('性格急躁');

      // Verify recent interactions with wikilinks
      expect(md).toContain('## Recent Interactions');
      // file_name may have extension stripped in wikilink
      expect(md).toContain('test-meeting');

      console.log('\n--- Generated Person File ---');
      console.log(md);
      console.log('--- End ---\n');
    });
  });

  // ─── Phase 8: Cleanup ───────────────────────────────────

  describe('Phase 8: Cleanup operations', () => {
    // cleanupOrphanedPersons tests removed — method was removed

    it('should delete a person and cascade', () => {
      const tempId = db.insertPerson({ name: '临时人物', source: 'manual' });
      db.insertPersonIdentifier({ person_id: tempId, type: 'phone', value: '00000000000' });

      db.deletePerson(tempId);
      expect(db.getPerson(tempId)).toBeUndefined();
      expect(db.getPersonIdentifiers(tempId).length).toBe(0);
    });
  });

  // ─── Phase 9: Full Pipeline Simulation ──────────────────

  describe('Phase 9: Full pipeline simulation', () => {
    it('should simulate a complete recording processing flow with name-based matching', () => {
      const matcher = new PersonMatcher(db);

      // Simulate: new recording comes in with 2 speakers
      const recId = db.insertRecording({
        file_path: `${TMP_DIR}/meeting3.wav`,
        file_name: 'meeting3.wav',
        status: 'processing',
      });

      // Match by name — 张明 already exists
      const match0 = matcher.matchByName('张明');
      expect(match0).not.toBeNull();
      const personId0 = match0!.personId;

      // New person — not found, so create
      const match1 = matcher.matchByName('新同事');
      expect(match1).toBeNull();
      const personId1 = db.insertPerson({ name: '新同事', source: 'auto' });

      // Create segments and link
      const seg0 = db.insertSegment({
        recording_id: recId,
        start_time: 0,
        end_time: 12,
        raw_text: '这是张明说的话',
      });
      const seg1 = db.insertSegment({
        recording_id: recId,
        start_time: 12,
        end_time: 25,
        raw_text: '这是新同事说的话',
      });

      matcher.linkContentToPerson(seg0, personId0, 'speaker');
      matcher.linkContentToPerson(seg1, personId1, 'speaker');

      // Verify
      const content0 = db.getPersonsForSegment(seg0);
      expect(content0.length).toBe(1);
      expect(content0[0].person_name).toBe('张明');

      const content1 = db.getPersonsForSegment(seg1);
      expect(content1.length).toBe(1);
      expect(content1[0].person_name).toBe('新同事');

      // Update recording status
      db.updateRecording(recId, { status: 'done' });
    });
  });
});
