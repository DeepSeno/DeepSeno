import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import {
  Search,
  ArrowRight,
  Globe,
  FileText,
  BarChart3,
  MessageSquare,
  Import,
  Settings,
  LayoutDashboard,
  Bot,
  Puzzle,
  BookOpen,
} from 'lucide-react';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface SearchResult {
  id: number;
  recording_id?: number;
  speaker_name?: string | null;
  recording_name?: string | null;
  start_time?: number;
  clean_text?: string | null;
  raw_text?: string | null;
}

interface Command {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
}

function formatTime(seconds: number | undefined): string {
  if (seconds == null) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { t, lang, setLang } = useI18n();
  const api = useApi();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCommandMode = query.startsWith('>');
  const searchQuery = isCommandMode ? '' : query.trim();
  const commandFilter = isCommandMode ? query.slice(1).trim().toLowerCase() : '';

  // Build commands list
  const commands: Command[] = useMemo(() => {
    const pages: { key: string; route: string; icon: React.ReactNode }[] = [
      { key: 'dashboard', route: '/', icon: <LayoutDashboard size={16} /> },
      { key: 'sources', route: '/sources', icon: <Import size={16} /> },
      { key: 'library', route: '/library', icon: <BookOpen size={16} /> },
      { key: 'assistant', route: '/assistant', icon: <MessageSquare size={16} /> },
      { key: 'reports', route: '/reports', icon: <BarChart3 size={16} /> },
      { key: 'agent', route: '/agent', icon: <Bot size={16} /> },
      { key: 'skills', route: '/plugins', icon: <Puzzle size={16} /> },
      { key: 'settings', route: '/settings', icon: <Settings size={16} /> },
    ];

    const cmds: Command[] = pages.map((p) => ({
      id: `goto-${p.key}`,
      label: `${t.cmd.go_to} ${t.menu[p.key as keyof typeof t.menu]}`,
      icon: p.icon,
      action: () => {
        navigate(p.route);
        onClose();
      },
    }));

    cmds.push({
      id: 'generate-daily',
      label: t.cmd.generate_daily,
      icon: <FileText size={16} />,
      action: () => {
        const today = new Date().toISOString().split('T')[0];
        api.generateDailySummary(today);
        navigate('/reports');
        onClose();
      },
    });

    cmds.push({
      id: 'switch-lang',
      label: t.cmd.switch_lang,
      icon: <Globe size={16} />,
      action: () => {
        setLang(lang === 'en' ? 'zh' : 'en');
        onClose();
      },
    });

    return cmds;
  }, [t, lang, setLang, navigate, onClose, api]);

  // Filter commands in command mode
  const filteredCommands = useMemo(() => {
    if (!commandFilter) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(commandFilter));
  }, [commands, commandFilter]);

  // Total selectable items
  const totalItems = isCommandMode ? filteredCommands.length : results.length + (query === '' ? commands.length : 0);

  // Reset state when palette opens/closes
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setLoading(false);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (isCommandMode || !searchQuery) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.searchSegments(searchQuery);
        setResults(res.slice(0, 8));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, isCommandMode, open, api]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [totalItems]);

  // Execute selected item
  const executeItem = useCallback(
    (index: number) => {
      if (isCommandMode) {
        const cmd = filteredCommands[index];
        if (cmd) cmd.action();
      } else if (results.length > 0 && index < results.length) {
        // Navigate to transcript with the recording + segment
        const seg = results[index];
        if (seg) {
          const params = new URLSearchParams();
          if (seg.recording_id) params.set('recording', String(seg.recording_id));
          params.set('segment', String(seg.id));
          navigate(`/library?${params.toString()}`);
          onClose();
        }
      } else {
        // It's a command from the default list
        const cmdIndex = index - results.length;
        const cmd = commands[cmdIndex];
        if (cmd) cmd.action();
      }
    },
    [isCommandMode, filteredCommands, results, commands, navigate, onClose]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(totalItems, 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        executeItem(selectedIndex);
        return;
      }
    },
    [onClose, totalItems, selectedIndex, executeItem]
  );

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  const sectionLabelClass = 'kz-serif-italic kz-text-mute px-4 pt-3 pb-1.5';
  const sectionLabelStyle = { fontSize: '11.5px' };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[4.5rem] kz-anim-in"
      style={{ background: 'oklch(0.3 0.02 60 / 0.35)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="kz-paper w-full max-w-xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input — search-wrap style */}
        <div
          className="flex items-center gap-3 px-4"
          style={{ height: '48px', borderBottom: '1px solid var(--line-soft)' }}
        >
          <Search size={16} className="kz-text-mute shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.cmd.placeholder}
            aria-label="Command palette search"
            className="flex-1 bg-transparent outline-none kz-text-ink"
            style={{ fontSize: '13px', fontStyle: query ? 'normal' : undefined }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="head__kbd shrink-0">ESC</kbd>
        </div>

        {/* Results / Commands list */}
        <div ref={listRef} className="max-h-80 overflow-y-auto">
          {isCommandMode ? (
            // Command mode
            <>
              <div className={sectionLabelClass} style={sectionLabelStyle}>
                {t.cmd.commands}
              </div>
              {filteredCommands.length === 0 ? (
                <div className="px-4 py-6 kz-text-mute text-center" style={{ fontSize: '12px' }}>
                  {t.cmd.no_results}
                </div>
              ) : (
                filteredCommands.map((cmd, i) => (
                  <div
                    key={cmd.id}
                    data-selected={i === selectedIndex}
                    className={`kz-row-hover flex items-center gap-3 px-4 py-2 ${
                      i === selectedIndex ? 'kz-row-selected' : ''
                    }`}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span className="kz-text-soft">{cmd.icon}</span>
                    <span className="flex-1 kz-text-ink" style={{ fontSize: '12.5px' }}>{cmd.label}</span>
                    <ArrowRight size={12} className="kz-text-faint" />
                  </div>
                ))
              )}
            </>
          ) : (
            // Search mode (or empty / default)
            <>
              {/* Search results */}
              {searchQuery && (
                <>
                  <div className={sectionLabelClass} style={sectionLabelStyle}>
                    {t.cmd.search_results}
                  </div>
                  {loading ? (
                    <div className="px-4 py-4 kz-text-mute text-center kz-mono" style={{ fontSize: '11.5px' }}>...</div>
                  ) : results.length === 0 ? (
                    <div className="px-4 py-6 kz-text-mute text-center" style={{ fontSize: '12px' }}>
                      {t.cmd.no_results}
                    </div>
                  ) : (
                    results.map((seg, i) => (
                      <div
                        key={seg.id}
                        data-selected={i === selectedIndex}
                        className={`kz-row-hover flex flex-col gap-0.5 px-4 py-2 ${
                          i === selectedIndex ? 'kz-row-selected' : ''
                        }`}
                        onClick={() => executeItem(i)}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <div className="flex items-center gap-2 kz-mono kz-text-mute" style={{ fontSize: '10.5px' }}>
                          <span className="kz-text-soft" style={{ fontWeight: 500 }}>
                            {seg.speaker_name || 'Person'}
                          </span>
                          <span className="kz-text-faint">|</span>
                          <span>{formatTime(seg.start_time)}</span>
                          {seg.recording_name && (
                            <>
                              <span className="kz-text-faint">|</span>
                              <span className="truncate max-w-[140px]">{seg.recording_name}</span>
                            </>
                          )}
                        </div>
                        <div className="kz-text-soft" style={{ fontSize: '12px', lineHeight: 1.55 }}>
                          {truncate(seg.clean_text || seg.raw_text || '', 120)}
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}

              {/* Commands (when no search query) */}
              {!searchQuery && (
                <>
                  <div className={sectionLabelClass} style={sectionLabelStyle}>
                    {t.cmd.commands}
                  </div>
                  {commands.map((cmd, i) => {
                    const itemIndex = results.length + i;
                    return (
                      <div
                        key={cmd.id}
                        data-selected={itemIndex === selectedIndex}
                        className={`kz-row-hover flex items-center gap-3 px-4 py-2 ${
                          itemIndex === selectedIndex ? 'kz-row-selected' : ''
                        }`}
                        onClick={() => cmd.action()}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <span className="kz-text-soft">{cmd.icon}</span>
                        <span className="flex-1 kz-text-ink" style={{ fontSize: '12.5px' }}>{cmd.label}</span>
                        <ArrowRight size={12} className="kz-text-faint" />
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
