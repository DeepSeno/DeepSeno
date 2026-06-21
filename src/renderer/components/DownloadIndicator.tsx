import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronUp,
  ChevronDown,
  X,
  SkipForward,
  RefreshCw,
} from 'lucide-react';
import { useApi, type DownloadManagerState, type DownloadItem } from '../hooks/useApi';
import { useI18n } from '../i18n';

// ─── Status icon for each download item ─────────────────
function StatusIcon({ status }: { status: DownloadItem['status'] }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />;
    case 'downloading':
      return <Loader2 size={13} className="text-blue-500 animate-spin shrink-0" />;
    case 'error':
      return <XCircle size={13} className="text-red-500 shrink-0" />;
    case 'skipped':
      return <SkipForward size={13} className="text-neutral-400 shrink-0" />;
    default:
      return <div className="w-[13px] h-[13px] rounded-full border border-neutral-300 shrink-0" />;
  }
}

// ─── Single download row in expanded view ────────────────
function DownloadRow({ item, onRestart }: { item: DownloadItem; onRestart?: (id: string) => void }) {
  const isActive = item.status === 'downloading';
  const canRestart = item.status === 'done' || item.status === 'error';
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <StatusIcon status={item.status} />
      <span
        className={`text-[11px] truncate flex-1 ${
          isActive ? 'text-neutral-900' : item.status === 'error' ? 'text-red-600' : 'text-neutral-500'
        }`}
      >
        {item.label}
      </span>
      {isActive && (
        <span className="text-[11px] text-blue-600 tabular-nums shrink-0">
          {Math.round(item.progress)}%
        </span>
      )}
      {item.status === 'error' && item.error && (
        <span className="text-[10px] text-red-400 truncate max-w-[120px]" title={item.error}>
          {item.error}
        </span>
      )}
      {canRestart && onRestart && (
        <button
          onClick={() => onRestart(item.id)}
          className="p-0.5 hover:bg-neutral-100 rounded cursor-pointer shrink-0"
          title="Re-download"
        >
          <RefreshCw size={11} className="text-neutral-400 hover:text-neutral-600" />
        </button>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────
export default function DownloadIndicator() {
  const api = useApi();
  const { t } = useI18n();
  const [state, setState] = useState<DownloadManagerState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch initial state once
  useEffect(() => {
    api.bgdownloadGetState().then((s) => {
      if (s) setState(s);
    });
  }, [api]);

  // Subscribe to state updates
  useEffect(() => {
    const unsub = api.onBgdownloadState((_event, s) => {
      setState(s);
      // Reset dismissed when new downloads start
      if (s.active) setDismissed(false);
    });
    return unsub;
  }, [api]);

  // Auto-dismiss 5 seconds after all done
  const allDone = state?.items.every((i) => i.status === 'done' || i.status === 'skipped');
  const hasErrors = state?.items.some((i) => i.status === 'error');

  useEffect(() => {
    if (autoDismissTimer.current) {
      clearTimeout(autoDismissTimer.current);
      autoDismissTimer.current = null;
    }
    if (allDone && !hasErrors && state && !state.active) {
      autoDismissTimer.current = setTimeout(() => {
        setDismissed(true);
      }, 5000);
    }
    return () => {
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    };
  }, [allDone, hasErrors, state]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissed(true);
  }, []);

  // ─── Visibility logic ──────────────────────────────────
  if (!state) return null;
  if (dismissed) return null;
  // Hide if everything is pending (not started yet) or all done/skipped with no errors
  const allPending = state.items.every((i) => i.status === 'pending');
  if (allPending) return null;
  // Hide only after auto-dismiss timer fires (allDone + no errors + not active)
  // While downloading or has errors, always show

  // Find the current active item for the header label
  const activeItem = state.items.find((i) => i.status === 'downloading');
  const headerLabel = activeItem
    ? activeItem.label
    : allDone
      ? (t as any).download?.all_done ?? 'All components ready'
      : hasErrors
        ? (t as any).download?.some_failed ?? 'Some downloads failed'
        : (t as any).download?.preparing ?? 'Preparing downloads...';

  const progress = Math.round(state.overallProgress);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 font-mono">
      <div className="bg-white border border-neutral-200 rounded-lg shadow-lg overflow-hidden">
        {/* ─── Collapsed header bar ─────────────────────── */}
        <div
          onClick={handleToggle}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-neutral-50 transition-colors cursor-pointer"
          role="button"
          tabIndex={0}
        >
          {state.active ? (
            <Loader2 size={14} className="text-blue-500 animate-spin shrink-0" />
          ) : allDone ? (
            <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
          ) : hasErrors ? (
            <XCircle size={14} className="text-red-500 shrink-0" />
          ) : (
            <Download size={14} className="text-neutral-500 shrink-0" />
          )}
          <span className="text-[11px] text-neutral-700 truncate flex-1 text-left">
            {headerLabel}
          </span>
          <span className="text-[11px] text-neutral-500 tabular-nums shrink-0">
            {progress}%
          </span>
          {!state.active && (allDone || hasErrors) && (
            <button
              onClick={handleDismiss}
              className="p-0.5 hover:bg-neutral-100 rounded cursor-pointer"
              title="Dismiss"
            >
              <X size={12} className="text-neutral-400" />
            </button>
          )}
          {expanded ? (
            <ChevronDown size={14} className="text-neutral-400 shrink-0" />
          ) : (
            <ChevronUp size={14} className="text-neutral-400 shrink-0" />
          )}
        </div>

        {/* ─── Progress bar ──────────────────────────────── */}
        <div className="h-1 bg-neutral-100">
          <div
            className={`h-full transition-all duration-300 ${
              hasErrors ? 'bg-red-400' : allDone ? 'bg-emerald-400' : 'bg-blue-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* ─── Expanded item list ────────────────────────── */}
        {expanded && (
          <div className="border-t border-neutral-100 py-1">
            {state.items.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                onRestart={(id) => {
                  if (typeof api.bgdownloadRestart === 'function') {
                    api.bgdownloadRestart([id]);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
