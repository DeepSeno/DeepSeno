CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  duration_seconds INTEGER,
  recorded_at DATETIME,
  processed_at DATETIME,
  status TEXT DEFAULT 'pending',
  media_type TEXT DEFAULT 'audio',
  page_count INTEGER,
  word_count INTEGER
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
  start_time REAL,
  end_time REAL,
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
  status TEXT DEFAULT 'active',
  source TEXT DEFAULT 'pipeline'
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date DATE UNIQUE NOT NULL,
  summary_text TEXT,
  timeline_json TEXT,
  key_events_json TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  raw_text, clean_text, content=segments, content_rowid=id
);
