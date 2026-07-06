import { X, RotateCcw, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Translations } from '../../i18n';
import type { QueueItem, HistoryItem } from './types';
import { getStepsForMediaType } from './types';

interface QueueSectionProps {
  queueItems: QueueItem[];
  historyItems: HistoryItem[];
  paused: boolean;
  expandedErrors: Set<string>;
  r: Translations['rec'];
  onPauseToggle: () => void;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onResetStuck: () => void;
  onToggleError: (itemId: string) => void;
}

export function getQueueSummaryLabel(queueItems: QueueItem[], r: Translations['rec']): string {
  const processing = queueItems.filter((item) => item.status === 'processing').length;
  const queued = queueItems.filter((item) => item.status === 'pending').length;
  const interrupted = queueItems.filter((item) => item.status === 'interrupted').length;
  const failed = queueItems.filter((item) => item.status === 'error').length;
  const parts: string[] = [];

  if (processing > 0) {
    parts.push(`${processing} ${(r as any).queue_in_progress || ''}`.trim());
  }
  if (queued > 0) {
    parts.push(`${queued} ${r.status_queued || ''}`.trim());
  }
  if (interrupted > 0) {
    parts.push(`${interrupted} ${((r as any).status_interrupted || 'Interrupted')}`.trim());
  }
  if (failed > 0) {
    parts.push(`${failed} ${r.status_error || ''}`.trim());
  }
  if (parts.length === 0 && queueItems.length > 0) {
    parts.push(`${queueItems.length} ${(r as any).queue_in_progress || ''}`.trim());
  }

  return parts.join(' / ');
}

export function canRetryQueueItem(item: Pick<QueueItem, 'status'>): boolean {
  return item.status === 'error' || item.status === 'interrupted';
}

export function getQueueStatusLabel(item: Pick<QueueItem, 'status' | 'progress'>, r: Translations['rec']): string {
  if (item.status === 'processing') return `${item.progress}%`;
  if (item.status === 'done') return r.status_success;
  if (item.status === 'cancelled') return r.status_cancelled;
  if (item.status === 'interrupted') return (r as any).status_interrupted || 'Interrupted';
  if (item.status === 'error') return r.status_error;
  return r.status_queued;
}

function getQueueStatusBadgeClass(status: string): string {
  if (status === 'processing') return 'kz-badge--info';
  if (status === 'done') return 'kz-badge--success';
  if (status === 'cancelled' || status === 'interrupted') return 'kz-badge--warn';
  if (status === 'error') return 'kz-badge--danger';
  return 'kz-badge--mute';
}

export default function QueueSection({
  queueItems,
  historyItems,
  paused,
  expandedErrors,
  r,
  onPauseToggle,
  onCancel,
  onRetry,
  onResetStuck,
  onToggleError,
}: QueueSectionProps) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3 className="kz-section-title">
        <span>{r.active_queue}</span>
        <span className="kz-section-title__count">
          {getQueueSummaryLabel(queueItems, r)}
        </span>
        {paused && (
          <span className="kz-badge kz-badge--warn" style={{ marginLeft: 4 }}>{r.paused}</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {historyItems.some((h) => h.status === 'active') && (
            <button onClick={onResetStuck} className="kz-btn kz-btn--sm">
              <RotateCcw size={11} />
              {r.reset_stuck}
            </button>
          )}
          {/* Auto-process Toggle — matches design's "自动处理 + Toggle" */}
          <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
            {(r as any).auto_process || ''}
          </span>
          <button
            type="button"
            onClick={onPauseToggle}
            className={'kz-toggle' + (!paused ? ' kz-toggle--on' : '')}
            title={paused ? r.resume : r.pause}
          />
        </span>
      </h3>

      <div className="kz-paper" style={{ overflow: 'hidden' }}>
        {queueItems.length === 0 ? (
          <div className="kz-empty">
            <div className="kz-empty__icon"><CheckCircle2 size={20} /></div>
            <div>
              <div className="kz-empty__title">{r.no_queue}</div>
              {(r as any).no_queue_sub && (
                <div className="kz-empty__sub" style={{ marginTop: 6 }}>{(r as any).no_queue_sub}</div>
              )}
            </div>
          </div>
        ) : (
          queueItems.map((item, i) => (
            <div
              key={item.id}
              className="kz-row-hover"
              style={{
                padding: '14px 20px',
                borderTop: i ? '1px solid var(--line-soft)' : 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.08 }}>{item.id.slice(-6).toUpperCase()}</span>
                  <span className="kz-mono" style={{ fontSize: 12.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>
                    {item.duration}{item.duration && item.size ? ' · ' : ''}{item.size}
                  </span>
                  <span
                    className={`kz-badge ${getQueueStatusBadgeClass(item.status)}`}
                  >
                    {getQueueStatusLabel(item, r)}
                  </span>
                  {(item.status === 'pending' || item.status === 'processing') && (
                    <button
                      onClick={() => onCancel(item.id)}
                      className="kz-btn kz-btn--ghost kz-btn--sm"
                      title="Cancel"
                      style={{ padding: '0 6px' }}
                    >
                      <X size={12} />
                    </button>
                  )}
                  {canRetryQueueItem(item) && (
                    <button
                      onClick={() => onRetry(item.id)}
                      className="kz-btn kz-btn--ghost kz-btn--sm"
                      title="Retry"
                      style={{ padding: '0 6px' }}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              </div>
              {/* Step indicator */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {(() => {
                  const steps = getStepsForMediaType(item.mediaType);
                  return steps.map((step, i) => {
                    const stepIdx = steps.findIndex(s => s.key === item.rawStatus);
                    const isDone = i < stepIdx;
                    const isCurrent = i === stepIdx;
                    const isFailed = item.rawStatus === 'failed';
                    const Icon = step.icon;
                    return (
                      <div key={step.key} style={{ display: 'flex', alignItems: 'center' }}>
                        <span
                          className={`kz-badge ${
                            isDone ? 'kz-badge--success' :
                            isCurrent ? 'kz-badge--info' :
                            isFailed && i === stepIdx ? 'kz-badge--danger' :
                            'kz-badge--mute'
                          }`}
                          style={{
                            opacity: isDone || isCurrent || (isFailed && i === stepIdx) ? 1 : 0.5,
                            animation: isCurrent ? 'kz-fade-up 0.6s ease-in-out infinite alternate' : undefined,
                          }}
                        >
                          <Icon size={10} />
                          <span>{step.label}</span>
                        </span>
                        {i < steps.length - 1 && (
                          <div style={{ width: 12, height: 1, margin: '0 2px', background: isDone ? 'var(--c-success)' : 'var(--line)' }} />
                        )}
                      </div>
                    );
                  });
                })()}
                {canRetryQueueItem(item) && (
                  <button
                    onClick={() => onRetry(item.id)}
                    className={`kz-btn kz-btn--sm${item.status === 'error' ? ' kz-btn--danger' : ''}`}
                    style={{ marginLeft: 6 }}
                  >
                    <RefreshCw size={10} />
                    {r.retry}
                  </button>
                )}
              </div>
              {/* Error detail */}
              {item.error && (
                <div
                  className="kz-mono"
                  style={{
                    fontSize: 11,
                    color: item.status === 'interrupted' ? 'var(--c-warn)' : 'var(--c-danger)',
                    marginTop: 8,
                    cursor: 'pointer',
                    userSelect: 'text',
                    whiteSpace: expandedErrors.has(item.id) ? 'pre-wrap' : 'nowrap',
                    overflow: expandedErrors.has(item.id) ? 'visible' : 'hidden',
                    textOverflow: expandedErrors.has(item.id) ? 'clip' : 'ellipsis',
                  }}
                  title={expandedErrors.has(item.id) ? undefined : item.error}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleError(item.id);
                  }}
                >
                  {item.error}
                </div>
              )}
              {/* Live progress detail */}
              {item.notes && item.status === 'processing' && (
                <div className="kz-mono kz-text-soft" style={{ marginTop: 8, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.notes}>
                  {item.notes}
                </div>
              )}
              {/* Progress bar */}
              {item.progress > 0 && item.status !== 'pending' && (
                <div style={{ marginTop: 8, height: 3, background: 'var(--bg-elev)', borderRadius: 999, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${item.progress}%`,
                      background: 'var(--c-accent)',
                      borderRadius: 999,
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
