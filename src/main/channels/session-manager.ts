// src/main/channels/session-manager.ts
import type { DatabaseSync } from 'node:sqlite';
import type { LLMClient } from '../llm/llm-client';

export interface Session {
  id: number;
  channelId: string;
  userId: string;
  startedAt: number;
}

export interface ContextPayload {
  recentSummaries: string[];
  activeMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface SessionRow {
  id: number;
  channel_id: string;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  message_count: number;
}

interface MessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class SessionManager {
  /** Maps `channelId:userId` to session ID */
  activeSessionCache: Map<string, number> = new Map();

  static readonly SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
  static readonly MAX_MESSAGES = 30;
  static readonly MAX_SUMMARIES = 3;
  private static readonly MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  private llm: LLMClient | null = null;
  private llmModel = '';

  /** Sessions currently being summarized — guards against concurrent/duplicate generation */
  private readonly pendingSummaries = new Set<number>();

  /** Hard cap on summary length to defend against runaway LLM output */
  private static readonly SUMMARY_MAX_CHARS = 2000;
  /** Per-segment token budget passed to the LLM (Local num_predict / OpenAI max_tokens) */
  private static readonly SUMMARY_NUM_PREDICT = 500;

  constructor(private readonly db: DatabaseSync) {}

  setLLM(llm: LLMClient, model: string): void {
    this.llm = llm;
    this.llmModel = model;
  }

  /**
   * Get or create an active session for the given channel + user.
   * Closes expired sessions and starts fresh ones automatically.
   */
  getOrCreateSession(channelId: string, userId: string): Session {
    const cacheKey = `${channelId}:${userId}`;

    // 1. Check cache
    const cachedId = this.activeSessionCache.get(cacheKey);
    if (cachedId !== undefined) {
      const lastTs = this.getLastMessageTimestamp(cachedId);
      if (lastTs === null || Date.now() - lastTs < SessionManager.SESSION_TIMEOUT_MS) {
        // Cache hit is still valid — return it
        const row = this.db
          .prepare('SELECT * FROM channel_sessions WHERE id = ?')
          .get(cachedId) as SessionRow;
        if (row && row.ended_at === null) {
          return this.rowToSession(row);
        }
      }
      // Expired or missing — close and evict
      this.closeSessionById(cachedId);
      this.activeSessionCache.delete(cacheKey);
      this.generateSummaryAsync(cachedId);
    }

    // 2. Query DB for active session
    const existing = this.db
      .prepare(
        'SELECT * FROM channel_sessions WHERE channel_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
      )
      .get(channelId, userId) as SessionRow | undefined;

    if (existing) {
      const lastTs = this.getLastMessageTimestamp(existing.id);
      if (lastTs === null || Date.now() - lastTs < SessionManager.SESSION_TIMEOUT_MS) {
        // Still active — cache and return
        this.activeSessionCache.set(cacheKey, existing.id);
        return this.rowToSession(existing);
      }
      // Expired — close it
      this.closeSessionById(existing.id);
      this.generateSummaryAsync(existing.id);
    }

    // 3. Create new session
    // Ensure started_at is unique for (channel_id, user_id) by bumping if needed
    let now = Date.now();
    const lastTs = this.db
      .prepare('SELECT MAX(started_at) as ts FROM channel_sessions WHERE channel_id = ? AND user_id = ?')
      .get(channelId, userId) as { ts: number | null };
    if (lastTs?.ts !== null && lastTs.ts >= now) {
      now = lastTs.ts + 1;
    }

    const result = this.db
      .prepare(
        'INSERT INTO channel_sessions (channel_id, user_id, started_at, message_count) VALUES (?, ?, ?, 0)'
      )
      .run(channelId, userId, now);

    const sessionId = result.lastInsertRowid as number;
    this.activeSessionCache.set(cacheKey, sessionId);

    return { id: sessionId, channelId, userId, startedAt: now };
  }

  /** Add a message to the current session */
  addMessage(channelId: string, userId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.getOrCreateSession(channelId, userId);
    const now = Date.now();

    this.db
      .prepare('INSERT INTO channel_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(session.id, role, content, now);

    this.db
      .prepare('UPDATE channel_sessions SET message_count = message_count + 1 WHERE id = ?')
      .run(session.id);
  }

  /** Get context (recent summaries + active messages) for the given channel + user */
  getContext(channelId: string, userId: string): ContextPayload {
    const session = this.getOrCreateSession(channelId, userId);

    // All messages for this session, oldest first
    const allMessages = this.db
      .prepare('SELECT role, content FROM channel_messages WHERE session_id = ? ORDER BY timestamp ASC')
      .all(session.id) as Array<{ role: 'user' | 'assistant'; content: string }>;

    // Cap to last MAX_MESSAGES
    const activeMessages =
      allMessages.length > SessionManager.MAX_MESSAGES
        ? allMessages.slice(allMessages.length - SessionManager.MAX_MESSAGES)
        : allMessages;

    // Last MAX_SUMMARIES closed sessions with a summary, ordered DESC (newest first), then reversed
    const summaryRows = this.db
      .prepare(
        `SELECT summary FROM channel_sessions
         WHERE channel_id = ? AND user_id = ? AND ended_at IS NOT NULL AND summary IS NOT NULL
         ORDER BY ended_at DESC
         LIMIT ?`
      )
      .all(channelId, userId, SessionManager.MAX_SUMMARIES) as Array<{ summary: string }>;

    // Reverse to oldest-first
    const recentSummaries = summaryRows.map((r) => r.summary).reverse();

    return { recentSummaries, activeMessages };
  }

  /** Close the active session for this channel + user */
  closeSession(channelId: string, userId: string): void {
    const cacheKey = `${channelId}:${userId}`;
    const cachedId = this.activeSessionCache.get(cacheKey);

    if (cachedId !== undefined) {
      this.closeSessionById(cachedId);
      this.activeSessionCache.delete(cacheKey);
      this.generateSummaryAsync(cachedId);
      return;
    }

    // Fallback: check DB
    const row = this.db
      .prepare(
        'SELECT id FROM channel_sessions WHERE channel_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
      )
      .get(channelId, userId) as { id: number } | undefined;

    if (row) {
      this.closeSessionById(row.id);
      this.generateSummaryAsync(row.id);
    }
  }

  /**
   * Handle a potential command message. Returns true if the message was a command and consumed.
   * Currently supports: /new — closes the current session to start fresh.
   */
  handleCommand(channelId: string, userId: string, message: string): boolean {
    const trimmed = message.trim();
    if (trimmed === '/new') {
      this.closeSession(channelId, userId);
      return true;
    }
    return false;
  }

  /**
   * Clean up expired sessions, generate missing summaries, and purge old messages.
   * Intended to be called periodically (e.g., on a scheduler).
   */
  cleanup(): void {
    const now = Date.now();
    const timeout = SessionManager.SESSION_TIMEOUT_MS;

    // Find active sessions whose last message is older than timeout
    const expired = this.db.prepare(`
      SELECT s.id FROM channel_sessions s
      WHERE s.ended_at IS NULL
      AND (
        SELECT MAX(m.timestamp) FROM channel_messages m WHERE m.session_id = s.id
      ) < ?
    `).all(now - timeout) as Array<{ id: number }>;

    for (const row of expired) {
      this.closeSessionById(row.id);
      this.generateSummaryAsync(row.id);
    }
    if (expired.length > 0) {
      console.log(`[SessionManager] Closed ${expired.length} expired session(s)`);
      this.activeSessionCache.clear();
    }

    // Generate summaries for closed sessions without one
    const unsummarized = this.db.prepare(
      'SELECT id FROM channel_sessions WHERE ended_at IS NOT NULL AND summary IS NULL'
    ).all() as Array<{ id: number }>;
    for (const row of unsummarized) {
      this.generateSummaryAsync(row.id);
    }

    // Delete messages older than 30 days
    const cutoff = now - SessionManager.MESSAGE_RETENTION_MS;
    const deleted = this.db.prepare('DELETE FROM channel_messages WHERE timestamp < ?').run(cutoff);
    if (deleted.changes > 0) {
      console.log(`[SessionManager] Purged ${deleted.changes} old message(s)`);
    }
  }

  /** Alias for closeSession (backward compatibility with ConversationManager.clear) */
  clear(channelId: string, userId: string): void {
    this.closeSession(channelId, userId);
  }

  /** Close all open sessions and clear the cache */
  clearAll(): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE channel_sessions SET ended_at = ? WHERE ended_at IS NULL')
      .run(now);
    this.activeSessionCache.clear();
  }

  /** Fire-and-forget summary generation */
  private generateSummaryAsync(sessionId: number): void {
    this.generateSummary(sessionId).catch(err => {
      console.error(`[SessionManager] Summary generation failed for session ${sessionId}:`, err);
    });
  }

  private async generateSummary(sessionId: number): Promise<void> {
    // Idempotency: skip if a summary already exists for this closed session
    const existing = this.db
      .prepare('SELECT summary FROM channel_sessions WHERE id = ?')
      .get(sessionId) as { summary: string | null } | undefined;
    if (existing?.summary) return;

    // Concurrency guard: only one in-flight summary per session
    if (this.pendingSummaries.has(sessionId)) return;
    this.pendingSummaries.add(sessionId);

    try {
      const messages = this.db.prepare(
        'SELECT role, content FROM channel_messages WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(sessionId) as Array<{ role: string; content: string }>;

      if (messages.length === 0) return;

      // Single turn (1 user + 1 assistant): use original text directly, no LLM call
      if (messages.length <= 2) {
        const summary = messages.map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n');
        this.writeSummary(sessionId, summary);
        return;
      }

      if (!this.llm) {
        console.warn('[SessionManager] No LLM configured, skipping summary generation');
        return;
      }

      const segments = this.segmentMessages(messages);
      const summaryParts: string[] = [];

      for (const segment of segments) {
        const conversationText = segment
          .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
          .join('\n');

        const prompt = `请将以下对话压缩为一段简洁的摘要（3-5句话）。
要求：
1. 保留关键事实：人名、数字、结论、待办事项、用户明确表达的偏好
2. 保留未完成的事项（用户说"稍后再说"、"下次继续"之类的）
3. 丢弃寒暄、重复确认、工具调用细节
4. 用第三人称描述（"用户询问了..."、"助手帮用户..."）

对话内容：
${conversationText}`;

        try {
          const result = await this.llm.generate({
            model: this.llmModel,
            prompt,
            temperature: 0.3,
            num_ctx: 4096,
            num_predict: SessionManager.SUMMARY_NUM_PREDICT,
          });
          summaryParts.push(result.trim());
        } catch (err) {
          console.error('[SessionManager] LLM summary call failed:', err);
          summaryParts.push(conversationText.slice(0, 200) + '...');
        }
      }

      this.writeSummary(sessionId, summaryParts.join('\n'));
    } finally {
      this.pendingSummaries.delete(sessionId);
    }
  }

  /** Write a summary to DB, clipping if it exceeds the safety cap. */
  private writeSummary(sessionId: number, summary: string): void {
    let final = summary;
    if (final.length > SessionManager.SUMMARY_MAX_CHARS) {
      console.warn(
        `[SessionManager] Summary for session ${sessionId} exceeds ${SessionManager.SUMMARY_MAX_CHARS} chars (${final.length}); clipping`
      );
      final = final.slice(0, SessionManager.SUMMARY_MAX_CHARS) + '…';
    }
    this.db.prepare('UPDATE channel_sessions SET summary = ? WHERE id = ?').run(final, sessionId);
    console.log(`[SessionManager] Summary generated for session ${sessionId} (${final.length} chars)`);
  }

  /** Split messages into segments of ~20 for long sessions */
  private segmentMessages(messages: Array<{ role: string; content: string }>): Array<Array<{ role: string; content: string }>> {
    if (messages.length <= 20) return [messages];
    const segmentSize = Math.ceil(messages.length / Math.ceil(messages.length / 20));
    const segments: Array<Array<{ role: string; content: string }>> = [];
    for (let i = 0; i < messages.length; i += segmentSize) {
      segments.push(messages.slice(i, i + segmentSize));
    }
    return segments;
  }

  /** Close a session by its ID */
  private closeSessionById(sessionId: number): void {
    this.db
      .prepare('UPDATE channel_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(Date.now(), sessionId);
  }

  /** Get the timestamp of the most recent message in a session, or null if none */
  private getLastMessageTimestamp(sessionId: number): number | null {
    const row = this.db
      .prepare('SELECT MAX(timestamp) as ts FROM channel_messages WHERE session_id = ?')
      .get(sessionId) as { ts: number | null };
    return row?.ts ?? null;
  }

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      channelId: row.channel_id,
      userId: row.user_id,
      startedAt: row.started_at,
    };
  }
}
