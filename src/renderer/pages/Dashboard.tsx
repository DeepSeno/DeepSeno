import { useState, useEffect, useCallback } from 'react';
import { Mic, AlertTriangle, Download } from 'lucide-react';

function formatDbSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
import { useI18n } from '../i18n';
import { useApi, RecordingRow, MeetingNotes, CuratedDay } from '../hooks/useApi';
import { useNavigate, useLocation } from 'react-router-dom';
import { OnboardingCard } from '../components/OnboardingCard';
import { Skeleton } from '../components/Skeleton';
import { useNotifications } from '../components/NotificationCenter';
import {
  TodayEvents,
  QuickAsk,
  ActivityStrip,
  RecentMeetings,
  TimelineItem,
  ChartData,
  formatDuration,
  toLocalDateStr,
} from './dashboard/index';
import { deriveRecordingTitle } from '../utils/recordingTitle';

const IMPORT_FILTERS = [
  {
    name: 'All Supported',
    extensions: [
      'wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm',
      'mp4', 'mkv', 'avi', 'mov', 'wmv',
      'pdf', 'docx', 'txt', 'md',
      'jpg', 'jpeg', 'png', 'heic', 'webp',
    ],
  },
  { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'] },
  { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv'] },
  { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
  { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp'] },
];

// ─── Component ───────────────────────────────────────────────

export default function Dashboard() {
  const { t, lang } = useI18n();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useNotifications();
  const d = t.dash;
  const r = t.rec;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [stats, setStats] = useState({ recordingCount: 0, segmentCount: 0, dbSize: 0 });
  const [timelineData, setTimelineData] = useState<TimelineItem[]>([]);
  const [charts, setCharts] = useState<ChartData>({
    recordingsPerDay: [],
    sentimentDistribution: [],
    topSpeakers: [],
    calendarActivity: [],
  });
  const [meetingNotesList, setMeetingNotesList] = useState<Array<{ recordingId: number; fileName: string; date: string; notes: MeetingNotes }>>([]);
  const [_sceneCounts, setSceneCounts] = useState<Record<string, number>>({});
  const [curated, setCurated] = useState<CuratedDay | null>(null);
  const [curatedDate, setCuratedDate] = useState<string | null>(null);
  const [userNickname, setUserNickname] = useState<string>('');

  // System readiness check
  const [readiness, setReadiness] = useState<{
    checked: boolean;
    sherpaReady: boolean;
    llmReady: boolean;
  } | null>(null);
  const [readinessDismissed, setReadinessDismissed] = useState(
    () => localStorage.getItem('readiness_dismissed') === 'true'
  );

  // I5: todayStr as state that updates if midnight passes
  const [todayStr, setTodayStr] = useState(() => toLocalDateStr(new Date()));
  useEffect(() => {
    const timer = setInterval(() => {
      setTodayStr((prev) => {
        const now = toLocalDateStr(new Date());
        return now !== prev ? now : prev;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // C1: data fetch depends on `lang`
  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    const logErr = (ctx: string) => (err: unknown) => {
      console.error(`[Dashboard] ${ctx}:`, err);
      setError(d.load_error ?? d.desc);
    };
    Promise.all([
      api.getQueue().then((q) => setQueueCount(q.length)).catch(logErr('getQueue')),
      api.getDbStats().then((s) => setStats(s)).catch(logErr('getDbStats')),
      api.getDashboardCharts().then((c) => setCharts(c)).catch(logErr('getCharts')),
      api.getTodayCuratedItems(todayStr)
        .then((c) => { setCurated(c); setCuratedDate(todayStr); })
        .catch(logErr('getTodayCuratedItems')),
      api.getRecordings().then(async (recordings: RecordingRow[]) => {
        const sc = recordings.reduce((acc: Record<string, number>, rec: any) => {
          const scene = rec.capture_scene || 'dictation';
          acc[scene] = (acc[scene] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        setSceneCounts(sc);

        if (recordings.length > 0) {
          setTimelineData(
            recordings.map((rec) => {
              // Prefer recorded_at; fall back to processed_at. If neither
              // exists, leave date empty — never default to "today" or those
              // recordings will be miscounted as today's events.
              const stamp = rec.recorded_at || rec.processed_at || null;
              return {
                date: stamp ? toLocalDateStr(new Date(stamp)) : '',
                time: stamp
                  ? new Date(stamp).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
                  : '',
                event: deriveRecordingTitle(rec),
                type: 'major' as const,
                mediaType: (rec.media_type as TimelineItem['mediaType']) || 'audio',
                duration: rec.duration_seconds
                  ? formatDuration(rec.duration_seconds)
                  : '',
                durationSeconds: rec.duration_seconds || 0,
                speakers: rec.speaker_count || 0,
                recordingId: rec.id,
              };
            })
          );
        }
        // Load meeting notes for recent 5 recordings
        const recentRecs = recordings.slice(0, 5);
        const results = await Promise.allSettled(
          recentRecs.map((rec) =>
            api.getMeetingNotes(rec.id).then((notes) =>
              notes ? {
                recordingId: rec.id,
                fileName: rec.file_name.replace(/\.[^.]+$/, ''),
                date: rec.recorded_at?.split('T')[0] || '',
                notes,
              } : null
            )
          )
        );
        setMeetingNotesList(
          results
            .filter((r): r is PromiseFulfilledResult<NonNullable<typeof r extends PromiseFulfilledResult<infer V> ? V : never>> =>
              r.status === 'fulfilled' && r.value !== null
            )
            .map((r) => r.value!)
        );
      }).catch(logErr('getRecordings')),
    ]).finally(() => setLoading(false));
  }, [api, lang, d, todayStr]);

  // Fetch data on mount AND on every navigation to this page
  useEffect(() => {
    fetchData();
  }, [location.key]);

  // I4: Subscribe to pipeline events for live updates
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    unsubs.push(api.onTaskCompleted(() => {
      // Full refresh: a completed task adds a new recording row, so
      // timelineData itself must be regenerated (not just counters).
      fetchData();
    }));
    unsubs.push(api.onTaskProgress(() => {
      api.getQueue().then((q) => setQueueCount(q.length)).catch((e) => console.warn('[Dashboard] bg refresh queue:', e));
    }));
    unsubs.push(api.onTaskAdded(() => {
      api.getQueue().then((q) => setQueueCount(q.length)).catch((e) => console.warn('[Dashboard] bg refresh queue:', e));
    }));
    return () => unsubs.forEach((fn) => fn());
  }, [api, fetchData]);

  // One-shot background backfill of AI titles for legacy recordings.
  // Idempotent on server (only acts on rows with empty title), but we
  // also gate with a localStorage flag so it's at most-once per install.
  useEffect(() => {
    if (localStorage.getItem('titles_backfilled') === 'true') return;
    const t = setTimeout(() => {
      api.backfillTitles(200)
        .then((res) => {
          console.log('[Dashboard] title backfill done:', res);
          localStorage.setItem('titles_backfilled', 'true');
          if (res.generated > 0) fetchData();
        })
        .catch((err) => console.warn('[Dashboard] title backfill failed:', err));
    }, 3000); // wait a few seconds so first render isn't competing with backfill
    return () => clearTimeout(t);
  }, [api, fetchData]);

  // One-shot curation backfill (importance + sessions) for legacy recordings.
  // Gated by localStorage; runs after titles backfill to avoid two heavy LLM
  // jobs competing for the model cache. ~10-15 min for ~150 rows on M5.
  useEffect(() => {
    if (localStorage.getItem('curation_backfilled') === 'true') return;
    const t = setTimeout(() => {
      api.backfillCuration(300)
        .then((res) => {
          console.log('[Dashboard] curation backfill done:', res);
          localStorage.setItem('curation_backfilled', 'true');
          if (res.scored > 0) fetchData();
        })
        .catch((err) => console.warn('[Dashboard] curation backfill failed:', err));
    }, 8000);  // start after titles backfill window
    return () => clearTimeout(t);
  }, [api, fetchData]);

  // Finalize any capture sessions whose last activity was > 10 min ago —
  // gives them a final LLM-generated topic + summary. Fire on every mount.
  useEffect(() => {
    api.finalizeStaleSessions()
      .then((res) => {
        if (res.finalized > 0) {
          console.log('[Dashboard] finalized stale sessions:', res.finalized);
          api.getTodayCuratedItems(todayStr).then((c) => { setCurated(c); setCuratedDate(todayStr); }).catch(() => {});
        }
      })
      .catch((err) => console.warn('[Dashboard] finalizeStaleSessions failed:', err));
  }, [api, todayStr]);

  // Load user nickname for the greeting line.
  useEffect(() => {
    let cancelled = false;
    api.loadSettings()
      .then((settings) => { if (!cancelled) setUserNickname(settings.userNickname || ''); })
      .catch(() => { /* fall back to default i18n greeting */ });
    return () => { cancelled = true; };
  }, [api]);

  // Check system readiness on mount
  useEffect(() => {
    if (readinessDismissed) return;
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.loadSettings();
        const sherpaResult = await api.checkSherpaModels();
        const sherpaReady = sherpaResult.allReady;

        // LLM is ready if: (local provider + has model selected) OR (cloud provider + has url + key + model)
        let llmReady = false;
        if (settings.llmProvider === 'openai') {
          llmReady = !!(settings.cloudApiUrl && settings.cloudApiKey && settings.cloudModel);
        } else {
          // Local: check if model is selected
          llmReady = !!(settings.llmModel);
        }

        if (!cancelled) {
          setReadiness({ checked: true, sherpaReady, llmReady });
        }
      } catch {
        if (!cancelled) {
          setReadiness({ checked: true, sherpaReady: false, llmReady: false });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, readinessDismissed]);

  // ─── Event handlers ────────────────────────────────────────

  const handleImportFile = useCallback(async () => {
    try {
      const filePaths = await api.openFiles(IMPORT_FILTERS);
      if (!filePaths || filePaths.length === 0) return;

      let enqueued = 0;
      let skipped = 0;
      let lastError = '';
      for (const filePath of filePaths) {
        try {
          const result = await api.enqueue(filePath);
          if (result?.status === 'failed') {
            skipped++;
            lastError = result.error || r.unknown_error;
          } else {
            enqueued++;
          }
        } catch (err) {
          skipped++;
          lastError = String(err);
        }
      }

      if (enqueued > 0) {
        toast('success', `${enqueued} ${r.files_queued}`, skipped > 0 ? `${skipped} ${r.files_skipped}` : undefined);
      } else if (skipped > 0) {
        toast('error', r.pipeline_failed, lastError || r.drop_formats);
      }
      fetchData();
    } catch (err) {
      toast('error', r.pipeline_failed, String(err));
    }
  }, [api, fetchData, r, toast]);

  // ─── Derived data ──────────────────────────────────────────

  // If today's curated payload is completely empty AND we have past
  // activity, re-fetch curation for the most recent active date so the
  // user lands on something meaningful instead of "no events today".
  useEffect(() => {
    if (!curated || !curatedDate || curatedDate !== todayStr) return;
    const isEmpty =
      curated.sessions.length === 0 &&
      curated.standalones.length === 0 &&
      curated.briefs.length === 0;
    if (!isEmpty) return;
    const recentDate = timelineData.find((it) => it.date && it.date !== todayStr)?.date;
    if (!recentDate) return;
    api.getTodayCuratedItems(recentDate)
      .then((c) => { setCurated(c); setCuratedDate(recentDate); })
      .catch(() => {});
  }, [curated, curatedDate, timelineData, todayStr, api]);

  const fallbackDate = curatedDate && curatedDate !== todayStr ? curatedDate : null;

  // ─── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <div role="status" aria-label="Loading">
        <div className="kz-ph">
          <div>
            <Skeleton variant="text" className="h-6 w-40 mb-2" />
            <Skeleton variant="text" className="h-4 w-64" />
          </div>
        </div>
        <div className="kz-paper" style={{ padding: 16, marginBottom: 22 }}>
          <Skeleton className="h-6 w-full" />
        </div>
        <div className="kz-paper" style={{ padding: 18, marginBottom: 22 }}>
          <Skeleton variant="text" className="w-32 mb-4" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="kz-paper" style={{ padding: 18 }}>
          <Skeleton variant="text" className="w-32 mb-4" />
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton variant="circle" className="h-2 w-2" />
                <Skeleton variant="text" className="flex-1" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Page header — editorial style: time-of-day greeting + today metrics */}
      {(() => {
        const hour = new Date().getHours();
        const greeting =
          hour < 6 ? d.greeting_late :
          hour < 11 ? d.greeting_morning :
          hour < 13 ? d.greeting_noon :
          hour < 18 ? d.greeting_afternoon :
          d.greeting_evening;
        const todayItems =
          (curated?.sessions.length || 0) + (curated?.standalones.length || 0);
        const todayBriefs = curated?.briefs.length || 0;
        const todayMinutes = Math.round(
          timelineData
            .filter((tl) => tl.date === todayStr)
            .reduce((sum, tl) => sum + (tl.durationSeconds || 0), 0) / 60
        );
        const subText =
          stats.recordingCount > 0
            ? d.today_summary(todayItems, todayBriefs, todayMinutes)
            : d.empty_welcome_desc;
        return (
          <div className="kz-ph">
            <div>
              <div className="kz-ph__title">
                {stats.recordingCount > 0 ? (
                  <>
                    {greeting}，
                    <span className="kz-serif-italic kz-text-accent">{userNickname || d.greeting_self}</span>
                    <span>。</span>
                  </>
                ) : (
                  d.empty_welcome
                )}
              </div>
              <div className="kz-ph__sub">{subText}</div>
            </div>
          </div>
        );
      })()}

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="kz-paper kz-anim-in"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            marginBottom: 16,
            borderColor: 'var(--c-danger)',
          }}
        >
          <span className="kz-badge kz-badge--danger kz-badge--dot">
            <AlertTriangle size={11} />
          </span>
          <span className="kz-text-soft" style={{ flex: 1, fontSize: 12.5 }}>{error}</span>
          <button onClick={fetchData} className="kz-btn kz-btn--sm kz-btn--danger">
            {d.retry}
          </button>
        </div>
      )}

      {/* Context-aware onboarding (single stage block) */}
      {(() => {
        // Stage 1: 模型未就绪
        const readinessBlocked =
          readiness?.checked &&
          (!readiness.sherpaReady || !readiness.llmReady) &&
          !readinessDismissed;
        if (readinessBlocked) {
          return (
            <div
              className="kz-paper kz-anim-in"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                marginBottom: 16,
              }}
            >
              <span className="kz-badge kz-badge--warn kz-badge--dot">
                <Download size={11} />
              </span>
              <span className="kz-text-soft" style={{ flex: 1, fontSize: 12.5 }}>
                {!readiness!.sherpaReady && !readiness!.llmReady
                  ? d.readiness_all_missing
                  : !readiness!.sherpaReady
                    ? d.readiness_sherpa_missing
                    : d.readiness_llm_missing}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {!readiness!.sherpaReady && (
                  <button
                    onClick={() => navigate('/models')}
                    className="kz-btn kz-btn--sm kz-btn--accent"
                  >
                    {d.readiness_go_models}
                  </button>
                )}
                {readiness!.sherpaReady && !readiness!.llmReady && (
                  <button
                    onClick={() => navigate('/settings')}
                    className="kz-btn kz-btn--sm kz-btn--accent"
                  >
                    {d.readiness_go_settings}
                  </button>
                )}
                <button
                  onClick={() => {
                    setReadinessDismissed(true);
                    localStorage.setItem('readiness_dismissed', 'true');
                  }}
                  className="kz-btn kz-btn--sm kz-btn--ghost kz-text-mute"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          );
        }
        // Stage 2: 模型就绪但 0 录音
        if (stats.recordingCount === 0) {
          return (
            <div className="kz-paper" style={{ marginBottom: 22 }}>
              <div className="kz-empty">
                <div className="kz-empty__icon">
                  <Mic size={22} />
                </div>
                <div>
                  <div className="kz-empty__title">{d.empty_welcome}</div>
                  <div className="kz-empty__sub">{d.empty_welcome_desc}</div>
                </div>
                <div className="kz-empty__actions">
                  <button
                    onClick={handleImportFile}
                    className="kz-btn kz-btn--primary"
                  >
                    <Download size={13} /> {d.empty_import_btn}
                  </button>
                </div>
              </div>
            </div>
          );
        }
        // Stage 3: 1-2 条录音 → 显示教学
        if (stats.recordingCount < 3) {
          return <OnboardingCard recordingCount={stats.recordingCount} sessionCount={0} />;
        }
        // Stage 4: 老用户 — 不显示引导
        return null;
      })()}

      {/* Quick Ask (hero CTA) */}
      {stats.recordingCount > 0 && (
        <QuickAsk
          onSubmit={(q) => navigate(`/assistant?query=${encodeURIComponent(q)}`)}
        />
      )}

      {/* Recent Meetings (hero — only when notes actually exist; otherwise TodayEvents fallback covers it) */}
      {meetingNotesList.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <RecentMeetings
            meetingNotesList={meetingNotesList}
            onNavigate={navigate}
          />
        </div>
      )}

      {/* 2-col on wide screens: left = TodayEvents + ActivityStrip, right = system rail */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 22,
          alignItems: 'stretch',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <TodayEvents
            curated={curated}
            fallbackDate={fallbackDate}
            queueCount={queueCount}
            onNavigate={navigate}
          />
          <ActivityStrip
            calendarActivity={charts.calendarActivity}
            todayStr={todayStr}
            onNavigate={navigate}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {/* 本周关注 — 频次最高的人物 */}
          <section>
            <h3 className="kz-section-title">
              <span>{d.highlights_title}</span>
              {charts.topSpeakers.length > 0 && (
                <span className="kz-section-title__count">{charts.topSpeakers.length}</span>
              )}
            </h3>
            <div className="kz-paper" style={{ padding: 14 }}>
              {charts.topSpeakers.length === 0 ? (
                <p
                  className="kz-text-mute kz-serif-italic"
                  style={{ fontSize: 12.5, margin: 0, padding: '6px 0', textAlign: 'center', lineHeight: 1.6 }}
                >
                  {d.highlights_empty}
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {charts.topSpeakers.slice(0, 5).map((s) => {
                    const initial = (s.name || '?').trim().charAt(0).toUpperCase();
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => navigate(`/library?speaker=${s.id}`)}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                            padding: '6px 6px', borderRadius: 6, background: 'transparent',
                            border: 0, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)',
                            transition: 'background 0.12s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elev)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          title={s.name}
                        >
                          <span
                            style={{
                              width: 24, height: 24, borderRadius: '50%',
                              background: 'color-mix(in oklch, var(--c-accent) 18%, transparent)',
                              color: 'var(--c-accent)',
                              display: 'grid', placeItems: 'center', flexShrink: 0,
                              fontFamily: 'var(--serif)', fontStyle: 'italic',
                              fontSize: 12,
                            }}
                          >
                            {initial}
                          </span>
                          <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                            {s.name}
                          </span>
                          <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, flexShrink: 0 }}>
                            {s.count} {d.highlights_mention_unit}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* 知识库 — 紧凑统计卡（录音 / 片段 / 大小） */}
          <section>
            <h3 className="kz-section-title"><span>{d.library_card_title}</span></h3>
            <div className="kz-paper" style={{ padding: '6px 14px' }}>
              {[
                { label: d.library_card_recordings, value: String(stats.recordingCount) },
                { label: d.library_card_segments,   value: String(stats.segmentCount) },
                { label: d.library_card_size,       value: formatDbSize(stats.dbSize) },
              ].map((row, i) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '9px 0',
                    borderTop: i > 0 ? '1px solid var(--line-soft)' : 0,
                  }}
                >
                  <span style={{ fontSize: 12 }}>{row.label}</span>
                  <span className="kz-mono" style={{ fontSize: 11, color: 'var(--ink)' }}>{row.value}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--line-soft)', padding: '8px 0 4px' }}>
                <button
                  onClick={() => navigate('/library')}
                  className="kz-mono"
                  style={{
                    background: 'transparent', border: 0, color: 'var(--ink-mute)',
                    fontSize: 10.5, padding: 0, cursor: 'pointer', transition: 'color 0.12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--c-accent)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-mute)'; }}
                >
                  {d.library_card_link}
                </button>
              </div>
            </div>
          </section>

          {/* 状态 — Sherpa · LLM · 队列 三合一紧凑卡 */}
          <section>
            <h3 className="kz-section-title"><span>{d.status_title}</span></h3>
            <div className="kz-paper" style={{ padding: '6px 14px' }}>
              {[
                {
                  label: 'Sherpa ASR',
                  ok: readiness?.sherpaReady ?? false,
                  hint: readiness?.sherpaReady ? 'Ready' : d.readiness_sherpa_missing,
                  tone: 'sherpa',
                },
                {
                  label: 'LLM',
                  ok: readiness?.llmReady ?? false,
                  hint: readiness?.llmReady ? 'Ready' : d.readiness_llm_missing,
                  tone: 'llm',
                },
                {
                  label: d.status_queue,
                  ok: queueCount === 0,
                  hint: queueCount > 0 ? `${queueCount} ${d.pending_jobs}` : d.status_queue_idle,
                  tone: 'queue',
                  onClick: queueCount > 0 ? () => navigate('/sources') : undefined,
                },
              ].map((row, i) => {
                const dotClass = row.tone === 'queue'
                  ? (queueCount > 0 ? 'kz-sdot--info' : 'kz-sdot--mute')
                  : (row.ok ? 'kz-sdot--success' : 'kz-sdot--warn');
                return (
                  <div
                    key={row.label}
                    onClick={row.onClick}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 0',
                      borderTop: i > 0 ? '1px solid var(--line-soft)' : 0,
                      cursor: row.onClick ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`kz-sdot ${dotClass}`} />
                      <span style={{ fontSize: 12 }}>{row.label}</span>
                    </span>
                    <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5 }}>{row.hint}</span>
                  </div>
                );
              })}
              <div style={{ borderTop: '1px solid var(--line-soft)', padding: '8px 0 4px' }}>
                <button
                  onClick={() => navigate('/models')}
                  className="kz-mono"
                  style={{
                    background: 'transparent', border: 0, color: 'var(--ink-mute)',
                    fontSize: 10.5, padding: 0, cursor: 'pointer', transition: 'color 0.12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--c-accent)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-mute)'; }}
                >
                  {d.status_models_link}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
