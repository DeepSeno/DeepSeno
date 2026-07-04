import { DatabaseSync } from 'node:sqlite';
import type { MeetingNotes } from '../llm/text-optimizer';
import { formatLocalDate } from '../utils/date';
import { transaction } from './sqlite-util';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  duration_seconds INTEGER,
  recorded_at DATETIME,
  processed_at DATETIME,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  voice_signature BLOB,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id INTEGER REFERENCES recordings(id),
  speaker_id INTEGER REFERENCES speakers(id),
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  raw_text TEXT,
  clean_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS extracted_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id INTEGER REFERENCES segments(id),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  due_date DATE,
  related_person TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE UNIQUE NOT NULL,
  summary_text TEXT,
  timeline_json TEXT,
  key_events_json TEXT
);

CREATE TABLE IF NOT EXISTS weekly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  summary_json TEXT,
  UNIQUE(start_date, end_date)
);

CREATE TABLE IF NOT EXISTS monthly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  summary_json TEXT,
  UNIQUE(start_date, end_date)
);

CREATE TABLE IF NOT EXISTS pushed_insights (
  insight_key TEXT PRIMARY KEY,
  pushed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  raw_text, clean_text, content=segments, content_rowid=id
);

CREATE TABLE IF NOT EXISTS channel_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  summary       TEXT,
  message_count INTEGER DEFAULT 0,
  UNIQUE(channel_id, user_id, started_at)
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES channel_sessions(id),
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_session ON channel_messages(session_id, timestamp);
`;

export interface RecordingData {
  file_path: string;
  file_name: string;
  duration_seconds?: number;
  recorded_at?: string;
  processed_at?: string;
  status?: string;
  capture_scene?: string;
  media_type?: string;
  page_count?: number;
  word_count?: number;
}

export interface SpeakerData {
  name?: string;
  voice_signature?: Buffer;
  notes?: string;
  is_auto_label?: boolean;
}

export interface SegmentData {
  recording_id: number;
  speaker_id?: number;
  start_time?: number | null;
  end_time?: number | null;
  raw_text?: string;
  clean_text?: string;
  source?: string;
  speaker_label?: string;
}

export interface ExtractedItemData {
  segment_id?: number | null;
  type: string;
  content: string;
  due_date?: string;
  related_person?: string;
  status?: string;
  source?: string;
  priority?: string;
  assignee?: string;
}

export interface DailySummaryData {
  date: string;
  summary_text?: string;
  timeline_json?: string;
  key_events_json?: string;
}

// ─── Row types (what the DB returns) ────────────────────────────

export interface RecordingRow {
  id: number;
  file_path: string;
  file_name: string;
  duration_seconds: number | null;
  recorded_at: string | null;
  processed_at: string | null;
  status: string;
  capture_scene: string | null;
  media_type: string;
  page_count: number | null;
  word_count: number | null;
  custom_title: string | null;
  custom_category: string | null;
  /** AI-generated whole-transcript title (5-15 chars). Set after
   * transcription completes (or via backfill); independent of
   * meeting_notes — covers dictation/notes too. */
  auto_title: string | null;
  /** LLM-assigned importance (0-10). 0 = unscored. */
  importance_score?: number;
  /** FK to sessions.id when this recording joined a session. */
  session_id?: number | null;
}

export interface SessionRow {
  id: number;
  date: string;          // YYYY-MM-DD local
  started_at: string;    // ISO
  ended_at: string;      // ISO
  topic: string | null;
  summary: string | null;
  importance_score: number;
  member_count: number;
  is_finalized: 0 | 1;
}

export interface CuratedDay {
  sessions: Array<{ session: SessionRow; members: RecordingWithStats[] }>;
  standalones: RecordingWithStats[];
  briefs: RecordingWithStats[];
}

export interface RecordingWithStats extends RecordingRow {
  speaker_count: number;
  extracted_count: number;
  /** First transcript segment text (clean_text || raw_text). Used as a
   * fallback display title when no AI meeting-notes title exists. */
  first_segment_text?: string | null;
}

export interface SpeakerRow {
  id: number;
  name: string | null;
  voice_signature: Buffer | null;
  first_seen_at: string | null;
  notes: string | null;
}

export interface SpeakerWithStats extends SpeakerRow {
  segment_count: number;
  total_duration: number;
}

export interface SegmentRow {
  id: number;
  recording_id: number;
  speaker_id: number | null;
  start_time: number | null;
  end_time: number | null;
  raw_text: string | null;
  clean_text: string | null;
  sentiment: string | null;
  bookmarked: number;
  created_at: string;
  source: string | null;
}

export interface SegmentWithSpeaker extends SegmentRow {
  speaker_name: string | null;
}

export interface SegmentSearchResult extends SegmentWithSpeaker {
  recording_name: string | null;
}

export interface ExtractedItemRow {
  id: number;
  segment_id: number | null;
  type: string;
  content: string;
  due_date: string | null;
  related_person: string | null;
  status: string;
  source: string;
  priority: string;
  reminder_sent: number;
  auto_detected_due: string | null;
  assignee: string | null;
  remind_at: string | null;
}

export interface DailySummaryRow {
  id: number;
  date: string;
  summary_text: string | null;
  timeline_json: string | null;
  key_events_json: string | null;
}

export interface WeeklySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}
export interface MonthlySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}

export interface TextNoteData {
  channel_id: string;
  user_id: string;
  user_name?: string;
  content: string;
  agent_reply?: string;
}

export interface TextNoteRow {
  id: number;
  channel_id: string;
  user_id: string;
  user_name: string | null;
  content: string;
  agent_reply: string | null;
  created_at: string;
}

export interface SpeakerCoOccurrence {
  speaker1_id: number;
  speaker1_name: string | null;
  speaker2_id: number;
  speaker2_name: string | null;
  shared_recordings: number;
}

export interface ChatSessionRow {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  session_id: number | null;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface RecordingChatMessageRow {
  id: number;
  recording_id: number;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface ChannelSessionRow {
  id: number;
  channel_id: string;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  message_count: number;
}

export interface ChannelMessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SpeakerSampleSegment {
  recording_id: number;
  start_time: number;
  end_time: number;
  raw_text: string | null;
  clean_text: string | null;
}

// ─── Person types (new person architecture) ─────────────────────────

export interface PersonData {
  name?: string;
  avatar_path?: string;
  gender?: string;
  company?: string;
  title?: string;
  tags?: string[];
  profile_markdown?: string;
  source?: 'manual' | 'auto' | 'import';
  knowledge_page_id?: number | null;
}

export interface PersonRow {
  id: number;
  name: string | null;
  avatar_path: string | null;
  gender: string | null;
  company: string | null;
  title: string | null;
  tags: string | null;
  profile_markdown: string | null;
  source: string;
  knowledge_page_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface PersonWithStats extends PersonRow {
  content_count: number;
  total_duration: number;
  last_active: string | null;
  last_text: string | null;
  last_media_type: string | null;
}

export interface PersonIdentifierRow {
  id: number;
  person_id: number;
  type: string;
  value: string | null;
  blob_value: Buffer | null;
  model: string | null;
  source: string;
  confidence: number | null;
  created_at: string;
}

export interface ContentPersonLinkRow {
  id: number;
  segment_id: number;
  person_id: number;
  role: string;
  confidence: number;
  source: string;
  created_at: string;
}

export interface PersonRelationshipRow {
  id: number;
  person_id: number;
  related_person_id: number | null;
  mentioned_name: string;
  relationship: string | null;
  context: string | null;
  recording_id: number | null;
  created_at: string;
  person_name?: string;
  related_person_name?: string;
}

export class VoiceBrainDB {
  private db: DatabaseSync;
  private walTimer: ReturnType<typeof setInterval> | null = null;
  private vacuumTimer: ReturnType<typeof setTimeout> | null = null;

  /** Run an ALTER TABLE ADD COLUMN, ignoring only "duplicate column" errors. */
  private safeAddColumn(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (err: any) {
      if (err?.message?.includes('duplicate column')) return;
      throw err;
    }
  }

  private isDatabaseMalformedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /database disk image is malformed|SQLITE_CORRUPT|corruption found/i.test(message);
  }

  private rebuildSegmentsFts(): void {
    console.warn('[DB] Rebuilding segments_fts index...');
    try {
      this.db.exec("INSERT INTO segments_fts(segments_fts) VALUES('rebuild')");
      console.log('[DB] segments_fts index rebuilt successfully');
    } catch (err) {
      console.warn('[DB] segments_fts rebuild failed, recreating table...', err);
      this.db.exec('DROP TABLE IF EXISTS segments_fts');
      this.db.exec(`CREATE VIRTUAL TABLE segments_fts USING fts5(
        raw_text, clean_text, content=segments, content_rowid=id
      )`);
      this.db.exec("INSERT INTO segments_fts(segments_fts) VALUES('rebuild')");
      console.log('[DB] segments_fts table recreated and rebuilt');
    }
  }

  private deleteSegmentsFtsRows(segmentIds: number[]): void {
    if (segmentIds.length === 0) return;

    const ph = segmentIds.map(() => '?').join(',');
    const sql = `DELETE FROM segments_fts WHERE rowid IN (${ph})`;

    try {
      this.db.prepare(sql).run(...segmentIds);
    } catch (err) {
      if (!this.isDatabaseMalformedError(err)) {
        throw err;
      }
      this.rebuildSegmentsFts();
      this.db.prepare(sql).run(...segmentIds);
    }
  }

  repairSegmentsFts(): void {
    this.rebuildSegmentsFts();
  }

  quickCheck(): { ok: boolean; details: string[] } {
    const rows = this.db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
    const details = rows.map((row) => String(Object.values(row)[0] ?? ''));
    return {
      ok: details.length > 0 && details.every((item) => item === 'ok'),
      details,
    };
  }


  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);

    // Allow waiting up to 5s for database lock instead of failing immediately
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Enable WAL mode for better concurrent performance
    this.db.exec('PRAGMA journal_mode = WAL');
    // Enable foreign key enforcement
    this.db.exec('PRAGMA foreign_keys = ON');

    // Execute schema
    this.db.exec(SCHEMA_SQL);

    // Core table indexes — critical for query performance at scale
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
      CREATE INDEX IF NOT EXISTS idx_recordings_recorded_at ON recordings(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_segments_recording_id ON segments(recording_id);
      CREATE INDEX IF NOT EXISTS idx_segments_speaker_id ON segments(speaker_id);
      CREATE INDEX IF NOT EXISTS idx_extracted_items_segment_id ON extracted_items(segment_id);
      CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
      CREATE INDEX IF NOT EXISTS idx_segments_created_at ON segments(created_at);
      CREATE INDEX IF NOT EXISTS idx_extracted_items_status ON extracted_items(status);
      CREATE INDEX IF NOT EXISTS idx_extracted_items_type_status ON extracted_items(type, status);
      CREATE INDEX IF NOT EXISTS idx_extracted_items_due_date ON extracted_items(due_date);
    `);

    // Auto-repair FTS5 — only run integrity-check if last shutdown was unclean.
    // Use a PRAGMA user_version bit as the "clean shutdown" flag.
    const userVer = ((this.db.prepare('PRAGMA user_version').get() as any)?.user_version as number) || 0;
    const CLEAN_SHUTDOWN_BIT = 0x1000;
    const wasCleanShutdown = (userVer & CLEAN_SHUTDOWN_BIT) !== 0;
    // Clear the flag immediately — will be set again on clean shutdown
    this.db.exec(`PRAGMA user_version = ${userVer & ~CLEAN_SHUTDOWN_BIT}`);

    if (!wasCleanShutdown) {
      try {
        this.db.exec("INSERT INTO segments_fts(segments_fts) VALUES('integrity-check')");
      } catch (err: any) {
        console.warn('[DB] FTS5 index corrupted, rebuilding...', err.message);
        this.rebuildSegmentsFts();
      }
    }

    // Migration: add sentiment column if not exists
    this.safeAddColumn('ALTER TABLE segments ADD COLUMN sentiment TEXT');

    // Migration: add bookmarked column if not exists
    this.safeAddColumn('ALTER TABLE segments ADD COLUMN bookmarked INTEGER DEFAULT 0');

    // Migration: create chat_messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: create chat_sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add session_id column to chat_messages
    this.safeAddColumn('ALTER TABLE chat_messages ADD COLUMN session_id INTEGER REFERENCES chat_sessions(id)');

    // Migration: assign orphan messages to a default session
    const orphanCount = (this.db.prepare(
      'SELECT COUNT(*) as count FROM chat_messages WHERE session_id IS NULL'
    ).get() as { count: number }).count;
    if (orphanCount > 0) {
      const result = this.db.prepare(
        "INSERT INTO chat_sessions (title) VALUES ('对话记录')"
      ).run();
      const defaultSessionId = Number(result.lastInsertRowid);
      this.db.prepare(
        'UPDATE chat_messages SET session_id = ? WHERE session_id IS NULL'
      ).run(defaultSessionId);
    }

    // Migration: add source column to extracted_items
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN source TEXT DEFAULT 'pipeline'");

    // Migration: create speaker_match_suggestions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS speaker_match_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        new_speaker_id INTEGER NOT NULL REFERENCES speakers(id),
        existing_speaker_id INTEGER NOT NULL REFERENCES speakers(id),
        similarity REAL NOT NULL,
        recording_id INTEGER REFERENCES recordings(id),
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add meeting_notes_json column to recordings
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN meeting_notes_json TEXT');

    // Migration: per-recording chat history (Library Q&A)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recording_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_recording_chat_messages_rec ON recording_chat_messages(recording_id, id)'
    );

    // Migration: add agent_memory table for persistent AI memory
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fact TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'general',
          layer TEXT NOT NULL DEFAULT 'active',
          confidence REAL NOT NULL DEFAULT 0.5,
          mention_count INTEGER NOT NULL DEFAULT 1,
          first_seen DATE NOT NULL,
          last_seen DATE NOT NULL,
          source_ids TEXT DEFAULT '[]',
          embedding BLOB,
          superseded_by INTEGER REFERENCES agent_memory(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: add FTS5 index on agent_memory.fact for hybrid search
    // Uses trigram tokenizer for substring matching (works with CJK text)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
          fact,
          content='agent_memory',
          content_rowid='id',
          tokenize='trigram'
        );
      `);
      // Backfill existing memories into FTS index
      this.db.exec(`
        INSERT OR IGNORE INTO agent_memory_fts(rowid, fact)
        SELECT id, fact FROM agent_memory WHERE superseded_by IS NULL
      `);
    } catch {
      // Table already exists or FTS5 not available
    }

    // Triggers to keep FTS5 in sync with agent_memory
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS agent_memory_fts_insert
        AFTER INSERT ON agent_memory BEGIN
          INSERT INTO agent_memory_fts(rowid, fact) VALUES (new.id, new.fact);
        END;

        CREATE TRIGGER IF NOT EXISTS agent_memory_fts_delete
        AFTER DELETE ON agent_memory BEGIN
          INSERT INTO agent_memory_fts(agent_memory_fts, rowid, fact) VALUES('delete', old.id, old.fact);
        END;

        CREATE TRIGGER IF NOT EXISTS agent_memory_fts_update
        AFTER UPDATE OF fact ON agent_memory BEGIN
          INSERT INTO agent_memory_fts(agent_memory_fts, rowid, fact) VALUES('delete', old.id, old.fact);
          INSERT INTO agent_memory_fts(rowid, fact) VALUES (new.id, new.fact);
        END;
      `);
    } catch {
      // Triggers already exist
    }

    // Migration: knowledge_pages table for structured knowledge wiki
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL DEFAULT 'topic',
          title TEXT NOT NULL,
          content_markdown TEXT NOT NULL DEFAULT '',
          summary TEXT,
          source_segment_ids TEXT NOT NULL DEFAULT '[]',
          source_recording_ids TEXT NOT NULL DEFAULT '[]',
          tags TEXT NOT NULL DEFAULT '[]',
          compilation_count INTEGER NOT NULL DEFAULT 0,
          content_edited INTEGER NOT NULL DEFAULT 0,
          last_compiled_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_pages_slug ON knowledge_pages (slug)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_pages_type ON knowledge_pages (type)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_pages_updated_at ON knowledge_pages (updated_at)`);
    } catch {
      // Table already exists, ignore
    }

    // Migration: content_edited flag — 1 once a user manually edits the page,
    // reset to 0 on recompile. Distinguishes 已编辑 / 已编译 / 未编译 in the UI.
    try {
      this.db.exec(`ALTER TABLE knowledge_pages ADD COLUMN content_edited INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: knowledge_links table for page-to-page relationships
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_page_id INTEGER NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
          to_page_id INTEGER NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
          link_type TEXT NOT NULL DEFAULT 'reference',
          context TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_page_id, to_page_id, link_type)
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_links_from ON knowledge_links (from_page_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_links_to ON knowledge_links (to_page_id)`);
    } catch {
      // Table already exists, ignore
    }

    // Migration: FTS5 index on knowledge_pages for full-text search (trigram for CJK)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_pages_fts USING fts5(
          title,
          content_markdown,
          summary,
          content='knowledge_pages',
          content_rowid='id',
          tokenize='trigram'
        )
      `);
      // Backfill existing pages into FTS index
      this.db.exec(`
        INSERT OR IGNORE INTO knowledge_pages_fts(rowid, title, content_markdown, summary)
        SELECT id, title, content_markdown, COALESCE(summary, '') FROM knowledge_pages
      `);
    } catch {
      // Table already exists or FTS5 not available
    }

    // Triggers to keep knowledge_pages_fts in sync with knowledge_pages
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_pages_fts_insert
        AFTER INSERT ON knowledge_pages BEGIN
          INSERT INTO knowledge_pages_fts(rowid, title, content_markdown, summary)
          VALUES (new.id, new.title, new.content_markdown, COALESCE(new.summary, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS knowledge_pages_fts_delete
        AFTER DELETE ON knowledge_pages BEGIN
          INSERT INTO knowledge_pages_fts(knowledge_pages_fts, rowid, title, content_markdown, summary)
          VALUES('delete', old.id, old.title, old.content_markdown, COALESCE(old.summary, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS knowledge_pages_au
        AFTER UPDATE OF title, content_markdown, summary ON knowledge_pages BEGIN
          INSERT INTO knowledge_pages_fts(knowledge_pages_fts, rowid, title, content_markdown, summary)
          VALUES('delete', old.id, old.title, old.content_markdown, COALESCE(old.summary, ''));
          INSERT INTO knowledge_pages_fts(rowid, title, content_markdown, summary)
          VALUES (new.id, new.title, new.content_markdown, COALESCE(new.summary, ''));
        END;
      `);
    } catch {
      // Triggers already exist
    }

    // Migration: compilation_queue table for tracking recording→knowledge compile jobs
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS compilation_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          completed_at DATETIME
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_compilation_queue_status_priority ON compilation_queue (status, priority DESC)`);
    } catch {
      // Table already exists, ignore
    }

    // Migration: add memory_documents table for daily memory docs
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL DEFAULT '',
          auto_generated INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: create speaker_relationships table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS speaker_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        speaker_id INTEGER REFERENCES speakers(id),
        mentioned_name TEXT NOT NULL,
        relationship TEXT,
        context TEXT,
        recording_id INTEGER REFERENCES recordings(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add tags column to recordings (JSON array string)
    this.safeAddColumn("ALTER TABLE recordings ADD COLUMN tags TEXT DEFAULT '[]'");

    // Migration: add TodoTracker fields to extracted_items
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN priority TEXT DEFAULT 'normal'");
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN reminder_sent INTEGER DEFAULT 0");
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN auto_detected_due TEXT");
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN assignee TEXT");
    this.safeAddColumn("ALTER TABLE extracted_items ADD COLUMN remind_at TEXT");

    // Migration: add embedding_model column + invalidate old ECAPA-TDNN voice_signatures for CAM++ upgrade
    this.safeAddColumn("ALTER TABLE speakers ADD COLUMN embedding_model TEXT");
    const invalidated = this.db.prepare(
      "UPDATE speakers SET voice_signature = NULL WHERE voice_signature IS NOT NULL AND embedding_model IS NULL"
    ).run();
    if (invalidated.changes > 0) {
      console.log(`[DB] Migration: invalidated ${invalidated.changes} old ECAPA-TDNN voice_signatures for CAM++ upgrade`);
    }

    // Migration: add capture_scene column for system audio recording scenes
    this.safeAddColumn("ALTER TABLE recordings ADD COLUMN capture_scene TEXT DEFAULT 'dictation'");

    // Migration: add source column to segments for dual-stream recording
    this.safeAddColumn("ALTER TABLE segments ADD COLUMN source TEXT DEFAULT 'mic'");

    // Migration: create text_notes table for persisting channel text messages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS text_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        user_name   TEXT,
        content     TEXT NOT NULL,
        agent_reply TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: FTS5 index on text_notes.content (trigram for CJK)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS text_notes_fts USING fts5(
          content,
          content='text_notes',
          content_rowid='id',
          tokenize='trigram'
        )
      `);
    } catch {
      // FTS5 not available or table exists
    }

    // Triggers to keep text_notes_fts in sync with text_notes
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS text_notes_fts_insert
        AFTER INSERT ON text_notes BEGIN
          INSERT INTO text_notes_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS text_notes_fts_delete
        AFTER DELETE ON text_notes BEGIN
          INSERT INTO text_notes_fts(text_notes_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS text_notes_fts_update
        AFTER UPDATE OF content ON text_notes BEGIN
          INSERT INTO text_notes_fts(text_notes_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO text_notes_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    } catch {
      // Triggers already exist
    }

    // Migration: create task_queue table for crash-recovery persistence
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_queue (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          recording_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          progress REAL DEFAULT 0,
          error TEXT,
          notes TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 2,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: add is_auto_label column to speakers (voiceprint bug fix)
    this.safeAddColumn("ALTER TABLE speakers ADD COLUMN is_auto_label INTEGER DEFAULT 0");
    // Backfill: mark existing auto-labeled speakers (e.g. "说话人 1", "Speaker 2")
    this.db.prepare(`
      UPDATE speakers SET is_auto_label = 1
      WHERE is_auto_label = 0
        AND (name LIKE '说话人 %' OR name LIKE 'Speaker %')
        AND typeof(CAST(SUBSTR(name, INSTR(name, ' ') + 1) AS INTEGER)) = 'integer'
        AND CAST(SUBSTR(name, INSTR(name, ' ') + 1) AS INTEGER) > 0
    `).run();

    // Migration: add retry columns to task_queue (for existing databases)
    try {
      this.db.exec(`ALTER TABLE task_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec(`ALTER TABLE task_queue ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 2`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: add media_type column to task_queue for multi-modal persistence
    this.safeAddColumn("ALTER TABLE task_queue ADD COLUMN media_type TEXT DEFAULT 'audio'");

    // Migration: scheduled_tasks table for task scheduler
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          task_type TEXT NOT NULL,
          action TEXT NOT NULL,
          action_params TEXT,
          schedule_type TEXT NOT NULL,
          schedule_expr TEXT,
          schedule_display TEXT,
          is_recurring INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active',
          next_run_at TEXT,
          last_run_at TEXT,
          last_run_status TEXT,
          last_run_result TEXT,
          run_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          permission_level TEXT NOT NULL DEFAULT 'readonly',
          allowed_tools TEXT,
          channels_override TEXT,
          missed_policy TEXT NOT NULL DEFAULT 'catch_up_latest',
          max_miss_hours INTEGER NOT NULL DEFAULT 24,
          max_retries INTEGER NOT NULL DEFAULT 1,
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next
        ON scheduled_tasks (status, next_run_at)
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: task_executions table for scheduler execution history
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          result_summary TEXT,
          error_message TEXT,
          channels_notified TEXT
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_executions_task_started
        ON task_executions (task_id, started_at)
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: scheduled_tasks output management
    this.safeAddColumn("ALTER TABLE scheduled_tasks ADD COLUMN output_mode TEXT NOT NULL DEFAULT 'push'");
    this.safeAddColumn('ALTER TABLE scheduled_tasks ADD COLUMN output_file_path TEXT');

    // Migration: add multi-modal columns to recordings
    this.safeAddColumn("ALTER TABLE recordings ADD COLUMN media_type TEXT DEFAULT 'audio'");
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN page_count INTEGER');
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN word_count INTEGER');

    // Migration: Person architecture tables (persons, person_identifiers, content_person_links, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        avatar_path TEXT,
        gender TEXT,
        company TEXT,
        title TEXT,
        tags TEXT DEFAULT '[]',
        profile_markdown TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_identifiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        blob_value BLOB,
        model TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        confidence REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(type, value)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_person_identifiers_type_value ON person_identifiers (type, value)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_person_identifiers_person_id ON person_identifiers (person_id)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_person_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(segment_id, person_id, role)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_person_links_segment_id ON content_person_links (segment_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_person_links_person_id ON content_person_links (person_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_person_links_role ON content_person_links (role)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_match_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        new_person_id INTEGER NOT NULL REFERENCES persons(id),
        existing_person_id INTEGER NOT NULL REFERENCES persons(id),
        match_type TEXT NOT NULL,
        similarity REAL NOT NULL,
        evidence TEXT,
        recording_id INTEGER REFERENCES recordings(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        related_person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
        mentioned_name TEXT,
        relationship TEXT,
        context TEXT,
        recording_id INTEGER REFERENCES recordings(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_person_relationships_person_id ON person_relationships (person_id)`);

    // Migration: add primary_person_id column to segments
    this.safeAddColumn('ALTER TABLE segments ADD COLUMN primary_person_id INTEGER REFERENCES persons(id)');

    // Migration: add speaker_label column to segments (diarization label without auto-creating persons)
    this.safeAddColumn('ALTER TABLE segments ADD COLUMN speaker_label TEXT');

    // Migration: add custom_title and custom_category to recordings
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN custom_title TEXT');
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN custom_category TEXT');
    // Migration: AI-generated whole-transcript title. Filled by pipeline
    // (and by backfill) for any recording with segments, regardless of
    // capture_scene. Lighter than meeting_notes — single short prompt.
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN auto_title TEXT');

    // Migration: LLM-assigned importance score (0-10) + per-day session
    // linking. importance_score drives TODAY filtering (low scores fold into
    // brief tail); session_id groups consecutive related dictations.
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN importance_score REAL DEFAULT 0');
    this.safeAddColumn('ALTER TABLE recordings ADD COLUMN session_id INTEGER');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at DATETIME NOT NULL,
        topic TEXT,
        summary TEXT,
        importance_score REAL DEFAULT 0,
        member_count INTEGER NOT NULL DEFAULT 0,
        is_finalized INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
      CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
    `);

    // Migration: link persons to knowledge pages
    this.safeAddColumn('ALTER TABLE persons ADD COLUMN knowledge_page_id INTEGER REFERENCES knowledge_pages(id)');

    // One-time migrations (controlled by PRAGMA user_version)
    {
      const ver = (this.db.prepare('PRAGMA user_version').get() as any).user_version;

      // v1: clear all legacy auto-extracted items (extraction is now on-demand)
      if (ver < 1) {
        const deleted = this.db.prepare("DELETE FROM extracted_items").run();
        if (deleted.changes > 0) {
          console.log(`[DB] Migration v1: cleared ${deleted.changes} legacy extracted items`);
        }
      }

      // v2: clear all auto-created persons (persons are now manual-only)
      if (ver < 2) {
        this.db.exec(`
          UPDATE segments SET primary_person_id = NULL WHERE primary_person_id IS NOT NULL;
          DELETE FROM content_person_links;
          DELETE FROM person_match_suggestions;
          DELETE FROM person_relationships;
          DELETE FROM person_identifiers;
          DELETE FROM persons;
        `);
        console.log('[DB] Migration v2: cleared all legacy auto-created persons');
      }

      // v3: migrate persons.profile_markdown content to knowledge_pages
      if (ver < 3) {
        const personsWithMarkdown = this.db.prepare(
          "SELECT id, name, profile_markdown FROM persons WHERE profile_markdown IS NOT NULL AND profile_markdown != ''"
        ).all() as Array<{ id: number; name: string; profile_markdown: string }>;

        for (const p of personsWithMarkdown) {
          const slug = `person/${p.name}`;
          // Check if a knowledge page already exists for this person
          const existing = this.db.prepare(
            "SELECT id FROM knowledge_pages WHERE slug = ?"
          ).get(slug) as { id: number } | undefined;

          if (existing) {
            // Link existing page
            this.db.prepare(
              "UPDATE persons SET knowledge_page_id = ? WHERE id = ?"
            ).run(existing.id, p.id);
          } else {
            // Create a new knowledge page from profile_markdown
            const result = this.db.prepare(
              `INSERT INTO knowledge_pages (slug, type, title, content_markdown, source_segment_ids, source_recording_ids, tags)
               VALUES (?, 'person', ?, ?, '[]', '[]', '[]')`
            ).run(slug, p.name, p.profile_markdown);
            this.db.prepare(
              "UPDATE persons SET knowledge_page_id = ? WHERE id = ?"
            ).run(result.lastInsertRowid, p.id);
          }
        }
        if (personsWithMarkdown.length > 0) {
          console.log(`[DB] Migration v3: migrated ${personsWithMarkdown.length} person profiles to knowledge pages`);
        }
      }

      // Bump to latest version
      if (ver < 3) {
        this.db.prepare('PRAGMA user_version = 3').run();
      }
    }

    // Migration: correction_dictionary table for ASR post-correction
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS correction_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wrong_text TEXT NOT NULL,
          correct_text TEXT NOT NULL,
          category TEXT DEFAULT 'general',
          source TEXT DEFAULT 'manual',
          hit_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT (datetime('now')),
          UNIQUE(wrong_text, correct_text)
        );
        CREATE INDEX IF NOT EXISTS idx_cd_wrong ON correction_dictionary(wrong_text);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: custom_vocabulary table for hot-words / proper nouns
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_vocabulary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          term TEXT NOT NULL UNIQUE,
          category TEXT DEFAULT 'general',
          created_at DATETIME DEFAULT (datetime('now'))
        );
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: generic external source tables for third-party data providers.
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS external_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT DEFAULT 'disconnected',
          config_json TEXT DEFAULT '{}',
          last_sync_at DATETIME,
          created_at DATETIME DEFAULT (datetime('now')),
          UNIQUE(source)
        );
        CREATE TABLE IF NOT EXISTS external_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          domain TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          url TEXT DEFAULT '',
          metadata_json TEXT DEFAULT '{}',
          fetched_at DATETIME DEFAULT (datetime('now')),
          deleted INTEGER DEFAULT 0,
          UNIQUE(source, domain, external_id)
        );
        CREATE TABLE IF NOT EXISTS external_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL REFERENCES external_documents(id),
          external_id TEXT NOT NULL,
          title TEXT DEFAULT '',
          url TEXT DEFAULT '',
          content TEXT NOT NULL,
          metadata_json TEXT DEFAULT '{}',
          content_hash TEXT NOT NULL,
          updated_at DATETIME DEFAULT (datetime('now')),
          deleted INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS external_sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          domain TEXT DEFAULT '',
          started_at DATETIME DEFAULT (datetime('now')),
          finished_at DATETIME,
          status TEXT DEFAULT 'running',
          documents_count INTEGER DEFAULT 0,
          chunks_count INTEGER DEFAULT 0,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ext_docs_source ON external_documents(source, domain);
        CREATE INDEX IF NOT EXISTS idx_ext_docs_ext_id ON external_documents(external_id);
        CREATE INDEX IF NOT EXISTS idx_ext_chunks_doc ON external_chunks(document_id);
        CREATE INDEX IF NOT EXISTS idx_ext_chunks_hash ON external_chunks(content_hash);
        CREATE INDEX IF NOT EXISTS idx_ext_sync_runs_source ON external_sync_runs(source);
      `);
    } catch {
      // Tables already exist, ignore
    }

    // Additional indexes for commonly-queried tables (must be after all migrations)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_category_layer ON agent_memory(category, layer);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_last_seen ON agent_memory(last_seen);
      CREATE INDEX IF NOT EXISTS idx_persons_created_at ON persons(created_at);
      CREATE INDEX IF NOT EXISTS idx_persons_source ON persons(source);
      CREATE INDEX IF NOT EXISTS idx_content_person_links_created_at ON content_person_links(created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_pages_created_at ON knowledge_pages(created_at);
      CREATE INDEX IF NOT EXISTS idx_text_notes_channel_id ON text_notes(channel_id);
      CREATE INDEX IF NOT EXISTS idx_text_notes_created_at ON text_notes(created_at);
      CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
      CREATE INDEX IF NOT EXISTS idx_memory_documents_date ON memory_documents(date);
      CREATE INDEX IF NOT EXISTS idx_speaker_match_suggestions_status ON speaker_match_suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_person_match_suggestions_status ON person_match_suggestions(status);
    `);

    // Start periodic WAL checkpoint to prevent unbounded WAL growth
    this.startWalCheckpoint();

    // Defer VACUUM to avoid blocking startup (VACUUM rewrites the entire DB file)
    this.vacuumTimer = setTimeout(() => this.vacuumIfNeeded(), 10_000);
  }

  /**
   * Start periodic WAL checkpoint (every 5 minutes).
   * Uses PASSIVE mode which does not block readers or writers.
   */
  startWalCheckpoint(): void {
    this.walTimer = setInterval(() => {
      try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }
      catch (e) { /* ignore — DB may be closed */ }
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop the periodic WAL checkpoint timer.
   * Runs a final TRUNCATE checkpoint to reset the WAL file on shutdown.
   */
  stopWalCheckpoint(): void {
    if (this.walTimer) {
      clearInterval(this.walTimer);
      this.walTimer = null;
    }
    try {
      // Mark clean shutdown so next startup skips FTS5 integrity-check
      const userVer = ((this.db.prepare('PRAGMA user_version').get() as any)?.user_version as number) || 0;
      this.db.exec(`PRAGMA user_version = ${userVer | 0x1000}`);
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { /* ignore — DB may already be closed */ }
  }

  /**
   * Run VACUUM if more than 7 days since last vacuum.
   * Tracks the last vacuum date via a lightweight `_vacuum_log` table
   * (user_version is reserved for schema versioning + shutdown flags).
   */
  vacuumIfNeeded(): void {
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS _vacuum_log (last_day INTEGER NOT NULL)');
      const row = this.db.prepare('SELECT last_day FROM _vacuum_log LIMIT 1').get() as { last_day: number } | undefined;
      const lastDay = row?.last_day || 0;
      const todayDay = Math.floor(Date.now() / 86400000);
      if (todayDay - lastDay >= 7) {
        console.log('[DB] Running periodic VACUUM...');
        const t0 = Date.now();
        this.db.exec('VACUUM');
        if (row) {
          this.db.prepare('UPDATE _vacuum_log SET last_day = ?').run(todayDay);
        } else {
          this.db.prepare('INSERT INTO _vacuum_log (last_day) VALUES (?)').run(todayDay);
        }
        console.log(`[DB] VACUUM complete (${Date.now() - t0}ms)`);
      }
    } catch (err: any) {
      console.warn('[DB] VACUUM failed (non-critical):', err.message);
    }
  }

  /**
   * List all user tables in the database.
   */
  listTables(): string[] {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  // ─── Recordings ──────────────────────────────────────────────

  insertRecording(data: RecordingData): number {
    const stmt = this.db.prepare(`
      INSERT INTO recordings (file_path, file_name, duration_seconds, recorded_at, processed_at, status, capture_scene, media_type, page_count, word_count)
      VALUES (@file_path, @file_name, @duration_seconds, @recorded_at, @processed_at, @status, @capture_scene, @media_type, @page_count, @word_count)
    `);
    const result = stmt.run({
      file_path: data.file_path,
      file_name: data.file_name,
      duration_seconds: data.duration_seconds ?? null,
      recorded_at: data.recorded_at ?? null,
      processed_at: data.processed_at ?? null,
      status: data.status ?? 'pending',
      capture_scene: data.capture_scene ?? 'dictation',
      media_type: data.media_type ?? 'audio',
      page_count: data.page_count ?? null,
      word_count: data.word_count ?? null,
    });
    return result.lastInsertRowid as number;
  }

  updateRecording(id: number, data: Partial<Pick<RecordingData, 'status' | 'processed_at' | 'duration_seconds' | 'media_type' | 'page_count' | 'word_count' | 'capture_scene'>>): void {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE recordings SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getRecording(id: number): RecordingRow | undefined {
    return this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;
  }

  getRecordingByPath(filePath: string): RecordingRow | undefined {
    return this.db.prepare('SELECT * FROM recordings WHERE file_path = ?').get(filePath) as RecordingRow | undefined;
  }

  getRecordingsByStatus(status: string): RecordingRow[] {
    return this.db.prepare('SELECT * FROM recordings WHERE status = ?').all(status) as RecordingRow[];
  }

  getAllRecordings(): RecordingWithStats[] {
    return this.db.prepare(`
      SELECT r.*,
        COALESCE(seg_stats.speaker_count, 0) AS speaker_count,
        COALESCE(seg_stats.extracted_count, 0) AS extracted_count,
        COALESCE(first_seg.clean_text, first_seg.raw_text) AS first_segment_text
      FROM recordings r
      LEFT JOIN (
        SELECT recording_id,
          COUNT(DISTINCT COALESCE(primary_person_id, speaker_id)) AS speaker_count,
          (SELECT COUNT(*) FROM extracted_items ei
           JOIN segments s2 ON ei.segment_id = s2.id
           WHERE s2.recording_id = segments.recording_id) AS extracted_count
        FROM segments
        GROUP BY recording_id
      ) seg_stats ON r.id = seg_stats.recording_id
      LEFT JOIN segments first_seg ON first_seg.id = (
        SELECT id FROM segments
        WHERE recording_id = r.id
        ORDER BY start_time ASC, id ASC
        LIMIT 1
      )
      ORDER BY r.id DESC
    `).all() as RecordingWithStats[];
  }

  /** Get most recent recordings with stats, limited to avoid loading all rows */
  getRecentRecordings(limit: number): RecordingWithStats[] {
    return this.db.prepare(`
      SELECT r.*,
        COALESCE(seg_stats.speaker_count, 0) AS speaker_count,
        COALESCE(seg_stats.extracted_count, 0) AS extracted_count
      FROM recordings r
      LEFT JOIN (
        SELECT recording_id,
          COUNT(DISTINCT COALESCE(primary_person_id, speaker_id)) AS speaker_count,
          (SELECT COUNT(*) FROM extracted_items ei
           JOIN segments s2 ON ei.segment_id = s2.id
           WHERE s2.recording_id = segments.recording_id) AS extracted_count
        FROM segments
        GROUP BY recording_id
      ) seg_stats ON r.id = seg_stats.recording_id
      ORDER BY r.id DESC
      LIMIT ?
    `).all(limit) as RecordingWithStats[];
  }

  updateRecordingDuration(id: number, durationSeconds: number): void {
    this.db
      .prepare('UPDATE recordings SET duration_seconds = ? WHERE id = ?')
      .run(Math.round(durationSeconds), id);
  }

  updateRecordingFilePath(id: number, filePath: string): void {
    this.db
      .prepare('UPDATE recordings SET file_path = ? WHERE id = ?')
      .run(filePath, id);
  }

  updateRecordingTitle(id: number, title: string): void {
    this.db.prepare('UPDATE recordings SET custom_title = ? WHERE id = ?').run(title || null, id);
  }

  /** Set AI-generated whole-transcript title. Called by pipeline + backfill. */
  updateRecordingAutoTitle(id: number, title: string): void {
    this.db.prepare('UPDATE recordings SET auto_title = ? WHERE id = ?').run(title || null, id);
  }

  // ─── Sessions ────────────────────────────────────────

  createCaptureSession(s: { date: string; started_at: string; ended_at: string }): number {
    const info = this.db.prepare(
      'INSERT INTO sessions (date, started_at, ended_at) VALUES (?, ?, ?)'
    ).run(s.date, s.started_at, s.ended_at);
    return info.lastInsertRowid as number;
  }

  getCaptureSession(id: number): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ?? null;
  }

  /** Members of a capture session — minimal projection sufficient for
   * assembly + UI rendering. Caller hydrates transcript via
   * getRecordingTranscriptText. */
  getCaptureSessionMembers(sessionId: number): RecordingWithStats[] {
    return this.db.prepare(`
      SELECT r.*,
        0 AS speaker_count,
        0 AS extracted_count,
        NULL AS first_segment_text
      FROM recordings r
      WHERE r.session_id = ?
      ORDER BY r.recorded_at ASC, r.id ASC
    `).all(sessionId) as RecordingWithStats[];
  }

  /** Find an unfinalized session on the same day + capture_scene whose last
   * activity is within `windowMinutes`. Used by pipeline to decide grouping. */
  findActiveCaptureSession(args: { date: string; captureScene: string; windowMinutes: number }): SessionRow | null {
    const cutoff = new Date(Date.now() - args.windowMinutes * 60_000).toISOString();
    const row = this.db.prepare(`
      SELECT s.* FROM sessions s
      WHERE s.date = ? AND s.is_finalized = 0 AND s.ended_at >= ?
        AND EXISTS (
          SELECT 1 FROM recordings r
          WHERE r.session_id = s.id AND r.capture_scene = ?
        )
      ORDER BY s.ended_at DESC LIMIT 1
    `).get(args.date, cutoff, args.captureScene) as SessionRow | undefined;
    return row ?? null;
  }

  addRecordingToCaptureSession(recordingId: number, sessionId: number, recordedAt: string): void {
    const txn = transaction(this.db, () => {
      this.db.prepare('UPDATE recordings SET session_id = ? WHERE id = ?').run(sessionId, recordingId);
      this.db.prepare(`
        UPDATE sessions
        SET ended_at = MAX(ended_at, ?),
            member_count = (SELECT COUNT(*) FROM recordings WHERE session_id = ?)
        WHERE id = ?
      `).run(recordedAt, sessionId, sessionId);
    });
    txn();
  }

  updateCaptureSession(id: number, patch: {
    topic?: string | null;
    summary?: string | null;
    importance_score?: number;
    is_finalized?: 0 | 1;
  }): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.topic !== undefined) { sets.push('topic = ?'); vals.push(patch.topic); }
    if (patch.summary !== undefined) { sets.push('summary = ?'); vals.push(patch.summary); }
    if (patch.importance_score !== undefined) { sets.push('importance_score = ?'); vals.push(patch.importance_score); }
    if (patch.is_finalized !== undefined) { sets.push('is_finalized = ?'); vals.push(patch.is_finalized); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  updateRecordingImportance(id: number, score: number): void {
    this.db.prepare('UPDATE recordings SET importance_score = ? WHERE id = ?').run(score, id);
  }

  /** Sessions whose last activity exceeds windowMinutes ago and are not yet
   * finalized. Caller computes final topic + summary, then sets is_finalized. */
  getStaleCaptureSessions(windowMinutes: number): SessionRow[] {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    return this.db.prepare(
      'SELECT * FROM sessions WHERE is_finalized = 0 AND ended_at < ? ORDER BY ended_at ASC'
    ).all(cutoff) as SessionRow[];
  }

  /**
   * Three-tier curated view of one day:
   *   - sessions: groups with >= 2 members OR session.importance_score >= 8
   *   - standalones: importance >= 5 OR custom_title OR non-audio media
   *   - briefs: low-score sessionless dictation (folded into UI tail)
   *
   * Mirrors the getAllRecordings projection (adds first_segment_text NULL
   * so callers don't need a separate type).
   */
  getTodayCuratedItems(date: string): CuratedDay {
    const recordings = this.db.prepare(`
      SELECT r.*,
        COALESCE(seg_stats.speaker_count, 0) AS speaker_count,
        COALESCE(seg_stats.extracted_count, 0) AS extracted_count,
        NULL AS first_segment_text
      FROM recordings r
      LEFT JOIN (
        SELECT recording_id,
          COUNT(DISTINCT COALESCE(primary_person_id, speaker_id)) AS speaker_count,
          (SELECT COUNT(*) FROM extracted_items ei
           JOIN segments s2 ON ei.segment_id = s2.id
           WHERE s2.recording_id = segments.recording_id) AS extracted_count
        FROM segments GROUP BY recording_id
      ) seg_stats ON r.id = seg_stats.recording_id
      WHERE r.status = 'completed'
        AND date(coalesce(r.recorded_at, r.processed_at), 'localtime') = ?
      ORDER BY coalesce(r.recorded_at, r.processed_at) DESC
    `).all(date) as RecordingWithStats[];

    const bySession = new Map<number, RecordingWithStats[]>();
    const sessionless: RecordingWithStats[] = [];
    for (const r of recordings) {
      if (r.session_id) {
        const arr = bySession.get(r.session_id) || [];
        arr.push(r);
        bySession.set(r.session_id, arr);
      } else {
        sessionless.push(r);
      }
    }

    const sessions: CuratedDay['sessions'] = [];
    const oneMemberSessionRecordings: RecordingWithStats[] = [];
    for (const [sid, members] of bySession) {
      const session = this.getCaptureSession(sid);
      if (!session) {
        sessionless.push(...members);
        continue;
      }
      if (members.length >= 2 || (session.importance_score || 0) >= 8) {
        sessions.push({
          session,
          members: members.sort((a, b) =>
            (a.recorded_at || '').localeCompare(b.recorded_at || '')
          ),
        });
      } else {
        // 1-member session treated as standalone — score & display by item.
        oneMemberSessionRecordings.push(...members);
      }
    }

    const standalones: RecordingWithStats[] = [];
    const briefs: RecordingWithStats[] = [];
    for (const r of [...sessionless, ...oneMemberSessionRecordings]) {
      const score = r.importance_score ?? 0;
      const isMedia = !!(r.media_type && r.media_type !== 'audio');
      const isImportant = isMedia || score >= 5 || !!(r.custom_title?.trim());
      if (isImportant) standalones.push(r);
      else briefs.push(r);
    }

    return { sessions, standalones, briefs };
  }

  /** Driver for the backfill IPC: recordings completed with segments but
   * not yet scored. Returns the minimum fields the backfill loop needs. */
  getRecordingsNeedingCuration(limit: number): Array<{
    id: number;
    date: string;
    capture_scene: string | null;
    recorded_at: string | null;
    processed_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT r.id,
             date(coalesce(r.recorded_at, r.processed_at), 'localtime') AS date,
             r.capture_scene,
             r.recorded_at,
             r.processed_at
      FROM recordings r
      WHERE r.status = 'completed'
        AND (r.importance_score IS NULL OR r.importance_score = 0)
        AND EXISTS (SELECT 1 FROM segments s WHERE s.recording_id = r.id)
      ORDER BY coalesce(r.recorded_at, r.processed_at) ASC
      LIMIT ?
    `).all(limit) as Array<{
      id: number; date: string; capture_scene: string | null;
      recorded_at: string | null; processed_at: string | null;
    }>;
  }

  /** Return recording IDs that have segments but no usable auto_title yet.
   * Excludes rows already covered by custom_title or meeting_notes.title. */
  getRecordingsNeedingTitle(limit: number = 1000): { id: number }[] {
    return this.db.prepare(`
      SELECT r.id
      FROM recordings r
      WHERE r.status = 'completed'
        AND (r.auto_title IS NULL OR r.auto_title = '')
        AND (r.custom_title IS NULL OR r.custom_title = '')
        AND EXISTS (SELECT 1 FROM segments s WHERE s.recording_id = r.id)
      ORDER BY r.id DESC
      LIMIT ?
    `).all(limit) as { id: number }[];
  }

  /** Concatenate clean_text (falling back to raw_text) of all segments for
   * a recording. Used to feed generateTitle without loading full SegmentRow. */
  getRecordingTranscriptText(id: number, maxChars: number = 4000): string {
    const rows = this.db.prepare(
      'SELECT COALESCE(clean_text, raw_text) AS text FROM segments WHERE recording_id = ? ORDER BY start_time ASC, id ASC'
    ).all(id) as { text: string | null }[];
    let combined = '';
    for (const r of rows) {
      if (!r.text) continue;
      combined += r.text.trim() + ' ';
      if (combined.length >= maxChars) break;
    }
    return combined.trim();
  }

  updateRecordingCategory(id: number, category: string | null): void {
    this.db.prepare('UPDATE recordings SET custom_category = ? WHERE id = ?').run(category, id);
  }

  updateRecordingStatus(id: number, status: string): void {
    if (status === 'completed') {
      this.db
        .prepare('UPDATE recordings SET status = ?, processed_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), id);
    } else {
      this.db
        .prepare('UPDATE recordings SET status = ? WHERE id = ?')
        .run(status, id);
    }
  }

  getRecordingTags(id: number): string[] {
    const row = this.db.prepare('SELECT tags FROM recordings WHERE id = ?').get(id) as { tags: string } | undefined;
    if (!row?.tags) return [];
    try { return JSON.parse(row.tags); } catch { return []; }
  }

  setRecordingTags(id: number, tags: string[]): void {
    this.db.prepare('UPDATE recordings SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
  }

  /** Reset any recordings stuck in active statuses (e.g. after a crash). Returns count. */
  recoverStuckRecordings(): number {
    const result = this.db
      .prepare("UPDATE recordings SET status = 'failed' WHERE status IN ('processing', 'pending', 'recording', 'post_processing')")
      .run();
    if (result.changes > 0) {
      console.log(`[DB] Recovered ${result.changes} stuck recording(s) from active statuses → 'failed'`);
    }
    return Number(result.changes);
  }

  /**
   * Remove duplicate recordings for the same file_path.
   * Keeps the newest recording (highest id) for each file_path, deletes older duplicates.
   * Returns count of removed duplicates.
   */
  deduplicateRecordings(): number {
    // Find file_paths with multiple recordings
    const dupes = this.db.prepare(`
      SELECT file_path, MAX(id) AS keep_id, COUNT(*) AS cnt
      FROM recordings
      GROUP BY file_path
      HAVING cnt > 1
    `).all() as { file_path: string; keep_id: number; cnt: number }[];

    if (dupes.length === 0) return 0;

    let removed = 0;
    const tx = transaction(this.db, () => {
      for (const dupe of dupes) {
        // Get IDs to delete (all except the newest)
        const toDelete = this.db.prepare(
          'SELECT id FROM recordings WHERE file_path = ? AND id != ? ORDER BY id'
        ).all(dupe.file_path, dupe.keep_id) as { id: number }[];

        for (const rec of toDelete) {
          // Use clearRecordingData + delete to safely remove with FK cascade
          this.clearRecordingData(rec.id);
          this.db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
          removed++;
        }
      }
    });
    tx();

    if (removed > 0) {
      console.log(`[DB] Deduplicated ${removed} duplicate recording(s) across ${dupes.length} file(s)`);
    }
    return removed;
  }

  saveMeetingNotes(recordingId: number, notes: MeetingNotes): void {
    this.db.prepare('UPDATE recordings SET meeting_notes_json = ? WHERE id = ?')
      .run(JSON.stringify(notes), recordingId);
  }

  getMeetingNotes(recordingId: number): MeetingNotes | null {
    const row = this.db.prepare('SELECT meeting_notes_json FROM recordings WHERE id = ?')
      .get(recordingId) as { meeting_notes_json: string | null } | undefined;
    return row?.meeting_notes_json ? JSON.parse(row.meeting_notes_json) : null;
  }

  // ─── Speakers ────────────────────────────────────────────────

  insertSpeaker(data: SpeakerData): number {
    const stmt = this.db.prepare(`
      INSERT INTO speakers (name, voice_signature, notes, is_auto_label)
      VALUES (@name, @voice_signature, @notes, @is_auto_label)
    `);
    const result = stmt.run({
      name: data.name ?? null,
      voice_signature: data.voice_signature ?? null,
      notes: data.notes ?? null,
      is_auto_label: data.is_auto_label ? 1 : 0,
    });
    return result.lastInsertRowid as number;
  }

  getSpeaker(id: number): SpeakerRow | undefined {
    return this.db.prepare('SELECT * FROM speakers WHERE id = ?').get(id) as SpeakerRow | undefined;
  }

  getSpeakerByName(name: string): SpeakerRow | undefined {
    return this.db.prepare('SELECT * FROM speakers WHERE name = ? LIMIT 1').get(name) as SpeakerRow | undefined;
  }

  getAllSpeakers(): SpeakerWithStats[] {
    return this.db.prepare(`
      SELECT s.*,
        COALESCE(seg_stats.segment_count, 0) AS segment_count,
        COALESCE(seg_stats.total_duration, 0) AS total_duration,
        seg_stats.first_seen_at
      FROM speakers s
      LEFT JOIN (
        SELECT speaker_id,
          COUNT(*) AS segment_count,
          SUM(end_time - start_time) AS total_duration,
          MIN(r.recorded_at) AS first_seen_at
        FROM segments seg
        LEFT JOIN recordings r ON seg.recording_id = r.id
        GROUP BY speaker_id
      ) seg_stats ON s.id = seg_stats.speaker_id
      WHERE COALESCE(seg_stats.segment_count, 0) > 0
    `).all() as SpeakerWithStats[];
  }

  renameSpeaker(id: number, name: string): void {
    this.db.prepare('UPDATE speakers SET name = ?, is_auto_label = 0 WHERE id = ?').run(name, id);
  }

  updateSpeakerNotes(id: number, notes: string): void {
    this.db.prepare('UPDATE speakers SET notes = ? WHERE id = ?').run(notes, id);
  }

  deleteSpeaker(id: number): void {
    this.db.prepare('UPDATE segments SET speaker_id = NULL WHERE speaker_id = ?').run(id);
    this.db.prepare('DELETE FROM speakers WHERE id = ?').run(id);
  }


  getSegmentsBySpeaker(speakerId: number, limit = 10): SegmentSearchResult[] {
    return this.db.prepare(`
      SELECT s.*, r.file_name AS recording_name, sp.name AS speaker_name
      FROM segments s
      LEFT JOIN recordings r ON s.recording_id = r.id
      LEFT JOIN speakers sp ON s.speaker_id = sp.id
      WHERE s.speaker_id = ?
      ORDER BY s.id DESC
      LIMIT ?
    `).all(speakerId, limit) as SegmentSearchResult[];
  }

  getSpeakerSampleSegment(speakerId: number): SpeakerSampleSegment | undefined {
    return this.db.prepare(`
      SELECT s.recording_id, s.start_time, s.end_time, s.raw_text, s.clean_text
      FROM segments s
      WHERE s.speaker_id = ? AND s.end_time - s.start_time > 2
      ORDER BY (s.end_time - s.start_time) DESC
      LIMIT 1
    `).get(speakerId) as SpeakerSampleSegment | undefined;
  }








  // ─── Person Relationships (insert) ─────────────────────────

  insertPersonRelationship(data: {
    person_id: number;
    related_person_id?: number;
    mentioned_name?: string;
    relationship?: string;
    context?: string;
    recording_id?: number;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO person_relationships (person_id, related_person_id, mentioned_name, relationship, context, recording_id)
      VALUES (@person_id, @related_person_id, @mentioned_name, @relationship, @context, @recording_id)
    `).run({
      person_id: data.person_id,
      related_person_id: data.related_person_id ?? null,
      mentioned_name: data.mentioned_name ?? null,
      relationship: data.relationship ?? null,
      context: data.context ?? null,
      recording_id: data.recording_id ?? null,
    });
    return result.lastInsertRowid as number;
  }

  // ─── Persons ─────────────────────────────────────────────────

  insertPerson(data: PersonData): number {
    const stmt = this.db.prepare(`
      INSERT INTO persons (name, avatar_path, gender, company, title, tags, profile_markdown, source, knowledge_page_id)
      VALUES (@name, @avatar_path, @gender, @company, @title, @tags, @profile_markdown, @source, @knowledge_page_id)
    `);
    const result = stmt.run({
      name: data.name ?? null,
      avatar_path: data.avatar_path ?? null,
      gender: data.gender ?? null,
      company: data.company ?? null,
      title: data.title ?? null,
      tags: data.tags ? JSON.stringify(data.tags) : '[]',
      profile_markdown: data.profile_markdown ?? null,
      source: data.source ?? 'manual',
      knowledge_page_id: data.knowledge_page_id ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getPerson(id: number): PersonRow | undefined {
    return this.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as PersonRow | undefined;
  }

  getPersonByName(name: string): PersonRow | undefined {
    return this.db.prepare('SELECT * FROM persons WHERE name = ? LIMIT 1').get(name) as PersonRow | undefined;
  }

  /** Fuzzy person lookup via SQL LIKE — avoids loading all persons into memory */
  searchPersonByNameFuzzy(nameQuery: string): PersonRow | undefined {
    // First: person name contains query
    const forward = this.db.prepare(
      'SELECT * FROM persons WHERE name LIKE ? LIMIT 1'
    ).get(`%${nameQuery}%`) as PersonRow | undefined;
    if (forward) return forward;
    // Reverse: query contains person name
    return this.db.prepare(
      `SELECT * FROM persons WHERE ? LIKE '%' || name || '%' LIMIT 1`
    ).get(nameQuery) as PersonRow | undefined;
  }

  getAllPersons(): PersonWithStats[] {
    return this.db.prepare(`
      SELECT p.*,
        COUNT(DISTINCT cpl.id) as content_count,
        COALESCE(SUM(CASE WHEN s.end_time IS NOT NULL AND s.start_time IS NOT NULL
          THEN s.end_time - s.start_time ELSE 0 END), 0) as total_duration,
        MAX(cpl.created_at) as last_active,
        (SELECT SUBSTR(COALESCE(s2.clean_text, s2.raw_text, ''), 1, 60)
          FROM content_person_links cpl2
          JOIN segments s2 ON s2.id = cpl2.segment_id
          WHERE cpl2.person_id = p.id
          ORDER BY CASE WHEN cpl2.role = 'speaker' THEN 0 ELSE 1 END, s2.id DESC
          LIMIT 1) as last_text,
        (SELECT COALESCE(r2.media_type, 'audio')
          FROM content_person_links cpl3
          JOIN segments s3 ON s3.id = cpl3.segment_id
          JOIN recordings r2 ON r2.id = s3.recording_id
          WHERE cpl3.person_id = p.id
          ORDER BY s3.id DESC
          LIMIT 1) as last_media_type
      FROM persons p
      LEFT JOIN content_person_links cpl ON cpl.person_id = p.id
      LEFT JOIN segments s ON s.id = cpl.segment_id
      GROUP BY p.id
      ORDER BY content_count DESC, p.created_at DESC
    `).all() as PersonWithStats[];
  }

  updatePerson(id: number, data: Partial<PersonData>): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.avatar_path !== undefined) { fields.push('avatar_path = ?'); values.push(data.avatar_path ?? null); }
    if (data.gender !== undefined) { fields.push('gender = ?'); values.push(data.gender ?? null); }
    if (data.company !== undefined) { fields.push('company = ?'); values.push(data.company ?? null); }
    if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title ?? null); }
    if (data.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(data.tags)); }
    if (data.profile_markdown !== undefined) { fields.push('profile_markdown = ?'); values.push(data.profile_markdown ?? null); }
    if (data.source !== undefined) { fields.push('source = ?'); values.push(data.source); }
    if (data.knowledge_page_id !== undefined) { fields.push('knowledge_page_id = ?'); values.push(data.knowledge_page_id ?? null); }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE persons SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePerson(id: number): void {
    const tx = transaction(this.db, () => {
      // Delete content_person_links
      this.db.prepare('DELETE FROM content_person_links WHERE person_id = ?').run(id);
      // Delete person_identifiers
      this.db.prepare('DELETE FROM person_identifiers WHERE person_id = ?').run(id);
      // Delete person_relationships (as person_id or related_person_id)
      this.db.prepare('DELETE FROM person_relationships WHERE person_id = ? OR related_person_id = ?').run(id, id);
      // Delete person_match_suggestions
      this.db.prepare('DELETE FROM person_match_suggestions WHERE new_person_id = ? OR existing_person_id = ?').run(id, id);
      // Clear primary_person_id references in segments
      this.db.prepare('UPDATE segments SET primary_person_id = NULL WHERE primary_person_id = ?').run(id);
      // Delete the person
      this.db.prepare('DELETE FROM persons WHERE id = ?').run(id);
    });
    tx();
  }


  /** Remove segments, extracted items, match suggestions, and meeting notes for a recording (for reprocessing). */
  clearRecordingData(id: number): void {
    const tx = transaction(this.db, () => {
      // Get segment IDs for this recording
      const segIds = this.db.prepare('SELECT id FROM segments WHERE recording_id = ?')
        .all(id) as { id: number }[];
      if (segIds.length > 0) {
        const ph = segIds.map(() => '?').join(',');
        const ids = segIds.map(s => s.id);
        // Delete extracted items
        this.db.prepare(`DELETE FROM extracted_items WHERE segment_id IN (${ph})`).run(...ids);
        // Delete FTS entries
        this.deleteSegmentsFtsRows(ids);
      }
      // Delete match suggestions for speakers in this recording
      const spkIds = this.db.prepare(
        'SELECT DISTINCT speaker_id FROM segments WHERE recording_id = ? AND speaker_id IS NOT NULL'
      ).all(id) as { speaker_id: number }[];
      if (spkIds.length > 0) {
        const ph = spkIds.map(() => '?').join(',');
        const ids = spkIds.map(s => s.speaker_id);
        this.db.prepare(
          `DELETE FROM speaker_match_suggestions WHERE new_speaker_id IN (${ph}) OR existing_speaker_id IN (${ph})`
        ).run(...ids, ...ids);
      }
      // Delete segments
      this.db.prepare('DELETE FROM segments WHERE recording_id = ?').run(id);
      // Delete meeting notes
      try {
        this.db.prepare('DELETE FROM meeting_notes WHERE recording_id = ?').run(id);
      } catch { /* Table might not exist */ }
      // Delete person relationships for this recording
      try {
        this.db.prepare('DELETE FROM person_relationships WHERE recording_id = ?').run(id);
      } catch { /* Table might not exist */ }
    });
    tx();
  }

  deleteRecording(id: number): void {
    const tx = transaction(this.db, () => {
      const rec = this.db.prepare('SELECT file_path FROM recordings WHERE id = ?')
        .get(id) as { file_path?: string } | undefined;

      // Delete recording-scoped queue/projection data first. Some tables were
      // created before ON DELETE CASCADE was consistently used, so be explicit.
      try { this.db.prepare('DELETE FROM task_queue WHERE recording_id = ? OR file_path = ?').run(id, rec?.file_path ?? ''); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM compilation_queue WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM meeting_notes WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM speaker_match_suggestions WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM speaker_relationships WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM person_match_suggestions WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM person_relationships WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }
      try { this.db.prepare('DELETE FROM recording_chat_messages WHERE recording_id = ?').run(id); } catch { /* table may not exist */ }

      // Delete extracted items linked to segments of this recording
      this.db.prepare(`
        DELETE FROM extracted_items WHERE segment_id IN (
          SELECT id FROM segments WHERE recording_id = ?
        )
      `).run(id);
      // Delete content-person links linked to segments of this recording
      this.db.prepare(`
        DELETE FROM content_person_links WHERE segment_id IN (
          SELECT id FROM segments WHERE recording_id = ?
        )
      `).run(id);
      // Delete FTS entries
      const segIds = this.db.prepare('SELECT id FROM segments WHERE recording_id = ?')
        .all(id) as { id: number }[];
      this.deleteSegmentsFtsRows(segIds.map(s => s.id));
      // Delete segments
      this.db.prepare('DELETE FROM segments WHERE recording_id = ?').run(id);
      // Delete recording
      this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    });
    tx();
  }

  clearAllData(): void {
    this.db.exec(`
      DELETE FROM speaker_match_suggestions;
      DELETE FROM extracted_items;
      DELETE FROM segments_fts;
      DELETE FROM segments;
      DELETE FROM speakers;
      DELETE FROM recording_chat_messages;
      DELETE FROM recordings;
      DELETE FROM daily_summaries;
      DELETE FROM weekly_summaries;
      DELETE FROM monthly_summaries;
      DELETE FROM chat_messages;
      DELETE FROM chat_sessions;
    `);
  }

  // ─── Segments ────────────────────────────────────────────────

  insertSegment(data: SegmentData): number {
    const insertStmt = this.db.prepare(`
      INSERT INTO segments (recording_id, speaker_id, start_time, end_time, raw_text, clean_text, source, speaker_label)
      VALUES (@recording_id, @speaker_id, @start_time, @end_time, @raw_text, @clean_text, @source, @speaker_label)
    `);

    const ftsStmt = this.db.prepare(`
      INSERT INTO segments_fts (rowid, raw_text, clean_text)
      VALUES (@rowid, @raw_text, @clean_text)
    `);

    const insertAndIndex = transaction(this.db, (d: SegmentData) => {
      const result = insertStmt.run({
        recording_id: d.recording_id,
        speaker_id: d.speaker_id ?? null,
        start_time: d.start_time ?? null,
        end_time: d.end_time ?? null,
        raw_text: d.raw_text ?? null,
        clean_text: d.clean_text ?? null,
        source: d.source ?? 'mic',
        speaker_label: d.speaker_label ?? null,
      });
      const newId = result.lastInsertRowid as number;

      // Update FTS index
      ftsStmt.run({
        rowid: newId,
        raw_text: d.raw_text ?? null,
        clean_text: d.clean_text ?? null,
      });

      return newId;
    });

    // Retry on SQLITE_BUSY_SNAPSHOT (WAL conflict with concurrent writer)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return insertAndIndex(data);
      } catch (err: any) {
        if (err.code === 'SQLITE_BUSY_SNAPSHOT' && attempt < 2) {
          continue; // retry immediately — transaction restarts with fresh snapshot
        }
        throw err;
      }
    }
    return insertAndIndex(data); // unreachable, satisfies TS
  }

  getSegment(id: number): SegmentWithSpeaker | undefined {
    return this.db
      .prepare(
        `SELECT s.*, COALESCE(p.name, s.speaker_label, sp.name) AS speaker_name
         FROM segments s
         LEFT JOIN persons p ON s.primary_person_id = p.id
         LEFT JOIN speakers sp ON s.speaker_id = sp.id
         WHERE s.id = ?`
      )
      .get(id) as SegmentWithSpeaker | undefined;
  }

  getSegmentIdsByRecording(recordingId: number): number[] {
    return (this.db.prepare('SELECT id FROM segments WHERE recording_id = ?')
      .all(recordingId) as { id: number }[]).map(r => r.id);
  }

  getSegmentsByRecording(recordingId: number): SegmentWithSpeaker[] {
    return this.db
      .prepare(
        `SELECT s.*, COALESCE(p.name, s.speaker_label, sp.name) AS speaker_name
         FROM segments s
         LEFT JOIN persons p ON s.primary_person_id = p.id
         LEFT JOIN speakers sp ON s.speaker_id = sp.id
         WHERE s.recording_id = ?
         ORDER BY s.start_time`
      )
      .all(recordingId) as SegmentWithSpeaker[];
  }

  searchSegments(query: string): SegmentSearchResult[] {
    return this.db
      .prepare(
        `SELECT s.*, COALESCE(p.name, s.speaker_label, sp.name) AS speaker_name, r.file_name AS recording_name
         FROM segments_fts fts
         JOIN segments s ON s.id = fts.rowid
         LEFT JOIN persons p ON s.primary_person_id = p.id
         LEFT JOIN speakers sp ON s.speaker_id = sp.id
         LEFT JOIN recordings r ON s.recording_id = r.id
         WHERE segments_fts MATCH ?
         ORDER BY rank
         LIMIT 50`
      )
      .all(query) as SegmentSearchResult[];
  }

  /** Bulk-assign speaker to all segments of a recording from a specific source */
  updateSegmentsSpeaker(recordingId: number, source: string, speakerId: number): void {
    this.db.prepare(
      'UPDATE segments SET speaker_id = ? WHERE recording_id = ? AND source = ?'
    ).run(speakerId, recordingId, source);
  }

  /** Get or create a speaker by name, returns speaker id */
  getOrCreateSpeaker(name: string): number {
    const existing = this.db.prepare('SELECT id FROM speakers WHERE name = ?').get(name) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = this.db.prepare('INSERT INTO speakers (name) VALUES (?)').run(name);
    return result.lastInsertRowid as number;
  }

  // ─── Extracted Items ─────────────────────────────────────────

  insertExtractedItem(data: ExtractedItemData): number {
    const stmt = this.db.prepare(`
      INSERT INTO extracted_items (segment_id, type, content, due_date, related_person, status, source, priority, assignee)
      VALUES (@segment_id, @type, @content, @due_date, @related_person, @status, @source, @priority, @assignee)
    `);
    const result = stmt.run({
      segment_id: data.segment_id ?? null,
      type: data.type,
      content: data.content,
      due_date: data.due_date ?? null,
      related_person: data.related_person ?? null,
      status: data.status ?? 'active',
      source: data.source ?? 'pipeline',
      priority: data.priority ?? 'normal',
      assignee: data.assignee ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getExtractedItemsByType(type: string, limit?: number): ExtractedItemRow[] {
    if (limit != null) {
      return this.db
        .prepare('SELECT * FROM extracted_items WHERE type = ? ORDER BY id DESC LIMIT ?')
        .all(type, limit) as ExtractedItemRow[];
    }
    return this.db
      .prepare('SELECT * FROM extracted_items WHERE type = ? ORDER BY id DESC')
      .all(type) as ExtractedItemRow[];
  }

  getActiveExtractedItems(): ExtractedItemRow[] {
    return this.db
      .prepare("SELECT * FROM extracted_items WHERE status = 'active'")
      .all() as ExtractedItemRow[];
  }

  getExtractedItemsByRecording(recordingId: number): ExtractedItemRow[] {
    return this.db
      .prepare(`
        SELECT ei.* FROM extracted_items ei
        JOIN segments s ON ei.segment_id = s.id
        WHERE s.recording_id = ?
        ORDER BY ei.id
      `)
      .all(recordingId) as ExtractedItemRow[];
  }

  updateExtractedItemStatus(id: number, status: string): void {
    this.db.prepare('UPDATE extracted_items SET status = ? WHERE id = ?').run(status, id);
  }

  getPendingReminders(): any[] {
    return this.db.prepare(`
      SELECT ei.*, s.recording_id
      FROM extracted_items ei
      LEFT JOIN segments s ON ei.segment_id = s.id
      WHERE ei.type = 'todo' AND ei.status = 'active'
      AND ei.reminder_sent = 0
      AND ei.due_date IS NOT NULL
      AND ei.due_date <= DATE('now', '+1 day')
      ORDER BY ei.due_date
    `).all();
  }

  getOverdueTodos(): any[] {
    return this.db.prepare(`
      SELECT ei.*, s.recording_id
      FROM extracted_items ei
      LEFT JOIN segments s ON ei.segment_id = s.id
      WHERE ei.type = 'todo' AND ei.status = 'active'
      AND ei.due_date IS NOT NULL AND ei.due_date < DATE('now')
      ORDER BY ei.due_date
    `).all();
  }

  markReminderSent(id: number): void {
    this.db.prepare('UPDATE extracted_items SET reminder_sent = 1 WHERE id = ?').run(id);
  }

  /** Get todos/reminders whose remind_at has arrived and haven't been sent yet */
  getActiveReminders(): any[] {
    return this.db.prepare(`
      SELECT ei.*, s.recording_id
      FROM extracted_items ei
      LEFT JOIN segments s ON ei.segment_id = s.id
      WHERE ei.status = 'active'
      AND ei.reminder_sent = 0
      AND ei.remind_at IS NOT NULL
      AND datetime(ei.remind_at) <= datetime('now')
      ORDER BY ei.remind_at
    `).all();
  }

  getAllExtractedItems(): (ExtractedItemRow & { recording_id: number | null })[] {
    return this.db
      .prepare(`
        SELECT ei.*, s.recording_id
        FROM extracted_items ei
        LEFT JOIN segments s ON ei.segment_id = s.id
        ORDER BY ei.id DESC
      `)
      .all() as (ExtractedItemRow & { recording_id: number | null })[];
  }

  updateExtractedItem(id: number, data: { content?: string; due_date?: string; related_person?: string; status?: string; type?: string; priority?: string; assignee?: string; remind_at?: string }): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (data.content !== undefined) { fields.push('content = ?'); values.push(data.content); }
    if (data.due_date !== undefined) { fields.push('due_date = ?'); values.push(data.due_date || null); }
    if (data.related_person !== undefined) { fields.push('related_person = ?'); values.push(data.related_person || null); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
    if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority); }
    if (data.assignee !== undefined) { fields.push('assignee = ?'); values.push(data.assignee || null); }
    if (data.remind_at !== undefined) { fields.push('remind_at = ?'); values.push(data.remind_at || null); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE extracted_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteExtractedItem(id: number): void {
    this.db.prepare('DELETE FROM extracted_items WHERE id = ?').run(id);
  }

  // ─── Daily Summaries ─────────────────────────────────────────

  insertDailySummary(data: DailySummaryData): number {
    const stmt = this.db.prepare(`
      INSERT INTO daily_summaries (date, summary_text, timeline_json, key_events_json)
      VALUES (@date, @summary_text, @timeline_json, @key_events_json)
    `);
    const result = stmt.run({
      date: data.date,
      summary_text: data.summary_text ?? null,
      timeline_json: data.timeline_json ?? null,
      key_events_json: data.key_events_json ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getDailySummary(date: string): DailySummaryRow | undefined {
    return this.db
      .prepare('SELECT * FROM daily_summaries WHERE date = ?')
      .get(date) as DailySummaryRow | undefined;
  }

  // ─── Segments by Date ───────────────────────────────────────

  getSegmentsByDate(date: string, limit?: number): SegmentSearchResult[] {
    const sql = `
      SELECT s.*, COALESCE(p.name, s.speaker_label, sp.name) AS speaker_name, r.file_name AS recording_name
      FROM segments s
      JOIN recordings r ON s.recording_id = r.id
      LEFT JOIN persons p ON s.primary_person_id = p.id
      LEFT JOIN speakers sp ON s.speaker_id = sp.id
      WHERE DATE(r.recorded_at, 'localtime') = ? OR (r.recorded_at IS NULL AND DATE(r.processed_at, 'localtime') = ?)
      ORDER BY s.start_time
      ${limit ? 'LIMIT ?' : ''}
    `;
    const params: any[] = [date, date];
    if (limit) params.push(limit);
    return this.db.prepare(sql).all(...params) as SegmentSearchResult[];
  }

  // ─── Text Notes ──────────────────────────────────────────────

  insertTextNote(data: TextNoteData): number {
    const result = this.db.prepare(`
      INSERT INTO text_notes (channel_id, user_id, user_name, content, agent_reply)
      VALUES (@channel_id, @user_id, @user_name, @content, @agent_reply)
    `).run({
      channel_id: data.channel_id,
      user_id: data.user_id,
      user_name: data.user_name ?? null,
      content: data.content,
      agent_reply: data.agent_reply ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getTextNoteById(id: number): TextNoteRow | undefined {
    return this.db.prepare('SELECT * FROM text_notes WHERE id = ?').get(id) as TextNoteRow | undefined;
  }

  getTextNotes(limit = 100): TextNoteRow[] {
    return this.db.prepare(
      'SELECT * FROM text_notes ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as TextNoteRow[];
  }

  getTextNotesByDate(date: string): TextNoteRow[] {
    return this.db.prepare(
      "SELECT * FROM text_notes WHERE DATE(created_at) = ? ORDER BY created_at"
    ).all(date) as TextNoteRow[];
  }

  updateSegmentCleanText(id: number, cleanText: string): void {
    this.db.prepare('UPDATE segments SET clean_text = ? WHERE id = ?').run(cleanText, id);
    // Update FTS index
    try {
      this.db.prepare('UPDATE segments_fts SET clean_text = ? WHERE rowid = ?').run(cleanText, id);
    } catch {
      // FTS update may fail if row doesn't exist — ignore
    }
  }

  updateSegmentSpeaker(id: number, speakerId: number): void {
    this.db.prepare('UPDATE segments SET speaker_id = ? WHERE id = ?').run(speakerId, id);
  }

  updateSegmentSentiment(id: number, sentiment: string): void {
    this.db.prepare('UPDATE segments SET sentiment = ? WHERE id = ?').run(sentiment, id);
  }

  // ─── Daily Summaries (extended) ────────────────────────────

  getDailySummariesInRange(startDate: string, endDate: string): DailySummaryRow[] {
    return this.db.prepare(
      'SELECT * FROM daily_summaries WHERE date >= ? AND date <= ? ORDER BY date'
    ).all(startDate, endDate) as DailySummaryRow[];
  }

  upsertDailySummary(data: DailySummaryData): number {
    const stmt = this.db.prepare(`
      INSERT INTO daily_summaries (date, summary_text, timeline_json, key_events_json)
      VALUES (@date, @summary_text, @timeline_json, @key_events_json)
      ON CONFLICT(date) DO UPDATE SET
        summary_text = excluded.summary_text,
        timeline_json = excluded.timeline_json,
        key_events_json = excluded.key_events_json
    `);
    const result = stmt.run({
      date: data.date,
      summary_text: data.summary_text ?? null,
      timeline_json: data.timeline_json ?? null,
      key_events_json: data.key_events_json ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getAllDailySummaries(): DailySummaryRow[] {
    return this.db.prepare('SELECT * FROM daily_summaries ORDER BY date DESC').all() as DailySummaryRow[];
  }

  deleteDailySummary(date: string): void {
    this.db.prepare('DELETE FROM daily_summaries WHERE date = ?').run(date);
  }

  updateDailySummaryKeyEvents(date: string, keyEventsJson: string): void {
    this.db.prepare('UPDATE daily_summaries SET key_events_json = ? WHERE date = ?').run(keyEventsJson, date);
  }

  // ─── Weekly Summaries ──────────────────────────────────────

  upsertWeeklySummary(startDate: string, endDate: string, summaryJson: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO weekly_summaries (start_date, end_date, summary_json)
      VALUES (?, ?, ?)
      ON CONFLICT(start_date, end_date) DO UPDATE SET summary_json = excluded.summary_json
    `);
    return Number(stmt.run(startDate, endDate, summaryJson).lastInsertRowid);
  }

  getWeeklySummary(startDate: string, endDate: string): WeeklySummaryRow | undefined {
    return this.db.prepare(
      'SELECT * FROM weekly_summaries WHERE start_date = ? AND end_date = ?'
    ).get(startDate, endDate) as WeeklySummaryRow | undefined;
  }

  getAllWeeklySummaries(): WeeklySummaryRow[] {
    return this.db.prepare('SELECT * FROM weekly_summaries ORDER BY start_date DESC').all() as WeeklySummaryRow[];
  }

  deleteWeeklySummary(startDate: string, endDate: string): void {
    this.db.prepare('DELETE FROM weekly_summaries WHERE start_date = ? AND end_date = ?').run(startDate, endDate);
  }

  // ─── Monthly Summaries ─────────────────────────────────────

  upsertMonthlySummary(startDate: string, endDate: string, summaryJson: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO monthly_summaries (start_date, end_date, summary_json)
      VALUES (?, ?, ?)
      ON CONFLICT(start_date, end_date) DO UPDATE SET summary_json = excluded.summary_json
    `);
    return Number(stmt.run(startDate, endDate, summaryJson).lastInsertRowid);
  }

  getMonthlySummary(startDate: string, endDate: string): MonthlySummaryRow | undefined {
    return this.db.prepare(
      'SELECT * FROM monthly_summaries WHERE start_date = ? AND end_date = ?'
    ).get(startDate, endDate) as MonthlySummaryRow | undefined;
  }

  getAllMonthlySummaries(): MonthlySummaryRow[] {
    return this.db.prepare('SELECT * FROM monthly_summaries ORDER BY start_date DESC').all() as MonthlySummaryRow[];
  }

  deleteMonthlySummary(startDate: string, endDate: string): void {
    this.db.prepare('DELETE FROM monthly_summaries WHERE start_date = ? AND end_date = ?').run(startDate, endDate);
  }

  // ─── Pushed Insight Dedup ──────────────────────────────────

  /** Return the set of insight keys pushed within the last `withinHours` hours. */
  getRecentlyPushedInsightKeys(withinHours: number): Set<string> {
    const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString();
    const rows = this.db
      .prepare('SELECT insight_key FROM pushed_insights WHERE pushed_at >= ?')
      .all(cutoff) as { insight_key: string }[];
    return new Set(rows.map((r) => r.insight_key));
  }

  /** Record (or refresh) the push timestamp for the given insight keys. */
  recordPushedInsights(keys: string[]): void {
    if (keys.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO pushed_insights (insight_key, pushed_at)
      VALUES (?, ?)
      ON CONFLICT(insight_key) DO UPDATE SET pushed_at = excluded.pushed_at
    `);
    const tx = transaction(this.db, (ks: string[]) => {
      for (const k of ks) stmt.run(k, now);
    });
    tx(keys);
  }

  /** Drop dedup records older than `olderThanHours` to keep the table small. */
  prunePushedInsights(olderThanHours: number): void {
    const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
    this.db.prepare('DELETE FROM pushed_insights WHERE pushed_at < ?').run(cutoff);
  }

  // ─── Segment Bookmarks ────────────────────────────────────

  toggleSegmentBookmark(id: number): boolean {
    const seg = this.db.prepare('SELECT bookmarked FROM segments WHERE id = ?').get(id) as { bookmarked: number } | undefined;
    const newVal = seg?.bookmarked ? 0 : 1;
    this.db.prepare('UPDATE segments SET bookmarked = ? WHERE id = ?').run(newVal, id);
    return newVal === 1;
  }

  getBookmarkedSegments(): SegmentSearchResult[] {
    return this.db.prepare(`
      SELECT s.*, COALESCE(p.name, s.speaker_label, sp.name) AS speaker_name, r.file_name AS recording_name
      FROM segments s
      LEFT JOIN persons p ON s.primary_person_id = p.id
      LEFT JOIN speakers sp ON s.speaker_id = sp.id
      LEFT JOIN recordings r ON s.recording_id = r.id
      WHERE s.bookmarked = 1
      ORDER BY s.id DESC
      LIMIT 50
    `).all() as SegmentSearchResult[];
  }

  // ─── Dashboard Charts ─────────────────────────────────────

  getRecordingsPerDay(days: number): { date: string; count: number }[] {
    return this.db.prepare(`
      SELECT DATE(COALESCE(recorded_at, processed_at), 'localtime') AS date, COUNT(*) AS count
      FROM recordings
      WHERE DATE(COALESCE(recorded_at, processed_at), 'localtime') >= DATE('now', 'localtime', '-' || ? || ' days')
      GROUP BY date
      ORDER BY date
    `).all(days) as { date: string; count: number }[];
  }

  getSentimentDistribution(): { sentiment: string; count: number }[] {
    return this.db.prepare(`
      SELECT COALESCE(sentiment, 'neutral') AS sentiment, COUNT(*) AS count
      FROM segments
      GROUP BY sentiment
      ORDER BY count DESC
    `).all() as { sentiment: string; count: number }[];
  }

  getTopSpeakers(limit: number): { id: number; name: string; count: number; duration: number }[] {
    return this.db.prepare(`
      SELECT s.id, COALESCE(s.name, 'Speaker ' || s.id) AS name,
        COUNT(seg.id) AS count,
        COALESCE(SUM(seg.end_time - seg.start_time), 0) AS duration
      FROM speakers s
      JOIN segments seg ON seg.speaker_id = s.id
      GROUP BY s.id
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as { id: number; name: string; count: number; duration: number }[];
  }

  getTopPersons(limit: number): { id: number; name: string; count: number; duration: number }[] {
    return this.db.prepare(`
      SELECT p.id, COALESCE(p.name, 'Person ' || p.id) AS name,
        COUNT(DISTINCT cpl.segment_id) AS count,
        COALESCE(SUM(seg.end_time - seg.start_time), 0) AS duration
      FROM persons p
      JOIN content_person_links cpl ON cpl.person_id = p.id
      JOIN segments seg ON seg.id = cpl.segment_id
      GROUP BY p.id
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as { id: number; name: string; count: number; duration: number }[];
  }

  // ─── Speaker Co-occurrences ────────────────────────────────

  getSpeakerCoOccurrences(): SpeakerCoOccurrence[] {
    return this.db.prepare(`
      SELECT
        COALESCE(s1.primary_person_id, s1.speaker_id) AS speaker1_id,
        COALESCE(p1.name, sp1.name) AS speaker1_name,
        COALESCE(s2.primary_person_id, s2.speaker_id) AS speaker2_id,
        COALESCE(p2.name, sp2.name) AS speaker2_name,
        COUNT(DISTINCT s1.recording_id) AS shared_recordings
      FROM segments s1
      JOIN segments s2 ON s1.recording_id = s2.recording_id
        AND COALESCE(s1.primary_person_id, s1.speaker_id) < COALESCE(s2.primary_person_id, s2.speaker_id)
      LEFT JOIN persons p1 ON s1.primary_person_id = p1.id
      LEFT JOIN speakers sp1 ON s1.speaker_id = sp1.id
      LEFT JOIN persons p2 ON s2.primary_person_id = p2.id
      LEFT JOIN speakers sp2 ON s2.speaker_id = sp2.id
      WHERE COALESCE(s1.primary_person_id, s1.speaker_id) IS NOT NULL
        AND COALESCE(s2.primary_person_id, s2.speaker_id) IS NOT NULL
      GROUP BY speaker1_id, speaker2_id
      ORDER BY shared_recordings DESC
    `).all() as SpeakerCoOccurrence[];
  }

  // ─── Chat Sessions ─────────────────────────────────────────

  createSession(title?: string): number {
    const result = this.db.prepare(
      'INSERT INTO chat_sessions (title) VALUES (?)'
    ).run(title || '新对话');
    return Number(result.lastInsertRowid);
  }

  getAllSessions(): ChatSessionRow[] {
    return this.db.prepare(
      'SELECT * FROM chat_sessions ORDER BY updated_at DESC'
    ).all() as ChatSessionRow[];
  }

  renameSession(id: number, title: string): void {
    this.db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
  }

  deleteSession(id: number): void {
    const tx = transaction(this.db, () => {
      this.db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    });
    tx();
  }

  // ─── Chat Messages ──────────────────────────────────────────

  saveChatMessage(sessionId: number, role: string, content: string, sourcesJson?: string): number {
    const result = this.db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, sources_json) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, content, sourcesJson || null);
    // Update session's updated_at
    this.db.prepare(
      'UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(sessionId);
    return Number(result.lastInsertRowid);
  }

  getSessionMessages(sessionId: number): ChatMessageRow[] {
    return this.db.prepare(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId) as ChatMessageRow[];
  }

  clearSessionMessages(sessionId: number): void {
    this.db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
  }

  deleteSessionMessage(messageId: number): void {
    this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
  }

  // ─── Per-recording Chat (Library Q&A) ───────────────────────

  saveRecordingChatMessage(
    recordingId: number,
    role: 'user' | 'assistant',
    content: string,
    sourcesJson?: string,
  ): number {
    const result = this.db.prepare(
      'INSERT INTO recording_chat_messages (recording_id, role, content, sources_json) VALUES (?, ?, ?, ?)'
    ).run(recordingId, role, content, sourcesJson || null);
    return Number(result.lastInsertRowid);
  }

  getRecordingChatMessages(recordingId: number): RecordingChatMessageRow[] {
    return this.db.prepare(
      'SELECT * FROM recording_chat_messages WHERE recording_id = ? ORDER BY id ASC'
    ).all(recordingId) as RecordingChatMessageRow[];
  }

  clearRecordingChatMessages(recordingId: number): void {
    this.db.prepare('DELETE FROM recording_chat_messages WHERE recording_id = ?').run(recordingId);
  }

  deleteRecordingChatMessage(messageId: number): void {
    this.db.prepare('DELETE FROM recording_chat_messages WHERE id = ?').run(messageId);
  }

  // ─── Channel Sessions (read-only for UI) ────────────────────

  getAllChannelSessions(): ChannelSessionRow[] {
    return this.db.prepare(
      'SELECT * FROM channel_sessions ORDER BY COALESCE(ended_at, started_at) DESC'
    ).all() as ChannelSessionRow[];
  }

  getChannelSessionMessages(sessionId: number): ChannelMessageRow[] {
    return this.db.prepare(
      'SELECT * FROM channel_messages WHERE session_id = ? ORDER BY timestamp ASC'
    ).all(sessionId) as ChannelMessageRow[];
  }

  getChannelSessionTitle(sessionId: number): string {
    // 1. Try summary
    const session = this.db.prepare(
      'SELECT summary, user_id, channel_id FROM channel_sessions WHERE id = ?'
    ).get(sessionId) as { summary: string | null; user_id: string; channel_id: string } | undefined;
    if (!session) return '';
    if (session.summary) return session.summary.slice(0, 30);

    // 2. Try first user message
    const firstMsg = this.db.prepare(
      "SELECT content FROM channel_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1"
    ).get(sessionId) as { content: string } | undefined;
    if (firstMsg?.content) return firstMsg.content.slice(0, 30);

    // 3. Fallback
    return `${session.user_id} · ${session.channel_id}`;
  }

  // ─── Agent Memory ──────────────────────────────────────────

  insertMemory(entry: {
    fact: string;
    category: string;
    layer: 'core' | 'active' | 'archive';
    confidence: number;
    sourceIds: number[];
  }): number {
    const now = formatLocalDate();
    const result = this.db.prepare(`
      INSERT INTO agent_memory (fact, category, layer, confidence, first_seen, last_seen, source_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entry.fact, entry.category, entry.layer, entry.confidence, now, now, JSON.stringify(entry.sourceIds));
    return Number(result.lastInsertRowid);
  }

  getActiveMemories(limit: number = 500): any[] {
    return this.db.prepare(`
      SELECT * FROM agent_memory
      WHERE layer IN ('core', 'active') AND superseded_by IS NULL
      ORDER BY CASE layer WHEN 'core' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, confidence DESC, last_seen DESC
      LIMIT ?
    `).all(limit);
  }

  getMemoriesByLayer(layer: string): any[] {
    return this.db.prepare(
      'SELECT * FROM agent_memory WHERE layer = ? AND superseded_by IS NULL ORDER BY confidence DESC'
    ).all(layer);
  }

  getAllMemories(): any[] {
    return this.db.prepare(
      "SELECT * FROM agent_memory WHERE superseded_by IS NULL ORDER BY CASE layer WHEN 'core' THEN 0 WHEN 'active' THEN 1 WHEN 'archive' THEN 2 ELSE 3 END, confidence DESC"
    ).all();
  }

  updateMemoryLastSeen(id: number): void {
    const now = formatLocalDate();
    this.db.prepare(
      'UPDATE agent_memory SET last_seen = ?, mention_count = mention_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(now, id);
  }

  updateMemoryFact(id: number, fact: string): void {
    this.db.prepare(
      'UPDATE agent_memory SET fact = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(fact, id);
  }

  supersedeMemory(oldId: number, newId: number): void {
    this.db.prepare(
      "UPDATE agent_memory SET superseded_by = ?, layer = 'archive', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newId, oldId);
  }

  promoteMemory(id: number, layer: 'core' | 'active' | 'archive'): void {
    this.db.prepare(
      'UPDATE agent_memory SET layer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(layer, id);
  }

  updateMemoryEmbedding(id: number, embedding: Buffer): void {
    this.db.prepare(
      'UPDATE agent_memory SET embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(embedding, id);
  }

  deleteMemory(id: number): void {
    this.db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id);
  }

  getMemoryStats(): { core: number; active: number; archive: number } {
    const rows = this.db.prepare(`
      SELECT layer, COUNT(*) as count FROM agent_memory WHERE superseded_by IS NULL GROUP BY layer
    `).all() as { layer: string; count: number }[];
    const stats = { core: 0, active: 0, archive: 0 };
    for (const r of rows) {
      if (r.layer in stats) (stats as any)[r.layer] = r.count;
    }
    return stats;
  }

  searchMemoriesFts(query: string, limit: number = 20): Array<{ id: number; fact: string; rank: number }> {
    if (!query || query.trim().length === 0) return [];
    const q = query.trim();
    // FTS5 trigram tokenizer needs >=3 bytes to match; CJK chars are 3 bytes each
    // so single CJK char or 2-char CJK queries may miss. Use LIKE fallback for short queries.
    try {
      const ftsResults = this.db.prepare(`
        SELECT am.id, am.fact, fts.rank
        FROM agent_memory_fts fts
        JOIN agent_memory am ON am.id = fts.rowid
        WHERE agent_memory_fts MATCH ?
          AND am.superseded_by IS NULL
          AND am.layer IN ('core', 'active')
        ORDER BY fts.rank
        LIMIT ?
      `).all(q, limit) as any[];
      if (ftsResults.length > 0) return ftsResults;
    } catch {
      // FTS5 query syntax error or table not available — fall through to LIKE
    }
    // Fallback: LIKE-based search for short CJK queries or FTS5 failures
    try {
      return this.db.prepare(`
        SELECT id, fact, 0 as rank
        FROM agent_memory
        WHERE fact LIKE ?
          AND superseded_by IS NULL
          AND layer IN ('core', 'active')
        ORDER BY confidence DESC, last_seen DESC
        LIMIT ?
      `).all(`%${q}%`, limit) as any[];
    } catch {
      return [];
    }
  }

  // ─── Memory Documents ──────────────────────────────────

  getMemoryDocument(date: string): { id: number; date: string; content: string; auto_generated: number; updated_at: string } | undefined {
    return this.db.prepare(
      'SELECT id, date, content, auto_generated, updated_at FROM memory_documents WHERE date = ?'
    ).get(date) as any;
  }

  getMemoryDocumentDates(): { date: string; has_recordings: boolean; recording_count: number }[] {
    return this.db.prepare(`
      SELECT md.date,
        COUNT(DISTINCT r.id) AS recording_count,
        CASE WHEN COUNT(r.id) > 0 THEN 1 ELSE 0 END AS has_recordings
      FROM memory_documents md
      LEFT JOIN recordings r ON DATE(COALESCE(r.recorded_at, r.processed_at), 'localtime') = md.date
      GROUP BY md.date
      ORDER BY md.date DESC
    `).all() as any[];
  }

  saveMemoryDocument(date: string, content: string, autoGenerated: boolean = false): void {
    this.db.prepare(`
      INSERT INTO memory_documents (date, content, auto_generated, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(date) DO UPDATE SET
        content = excluded.content,
        auto_generated = excluded.auto_generated,
        updated_at = CURRENT_TIMESTAMP
    `).run(date, content, autoGenerated ? 1 : 0);
  }

  getDatesWithRecordings(days: number): { date: string; recording_count: number }[] {
    return this.db.prepare(`
      SELECT DATE(COALESCE(recorded_at, processed_at), 'localtime') AS date,
        COUNT(*) AS recording_count
      FROM recordings
      WHERE DATE(COALESCE(recorded_at, processed_at), 'localtime') >= DATE('now', 'localtime', '-' || ? || ' days')
      GROUP BY date
      ORDER BY date DESC
    `).all(days) as any[];
  }

  getRecordingsByDate(date: string): any[] {
    return this.db.prepare(`
      SELECT r.*,
        COUNT(DISTINCT COALESCE(s.primary_person_id, s.speaker_id)) AS speaker_count,
        GROUP_CONCAT(COALESCE(s.clean_text, s.raw_text), ' ') AS combined_text
      FROM recordings r
      LEFT JOIN segments s ON s.recording_id = r.id
      WHERE DATE(COALESCE(r.recorded_at, r.processed_at), 'localtime') = ?
      GROUP BY r.id
      ORDER BY r.recorded_at
    `).all(date);
  }

  getExtractedItemsByDate(date: string): any[] {
    return this.db.prepare(`
      SELECT ei.*
      FROM extracted_items ei
      JOIN segments s ON ei.segment_id = s.id
      JOIN recordings r ON s.recording_id = r.id
      WHERE DATE(COALESCE(r.recorded_at, r.processed_at), 'localtime') = ?
    `).all(date);
  }

  // ─── Scheduled Tasks ──────────────────────────────────────

  insertScheduledTask(task: {
    name: string;
    description?: string;
    task_type: string;
    action: string;
    action_params?: string;
    schedule_type: string;
    schedule_expr?: string;
    schedule_display?: string;
    is_recurring?: boolean;
    permission_level?: string;
    allowed_tools?: string;
    channels_override?: string;
    missed_policy?: string;
    max_miss_hours?: number;
    max_retries?: number;
    created_by?: string;
    next_run_at?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO scheduled_tasks
        (name, description, task_type, action, action_params,
         schedule_type, schedule_expr, schedule_display, is_recurring,
         permission_level, allowed_tools, channels_override,
         missed_policy, max_miss_hours, max_retries, created_by, next_run_at)
      VALUES
        (@name, @description, @task_type, @action, @action_params,
         @schedule_type, @schedule_expr, @schedule_display, @is_recurring,
         @permission_level, @allowed_tools, @channels_override,
         @missed_policy, @max_miss_hours, @max_retries, @created_by, @next_run_at)
    `).run({
      name: task.name,
      description: task.description ?? null,
      task_type: task.task_type,
      action: task.action,
      action_params: task.action_params ?? null,
      schedule_type: task.schedule_type,
      schedule_expr: task.schedule_expr ?? null,
      schedule_display: task.schedule_display ?? null,
      is_recurring: task.is_recurring === false ? 0 : 1,
      permission_level: task.permission_level ?? 'readonly',
      allowed_tools: task.allowed_tools ?? null,
      channels_override: task.channels_override ?? null,
      missed_policy: task.missed_policy ?? 'catch_up_latest',
      max_miss_hours: task.max_miss_hours ?? 24,
      max_retries: task.max_retries ?? 1,
      created_by: task.created_by ?? 'user',
      next_run_at: task.next_run_at ?? null,
    });
    return result.lastInsertRowid as number;
  }

  updateScheduledTask(id: number, updates: Record<string, any>): void {
    const ALLOWED_COLUMNS = new Set([
      'name', 'description', 'task_type', 'action', 'action_params',
      'schedule_type', 'schedule_expr', 'schedule_display', 'is_recurring',
      'status', 'next_run_at', 'last_run_at', 'last_run_status', 'last_run_result',
      'run_count', 'fail_count', 'permission_level', 'allowed_tools',
      'channels_override', 'missed_policy', 'max_miss_hours', 'max_retries',
      'retry_count', 'created_by',
    ]);
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_COLUMNS.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(
      `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);
  }

  deleteScheduledTask(id: number): void {
    const tx = transaction(this.db, () => {
      this.db.prepare('DELETE FROM task_executions WHERE task_id = ?').run(id);
      this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    });
    tx();
  }

  getScheduledTask(id: number): any | undefined {
    return this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  }

  listScheduledTasks(filter?: { status?: string }): any[] {
    if (filter?.status && filter.status !== 'all') {
      return this.db.prepare(
        'SELECT * FROM scheduled_tasks WHERE status = ? ORDER BY status, next_run_at'
      ).all(filter.status);
    }
    return this.db.prepare(
      'SELECT * FROM scheduled_tasks ORDER BY status, next_run_at'
    ).all();
  }

  getDueScheduledTasks(): any[] {
    return this.db.prepare(
      "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime('now') ORDER BY next_run_at"
    ).all();
  }

  insertTaskExecution(exec: {
    task_id: number;
    started_at: string;
    status: string;
    finished_at?: string;
    result_summary?: string;
    error_message?: string;
    channels_notified?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO task_executions (task_id, started_at, status, finished_at, result_summary, error_message, channels_notified)
      VALUES (@task_id, @started_at, @status, @finished_at, @result_summary, @error_message, @channels_notified)
    `).run({
      task_id: exec.task_id,
      started_at: exec.started_at,
      status: exec.status,
      finished_at: exec.finished_at ?? null,
      result_summary: exec.result_summary ?? null,
      error_message: exec.error_message ?? null,
      channels_notified: exec.channels_notified ?? null,
    });
    return result.lastInsertRowid as number;
  }

  updateTaskExecution(id: number, updates: Record<string, any>): void {
    const ALLOWED_COLUMNS = new Set([
      'started_at', 'finished_at', 'status', 'result_summary',
      'error_message', 'channels_notified',
    ]);
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_COLUMNS.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(
      `UPDATE task_executions SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);
  }

  getTaskExecutions(taskId: number, limit: number = 20): any[] {
    return this.db.prepare(
      'SELECT * FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(taskId, limit);
  }

  // ─── Person Identifiers ──────────────────────────────────────

  insertPersonIdentifier(data: {
    person_id: number;
    type: string;
    value?: string;
    blob_value?: Buffer;
    model?: string;
    source?: string;
    confidence?: number;
  }): number {
    const result = this.db.prepare(`
      INSERT OR REPLACE INTO person_identifiers (person_id, type, value, blob_value, model, source, confidence)
      VALUES (@person_id, @type, @value, @blob_value, @model, @source, @confidence)
    `).run({
      person_id: data.person_id,
      type: data.type,
      value: data.value ?? `${data.type}:${data.person_id}`,
      blob_value: data.blob_value ?? null,
      model: data.model ?? null,
      source: data.source ?? 'manual',
      confidence: data.confidence ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getPersonIdentifiers(personId: number): PersonIdentifierRow[] {
    return this.db.prepare(
      'SELECT * FROM person_identifiers WHERE person_id = ? ORDER BY type, created_at'
    ).all(personId) as PersonIdentifierRow[];
  }

  findPersonByIdentifier(type: string, value: string): PersonRow | undefined {
    return this.db.prepare(`
      SELECT p.*
      FROM persons p
      JOIN person_identifiers pi ON pi.person_id = p.id
      WHERE pi.type = ? AND pi.value = ?
      LIMIT 1
    `).get(type, value) as PersonRow | undefined;
  }

  deletePersonIdentifier(id: number): void {
    this.db.prepare('DELETE FROM person_identifiers WHERE id = ?').run(id);
  }

  // ─── Content-Person Links ──────────────────────────────────

  insertContentPersonLink(data: {
    segment_id: number;
    person_id: number;
    role: string;
    confidence?: number;
    source?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO content_person_links (segment_id, person_id, role, confidence, source)
      VALUES (@segment_id, @person_id, @role, @confidence, @source)
    `).run({
      segment_id: data.segment_id,
      person_id: data.person_id,
      role: data.role,
      confidence: data.confidence ?? 1.0,
      source: data.source ?? 'manual',
    });
    return result.lastInsertRowid as number;
  }

  getContentByPerson(personId: number, limit: number = 20): {
    segment_id: number; role: string; raw_text: string; clean_text: string | null;
    start_time: number | null; end_time: number | null;
    recording_id: number; file_name: string; media_type: string;
  }[] {
    return this.db.prepare(`
      SELECT cpl.segment_id, cpl.role,
        s.raw_text, s.clean_text, s.start_time, s.end_time,
        s.recording_id, r.file_name,
        COALESCE(r.media_type, 'audio') AS media_type
      FROM content_person_links cpl
      JOIN segments s ON s.id = cpl.segment_id
      JOIN recordings r ON r.id = s.recording_id
      WHERE cpl.person_id = ?
      ORDER BY s.id DESC
      LIMIT ?
    `).all(personId, limit) as any[];
  }

  getPersonsForSegment(segmentId: number): (ContentPersonLinkRow & { person_name: string | null })[] {
    return this.db.prepare(`
      SELECT cpl.*, p.name AS person_name
      FROM content_person_links cpl
      JOIN persons p ON p.id = cpl.person_id
      WHERE cpl.segment_id = ?
      ORDER BY cpl.confidence DESC
    `).all(segmentId) as (ContentPersonLinkRow & { person_name: string | null })[];
  }








  // ─── Person Merge ──────────────────────────────────────────

  mergePersons(fromId: number, toId: number): void {
    const tx = transaction(this.db, () => {
      // 1. Move content_person_links: fromId → toId (ignore duplicates)
      this.db.prepare(
        'UPDATE OR IGNORE content_person_links SET person_id = ? WHERE person_id = ?'
      ).run(toId, fromId);
      this.db.prepare(
        'DELETE FROM content_person_links WHERE person_id = ?'
      ).run(fromId);

      // 2. Move non-voiceprint person_identifiers: fromId → toId (skip voiceprints)
      this.db.prepare(
        "UPDATE OR IGNORE person_identifiers SET person_id = ? WHERE person_id = ? AND type != 'voiceprint'"
      ).run(toId, fromId);
      this.db.prepare(
        'DELETE FROM person_identifiers WHERE person_id = ?'
      ).run(fromId);

      // 3. Move person_relationships: fromId → toId (both sides)
      this.db.prepare(
        'UPDATE OR IGNORE person_relationships SET person_id = ? WHERE person_id = ?'
      ).run(toId, fromId);
      this.db.prepare(
        'DELETE FROM person_relationships WHERE person_id = ?'
      ).run(fromId);
      // Also update related_person_id references
      this.db.prepare(
        'UPDATE person_relationships SET related_person_id = ? WHERE related_person_id = ?'
      ).run(toId, fromId);

      // 4. Move segments.primary_person_id: fromId → toId
      this.db.prepare(
        'UPDATE segments SET primary_person_id = ? WHERE primary_person_id = ?'
      ).run(toId, fromId);

      // 5. Append profile_markdown from source to target (with separator)
      const fromPerson = this.db.prepare('SELECT profile_markdown FROM persons WHERE id = ?').get(fromId) as { profile_markdown: string | null } | undefined;
      const toPerson = this.db.prepare('SELECT profile_markdown FROM persons WHERE id = ?').get(toId) as { profile_markdown: string | null } | undefined;
      if (fromPerson?.profile_markdown) {
        const combined = toPerson?.profile_markdown
          ? `${toPerson.profile_markdown}\n\n---\n\n${fromPerson.profile_markdown}`
          : fromPerson.profile_markdown;
        this.db.prepare(
          "UPDATE persons SET profile_markdown = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(combined, toId);
      }

      // 6. Clean up match suggestions referencing fromId
      this.db.prepare(
        'DELETE FROM person_match_suggestions WHERE new_person_id = ? OR existing_person_id = ?'
      ).run(fromId, fromId);

      // 7. Delete the source person
      this.db.prepare('DELETE FROM persons WHERE id = ?').run(fromId);
    });
    tx();
  }

  // ─── Person Relationships & Co-occurrence ──────────────────

  getPersonRelationships(personId: number): PersonRelationshipRow[] {
    return this.db.prepare(`
      SELECT pr.*,
        p1.name AS person_name,
        p2.name AS related_person_name
      FROM person_relationships pr
      LEFT JOIN persons p1 ON pr.person_id = p1.id
      LEFT JOIN persons p2 ON pr.related_person_id = p2.id
      WHERE pr.person_id = ?
      ORDER BY pr.created_at DESC
    `).all(personId) as PersonRelationshipRow[];
  }

  getAllPersonRelationships(): PersonRelationshipRow[] {
    return this.db.prepare(`
      SELECT pr.*,
        p1.name AS person_name,
        p2.name AS related_person_name
      FROM person_relationships pr
      LEFT JOIN persons p1 ON pr.person_id = p1.id
      LEFT JOIN persons p2 ON pr.related_person_id = p2.id
      ORDER BY pr.created_at DESC
    `).all() as PersonRelationshipRow[];
  }

  getPersonCoOccurrences(): { person1_id: number; person1_name: string; person2_id: number; person2_name: string; count: number }[] {
    return this.db.prepare(`
      SELECT
        cpl1.person_id AS person1_id,
        p1.name AS person1_name,
        cpl2.person_id AS person2_id,
        p2.name AS person2_name,
        COUNT(DISTINCT cpl1.segment_id) AS count
      FROM content_person_links cpl1
      JOIN content_person_links cpl2
        ON cpl1.segment_id = cpl2.segment_id
        AND cpl1.person_id < cpl2.person_id
      JOIN persons p1 ON cpl1.person_id = p1.id
      JOIN persons p2 ON cpl2.person_id = p2.id
      GROUP BY cpl1.person_id, cpl2.person_id
      ORDER BY count DESC
    `).all() as { person1_id: number; person1_name: string; person2_id: number; person2_name: string; count: number }[];
  }

  getPersonSampleSegment(personId: number): { recording_id: number; start_time: number; end_time: number; text: string } | undefined {
    return this.db.prepare(`
      SELECT s.recording_id, s.start_time, s.end_time,
        COALESCE(s.clean_text, s.raw_text) AS text
      FROM content_person_links cpl
      JOIN segments s ON s.id = cpl.segment_id
      WHERE cpl.person_id = ?
        AND cpl.role = 'speaker'
        AND s.start_time IS NOT NULL
        AND s.end_time IS NOT NULL
        AND (s.end_time - s.start_time) > 0
      ORDER BY (s.end_time - s.start_time) DESC
      LIMIT 1
    `).get(personId) as { recording_id: number; start_time: number; end_time: number; text: string } | undefined;
  }

  // ─── Knowledge Pages ─────────────────────────────────────────

  insertKnowledgePage(
    slug: string,
    type: string,
    title: string,
    contentMarkdown: string,
    summary?: string
  ): number {
    const result = this.db.prepare(`
      INSERT INTO knowledge_pages (slug, type, title, content_markdown, summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(slug, type, title, contentMarkdown, summary ?? null);
    return result.lastInsertRowid as number;
  }

  getKnowledgePage(id: number): any {
    return this.db.prepare('SELECT * FROM knowledge_pages WHERE id = ?').get(id);
  }

  getKnowledgePageBySlug(slug: string): any {
    return this.db.prepare('SELECT * FROM knowledge_pages WHERE slug = ?').get(slug);
  }

  getAllKnowledgePages(type?: string): any[] {
    if (type) {
      return this.db.prepare(
        'SELECT * FROM knowledge_pages WHERE type = ? ORDER BY updated_at DESC'
      ).all(type) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM knowledge_pages ORDER BY updated_at DESC'
    ).all() as any[];
  }

  getAllKnowledgePageSlugs(): string[] {
    const rows = this.db.prepare('SELECT slug FROM knowledge_pages ORDER BY slug').all() as { slug: string }[];
    return rows.map((r) => r.slug);
  }

  getKnowledgePagesBySlugPrefix(prefix: string): any[] {
    return this.db.prepare(
      'SELECT * FROM knowledge_pages WHERE slug LIKE ? ORDER BY slug'
    ).all(`${prefix}%`) as any[];
  }

  updateKnowledgePageContent(
    id: number,
    contentMarkdown: string,
    summary: string,
    sourceSegmentIds: number[],
    sourceRecordingIds: number[]
  ): void {
    this.db.prepare(`
      UPDATE knowledge_pages
      SET content_markdown = ?,
          summary = ?,
          source_segment_ids = ?,
          source_recording_ids = ?,
          compilation_count = compilation_count + 1,
          content_edited = 0,
          last_compiled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      contentMarkdown,
      summary,
      JSON.stringify(sourceSegmentIds),
      JSON.stringify(sourceRecordingIds),
      id
    );
  }

  updateKnowledgePageContentOnly(id: number, contentMarkdown: string): void {
    const summary = contentMarkdown.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .slice(0, 2).join(' ').slice(0, 200);
    this.db.prepare(`
      UPDATE knowledge_pages
      SET content_markdown = ?, summary = ?, content_edited = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(contentMarkdown, summary, id);
  }

  /** Bulk-replace [[oldSlug]] with [[newSlug]] in all knowledge pages via a single SQL UPDATE */
  bulkUpdateKnowledgeSlugReferences(oldSlug: string, newSlug: string, excludePageId?: number): void {
    const oldRef = `[[${oldSlug}]]`;
    const newRef = `[[${newSlug}]]`;
    if (excludePageId != null) {
      this.db.prepare(`
        UPDATE knowledge_pages
        SET content_markdown = REPLACE(content_markdown, ?, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE content_markdown LIKE ? AND id != ?
      `).run(oldRef, newRef, `%${oldRef}%`, excludePageId);
    } else {
      this.db.prepare(`
        UPDATE knowledge_pages
        SET content_markdown = REPLACE(content_markdown, ?, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE content_markdown LIKE ?
      `).run(oldRef, newRef, `%${oldRef}%`);
    }
  }

  updateKnowledgePageTags(id: number, tags: string[]): void {
    this.db.prepare(
      'UPDATE knowledge_pages SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(JSON.stringify(tags), id);
  }

  renameKnowledgePage(id: number, newTitle: string, newType: string): void {
    const newSlug = `${newType}/${newTitle}`;
    this.db.prepare(`
      UPDATE knowledge_pages
      SET title = ?, slug = ?, type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newTitle, newSlug, newType, id);
  }

  deleteKnowledgePage(id: number): void {
    this.db.prepare('DELETE FROM knowledge_pages WHERE id = ?').run(id);
  }

  searchKnowledgePagesFts(query: string, limit: number = 10): Array<{ id: number; rank: number }> {
    if (!query || query.trim().length === 0) return [];
    const q = query.trim();
    // FTS5 trigram tokenizer needs >=3 bytes; use LIKE fallback for very short queries
    try {
      const safeQuery = `"${q.replace(/"/g, '""')}"`;
      const ftsResults = this.db.prepare(`
        SELECT kp.id, fts.rank
        FROM knowledge_pages_fts fts
        JOIN knowledge_pages kp ON kp.id = fts.rowid
        WHERE knowledge_pages_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(safeQuery, limit) as any[];
      if (ftsResults.length > 0) return ftsResults;
    } catch {
      // FTS5 query syntax error — fall through to LIKE
    }
    // Fallback: LIKE-based search for short or special queries
    try {
      return this.db.prepare(`
        SELECT id, 0 AS rank
        FROM knowledge_pages
        WHERE title LIKE ?
           OR content_markdown LIKE ?
           OR summary LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(`%${q}%`, `%${q}%`, `%${q}%`, limit) as any[];
    } catch {
      return [];
    }
  }

  getStaleKnowledgePages(daysSinceUpdate: number): any[] {
    return this.db.prepare(`
      SELECT * FROM knowledge_pages
      WHERE last_compiled_at IS NULL
         OR last_compiled_at <= datetime('now', '-' || ? || ' days')
      ORDER BY updated_at ASC
    `).all(daysSinceUpdate) as any[];
  }

  isRecordingInKnowledgePages(recordingId: number): boolean {
    const row = this.db.prepare(`
      SELECT id FROM knowledge_pages
      WHERE source_recording_ids LIKE ?
      LIMIT 1
    `).get(`%${recordingId}%`) as { id: number } | undefined;
    return row !== undefined;
  }

  getKnowledgePageCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_pages').get() as { cnt: number };
    return row.cnt;
  }

  getKnowledgeStats(): { total: number; person: number; topic: number; project: number; concept: number } {
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) AS cnt
      FROM knowledge_pages
      GROUP BY type
    `).all() as { type: string; cnt: number }[];

    const stats = { total: 0, person: 0, topic: 0, project: 0, concept: 0 };
    for (const r of rows) {
      stats.total += r.cnt;
      if (r.type in stats) (stats as any)[r.type] = r.cnt;
    }
    return stats;
  }

  // ─── Knowledge Links ─────────────────────────────────────────

  insertKnowledgeLink(
    fromPageId: number,
    toPageId: number,
    linkType: string = 'reference',
    context?: string
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_page_id, to_page_id, link_type, context)
      VALUES (?, ?, ?, ?)
    `).run(fromPageId, toPageId, linkType, context ?? null);
  }

  getKnowledgeLinks(pageId: number): any[] {
    return this.db.prepare(`
      SELECT kl.*, kp.title AS to_title, kp.slug AS to_slug, kp.type AS to_type
      FROM knowledge_links kl
      JOIN knowledge_pages kp ON kp.id = kl.to_page_id
      WHERE kl.from_page_id = ?
      ORDER BY kl.created_at DESC
    `).all(pageId) as any[];
  }

  getKnowledgeBacklinks(pageId: number): any[] {
    return this.db.prepare(`
      SELECT kl.*, kp.title AS from_title, kp.slug AS from_slug, kp.type AS from_type
      FROM knowledge_links kl
      JOIN knowledge_pages kp ON kp.id = kl.from_page_id
      WHERE kl.to_page_id = ?
      ORDER BY kl.created_at DESC
    `).all(pageId) as any[];
  }

  deleteKnowledgeLinksFrom(pageId: number): void {
    this.db.prepare('DELETE FROM knowledge_links WHERE from_page_id = ?').run(pageId);
  }

  deleteKnowledgeLinksTo(pageId: number): void {
    this.db.prepare('DELETE FROM knowledge_links WHERE to_page_id = ?').run(pageId);
  }

  getKnowledgeGraph(): { nodes: any[]; edges: any[] } {
    const nodes = this.db.prepare(
      'SELECT id, slug, type, title FROM knowledge_pages ORDER BY type, title'
    ).all() as any[];
    const edges = this.db.prepare(
      'SELECT id, from_page_id, to_page_id, link_type FROM knowledge_links'
    ).all() as any[];
    return { nodes, edges };
  }

  // ─── Compilation Queue ───────────────────────────────────────

  insertCompilationQueueEntry(recordingId: number, priority: number = 0): number {
    // Skip if there's already a pending entry for this recording
    const existing = this.db.prepare(`
      SELECT id FROM compilation_queue
      WHERE recording_id = ? AND status = 'pending'
      LIMIT 1
    `).get(recordingId) as { id: number } | undefined;

    if (existing) return existing.id;

    const result = this.db.prepare(`
      INSERT INTO compilation_queue (recording_id, priority)
      VALUES (?, ?)
    `).run(recordingId, priority);
    return result.lastInsertRowid as number;
  }

  getNextCompilationQueueEntry(): any {
    return this.db.prepare(`
      SELECT * FROM compilation_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get();
  }

  startCompilationQueueEntry(id: number): void {
    this.db.prepare(`
      UPDATE compilation_queue
      SET status = 'processing', started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  completeCompilationQueueEntry(id: number): void {
    this.db.prepare(`
      UPDATE compilation_queue
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  failCompilationQueueEntry(id: number, errorMessage: string): void {
    this.db.prepare(`
      UPDATE compilation_queue
      SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(errorMessage, id);
  }

  getCompilationQueueStatus(): { pending: number; processing: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS cnt
      FROM compilation_queue
      WHERE status IN ('pending', 'processing')
      GROUP BY status
    `).all() as { status: string; cnt: number }[];

    const result = { pending: 0, processing: 0 };
    for (const r of rows) {
      if (r.status === 'pending') result.pending = r.cnt;
      if (r.status === 'processing') result.processing = r.cnt;
    }
    return result;
  }

  /**
   * Reset entries left in 'processing' (e.g. the app quit or crashed mid-compile)
   * back to 'pending' so they get retried. Returns the number reset.
   * Called on KnowledgeCompiler startup — without this an interrupted job stays
   * 'processing' forever and the queue badge shows a phantom "1 compiling".
   */
  resetOrphanedCompilationEntries(): number {
    const res = this.db.prepare(`
      UPDATE compilation_queue
      SET status = 'pending', started_at = NULL
      WHERE status = 'processing'
    `).run();
    return res.changes as number;
  }

  /** Active + recently-finished queue entries, joined with recording names, for the UI detail panel. */
  getCompilationQueueEntries(limit: number = 50): Array<{
    id: number;
    recording_id: number;
    recording_name: string | null;
    status: string;
    priority: number;
    error_message: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT q.id, q.recording_id, r.file_name AS recording_name,
             q.status, q.priority, q.error_message,
             q.created_at, q.started_at, q.completed_at
      FROM compilation_queue q
      LEFT JOIN recordings r ON r.id = q.recording_id
      WHERE q.status IN ('pending', 'processing')
         OR (q.status = 'failed' AND q.completed_at > datetime('now', '-1 day'))
      ORDER BY
        CASE q.status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        q.priority DESC, q.created_at ASC
      LIMIT ?
    `).all(limit) as any;
  }

  /** Clear stuck (processing) and failed entries — manual recovery from the UI. Returns count removed. */
  clearStuckCompilationEntries(): number {
    const res = this.db.prepare(`
      DELETE FROM compilation_queue
      WHERE status IN ('processing', 'failed')
    `).run();
    return res.changes as number;
  }

  // ─── Segment FTS Search ──────────────────────────────────────

  searchSegmentsFts(query: string, limit: number = 15): Array<{ id: number; rank: number }> {
    if (!query || query.trim().length === 0) return [];
    const q = query.trim();
    try {
      const safeQuery = `"${q.replace(/"/g, '""')}"`;
      const ftsResults = this.db.prepare(`
        SELECT s.id, fts.rank
        FROM segments_fts fts
        JOIN segments s ON s.id = fts.rowid
        WHERE segments_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(safeQuery, limit) as any[];
      if (ftsResults.length > 0) return ftsResults;
    } catch {
      // FTS5 query error — fall through to LIKE
    }
    try {
      return this.db.prepare(`
        SELECT id, 0 AS rank
        FROM segments
        WHERE raw_text LIKE ? OR clean_text LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(`%${q}%`, `%${q}%`, limit) as any[];
    } catch {
      return [];
    }
  }

  // ── Correction Dictionary ──────────────────────────────────────

  insertCorrection(wrongText: string, correctText: string, category: string = 'general', source: string = 'manual'): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO correction_dictionary (wrong_text, correct_text, category, source)
      VALUES (?, ?, ?, ?)
    `);
    return Number(stmt.run(wrongText, correctText, category, source).lastInsertRowid);
  }

  getAllCorrections(): any[] {
    return this.db.prepare('SELECT * FROM correction_dictionary ORDER BY hit_count DESC, created_at DESC').all();
  }

  getCorrectionsByCategory(category: string): any[] {
    return this.db.prepare('SELECT * FROM correction_dictionary WHERE category = ? ORDER BY hit_count DESC').all(category);
  }

  deleteCorrection(id: number): void {
    this.db.prepare('DELETE FROM correction_dictionary WHERE id = ?').run(id);
  }

  updateCorrection(id: number, wrongText: string, correctText: string, category: string): void {
    this.db.prepare('UPDATE correction_dictionary SET wrong_text = ?, correct_text = ?, category = ? WHERE id = ?')
      .run(wrongText, correctText, category, id);
  }

  incrementCorrectionHitCount(id: number): void {
    this.db.prepare('UPDATE correction_dictionary SET hit_count = hit_count + 1 WHERE id = ?').run(id);
  }

  /** Apply all corrections to a text string. Returns corrected text and list of applied correction IDs. */
  applyCorrections(text: string): { corrected: string; appliedIds: number[] } {
    const corrections = this.db.prepare('SELECT id, wrong_text, correct_text FROM correction_dictionary ORDER BY LENGTH(wrong_text) DESC').all() as any[];
    let result = text;
    const appliedIds: number[] = [];
    for (const c of corrections) {
      if (result.includes(c.wrong_text)) {
        result = result.split(c.wrong_text).join(c.correct_text);
        appliedIds.push(c.id);
      }
    }
    return { corrected: result, appliedIds };
  }

  // ── Custom Vocabulary ──────────────────────────────────────────

  insertVocabularyTerm(term: string, category: string = 'general'): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO custom_vocabulary (term, category) VALUES (?, ?)');
    return Number(stmt.run(term, category).lastInsertRowid);
  }

  getAllVocabulary(): any[] {
    return this.db.prepare('SELECT * FROM custom_vocabulary ORDER BY category, term').all();
  }

  deleteVocabularyTerm(id: number): void {
    this.db.prepare('DELETE FROM custom_vocabulary WHERE id = ?').run(id);
  }

  /** Build prompt block for LLM injection: user's vocabulary context + auto-learned corrections. */
  buildVocabularyPromptBlock(vocabularyContext?: string): string {
    const parts: string[] = [];

    // 1. User's free-form vocabulary/instructions (from settings.vocabularyContext)
    if (vocabularyContext?.trim()) {
      parts.push(`【专有名词与纠正规则】\n${vocabularyContext.trim()}`);
    }

    // 2. Auto-learned corrections (from page merges/pinyin matches — silent background accumulation)
    try {
      const corrections = this.db.prepare(
        "SELECT wrong_text, correct_text FROM correction_dictionary WHERE source = 'auto_learned' ORDER BY hit_count DESC LIMIT 30"
      ).all() as any[];
      if (corrections.length > 0) {
        const corrLines = corrections.map((c: any) => `"${c.wrong_text}"→"${c.correct_text}"`);
        parts.push(`【已知错误映射】${corrLines.join('、')}`);
      }
    } catch { /* table may not exist yet */ }

    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ─── External Sources (Feishu CLI data source) ──────────

  upsertExternalSource(source: string, name: string): void {
    this.db.prepare(
      `INSERT INTO external_sources (source, name) VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET name = excluded.name`
    ).run(source, name);
  }

  updateExternalSourceStatus(source: string, status: string): void {
    this.db.prepare(
      'UPDATE external_sources SET status = ? WHERE source = ?'
    ).run(status, source);
  }

  updateExternalSourceLastSync(source: string, lastSyncAt: string): void {
    this.db.prepare(
      'UPDATE external_sources SET last_sync_at = ? WHERE source = ?'
    ).run(lastSyncAt, source);
  }

  getExternalSource(source: string): any | undefined {
    return this.db.prepare(
      'SELECT * FROM external_sources WHERE source = ?'
    ).get(source);
  }

  upsertExternalDocument(
    source: string,
    domain: string,
    externalId: string,
    title: string,
    url: string,
    metadataJson: string,
    _updatedAt: string,
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM external_documents WHERE source = ? AND domain = ? AND external_id = ?'
    ).get(source, domain, externalId) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE external_documents
         SET title = ?, url = ?, metadata_json = ?, fetched_at = datetime('now'), deleted = 0
         WHERE id = ?`
      ).run(title, url, metadataJson, existing.id);
      return existing.id;
    }

    const r = this.db.prepare(
      `INSERT INTO external_documents (source, domain, external_id, title, url, metadata_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(source, domain, externalId, title, url, metadataJson);
    return Number(r.lastInsertRowid);
  }

  upsertExternalChunk(
    documentId: number,
    externalId: string,
    title: string,
    url: string,
    content: string,
    metadataJson: string,
    contentHash: string,
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM external_chunks WHERE document_id = ? AND content_hash = ?'
    ).get(documentId, contentHash) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE external_chunks
         SET title = ?, url = ?, content = ?, metadata_json = ?, updated_at = datetime('now'), deleted = 0
         WHERE id = ?`
      ).run(title, url, content, metadataJson, existing.id);
      return existing.id;
    } else {
      const r = this.db.prepare(
        `INSERT INTO external_chunks (document_id, external_id, title, url, content, metadata_json, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(documentId, externalId, title, url, content, metadataJson, contentHash);
      return Number(r.lastInsertRowid);
    }
  }

  softDeleteExternalChunksBySource(source: string): void {
    const rows = this.db.prepare(
      `SELECT ec.id FROM external_chunks ec
       JOIN external_documents ed ON ec.document_id = ed.id
       WHERE ed.source = ? AND ec.deleted = 0`
    ).all(source) as Array<{ id: number }>;
    for (const row of rows) {
      this.db.prepare('UPDATE external_chunks SET deleted = 1 WHERE id = ?').run(row.id);
    }
  }

  getExternalChunks(source: string, limit: number = 100): Array<{
    id: number;
    document_id: number;
    external_id: string;
    title: string;
    url: string;
    content: string;
    metadata_json: string;
    updated_at: string;
  }> {
    return this.db.prepare(
      `SELECT ec.id, ec.document_id, ec.external_id, ec.title, ec.url, ec.content, ec.metadata_json, ec.updated_at
       FROM external_chunks ec
       JOIN external_documents ed ON ec.document_id = ed.id
       WHERE ed.source = ? AND ec.deleted = 0
       ORDER BY ec.updated_at DESC LIMIT ?`
    ).all(source, limit) as any[];
  }

  getExternalChunksByIds(ids: number[]): Array<{
    id: number;
    document_id: number;
    external_id: string;
    source: string;
    domain: string;
    title: string;
    url: string;
    content: string;
    metadata_json: string;
  }> {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT ec.id, ec.document_id, ec.external_id, ed.source, ed.domain, ec.title, ec.url, ec.content, ec.metadata_json
       FROM external_chunks ec
       JOIN external_documents ed ON ec.document_id = ed.id
       WHERE ec.id IN (${ph}) AND ec.deleted = 0 AND ed.deleted = 0`
    ).all(...ids) as any[];
  }

  searchExternalChunksByText(query: string, limit = 10): Array<{
    id: number;
    document_id: number;
    external_id: string;
    source: string;
    domain: string;
    title: string;
    url: string;
    content: string;
    metadata_json: string;
  }> {
    // 拆成關鍵詞（≥2字），任一詞命中即可
    const keywords = query.split(/[\s，。！？,!?、]+/).filter((w) => w.length >= 2).slice(0, 6);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => '(ec.content LIKE ? OR ec.title LIKE ?)').join(' OR ');
    const params: string[] = keywords.flatMap((w) => [`%${w}%`, `%${w}%`]);
    params.push(String(limit));

    return this.db.prepare(
      `SELECT ec.id, ec.document_id, ec.external_id, ed.source, ed.domain, ec.title, ec.url, ec.content, ec.metadata_json
       FROM external_chunks ec
       JOIN external_documents ed ON ec.document_id = ed.id
       WHERE (${conditions}) AND ec.deleted = 0 AND ed.deleted = 0
       LIMIT ?`
    ).all(...params) as any[];
  }

  startExternalSyncRun(source: string, domain: string = ''): number {
    const r = this.db.prepare(
      `INSERT INTO external_sync_runs (source, domain, status) VALUES (?, ?, 'running')`
    ).run(source, domain);
    return Number(r.lastInsertRowid);
  }

  finishExternalSyncRun(runId: number, docsCount: number, chunksCount: number, error?: string): void {
    this.db.prepare(
      `UPDATE external_sync_runs
       SET finished_at = datetime('now'), status = ?, documents_count = ?, chunks_count = ?, error = ?
       WHERE id = ?`
    ).run(error ? 'failed' : 'completed', docsCount, chunksCount, error || null, runId);
  }

  getExternalSyncRuns(source: string, limit: number = 20): any[] {
    return this.db.prepare(
      'SELECT * FROM external_sync_runs WHERE source = ? ORDER BY started_at DESC LIMIT ?'
    ).all(source, limit);
  }

  getExternalDocuments(source: string, domain?: string): any[] {
    if (domain) {
      return this.db.prepare(
        'SELECT * FROM external_documents WHERE source = ? AND domain = ? AND deleted = 0 ORDER BY fetched_at DESC'
      ).all(source, domain);
    }
    return this.db.prepare(
      'SELECT * FROM external_documents WHERE source = ? AND deleted = 0 ORDER BY fetched_at DESC'
    ).all(source);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /** Expose the raw DatabaseSync handle (e.g. for TaskQueue persistence). */
  getRawDb(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.vacuumTimer) {
      clearTimeout(this.vacuumTimer);
      this.vacuumTimer = null;
    }
    this.stopWalCheckpoint();
    this.db.close();
  }
}
