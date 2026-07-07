import { useState, useEffect, useCallback } from 'react';
import { Copy, Merge, Loader2, CheckSquare, Square, X } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useI18n } from '../../i18n';
import Select from '../../components/Select';

// ─── Types ──────────────────────────────────────────────────────
interface DuplicatePair {
  pageA: { id: number; title: string; slug: string; type: string };
  pageB: { id: number; title: string; slug: string; type: string };
  similarity: number;
  reason: string;
}

interface PageItem {
  id: number;
  slug: string;
  title: string;
  type: string;
}

interface DuplicatePanelProps {
  pages: PageItem[];
  selectMode: boolean;
  selectedIds: Set<number>;
  onToggleSelectMode: () => void;
  onMergeComplete: (targetSlug?: string | null) => void | Promise<void>;
  /** Slot rendered on the right side of the toolbar (e.g. rebuild / delete) */
  rightSlot?: React.ReactNode;
}

interface MergeResult {
  success?: boolean;
  error?: string;
  merged?: number;
  targetSlug?: string;
}

// ─── Component ──────────────────────────────────────────────────
export default function DuplicatePanel({
  pages,
  selectMode,
  selectedIds,
  onToggleSelectMode,
  onMergeComplete,
  rightSlot,
}: DuplicatePanelProps) {
  const api = useApi();
  const { t } = useI18n();
  const k = t.knowledge || {} as any;

  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const scanDuplicates = useCallback(async () => {
    setScanning(true);
    try {
      const result = await (api as any).knowledgeFindDuplicates();
      const next = Array.isArray(result) ? result : [];
      setDuplicates(next);
      setShowDuplicates(true);
      return next;
    } catch {
      setDuplicates([]);
      return [];
    } finally {
      setScanning(false);
    }
  }, [api]);

  // Keep merge target valid as selection changes. This prevents the first
  // confirmation click from using a stale target from a previous selection.
  useEffect(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setMergeTarget(null);
      return;
    }
    if (!mergeTarget || !selectedIds.has(mergeTarget)) {
      setMergeTarget(ids[0]);
    }
  }, [selectedIds, mergeTarget]);

  const assertMergeSuccess = (result: MergeResult | undefined | null): MergeResult => {
    if (!result || result.success === false) {
      throw new Error(result?.error || 'Merge failed');
    }
    return result;
  };

  const handleMergeFromDuplicate = async (pair: DuplicatePair, targetId: number) => {
    setMerging(true);
    setMergeError(null);
    try {
      const sourceId = targetId === pair.pageA.id ? pair.pageB.id : pair.pageA.id;
      const result = assertMergeSuccess(await (api as any).knowledgeMergePages([sourceId], targetId));
      setDuplicates((prev) => prev.filter((d) =>
        d.pageA.id !== sourceId &&
        d.pageB.id !== sourceId &&
        d.pageA.id !== targetId &&
        d.pageB.id !== targetId
      ));
      await onMergeComplete(result.targetSlug || null);
      await scanDuplicates();
    } catch (err: any) {
      setMergeError(err?.message || 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  const handleMergeSelected = async () => {
    if (!mergeTarget || selectedIds.size < 2 || merging) return;
    setMerging(true);
    setMergeError(null);
    try {
      const sourceIds = Array.from(selectedIds).filter((id) => id !== mergeTarget);
      const result = assertMergeSuccess(await (api as any).knowledgeMergePages(sourceIds, mergeTarget));
      setShowMergeConfirm(false);
      await onMergeComplete(result.targetSlug || null);
      await scanDuplicates();
    } catch (err: any) {
      setMergeError(err?.message || 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  const selectedPages = pages.filter((p) => selectedIds.has(p.id));

  return (
    <>
      {/* Sidebar Controls — unified toolbar: 查重 · 选择 · [rightSlot] */}
      <div
        className="flex items-center gap-1.5"
        style={{
          padding: 12,
          borderTop: '1px solid var(--line-soft)',
          background: 'var(--bg)',
        }}
      >
        {/* Duplicate Scan Button */}
        <button
          onClick={scanDuplicates}
          disabled={scanning}
          className={`kz-btn kz-btn--sm kz-btn--ghost ${scanning ? 'opacity-50 cursor-not-allowed' : ''}`}
          style={showDuplicates ? { background: 'var(--c-accent-bg)', color: 'var(--c-accent)' } : undefined}
          title={k.dup_scan_tooltip || 'Scan for duplicates'}
        >
          {scanning ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Copy size={11} />
          )}
          {k.dup_scan || 'Duplicates'}
          {duplicates.length > 0 && (
            <span className="kz-mono" style={{ marginLeft: 2, fontSize: 10, opacity: 0.7 }}>
              {duplicates.length}
            </span>
          )}
        </button>

        {/* Select Mode Toggle */}
        <button
          onClick={onToggleSelectMode}
          className={`kz-btn kz-btn--sm ${selectMode ? '' : 'kz-btn--ghost'}`}
          style={selectMode ? { background: 'var(--c-accent)', color: 'var(--c-accent-ink)', borderColor: 'var(--c-accent)' } : undefined}
          title={selectMode
            ? (k.select_mode_exit || 'Exit select mode')
            : (k.select_tooltip || 'Select pages to merge')
          }
        >
          {selectMode ? <CheckSquare size={11} /> : <Square size={11} />}
          {k.select_mode || 'Select'}
        </button>

        {/* Right slot — caller injects 重建 / 删除 etc., auto-right-aligned */}
        {rightSlot && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {rightSlot}
          </div>
        )}
      </div>

      {/* Merge Selected Bar (fixed at bottom of sidebar when items selected) */}
      {selectMode && selectedIds.size >= 2 && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}>
          <button
            onClick={() => {
              setMergeTarget(Array.from(selectedIds)[0]);
              setMergeError(null);
              setShowMergeConfirm(true);
            }}
            className="kz-btn kz-btn--primary kz-btn--sm w-full justify-center"
          >
            <Merge size={12} />
            {(k.merge_selected || 'Merge {count} Selected').replace('{count}', String(selectedIds.size))}
          </button>
        </div>
      )}

      {/* Duplicate Results Overlay */}
      {showDuplicates && (
        <div
          className="px-3 py-2 max-h-48 overflow-y-auto"
          style={{
            borderTop: '1px solid var(--line-soft)',
            background: 'color-mix(in oklch, var(--c-accent) 6%, var(--bg-elev))',
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="kz-serif-italic" style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
              {k.dup_title || 'Suspected Duplicates'}
            </span>
            <button
              onClick={() => setShowDuplicates(false)}
              className="kz-btn kz-btn--ghost kz-btn--sm"
              style={{ padding: '2px 4px', height: 'auto' }}
            >
              <X size={12} />
            </button>
          </div>
          {duplicates.length === 0 ? (
            <p className="kz-text-mute py-2 text-center" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>
              {k.dup_empty || 'No duplicates found'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {duplicates.map((pair, idx) => (
                <div
                  key={idx}
                  className="kz-card p-2"
                  style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}
                >
                  <div className="flex items-center gap-1 kz-text-ink">
                    <span className="truncate max-w-[90px]" title={pair.pageA.title}>
                      {pair.pageA.title}
                    </span>
                    <span className="kz-text-faint flex-shrink-0">&harr;</span>
                    <span className="truncate max-w-[90px]" title={pair.pageB.title}>
                      {pair.pageB.title}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="kz-text-mute">
                      {Math.round(pair.similarity * 100)}% {k.dup_similar || 'similar'}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleMergeFromDuplicate(pair, pair.pageA.id)}
                        disabled={merging}
                        className="kz-btn kz-btn--primary kz-btn--sm"
                        style={{ height: 22, padding: '0 8px', fontSize: 10 }}
                        title={pair.pageA.title}
                      >
                        {k.dup_keep_a || 'Keep A'}
                      </button>
                      <button
                        onClick={() => handleMergeFromDuplicate(pair, pair.pageB.id)}
                        disabled={merging}
                        className="kz-btn kz-btn--primary kz-btn--sm"
                        style={{ height: 22, padding: '0 8px', fontSize: 10 }}
                        title={pair.pageB.title}
                      >
                        {k.dup_keep_b || 'Keep B'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {mergeError && (
            <p className="mt-2" style={{ color: 'var(--c-danger)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
              {mergeError}
            </p>
          )}
        </div>
      )}

      {/* Merge Confirmation Modal */}
      {showMergeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'oklch(0 0 0 / 0.3)' }}>
          <div className="kz-paper p-5 w-80">
            <div className="flex items-center gap-2 mb-3">
              <Merge size={16} className="kz-text-soft" />
              <h3 className="kz-serif" style={{ fontSize: 16, color: 'var(--ink)' }}>
                {k.merge_title || 'Merge Pages'}
              </h3>
            </div>

            <p className="kz-text-soft mb-3" style={{ fontSize: 12 }}>
              {k.merge_desc || 'Select which page to keep as the merge target. Other selected pages will be merged into it and deleted.'}
            </p>

            <div className="mb-3">
              <label className="kz-text-mute mb-1 block kz-serif-italic" style={{ fontSize: 11 }}>
                {k.merge_into || 'Merge into:'}
              </label>
              <Select
                value={mergeTarget != null ? String(mergeTarget) : ''}
                onChange={(v) => setMergeTarget(Number(v))}
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                ariaLabel={k.merge_into || 'Merge into'}
                options={selectedPages.map((p) => ({ value: String(p.id), label: p.title }))}
              />
            </div>

            <div className="mb-4">
              <label className="kz-text-mute mb-1 block kz-serif-italic" style={{ fontSize: 11 }}>
                {k.merge_will_merge || 'Will be merged:'}
              </label>
              <div className="space-y-1">
                {selectedPages
                  .filter((p) => p.id !== mergeTarget)
                  .map((p) => (
                    <div key={p.id} className="kz-text-soft flex items-center gap-1" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                      <span style={{ color: 'var(--c-danger)' }}>&times;</span>
                      {p.title}
                    </div>
                  ))}
              </div>
            </div>

            {mergeError && (
              <p className="mb-3" style={{ color: 'var(--c-danger)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                {mergeError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowMergeConfirm(false)}
                className="kz-btn flex-1 justify-center"
              >
                {k.merge_cancel || 'Cancel'}
              </button>
              <button
                onClick={handleMergeSelected}
                disabled={merging || !mergeTarget}
                className="kz-btn kz-btn--primary flex-1 justify-center"
              >
                {merging ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Merge size={12} />
                )}
                {k.merge_confirm || 'Confirm Merge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
