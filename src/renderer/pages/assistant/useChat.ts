import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useApi, ChatMessageRow, RagSource, ChannelSessionRow, ActiveRagStream } from '../../hooks/useApi';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useNotifications } from '../../components/NotificationCenter';
import { Translations } from '../../i18n';
import { ChatMessage, Source, Session, UnifiedSession, nextMsgId, parseDbTime } from './types';

export function useChat(a: Translations['asst']) {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useNotifications();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Core state
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextMsgId(), role: 'system', content: a.welcome },
  ]);
  const [copiedIdx, setCopiedIdx] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [allCopied, setAllCopied] = useState(false);

  // Session state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [channelSessions, setChannelSessions] = useState<ChannelSessionRow[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [activeSessionType, setActiveSessionType] = useState<'local' | 'channel'>('local');
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Streaming / timer refs
  const streamTextRef = useRef('');
  const streamIdRef = useRef(0);
  const firstMessageSent = useRef(false);
  const [streamStatus, setStreamStatus] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const aRef = useRef(a);
  useEffect(() => { aRef.current = a; }, [a]);
  // Ref to latest loadSessions so the once-only stream subscription effect
  // never calls a stale closure that captures first-render state.
  const loadSessionsRef = useRef<() => Promise<void>>(async () => {});
  // Active session id ref — used by stream callbacks (registered once) to
  // reload messages and pick up newly-saved dbIds without stale closures.
  const activeSessionIdRef = useRef<number | null>(null);
  // Ref to latest loadSessionMessages so the once-only stream subscription
  // can backfill dbIds after the assistant reply is persisted.
  const loadSessionMessagesRef = useRef<(id: number) => Promise<void>>(async () => {});

  // Elapsed timer
  useEffect(() => {
    if (isLoading) {
      setElapsed(0);
      elapsedRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);
    } else {
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
      setElapsed(0);
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current); };
  }, [isLoading]);

  // Build unified session list
  const channelLabels = a.channel_labels || {};
  const unifiedSessions = useMemo<UnifiedSession[]>(() => {
    const local: UnifiedSession[] = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updated_at,
      type: 'local' as const,
    }));
    // 'app' is the synthetic channel used by in-app agent-mode calls
    // (agentExecutor.execute('app', 'local-user', ...) writes into channel_sessions
    // for context memory). These are the user's own local turns — surfacing them
    // again as separate "app · local-user" sessions duplicates the local list.
    const channel: UnifiedSession[] = channelSessions
      .filter((cs) => cs.channel_id !== 'app')
      .map((cs) => {
        const label = channelLabels[cs.channel_id] || cs.channel_id;
        // Derive title: summary → first 30 chars, or fallback
        let title = cs.summary ? cs.summary.slice(0, 30) : `${cs.user_id}`;
        return {
          id: cs.id,
          title,
          updatedAt: new Date(cs.ended_at || cs.started_at).toISOString(),
          type: 'channel' as const,
          channelId: cs.channel_id,
          channelLabel: label,
          readOnly: true,
        };
      });
    // Sort by real timestamp — local and channel sessions use different string
    // formats ("YYYY-MM-DD HH:MM:SS" vs ISO with Z), which makes a plain
    // localeCompare put fresh local sessions below older channel ones.
    return [...local, ...channel].sort((a, b) => parseDbTime(b.updatedAt) - parseDbTime(a.updatedAt));
  }, [sessions, channelSessions, channelLabels]);

  // Load sessions on mount
  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { loadSessionsRef.current = loadSessions; });
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { loadSessionMessagesRef.current = loadSessionMessages; });

  async function loadSessions() {
    const [list, chList] = await Promise.all([
      api.getSessions(),
      api.getChannelSessions(),
    ]);
    setChannelSessions(chList);
    if (list.length === 0) {
      const result = await api.createSession(a.new_chat_title);
      if (result.success && result.id) {
        const refreshed = await api.getSessions();
        setSessions(refreshed);
        setActiveSessionId(result.id);
        setActiveSessionType('local');
      }
    } else {
      setSessions(list);
      if (!activeSessionId || !list.find((s) => s.id === activeSessionId)) {
        if (activeSessionType !== 'channel') {
          setActiveSessionId(list[0].id);
          setActiveSessionType('local');
        }
      }
    }
  }

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) return;
    cancelledRef.current = false;
    firstMessageSent.current = false;
    if (activeSessionType === 'channel') {
      loadChannelSessionMessages(activeSessionId);
    } else {
      loadSessionMessages(activeSessionId);
    }
  }, [activeSessionId, activeSessionType]);

  async function loadSessionMessages(sessionId: number) {
    try {
      const rows = await api.getSessionMessages(sessionId);
      let activeStream: ActiveRagStream | null = null;
      try {
        activeStream = await api.getActiveRagStream(sessionId);
      } catch {
        activeStream = null;
      }
      if (!rows || rows.length === 0) {
        const baseMessages: ChatMessage[] = [{ id: nextMsgId(), role: 'system', content: a.welcome }];
        if (activeStream?.active) {
          streamTextRef.current = activeStream.text || '';
          setStreamStatus(activeStream.status || '');
          setIsLoading(true);
          cancelledRef.current = false;
          firstMessageSent.current = true;
          setMessages([
            ...baseMessages,
            { id: nextMsgId(), role: 'user', content: activeStream.question },
            { id: nextMsgId(), role: 'assistant', content: activeStream.text || '', streaming: true },
          ]);
        } else {
          setIsLoading(false);
          setStreamStatus('');
          setMessages(baseMessages);
        }
        return;
      }
      const loaded: ChatMessage[] = rows.map((r: ChatMessageRow) => {
        let sources: Source[] | undefined;
        if (r.sources_json) {
          try { sources = JSON.parse(r.sources_json); } catch { /* ignore */ }
        }
        return { id: nextMsgId(), dbId: r.id, role: r.role as ChatMessage['role'], content: r.content || '', sources };
      });
      const baseMessages: ChatMessage[] = [{ id: nextMsgId(), role: 'system', content: a.welcome }, ...loaded];
      if (activeStream?.active) {
        streamTextRef.current = activeStream.text || '';
        setStreamStatus(activeStream.status || '');
        setIsLoading(true);
        cancelledRef.current = false;
        const hasQuestion = loaded.some((m) => m.role === 'user' && m.content === activeStream.question);
        setMessages([
          ...baseMessages,
          ...(hasQuestion ? [] : [{ id: nextMsgId(), role: 'user' as const, content: activeStream.question }]),
          { id: nextMsgId(), role: 'assistant', content: activeStream.text || '', streaming: true },
        ]);
      } else {
        setIsLoading(false);
        setStreamStatus('');
        setMessages(baseMessages);
      }
      firstMessageSent.current = loaded.some((m) => m.role === 'user') || !!activeStream?.active;
    } catch (err) {
      console.error('[Assistant] Failed to load session messages:', err);
      setMessages([{ id: nextMsgId(), role: 'system', content: a.welcome }]);
      setIsLoading(false);
      setStreamStatus('');
    }
  }

  async function loadChannelSessionMessages(sessionId: number) {
    try {
      const rows = await api.getChannelSessionMessages(sessionId);
      if (!rows || rows.length === 0) {
        setMessages([]);
        return;
      }
      const loaded: ChatMessage[] = rows.map((r) => ({
        id: nextMsgId(),
        role: r.role as ChatMessage['role'],
        content: r.content || '',
      }));
      setMessages(loaded);
    } catch (err) {
      console.error('[Assistant] Failed to load channel session messages:', err);
      setMessages([]);
    }
  }

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Handle query param from Dashboard
  const queryParamHandled = useRef(false);
  useEffect(() => {
    const q = searchParams.get('query');
    if (q && activeSessionId && !isLoading && !queryParamHandled.current) {
      queryParamHandled.current = true;
      setSearchParams({}, { replace: true });
      setInput(q);
      setTimeout(() => { handleSend(q); }, 100);
    }
  }, [searchParams, activeSessionId, isLoading]);

  // Handle context param from Transcripts (e.g. ?context=recording:123)
  const contextParamHandled = useRef(false);
  useEffect(() => {
    const ctx = searchParams.get('context');
    if (ctx && activeSessionId && !isLoading && !contextParamHandled.current) {
      contextParamHandled.current = true;
      setSearchParams({}, { replace: true });
      const match = ctx.match(/^recording:(\d+)$/);
      if (match) {
        const recordingId = match[1];
        const query = a.summarize_content?.(recordingId) ?? `Summarize content #${recordingId}`;
        setInput(query);
        setTimeout(() => { handleSend(query); }, 100);
      }
    }
  }, [searchParams, activeSessionId, isLoading]);

  // Subscribe to streaming events
  useEffect(() => {
    const unsubs = [
      api.onRagStreamStatus((_e, status) => {
        if (cancelledRef.current) return;
        setStreamStatus(status);
      }),
      api.onRagStreamChunk((_e, chunk) => {
        if (cancelledRef.current) return;
        setStreamStatus('');
        streamTextRef.current += chunk;
        const text = streamTextRef.current;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: text }];
          return prev;
        });
      }),
      api.onRagStreamDone((_e, rawSources: RagSource[]) => {
        if (cancelledRef.current) return;
        const sources: Source[] = (rawSources ?? []).map((s: RagSource, i: number) => ({
          id: `SEG-${String(s.segment_id || i).padStart(4, '0')}`,
          segmentId: s.segment_id || 0,
          time: s.time || '',
          speaker: s.speaker || 'Unknown',
          text: s.text || '',
        }));
        const finalText = streamTextRef.current;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) {
            return [...prev.slice(0, -1), { ...last, content: finalText, streaming: false, sources: sources.length > 0 ? sources : undefined }];
          }
          return prev;
        });
        setIsLoading(false);
        setStreamStatus('');
        loadSessionsRef.current();
        // Reload messages from DB so the just-persisted pair picks up dbIds
        // for the delete-message action. Slight delay lets the backend finish
        // the UPDATE/INSERT transaction.
        const sid = activeSessionIdRef.current;
        if (sid != null) {
          setTimeout(() => {
            loadSessionMessagesRef.current(sid).catch(() => { /* non-fatal */ });
          }, 150);
        }
      }),
      api.onRagStreamError((_e, error) => {
        if (cancelledRef.current) return;
        setStreamStatus('');
        const errContent = `[${aRef.current.error}] ${error}`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: errContent, streaming: false }];
          return [...prev, { id: nextMsgId(), role: 'assistant', content: errContent }];
        });
        setIsLoading(false);
      }),
    ];
    return () => {
      cancelledRef.current = true;
      unsubs.forEach((fn) => fn());
    };
  }, []);

  // --- Handlers ---

  const handleSend = useCallback(async (directQuery?: string) => {
    const text = directQuery ?? input.trim();
    if (!text || isLoading || !activeSessionId) return;
    const query = text;
    setInput('');
    streamTextRef.current = '';
    cancelledRef.current = false;
    streamIdRef.current += 1;

    if (!firstMessageSent.current) {
      firstMessageSent.current = true;
      const title = query.slice(0, 30);
      try { await api.renameSession(activeSessionId, title); } catch {}
      setSessions((prev) => prev.map((s) => s.id === activeSessionId ? { ...s, title } : s));
    }

    let userDbId: number | undefined;
    try {
      const saved = await api.saveChatMessage(activeSessionId, 'user', query);
      if (saved.success && saved.id) userDbId = saved.id;
    } catch { /* ignore */ }

    setMessages((prev) => [
      ...prev,
      { id: nextMsgId(), dbId: userDbId, role: 'user', content: query },
      { id: nextMsgId(), role: 'assistant', content: '', streaming: true },
    ]);
    setIsLoading(true);

    try {
      if (agentMode) {
        const result = await api.agentChat(query);
        const content = result.success ? (result.text || '') : `[Error] ${result.error}`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.streaming) return [...prev.slice(0, -1), { ...last, content, streaming: false }];
          return prev;
        });
        setIsLoading(false);
        if (activeSessionId) {
          try { await api.saveChatMessage(activeSessionId, 'assistant', content); } catch {}
        }
        return;
      }
      await api.ragQueryStream(query, activeSessionId);
    } catch {
      const errContent = `[${a.error}] ${a.error_desc}`;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) return [...prev.slice(0, -1), { ...last, content: errContent, streaming: false }];
        return prev;
      });
      if (activeSessionId) {
        try { await api.saveChatMessage(activeSessionId, 'assistant', errContent); } catch {}
      }
      setIsLoading(false);
    }
  }, [input, isLoading, api, a, activeSessionId, agentMode]);

  async function handleNewSession() {
    const result = await api.createSession(a.new_chat_title);
    if (result.success && result.id) {
      await loadSessions();
      setActiveSessionId(result.id);
    }
  }

  async function handleDeleteSession(id: number) {
    await api.deleteSession(id);
    setDeleteConfirmId(null);
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const result = await api.createSession(a.new_chat_title);
      if (result.success && result.id) {
        await loadSessions();
        setActiveSessionId(result.id);
      }
    } else {
      setSessions(remaining);
      if (activeSessionId === id) setActiveSessionId(remaining[0].id);
    }
  }

  function handleStartRename(session: Session) {
    setEditingSessionId(session.id);
    setEditTitle(session.title);
  }

  async function handleFinishRename() {
    if (editingSessionId && editTitle.trim()) {
      await api.renameSession(editingSessionId, editTitle.trim());
      setSessions((prev) => prev.map((s) => s.id === editingSessionId ? { ...s, title: editTitle.trim() } : s));
    }
    setEditingSessionId(null);
  }

  function handleStop() {
    cancelledRef.current = true;
    streamTextRef.current = '';
    api.ragCancelStream().catch(() => {});
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.streaming) return [...prev.slice(0, -1), { ...last, streaming: false }];
      return prev;
    });
    setIsLoading(false);
  }

  function handleCopy(text: string, msgIdx: string) {
    window.api.clipboardWriteText(text).then(() => {
      setCopiedIdx(msgIdx);
      setTimeout(() => setCopiedIdx(null), 2000);
    });
  }

  /** Remove a single message (from DB + local state). */
  async function handleDeleteMessage(msgId: string) {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.streaming) return;
    if (msg.dbId) {
      try { await api.deleteChatMessage(msg.dbId); } catch { /* non-fatal; UI still removes */ }
    }
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  }

  /** Put a user message's content back into the input for re-sending. */
  function handleEditMessage(msgId: string) {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'user') return;
    setInput(msg.content);
  }

  function handleCopyAllMd() {
    const today = new Date().toISOString().split('T')[0];
    const lines: string[] = [`# ${a.chat_record_title}`, `> ${today}`, ''];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') {
        lines.push(`## Q: ${msg.content}`, '');
      } else {
        lines.push(msg.content, '');
        if (msg.sources && msg.sources.length > 0) {
          lines.push(`**${a.sources_label}**`);
          for (const src of msg.sources) lines.push(`- ${src.id} ${src.speaker} [${src.time}] ${src.text}`);
          lines.push('');
        }
        lines.push('---', '');
      }
    }
    window.api.clipboardWriteText(lines.join('\n')).then(() => {
      setAllCopied(true);
      toast('success', a.copy_all_done);
      setTimeout(() => setAllCopied(false), 2000);
    });
  }

  function handleSourceClick(src: Source) {
    if (src.recordingId) navigate(`/library?recording=${src.recordingId}&segment=${src.segmentId}`);
    else navigate('/library');
  }

  function handleToggleSourceExpand(msgId: string) {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }

  function handleClearRequest() {
    if (!isLoading && activeSessionId) setShowClearConfirm(true);
  }

  function handleClearConfirm() {
    if (!activeSessionId) return;
    setMessages([{ id: nextMsgId(), role: 'system', content: a.welcome }]);
    setExpandedSources(new Set());
    api.clearChatMessages(activeSessionId);
    firstMessageSent.current = false;
    setShowClearConfirm(false);
  }

  function handleClearCancel() {
    setShowClearConfirm(false);
  }

  function handleSelectUnifiedSession(session: UnifiedSession) {
    setActiveSessionId(session.id);
    setActiveSessionType(session.type);
  }

  const isChannelSession = activeSessionType === 'channel';
  const activeChannelLabel = isChannelSession
    ? unifiedSessions.find((s) => s.id === activeSessionId && s.type === 'channel')?.channelLabel || ''
    : '';
  const hasConversation = messages.some((m) => m.role === 'user');

  return {
    // State
    input, setInput,
    isLoading,
    messages,
    sessions,
    unifiedSessions,
    activeSessionId, setActiveSessionId,
    activeSessionType,
    isChannelSession,
    activeChannelLabel,
    editingSessionId, setEditingSessionId,
    editTitle, setEditTitle,
    deleteConfirmId, setDeleteConfirmId,
    agentMode, setAgentMode,
    showClearConfirm,
    streamStatus,
    elapsed,
    copiedIdx,
    expandedSources,
    allCopied,
    hasConversation,
    messagesEndRef,
    // Handlers
    handleSend,
    handleNewSession,
    handleDeleteSession,
    handleStartRename,
    handleFinishRename,
    handleSelectUnifiedSession,
    handleStop,
    handleCopy,
    handleCopyAllMd,
    handleSourceClick,
    handleToggleSourceExpand,
    handleClearRequest,
    handleClearConfirm,
    handleClearCancel,
    handleDeleteMessage,
    handleEditMessage,
  };
}
