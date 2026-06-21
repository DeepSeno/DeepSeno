// src/main/__tests__/session-manager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '../channels/session-manager';
import type { LLMClient } from '../llm/llm-client';

function createMockLLM(response = 'Test summary'): LLMClient {
  return {
    generate: vi.fn().mockResolvedValue(response),
    generateStream: vi.fn(),
    generateJSON: vi.fn(),
    embed: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as LLMClient;
}

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
  `);
  return db;
}

describe('SessionManager', () => {
  let db: DatabaseSync;
  let manager: SessionManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new SessionManager(db);
  });

  it('creates a new session when none exists', () => {
    const session = manager.getOrCreateSession('ch1', 'u1');
    expect(session.id).toBeGreaterThan(0);
    expect(session.channelId).toBe('ch1');
    expect(session.userId).toBe('u1');
    expect(session.startedAt).toBeGreaterThan(0);

    // Verify it's in the DB
    const row = db.prepare('SELECT * FROM channel_sessions WHERE id = ?').get(session.id) as any;
    expect(row).toBeTruthy();
    expect(row.ended_at).toBeNull();
  });

  it('reuses active session within timeout', () => {
    const session1 = manager.getOrCreateSession('ch1', 'u1');
    // Add a message so there is a timestamp to check
    manager.addMessage('ch1', 'u1', 'user', 'hello');

    const session2 = manager.getOrCreateSession('ch1', 'u1');
    expect(session2.id).toBe(session1.id);
  });

  it('creates new session after timeout', () => {
    const session1 = manager.getOrCreateSession('ch1', 'u1');
    manager.addMessage('ch1', 'u1', 'user', 'hello');

    // Backdate all messages to simulate timeout (3 hours ago)
    db.prepare('UPDATE channel_messages SET timestamp = ? WHERE session_id = ?').run(
      Date.now() - 3 * 60 * 60 * 1000,
      session1.id
    );

    // Clear cache so it re-queries DB
    manager.activeSessionCache.delete('ch1:u1');

    const session2 = manager.getOrCreateSession('ch1', 'u1');
    expect(session2.id).not.toBe(session1.id);

    // Old session should be closed
    const oldRow = db.prepare('SELECT ended_at FROM channel_sessions WHERE id = ?').get(session1.id) as any;
    expect(oldRow.ended_at).not.toBeNull();
  });

  it('isolates sessions by channel', () => {
    const session1 = manager.getOrCreateSession('ch1', 'u1');
    const session2 = manager.getOrCreateSession('ch2', 'u1');
    const session3 = manager.getOrCreateSession('ch1', 'u2');

    expect(session1.id).not.toBe(session2.id);
    expect(session1.id).not.toBe(session3.id);
    expect(session2.id).not.toBe(session3.id);
  });

  it('stores messages and returns them via getContext', () => {
    manager.addMessage('ch1', 'u1', 'user', 'What is the weather?');
    manager.addMessage('ch1', 'u1', 'assistant', 'It is sunny.');

    const ctx = manager.getContext('ch1', 'u1');
    expect(ctx.activeMessages).toHaveLength(2);
    expect(ctx.activeMessages[0]).toEqual({ role: 'user', content: 'What is the weather?' });
    expect(ctx.activeMessages[1]).toEqual({ role: 'assistant', content: 'It is sunny.' });
    expect(ctx.recentSummaries).toEqual([]);
  });

  it('caps active messages at MAX_MESSAGES (30), keeps most recent', () => {
    // Add 35 messages
    for (let i = 1; i <= 35; i++) {
      manager.addMessage('ch1', 'u1', 'user', `message ${i}`);
    }

    const ctx = manager.getContext('ch1', 'u1');
    expect(ctx.activeMessages).toHaveLength(30);

    // Most recent 30 should be kept (messages 6-35)
    expect(ctx.activeMessages[0].content).toBe('message 6');
    expect(ctx.activeMessages[29].content).toBe('message 35');
  });

  it('closeSession marks session as ended', () => {
    const session = manager.getOrCreateSession('ch1', 'u1');
    manager.closeSession('ch1', 'u1');

    const row = db.prepare('SELECT ended_at FROM channel_sessions WHERE id = ?').get(session.id) as any;
    expect(row.ended_at).not.toBeNull();

    // Cache should be cleared
    expect(manager.activeSessionCache.has('ch1:u1')).toBe(false);
  });

  it('clear is an alias for closeSession', () => {
    const session = manager.getOrCreateSession('ch1', 'u1');
    manager.clear('ch1', 'u1');

    const row = db.prepare('SELECT ended_at FROM channel_sessions WHERE id = ?').get(session.id) as any;
    expect(row.ended_at).not.toBeNull();
  });

  it('clearAll closes all open sessions and clears cache', () => {
    manager.getOrCreateSession('ch1', 'u1');
    manager.getOrCreateSession('ch2', 'u2');

    manager.clearAll();

    const openSessions = db.prepare('SELECT * FROM channel_sessions WHERE ended_at IS NULL').all();
    expect(openSessions).toHaveLength(0);
    expect(manager.activeSessionCache.size).toBe(0);
  });

  it('getContext includes summaries from closed sessions', () => {
    // Create and close a session with a summary
    db.exec(`
      INSERT INTO channel_sessions (channel_id, user_id, started_at, ended_at, summary, message_count)
      VALUES ('ch1', 'u1', ${Date.now() - 10000}, ${Date.now() - 5000}, 'Previous session summary', 1)
    `);

    manager.addMessage('ch1', 'u1', 'user', 'New question');
    const ctx = manager.getContext('ch1', 'u1');

    expect(ctx.recentSummaries).toHaveLength(1);
    expect(ctx.recentSummaries[0]).toBe('Previous session summary');
  });

  describe('handleCommand', () => {
    it('returns true and closes session for /new', () => {
      manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', 'hello');

      const handled = manager.handleCommand('wechat', 'user1', '/new');
      expect(handled).toBe(true);

      // Next getOrCreateSession should create a new one
      manager.getOrCreateSession('wechat', 'user1');
      const row = db.prepare('SELECT COUNT(*) as cnt FROM channel_sessions WHERE channel_id = ? AND user_id = ?').get('wechat', 'user1') as any;
      expect(row.cnt).toBe(2); // old (closed) + new
    });

    it('returns false for normal messages', () => {
      const handled = manager.handleCommand('wechat', 'user1', 'hello');
      expect(handled).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('closes expired sessions', () => {
      const s = manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', 'hello');
      // Make message old
      db.prepare('UPDATE channel_messages SET timestamp = ? WHERE session_id = ?')
        .run(Date.now() - 3 * 60 * 60 * 1000, s.id);

      manager.cleanup();

      const row = db.prepare('SELECT ended_at FROM channel_sessions WHERE id = ?').get(s.id) as any;
      expect(row.ended_at).not.toBeNull();
    });

    it('deletes messages older than 30 days', () => {
      const s = manager.getOrCreateSession('wechat', 'user1');
      // Insert both messages directly to avoid triggering session timeout via addMessage
      db.prepare('INSERT INTO channel_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(s.id, 'user', 'ancient message', Date.now() - 31 * 24 * 60 * 60 * 1000);
      db.prepare('INSERT INTO channel_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(s.id, 'user', 'recent message', Date.now());

      manager.cleanup();

      const rows = db.prepare('SELECT content FROM channel_messages WHERE session_id = ?').all(s.id) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('recent message');
    });
  });

  describe('full lifecycle', () => {
    it('session timeout → summary → new session with context', async () => {
      const mockLLM = createMockLLM('用户讨论了天气问题。助手提供了预报。');
      manager.setLLM(mockLLM, 'test-model');

      // Session 1: multi-turn conversation
      manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', '今天天气怎么样？');
      manager.addMessage('wechat', 'user1', 'assistant', '今天晴天，25度。');
      manager.addMessage('wechat', 'user1', 'user', '明天呢？');
      manager.addMessage('wechat', 'user1', 'assistant', '明天多云，22度。');

      // Simulate timeout: make messages old
      const s1 = manager.getOrCreateSession('wechat', 'user1');
      db.prepare('UPDATE channel_messages SET timestamp = ? WHERE session_id = ?')
        .run(Date.now() - 3 * 60 * 60 * 1000, s1.id);

      // New message triggers session rotation
      manager.addMessage('wechat', 'user1', 'user', '帮我查一下伴鱼的官网');

      // Wait for async summary
      await vi.waitFor(() => {
        const row = db.prepare('SELECT summary FROM channel_sessions WHERE id = ?').get(s1.id) as any;
        expect(row.summary).toBeTruthy();
      }, { timeout: 2000 });

      const ctx = manager.getContext('wechat', 'user1');

      // Should have summary from session 1
      expect(ctx.recentSummaries).toHaveLength(1);
      expect(ctx.recentSummaries[0]).toContain('天气');

      // Active messages should only contain the new message
      expect(ctx.activeMessages).toHaveLength(1);
      expect(ctx.activeMessages[0].content).toBe('帮我查一下伴鱼的官网');
    });
  });

  describe('summary generation', () => {
    it('generates summary when session is closed with enough messages', async () => {
      const mockLLM = createMockLLM('User asked about weather. Assistant provided forecast.');
      manager.setLLM(mockLLM, 'test-model');

      manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', 'What is the weather?');
      manager.addMessage('wechat', 'user1', 'assistant', 'It is sunny today.');
      manager.addMessage('wechat', 'user1', 'user', 'Thanks!');
      manager.addMessage('wechat', 'user1', 'assistant', 'You are welcome.');

      manager.closeSession('wechat', 'user1');
      await vi.waitFor(() => {
        const row = db.prepare('SELECT summary FROM channel_sessions WHERE channel_id = ? AND user_id = ?').get('wechat', 'user1') as any;
        expect(row.summary).toBe('User asked about weather. Assistant provided forecast.');
      }, { timeout: 2000 });

      expect(mockLLM.generate).toHaveBeenCalledOnce();
    });

    it('uses original text as summary for single-turn sessions', async () => {
      const mockLLM = createMockLLM();
      manager.setLLM(mockLLM, 'test-model');

      manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', 'Hello');
      manager.addMessage('wechat', 'user1', 'assistant', 'Hi there');

      manager.closeSession('wechat', 'user1');
      await vi.waitFor(() => {
        const row = db.prepare('SELECT summary FROM channel_sessions WHERE channel_id = ? AND user_id = ?').get('wechat', 'user1') as any;
        expect(row.summary).toBeTruthy();
      }, { timeout: 2000 });

      // Single turn: no LLM call, just direct text
      expect(mockLLM.generate).not.toHaveBeenCalled();
    });

    it('injects summaries from closed sessions into new session context', async () => {
      const mockLLM = createMockLLM('Previous conversation summary.');
      manager.setLLM(mockLLM, 'test-model');

      // Create and close a session with enough messages for LLM summary
      manager.getOrCreateSession('wechat', 'user1');
      manager.addMessage('wechat', 'user1', 'user', 'msg1');
      manager.addMessage('wechat', 'user1', 'assistant', 'reply1');
      manager.addMessage('wechat', 'user1', 'user', 'msg2');
      manager.addMessage('wechat', 'user1', 'assistant', 'reply2');
      manager.closeSession('wechat', 'user1');

      await vi.waitFor(() => {
        const row = db.prepare('SELECT summary FROM channel_sessions WHERE ended_at IS NOT NULL').get() as any;
        expect(row.summary).toBeTruthy();
      }, { timeout: 2000 });

      // Start new session, check context has summary
      manager.addMessage('wechat', 'user1', 'user', 'new message');
      const ctx = manager.getContext('wechat', 'user1');
      expect(ctx.recentSummaries).toHaveLength(1);
      expect(ctx.recentSummaries[0]).toBe('Previous conversation summary.');
      expect(ctx.activeMessages).toHaveLength(1);
      expect(ctx.activeMessages[0].content).toBe('new message');
    });
  });
});
