import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { MemoryExtractor } from '../agent/memory-extractor';
import { loadSettings } from '../settings';
import { getLLMModel } from '../llm/create-client';
import { requireId, requireString, ValidationError } from './validate';

let streamAbort: AbortController | null = null;
let scopedStreamAbort: AbortController | null = null;

export function registerRagHandlers(ctx: IpcContext): void {
  // ─── Chat Sessions ───────────────────────────────────────
  ipcMain.handle('chat:createSession', async (_event, title?: string) => {
    try {
      const id = ctx.getDb().createSession(title);
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:getSessions', async () => {
    try {
      return ctx.getDb().getAllSessions();
    } catch {
      return [];
    }
  });

  ipcMain.handle('chat:renameSession', async (_event, id: number, title: string) => {
    try {
      const validId = requireId(id, 'id');
      const validTitle = requireString(title, 'title', 500);
      ctx.getDb().renameSession(validId, validTitle);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:deleteSession', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deleteSession(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:getSessionMessages', async (_event, sessionId: number) => {
    try {
      const validId = requireId(sessionId, 'sessionId');
      return ctx.getDb().getSessionMessages(validId);
    } catch {
      return [];
    }
  });

  // ─── Channel Sessions (read-only) ─────────────────────────
  ipcMain.handle('chat:getChannelSessions', async () => {
    try {
      return ctx.getDb().getAllChannelSessions();
    } catch {
      return [];
    }
  });

  ipcMain.handle('chat:getChannelSessionMessages', async (_event, sessionId: number) => {
    try {
      const validId = requireId(sessionId, 'sessionId');
      return ctx.getDb().getChannelSessionMessages(validId);
    } catch {
      return [];
    }
  });

  // ─── Chat Messages ────────────────────────────────────────
  ipcMain.handle('chat:save', async (_event, sessionId: number, role: string, content: string, sourcesJson?: string) => {
    try {
      const id = ctx.getDb().saveChatMessage(sessionId, role, content, sourcesJson);
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:clear', async (_event, sessionId: number) => {
    try {
      ctx.getDb().clearSessionMessages(sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:deleteMessage', async (_event, messageId: number) => {
    try {
      const validId = requireId(messageId, 'messageId');
      ctx.getDb().deleteSessionMessage(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Per-recording Chat (Library Q&A) ────────────────────
  ipcMain.handle('chat:getRecordingMessages', async (_event, recordingId: number) => {
    try {
      const validId = requireId(recordingId, 'recordingId');
      return ctx.getDb().getRecordingChatMessages(validId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('chat:clearRecordingMessages', async (_event, recordingId: number) => {
    try {
      const validId = requireId(recordingId, 'recordingId');
      ctx.getDb().clearRecordingChatMessages(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('chat:deleteRecordingMessage', async (_event, messageId: number) => {
    try {
      const validId = requireId(messageId, 'messageId');
      ctx.getDb().deleteRecordingChatMessage(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── RAG ───────────────────────────────────────────────────
  ipcMain.handle('rag:query', async (_event, question: string) => {
    try {
      const validQuestion = requireString(question, 'question', 5000);
      return await ctx.getQueryEngine().query(validQuestion);
    } catch (err: any) {
      return {
        answer: `查询失败: ${err.message || 'Unknown error'}. 请确认 Local 已启动且 bge-m3、qwen3.5 模型已加载。`,
        sources: [],
      };
    }
  });

  ipcMain.handle('rag:cancelStream', () => {
    if (streamAbort) {
      streamAbort.abort();
      streamAbort = null;
    }
  });

  ipcMain.handle('rag:queryStream', async (_event, question: string, sessionId?: number) => {
    try {
      const validQuestion = requireString(question, 'question', 5000);
      const _ragSettings = loadSettings();
      const win = ctx.getWindow();
      let fullText = '';
      streamAbort = new AbortController();
      const result = await ctx.getQueryEngine().queryStream(
        validQuestion,
        (chunk) => {
          fullText += chunk;
          if (win && !win.isDestroyed()) {
            win.webContents.send('rag:stream:chunk', chunk);
          }
        },
        (status) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('rag:stream:status', status);
          }
        },
        streamAbort.signal,
      );
      streamAbort = null;
      // Save assistant response to DB from main process (reliable even if renderer unmounted)
      if (sessionId && fullText) {
        try {
          const sourcesJson = result.sources?.length > 0 ? JSON.stringify(
            result.sources.map((s, i) => ({
              id: `SEG-${String(s.segment_id || i).padStart(4, '0')}`,
              segmentId: s.segment_id || 0,
              recordingId: s.recording_id,
              time: s.time || '',
              speaker: s.speaker || 'Unknown',
              text: s.text || '',
            }))
          ) : undefined;
          ctx.getDb().saveChatMessage(sessionId, 'assistant', fullText, sourcesJson);
        } catch (err) {
          console.error('[RAG] Failed to save assistant message:', err);
        }
      }
      // Send done event with sources
      if (win && !win.isDestroyed()) {
        win.webContents.send('rag:stream:done', result.sources);
      }

      // Extract memories from chat conversation (fire-and-forget, never blocks response)
      try {
        const mm = ctx.getMemoryManager();
        if (mm && fullText) {
          const chatText = `用户: ${validQuestion}\n助手: ${fullText}`;
          const settings = loadSettings();
          const extractor = new MemoryExtractor(ctx.getLLM(), getLLMModel(settings));
          extractor.extract(chatText).then((facts) => {
            for (const fact of facts) {
              mm.addFact(fact.fact, fact.category, fact.confidence, []).catch((err) =>
                console.warn('[RAG] Chat memory save failed:', err)
              );
            }
            if (facts.length > 0) {
              console.log(`[RAG] Extracted ${facts.length} memories from chat`);
            }
          }).catch((err) => console.warn('[RAG] Chat memory extraction failed:', err));
        }
      } catch {
        // Non-critical — never break the response flow
      }

      return { success: true };
    } catch (err: any) {
      const win = ctx.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('rag:stream:error', err.message || 'Unknown error');
      }
      return { success: false, error: err.message };
    }
  });

  // ─── Scoped RAG (single recording) ─────────────────────
  ipcMain.handle('rag:cancelScopedStream', () => {
    if (scopedStreamAbort) {
      scopedStreamAbort.abort();
      scopedStreamAbort = null;
    }
  });

  ipcMain.handle('rag:scopedQueryStream', async (
    _event,
    question: string,
    recordingId: number,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => {
    try {
      const validQuestion = requireString(question, 'question', 5000);
      const validRecordingId = requireId(recordingId, 'recordingId');
      const win = ctx.getWindow();

      try {
        ctx.getDb().saveRecordingChatMessage(validRecordingId, 'user', validQuestion);
      } catch (err) {
        console.error('[RAG scoped] Failed to persist user message:', err);
      }

      const safeHistory = Array.isArray(history)
        ? history
            .filter((h) => h && typeof h.content === 'string' && (h.role === 'user' || h.role === 'assistant'))
            .map((h) => ({ role: h.role, content: h.content }))
        : undefined;

      let fullText = '';
      scopedStreamAbort = new AbortController();
      const result = await ctx.getQueryEngine().queryScopedStream(
        validQuestion,
        validRecordingId,
        (chunk) => {
          fullText += chunk;
          if (win && !win.isDestroyed()) {
            win.webContents.send('rag:scoped:chunk', chunk);
          }
        },
        (status) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('rag:scoped:status', status);
          }
        },
        scopedStreamAbort.signal,
        safeHistory,
      );
      scopedStreamAbort = null;

      if (fullText) {
        try {
          const sourcesJson = result.sources?.length > 0
            ? JSON.stringify(result.sources)
            : undefined;
          ctx.getDb().saveRecordingChatMessage(validRecordingId, 'assistant', fullText, sourcesJson);
        } catch (err) {
          console.error('[RAG scoped] Failed to persist assistant message:', err);
        }
      }

      if (win && !win.isDestroyed()) {
        win.webContents.send('rag:scoped:done', result.sources);
      }
      return { success: true };
    } catch (err: any) {
      const win = ctx.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('rag:scoped:error', err.message || 'Unknown error');
      }
      return { success: false, error: err.message };
    }
  });
}
