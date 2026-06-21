import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, AlertCircle, CheckCircle2, ChevronRight, Repeat, Timer,
  Settings2, Bell, FileOutput, ShieldCheck,
} from 'lucide-react';
import { useApi, type AppSettings, type ParsedSchedule } from '../hooks/useApi';
import Select from './Select';

// ─── Predefined Actions ─────────────────────────────────
// Fetched at runtime from the backend registry (scheduler:listActions) — the
// single source of truth — so this modal never drifts from the available set.
interface PredefinedAction { name: string; label_zh: string; label_en: string }

const CHANNELS = [
  { value: 'global', zh: '全局', en: 'Global' },
  { value: 'feishu', zh: '飞书', en: 'Feishu' },
  { value: 'wechat', zh: '企业微信', en: 'WeChat Work' },
  { value: 'openclaw-wechat', zh: '个人微信', en: 'Personal WeChat' },
  { value: 'telegram', zh: 'Telegram', en: 'Telegram' },
];

// ─── Props ──────────────────────────────────────────────
interface SchedulerTaskModalProps {
  open: boolean;
  task?: any;
  onClose: () => void;
  onSaved: () => void;
}

// ─── Reusable Field Label ───────────────────────────────
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="kz-serif-italic text-[12px] kz-text-soft mb-1.5 block select-none">
      {children}
    </label>
  );
}

// ─── Pill Selector ──────────────────────────────────────
function PillGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="kz-tabs" style={{ display: 'flex', width: '100%' }}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={value === opt.key ? 'is-on' : ''}
          style={{ flex: 1 }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function SchedulerTaskModal({ open, task, onClose, onSaved }: SchedulerTaskModalProps) {
  const api = useApi();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [predefinedActions, setPredefinedActions] = useState<PredefinedAction[]>([]);

  useEffect(() => {
    api.loadSettings().then(setSettings).catch(() => {});
    api.schedulerListActions().then(setPredefinedActions).catch(() => setPredefinedActions([]));
  }, []);

  const isZh = settings?.language === 'zh';
  const L = (zh: string, en: string) => isZh ? zh : en;
  const isEdit = !!task;

  // ─── Form State ─────────────────────────────────────
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<'predefined' | 'prompt'>('predefined');
  const [action, setAction] = useState('daily_report');
  const [promptText, setPromptText] = useState('');
  const [scheduleText, setScheduleText] = useState('');
  const [parsedSchedule, setParsedSchedule] = useState<ParsedSchedule | null>(null);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [scheduleType, setScheduleType] = useState<'cron' | 'interval' | 'once'>('cron');
  const [isRecurring, setIsRecurring] = useState(true);
  const [permissionLevel, setPermissionLevel] = useState<'readonly' | 'readwrite'>('readonly');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [channelsOverride, setChannelsOverride] = useState<string[]>(['global']);
  const [missedPolicy, setMissedPolicy] = useState<'catch_up_latest' | 'skip'>('skip');
  const [maxMissHours, setMaxMissHours] = useState(24);
  const [maxRetries, setMaxRetries] = useState(3);
  const [outputMode, setOutputMode] = useState<'push' | 'append_file' | 'accumulate'>('push');
  const [outputFilePath, setOutputFilePath] = useState('');
  const [saving, setSaving] = useState(false);

  const parseTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // ─── Populate form on edit ──────────────────────────
  useEffect(() => {
    if (task) {
      setName(task.name || '');
      const isPredefined = predefinedActions.some((a) => a.name === task.action);
      setTaskType(isPredefined ? 'predefined' : 'prompt');
      setAction(isPredefined ? task.action : 'daily_report');
      setPromptText(isPredefined ? '' : task.action || '');
      setScheduleText(task.schedule_display || task.schedule_expr || '');
      setPermissionLevel(task.permission_level || 'readonly');
      setMissedPolicy(task.missed_policy || 'skip');
      setMaxMissHours(task.max_miss_hours ?? 24);
      setMaxRetries(task.max_retries ?? 3);
      setOutputMode(task.output_mode || 'push');
      setOutputFilePath(task.output_file_path || '');
      if (task.channels_override) {
        try {
          const parsed = JSON.parse(task.channels_override);
          if (Array.isArray(parsed)) setChannelsOverride(parsed);
        } catch { /* ignore */ }
      }
      setScheduleType(task.schedule_type || 'cron');
      setIsRecurring(!!task.is_recurring);
      if (task.schedule_expr) {
        setParsedSchedule({
          type: task.schedule_type || 'cron',
          expr: task.schedule_expr,
          display: task.schedule_display || '',
          nextRunAt: task.next_run_at || null,
        });
      }
    } else {
      setName('');
      setTaskType('predefined');
      setAction('daily_report');
      setPromptText('');
      setScheduleText('');
      setParsedSchedule(null);
      setParseError('');
      setScheduleType('cron');
      setIsRecurring(true);
      setPermissionLevel('readonly');
      setShowAdvanced(false);
      setChannelsOverride(['global']);
      setMissedPolicy('skip');
      setMaxMissHours(24);
      setMaxRetries(3);
      setOutputMode('push');
      setOutputFilePath('');
    }
  }, [task, open, predefinedActions]);

  // ─── Schedule parsing with debounce ─────────────────
  const parseSchedule = useCallback(async (text: string) => {
    if (!text.trim()) {
      setParsedSchedule(null);
      setParseError('');
      return;
    }
    setParsing(true);
    try {
      const result = await api.schedulerParseSchedule(text);
      setParsedSchedule(result);
      setParseError('');
      setScheduleType(result.type);
      setIsRecurring(result.type !== 'once');
    } catch (err: any) {
      setParsedSchedule(null);
      setParseError(err?.message || L('解析失败', 'Parse failed'));
    } finally {
      setParsing(false);
    }
  }, [api]);

  const handleScheduleChange = (text: string) => {
    setScheduleText(text);
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    parseTimerRef.current = setTimeout(() => parseSchedule(text), 500);
  };

  const handleScheduleBlur = () => {
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    parseSchedule(scheduleText);
  };

  const toggleChannel = (ch: string) => {
    setChannelsOverride((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
    );
  };

  // ─── Save ───────────────────────────────────────────
  const handleSave = async () => {
    if (!name.trim() || !scheduleText.trim()) return;
    if (!parsedSchedule) return;

    setSaving(true);
    try {
      const params = {
        name: name.trim(),
        task_type: taskType,
        action: taskType === 'predefined' ? action : promptText.trim(),
        schedule_type: scheduleType,
        schedule_expr: parsedSchedule.expr,
        schedule_display: scheduleText.trim(),
        is_recurring: isRecurring ? 1 : 0,
        permission_level: permissionLevel,
        channels_override: JSON.stringify(channelsOverride),
        missed_policy: missedPolicy,
        max_miss_hours: maxMissHours,
        max_retries: maxRetries,
        output_mode: outputMode,
        output_file_path: outputMode === 'append_file' ? outputFilePath.trim() : null,
      };

      if (isEdit) {
        await api.schedulerUpdate(task.id, params);
      } else {
        await api.schedulerCreate(params);
      }

      onSaved();
      onClose();
    } catch (err: any) {
      console.error('[SchedulerTaskModal] save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const canSave = name.trim() && scheduleText.trim() && parsedSchedule && !parseError && (taskType === 'predefined' || promptText.trim());

  const inputCls = 'kz-input kz-mono w-full text-sm';

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'oklch(0.2 0.02 60 / 0.25)', backdropFilter: 'blur(2px)' }} onClick={onClose}>
      <div
        className="kz-paper kz-anim-in w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div>
            <h2 className="kz-serif text-[18px] kz-text-ink">
              {isEdit ? L('编辑任务', 'Edit Task') : L('新建定时任务', 'New Scheduled Task')}
            </h2>
            <p className="kz-serif-italic text-[12px] kz-text-mute mt-0.5">
              {isEdit ? L('修改任务配置', 'Modify task configuration') : L('配置自动化定时任务', 'Configure an automated scheduled task')}
            </p>
          </div>
          <button onClick={onClose} className="kz-btn kz-btn--ghost kz-btn--sm" style={{ width: 32, padding: 0, justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        {/* ── Body ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Task name */}
          <div>
            <FieldLabel>{L('任务名称', 'Task Name')}</FieldLabel>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={L('例: 每日报告', 'e.g. Daily Report')}
              autoFocus
              className={inputCls}
            />
          </div>

          {/* Task type toggle */}
          <div>
            <FieldLabel>{L('任务类型', 'Task Type')}</FieldLabel>
            <PillGroup
              options={[
                { key: 'predefined' as const, label: L('预定义动作', 'Predefined Action') },
                { key: 'prompt' as const, label: L('自定义 Prompt', 'Custom Prompt') },
              ]}
              value={taskType}
              onChange={setTaskType}
            />

            <div className="mt-2.5">
              {taskType === 'predefined' ? (
                <Select
                  value={action}
                  onChange={setAction}
                  className="kz-mono text-sm"
                  ariaLabel={L('预定义动作', 'Predefined action')}
                  placeholder={L('选择动作', 'Select action')}
                  options={predefinedActions.map((a) => ({ value: a.name, label: isZh ? a.label_zh : a.label_en }))}
                />
              ) : (
                <textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder={L('输入自定义 prompt...', 'Enter custom prompt...')}
                  rows={3}
                  className={`${inputCls} resize-none`}
                  style={{ height: 'auto', padding: '10px 12px' }}
                />
              )}
            </div>
          </div>

          {/* Schedule input */}
          <div>
            <FieldLabel>{L('执行计划', 'Schedule')}</FieldLabel>
            <input
              type="text"
              value={scheduleText}
              onChange={(e) => handleScheduleChange(e.target.value)}
              onBlur={handleScheduleBlur}
              placeholder={L('例: 每天早上9点 / 0 9 * * *', 'e.g. every day at 9am / 0 9 * * *')}
              className={inputCls}
            />
            {/* Parse result */}
            <div className="mt-1.5 min-h-[20px]">
              {parsing && (
                <span className="text-[11px] kz-mono kz-text-mute flex items-center gap-1">
                  <span className="kz-sdot kz-sdot--mute animate-pulse" />
                  {L('解析中...', 'Parsing...')}
                </span>
              )}
              {!parsing && parsedSchedule && (
                <span className="flex items-center gap-2 text-[11px] kz-mono">
                  <span className="kz-badge kz-badge--success">
                    <CheckCircle2 size={11} />
                    {parsedSchedule.type}
                  </span>
                  <span className="kz-text-soft">{parsedSchedule.expr}</span>
                  {parsedSchedule.nextRunAt && (
                    <span className="kz-text-mute">
                      {L('下次', 'next')}: {new Date(parsedSchedule.nextRunAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
                    </span>
                  )}
                </span>
              )}
              {!parsing && parseError && (
                <span className="kz-badge kz-badge--danger flex items-center gap-1">
                  <AlertCircle size={11} />
                  {parseError}
                </span>
              )}
            </div>

            {/* Schedule type + recurring */}
            <div className="flex items-end gap-4 mt-2">
              <div className="flex-1">
                <FieldLabel>{L('调度类型', 'Schedule Type')}</FieldLabel>
                <PillGroup
                  options={[
                    { key: 'cron' as const, label: L('Cron 表达式', 'Cron') },
                    { key: 'interval' as const, label: L('间隔', 'Interval') },
                    { key: 'once' as const, label: L('单次', 'Once') },
                  ]}
                  value={scheduleType}
                  onChange={(v) => {
                    setScheduleType(v);
                    setIsRecurring(v !== 'once');
                  }}
                />
              </div>

              <button
                type="button"
                onClick={() => setIsRecurring(!isRecurring)}
                className={`kz-chip ${isRecurring ? 'kz-chip--on' : 'kz-chip--outline'}`}
              >
                {isRecurring ? <Repeat size={12} /> : <Timer size={12} />}
                {isRecurring ? L('循环', 'Recurring') : L('单次', 'One-time')}
              </button>
            </div>
          </div>

          {/* Permission level */}
          <div>
            <FieldLabel>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck size={10} />
                {L('权限级别', 'Permission Level')}
              </span>
            </FieldLabel>
            <div className="flex gap-4">
              {[
                { value: 'readonly' as const, label: L('只读', 'Read Only') },
                { value: 'readwrite' as const, label: L('读写', 'Read/Write') },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer group">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors`}
                    style={{
                      border: '2px solid',
                      borderColor: permissionLevel === opt.value ? 'var(--ink)' : 'var(--line-strong)',
                      background: permissionLevel === opt.value ? 'var(--ink)' : 'transparent',
                    }}
                  >
                    {permissionLevel === opt.value && (
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--bg)' }} />
                    )}
                  </div>
                  <span className={`text-xs ${permissionLevel === opt.value ? 'kz-text-ink' : 'kz-text-soft'}`}>
                    {opt.label}
                  </span>
                  <input
                    type="radio"
                    name="permission"
                    checked={permissionLevel === opt.value}
                    onChange={() => setPermissionLevel(opt.value)}
                    className="sr-only"
                  />
                </label>
              ))}
            </div>
          </div>

          {/* ── Advanced section ───────────────────────── */}
          <div className="kz-card overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="kz-row-hover w-full flex items-center justify-between px-3 py-2.5 kz-text-soft"
            >
              <span className="flex items-center gap-1.5">
                <Settings2 size={12} className="kz-text-mute" />
                <span className="kz-serif-italic text-[12px]">{L('高级设置', 'Advanced')}</span>
              </span>
              <ChevronRight
                size={14}
                className={`kz-text-mute transition-transform duration-150 ${showAdvanced ? 'rotate-90' : ''}`}
              />
            </button>

            {showAdvanced && (
              <div className="px-3 pb-4 pt-3 space-y-4" style={{ borderTop: '1px solid var(--line-soft)' }}>
                {/* Channel override */}
                <div>
                  <FieldLabel>
                    <span className="inline-flex items-center gap-1">
                      <Bell size={10} />
                      {L('通知渠道', 'Notification Channels')}
                    </span>
                  </FieldLabel>
                  <div className="flex gap-2 flex-wrap">
                    {CHANNELS.map((ch) => {
                      const checked = channelsOverride.includes(ch.value);
                      return (
                        <button
                          key={ch.value}
                          type="button"
                          onClick={() => toggleChannel(ch.value)}
                          className={`kz-chip ${checked ? 'kz-chip--on' : 'kz-chip--outline'}`}
                        >
                          {isZh ? ch.zh : ch.en}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Output mode */}
                <div>
                  <FieldLabel>
                    <span className="inline-flex items-center gap-1">
                      <FileOutput size={10} />
                      {L('输出方式', 'Output Mode')}
                    </span>
                  </FieldLabel>
                  <PillGroup
                    options={[
                      { key: 'push' as const, label: L('推送通知', 'Push') },
                      { key: 'append_file' as const, label: L('追加到文件', 'Append File') },
                      { key: 'accumulate' as const, label: L('仅记录', 'Log Only') },
                    ]}
                    value={outputMode}
                    onChange={setOutputMode}
                  />
                  {outputMode === 'append_file' && (
                    <input
                      type="text"
                      value={outputFilePath}
                      onChange={(e) => setOutputFilePath(e.target.value)}
                      placeholder={L('输出文件路径（留空则自动生成）', 'Output file path (auto if empty)')}
                      className={`${inputCls} mt-2`}
                    />
                  )}
                </div>

                {/* Missed policy */}
                <div>
                  <FieldLabel>{L('错过策略', 'Missed Policy')}</FieldLabel>
                  <div className="flex gap-4">
                    {[
                      { value: 'catch_up_latest' as const, label: L('补执行最新一次', 'Catch up latest') },
                      { value: 'skip' as const, label: L('跳过', 'Skip') },
                    ].map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2 cursor-pointer group">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors`}
                          style={{
                            border: '2px solid',
                            borderColor: missedPolicy === opt.value ? 'var(--ink)' : 'var(--line-strong)',
                            background: missedPolicy === opt.value ? 'var(--ink)' : 'transparent',
                          }}
                        >
                          {missedPolicy === opt.value && (
                            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--bg)' }} />
                          )}
                        </div>
                        <span className={`text-xs ${missedPolicy === opt.value ? 'kz-text-ink' : 'kz-text-soft'}`}>
                          {opt.label}
                        </span>
                        <input
                          type="radio"
                          name="missed"
                          checked={missedPolicy === opt.value}
                          onChange={() => setMissedPolicy(opt.value)}
                          className="sr-only"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                {/* Number fields in a row */}
                <div className="flex gap-4">
                  <div className="flex-1">
                    <FieldLabel>{L('最大补执行时间（小时）', 'Max Miss Hours')}</FieldLabel>
                    <input
                      type="number"
                      value={maxMissHours}
                      onChange={(e) => setMaxMissHours(parseInt(e.target.value) || 0)}
                      min={0}
                      className={`${inputCls} !w-full tabular-nums`}
                    />
                  </div>
                  <div className="flex-1">
                    <FieldLabel>{L('最大重试次数', 'Max Retries')}</FieldLabel>
                    <input
                      type="number"
                      value={maxRetries}
                      onChange={(e) => setMaxRetries(parseInt(e.target.value) || 0)}
                      min={0}
                      max={10}
                      className={`${inputCls} !w-full tabular-nums`}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────── */}
        <div className="flex justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}>
          <button
            onClick={onClose}
            className="kz-btn kz-btn--sm"
          >
            {L('取消', 'Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className={`kz-btn kz-btn--primary kz-btn--sm ${!canSave || saving ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {saving ? L('保存中...', 'Saving...') : isEdit ? L('更新', 'Update') : L('创建', 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
