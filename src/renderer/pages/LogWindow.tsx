import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, Download, Trash2, Search, Pause, Play } from 'lucide-react';
import { useApi, type AppLogEntry, type AppLogLevel, type AppLogSource } from '../hooks/useApi';
import { getVirtualRange } from './logs/virtual-range';

type LevelFilter = 'all' | AppLogLevel;
type SourceFilter = 'all' | AppLogSource;

const ROW_HEIGHT = 38;
const LEVELS: LevelFilter[] = ['all', 'debug', 'info', 'warn', 'error'];
const SOURCES: SourceFilter[] = ['all', 'main', 'renderer'];

function levelColor(level: AppLogLevel): string {
  if (level === 'error') return '#ef4444';
  if (level === 'warn') return '#f59e0b';
  if (level === 'debug') return '#8b8b94';
  return '#10b981';
}

function formatLogLine(entry: AppLogEntry): string {
  const base = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}:${entry.scope}] ${entry.message}`;
  return entry.details ? `${base}\n${entry.details}` : base;
}

function formatLogText(entries: AppLogEntry[]): string {
  return entries.map(formatLogLine).join('\n');
}

function countByLevel(entries: AppLogEntry[], level: AppLogLevel): number {
  return entries.filter((entry) => entry.level === level).length;
}

export default function LogWindow() {
  const api = useApi();
  const [logs, setLogs] = useState<AppLogEntry[]>([]);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [followTail, setFollowTail] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.title = 'DeepSeno - Logs';
    api.getAppLogs().then(setLogs).catch((err) => {
      setStatus(`读取日志失败：${err instanceof Error ? err.message : String(err)}`);
    });
    const off = api.onAppLogEntry((_event, entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    return off;
  }, [api]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const resize = () => setViewportHeight(node.clientHeight || 520);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!followTail) return;
    const node = scrollerRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [logs.length, followTail]);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (source !== 'all' && entry.source !== source) return false;
      if (!q) return true;
      return [
        entry.timestamp,
        entry.level,
        entry.source,
        entry.scope,
        entry.message,
        entry.details || '',
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [logs, level, source, query]);

  const range = getVirtualRange(filteredLogs.length, scrollTop, viewportHeight, ROW_HEIGHT, 12);
  const visibleLogs = filteredLogs.slice(range.start, range.end);

  const handleScroll = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    setScrollTop(node.scrollTop);
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setFollowTail(distanceToBottom < 80);
  }, []);

  const handleCopyAll = useCallback(async () => {
    await api.clipboardWriteText(formatLogText(logs));
    setStatus(`已复制 ${logs.length} 条日志`);
  }, [api, logs]);

  const handleExport = useCallback(async () => {
    const result = await api.exportAppLogs();
    if (result.canceled) {
      setStatus('已取消导出');
    } else {
      setStatus(`已导出 ${result.count} 条日志`);
    }
  }, [api]);

  const handleClear = useCallback(async () => {
    await api.clearAppLogs();
    setLogs([]);
    setStatus('已清空当前内存日志');
  }, [api]);

  return (
    <div
      style={{
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#0a0a0b',
        color: '#ececef',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div
        className="log-window__topbar"
        style={{
          height: 76,
          minWidth: 1180,
          padding: '16px 22px 12px 96px',
          display: 'grid',
          gridTemplateColumns: '170px max-content max-content minmax(220px, 1fr) max-content',
          alignItems: 'center',
          columnGap: 12,
          borderBottom: '1px solid #242429',
          background: '#101013',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 166 }}>
          <div style={{ fontSize: 14, fontWeight: 650 }}>DeepSeno Logs</div>
          <div style={{ fontSize: 11, color: '#8b8b94', marginTop: 2 }}>
            {logs.length} total · {filteredLogs.length} visible
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {LEVELS.map((item) => (
            <button
              key={item}
              onClick={() => setLevel(item)}
              style={{
                width: 66,
                height: 44,
                padding: '0 8px',
                border: '1px solid #2b2b31',
                borderRadius: 6,
                background: level === item ? '#00d084' : '#141418',
                color: level === item ? '#03130c' : '#c8c8cf',
                fontWeight: 600,
                display: 'inline-flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                flexShrink: 0,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 10, lineHeight: 1 }}>
                {item === 'all' ? 'ALL' : item.toUpperCase()}
              </span>
              <span style={{ fontSize: 12, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                {item === 'all' ? logs.length : countByLevel(logs, item)}
              </span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {SOURCES.map((item) => (
            <button
              key={item}
              onClick={() => setSource(item)}
              style={{
                height: 44,
                minWidth: item === 'all' ? 86 : item === 'renderer' ? 84 : 62,
                padding: '0 12px',
                border: '1px solid #2b2b31',
                borderRadius: 6,
                background: source === item ? '#2b2b31' : '#141418',
                color: '#c8c8cf',
                fontSize: 11,
                lineHeight: 1,
                flexShrink: 0,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              {item === 'all' ? 'all sources' : item}
            </button>
          ))}
        </div>

        <label
          style={{
            height: 42,
            minWidth: 220,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 10px',
            border: '1px solid #2b2b31',
            borderRadius: 6,
            background: '#0d0d10',
            overflow: 'hidden',
          }}
        >
          <Search size={13} color="#8b8b94" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search logs..."
            style={{
              width: '100%',
              border: 0,
              outline: 'none',
              background: 'transparent',
              color: '#ececef',
              fontSize: 12,
            }}
          />
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setFollowTail((prev) => !prev)}
            title={followTail ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            style={{
              width: 58,
              minWidth: 58,
              height: 42,
              border: '1px solid #2b2b31',
              borderRadius: 6,
              background: followTail ? '#123126' : '#141418',
              color: '#d7d7dd',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            {followTail ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button className="kz-btn kz-btn--sm" onClick={handleCopyAll} style={{ height: 42, minWidth: 100, justifyContent: 'center', flexShrink: 0 }}>
            <ClipboardCopy size={13} /> 复制全部
          </button>
          <button className="kz-btn kz-btn--sm" onClick={handleExport} style={{ height: 42, minWidth: 78, justifyContent: 'center', flexShrink: 0 }}>
            <Download size={13} /> 导出
          </button>
          <button className="kz-btn kz-btn--ghost kz-btn--sm" onClick={handleClear} style={{ height: 42, minWidth: 78, justifyContent: 'center', flexShrink: 0 }}>
            <Trash2 size={13} /> 清空
          </button>
        </div>
      </div>

      <div
        style={{
          height: 28,
          padding: '0 18px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #202026',
          background: '#0d0d10',
          color: status ? '#b8f7d6' : '#74747d',
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        {status || '日志仅保存在内存中。复制或导出时会包含当前缓冲区里的所有前端与主进程日志。'}
      </div>

      <div
        style={{
          height: 30,
          display: 'grid',
          gridTemplateColumns: '210px 76px 92px 150px 1fr',
          gap: 0,
          alignItems: 'center',
          padding: '0 18px',
          color: '#74747d',
          background: '#101013',
          borderBottom: '1px solid #202026',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.08,
          flexShrink: 0,
        }}
      >
        <div>time</div>
        <div>level</div>
        <div>source</div>
        <div>scope</div>
        <div>message</div>
      </div>

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
          background: '#08080a',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        <div style={{ height: range.totalHeight, position: 'relative' }}>
          <div
            style={{
              transform: `translateY(${range.offsetTop}px)`,
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
            }}
          >
            {visibleLogs.map((entry) => (
              <div
                key={entry.id}
                title={formatLogLine(entry)}
                style={{
                  height: ROW_HEIGHT,
                  display: 'grid',
                  gridTemplateColumns: '210px 76px 92px 150px 1fr',
                  alignItems: 'center',
                  padding: '0 18px',
                  borderBottom: '1px solid #18181d',
                  color: '#d7d7dd',
                  fontSize: 11.5,
                  overflow: 'hidden',
                }}
              >
                <div style={{ color: '#8b8b94', whiteSpace: 'nowrap' }}>{entry.timestamp}</div>
                <div>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 18,
                      padding: '0 6px',
                      borderRadius: 4,
                      background: `${levelColor(entry.level)}22`,
                      color: levelColor(entry.level),
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    {entry.level}
                  </span>
                </div>
                <div style={{ color: entry.source === 'main' ? '#93c5fd' : '#c4b5fd' }}>{entry.source}</div>
                <div style={{ color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.scope}
                </div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.message}
                  {entry.details && (
                    <span style={{ color: '#7b7b84' }}> · {entry.details}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {filteredLogs.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#74747d', fontSize: 13 }}>
            暂无匹配日志
          </div>
        )}
      </div>
    </div>
  );
}
