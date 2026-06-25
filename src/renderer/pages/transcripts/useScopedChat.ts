import { useState, useRef, useEffect, useCallback } from 'react';

export interface ScopedMessage {
  /** Stable client id so React can key against even before DB persistence. */
  clientId: string;
  /** Database row id — set once persisted. Required for per-message delete. */
  dbId?: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

function nextClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function useScopedChat(recordingId: number | undefined) {
  const [messages, setMessages] = useState<ScopedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  const streamTextRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Mirror messages so sendMessage can capture history without re-creating on every chunk.
  const messagesRef = useRef<ScopedMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Ref to current recordingId so the once-registered stream listeners can
  // reload messages without capturing a stale closure.
  const recordingIdRef = useRef<number | undefined>(recordingId);
  useEffect(() => { recordingIdRef.current = recordingId; }, [recordingId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(false);
    setStatus('');
    streamTextRef.current = '';
    if (!recordingId) {
      setMessages([]);
      return;
    }
    (async () => {
      try {
        const rows = await window.api.getRecordingChatMessages(recordingId);
        const activeStream = await window.api.getActiveScopedRagStream(recordingId).catch(() => null);
        if (cancelled) return;
        const hydrated: ScopedMessage[] = rows
          .filter((r) => r.role === 'user' || r.role === 'assistant')
          .map((r) => ({
            clientId: nextClientId(),
            dbId: r.id,
            role: r.role as 'user' | 'assistant',
            content: r.content,
          }));
        if (activeStream?.active) {
          streamTextRef.current = activeStream.text || '';
          setStatus(activeStream.status || '');
          setIsLoading(true);
          const hasQuestion = hydrated.some((m) => m.role === 'user' && m.content === activeStream.question);
          setMessages([
            ...hydrated,
            ...(hasQuestion ? [] : [{ clientId: nextClientId(), role: 'user' as const, content: activeStream.question }]),
            { clientId: nextClientId(), role: 'assistant', content: activeStream.text || '', streaming: true },
          ]);
        } else {
          setIsLoading(false);
          setStatus('');
          setMessages(hydrated);
        }
      } catch {
        if (!cancelled) {
          setMessages([]);
          setIsLoading(false);
          setStatus('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [recordingId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const api = window.api;
    if (!api.onRagScopedChunk) return;

    const unsubs = [
      api.onRagScopedStatus((_e, s) => {
        setStatus(s);
      }),
      api.onRagScopedChunk((_e, chunk) => {
        setStatus('');
        streamTextRef.current += chunk;
        const text = streamTextRef.current;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: text }];
          return prev;
        });
      }),
      api.onRagScopedDone(() => {
        const finalText = streamTextRef.current;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: finalText, streaming: false }];
          return prev;
        });
        setIsLoading(false);
        setStatus('');
        streamTextRef.current = '';
        // Re-fetch from DB to pick up dbIds for both the just-saved user
        // prompt and assistant reply (enables the delete button on them).
        const rid = recordingIdRef.current;
        if (rid != null) {
          setTimeout(() => {
            window.api.getRecordingChatMessages(rid).then((rows) => {
              const hydrated: ScopedMessage[] = rows
                .filter((r) => r.role === 'user' || r.role === 'assistant')
                .map((r) => ({
                  clientId: nextClientId(),
                  dbId: r.id,
                  role: r.role as 'user' | 'assistant',
                  content: r.content,
                }));
              setMessages(hydrated);
            }).catch(() => { /* non-fatal */ });
          }, 150);
        }
      }),
      api.onRagScopedError((_e, error) => {
        setStatus('');
        const errContent = `[Error] ${error}`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: errContent, streaming: false }];
          return [...prev, { clientId: nextClientId(), role: 'assistant', content: errContent }];
        });
        setIsLoading(false);
      }),
    ];

    return () => { unsubs.forEach((fn) => fn()); };
  }, []);

  const sendMessage = useCallback(async (question: string) => {
    if (!question.trim() || isLoading || !recordingId) return;
    streamTextRef.current = '';

    const history = messagesRef.current
      .filter((m) => !m.streaming && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { clientId: nextClientId(), role: 'user', content: question },
      { clientId: nextClientId(), role: 'assistant', content: '', streaming: true },
    ]);
    setIsLoading(true);

    try {
      await window.api.ragScopedQueryStream(question, recordingId, history);
    } catch {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: '[Error] Failed to send query', streaming: false }];
        return prev;
      });
      setIsLoading(false);
    }
  }, [isLoading, recordingId]);

  const clearMessages = useCallback(async () => {
    if (recordingId) {
      try { await window.api.clearRecordingChatMessages(recordingId); } catch { /* UI clears anyway */ }
    }
    setMessages([]);
    setIsLoading(false);
    setStatus('');
    streamTextRef.current = '';
  }, [recordingId]);

  /** Delete a single message from DB + local state. No-op if still streaming. */
  const deleteMessage = useCallback(async (clientId: string) => {
    const msg = messagesRef.current.find((m) => m.clientId === clientId);
    if (!msg || msg.streaming) return;
    if (msg.dbId) {
      try { await window.api.deleteRecordingChatMessage(msg.dbId); } catch { /* non-fatal */ }
    }
    setMessages((prev) => prev.filter((m) => m.clientId !== clientId));
  }, []);

  /** Request that the input be prefilled with this message's content. */
  const editMessage = useCallback((clientId: string) => {
    const msg = messagesRef.current.find((m) => m.clientId === clientId);
    if (!msg || msg.role !== 'user') return;
    setPendingEdit(msg.content);
  }, []);

  /** Consume the pending edit payload. Parent should read + clear after applying. */
  const consumePendingEdit = useCallback(() => {
    const text = pendingEdit;
    setPendingEdit(null);
    return text;
  }, [pendingEdit]);

  return {
    messages, isLoading, status, sendMessage, clearMessages, messagesEndRef,
    deleteMessage, editMessage, pendingEdit, consumePendingEdit,
  };
}
