import { useState, useEffect, useRef, useCallback } from 'react';
import {
  AlertCircle, Loader2,
  Pencil, Trash2, Wrench, FileText, Info,
  ToggleLeft, ToggleRight, ArrowUpCircle,
  X, Check,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useI18n } from '../i18n';
import { getPluginKind, isHybridPlugin } from '../lib/capability';
import { parseMcpServersJson, pluginMcpToJson } from '../lib/mcp-json';

interface PluginStatusInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  hasInstructions: boolean;
  hasMCP: boolean;
  status: string;
  toolCount: number;
  skill_path?: string;
  error?: string;
  source: string;
  sourceUri?: string;
  version?: string;
  page?: { icon?: string; menuLabel?: string; welcomeMessage?: string };
  serverInfo?: { name: string; version: string };
}

interface PluginDetailPanelProps {
  plugin: PluginStatusInfo;
  onClose: () => void;
  onRefresh: () => void;
}

interface ToolInfo {
  name: string;
  description: string;
  parameters: any;
}

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
}

const LOG_COLORS: Record<string, string> = {
  event: 'text-emerald-400',
  error: 'text-red-400',
  tool: 'text-cyan-400',
  info: 'text-neutral-300',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function PluginDetailPanel({ plugin, onClose, onRefresh }: PluginDetailPanelProps) {
  const api = useApi();
  const { t, lang } = useI18n();
  const isZh = lang === 'zh';
  const s = t.settings;

  const kind = getPluginKind(plugin);
  const hybrid = isHybridPlugin(plugin);
  const tabs = ['overview', ...(kind === 'mcp' ? ['tools', 'logs'] : [])] as const;
  type TabKey = (typeof tabs)[number];
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ package: string; latest: string; current?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editJson, setEditJson] = useState('');
  const [editError, setEditError] = useState('');

  // Reset edit state when switching plugins
  useEffect(() => {
    setEditing(false);
    setEditJson('');
    setEditError('');
    setActiveTab('overview');
  }, [plugin.id]);

  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const isRunning = plugin.status === 'running' || plugin.status === 'active';
  const isError = plugin.status === 'error';
  const isNpx = plugin.sourceUri && plugin.hasMCP;

  // Load tools when tab switches
  useEffect(() => {
    if (activeTab === 'tools' && plugin.hasMCP) {
      api.pluginGetTools(plugin.id).then(setTools).catch(() => {});
    }
  }, [activeTab, plugin.id, plugin.hasMCP]);

  // Poll logs
  useEffect(() => {
    if (activeTab !== 'logs' || !plugin.hasMCP) return;
    const fetch = () => api.pluginGetLogs(plugin.id).then(setLogs).catch(() => {});
    fetch();
    const interval = setInterval(fetch, 2000);
    return () => clearInterval(interval);
  }, [activeTab, plugin.id, plugin.hasMCP]);

  // Check for updates
  useEffect(() => {
    if (isNpx) {
      api.pluginCheckUpdate(plugin.id).then(setUpdateInfo).catch(() => {});
    }
  }, [plugin.id, isNpx]);

  // Auto-scroll logs
  useEffect(() => {
    if (activeTab === 'logs' && autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab, autoScroll]);

  const handleLogScroll = () => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const handleToggle = useCallback(async () => {
    setLoading(true);
    try {
      if (plugin.enabled) {
        await api.pluginDisable(plugin.id);
      } else {
        await api.pluginEnable(plugin.id);
      }
      onRefresh();
    } finally {
      setLoading(false);
    }
  }, [plugin.id, plugin.enabled, api, onRefresh]);

  const handleUninstall = useCallback(async () => {
    if (!window.confirm(`Uninstall "${plugin.name}"?`)) return;
    await api.pluginUninstall(plugin.id);
    onRefresh();
    onClose();
  }, [plugin.id, plugin.name, api, onRefresh, onClose]);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true);
    try {
      const result = await api.pluginUpgrade(plugin.id);
      if (result.success) {
        setUpdateInfo(null);
        onRefresh();
      }
    } finally {
      setUpgrading(false);
    }
  }, [plugin.id, api, onRefresh]);

  const handleClearLogs = useCallback(() => {
    api.pluginClearLogs(plugin.id);
    setLogs([]);
  }, [plugin.id, api]);

  const [editLoading, setEditLoading] = useState(false);

  const handleStartEdit = useCallback(async () => {
    setEditLoading(true);
    try {
      const settings: any = await api.loadSettings();
      const pluginConfig = (settings.plugins || []).find((p: any) => p.id === plugin.id);
      if (kind === 'mcp') {
        setEditJson(pluginMcpToJson(plugin.id, pluginConfig?.mcp));
        setEditError('');
        setEditing(true);
        return;
      }

      const clean: any = { id: plugin.id, name: plugin.name };
      if (pluginConfig) {
        if (pluginConfig.description) clean.description = pluginConfig.description;
        if (pluginConfig.version) clean.version = pluginConfig.version;
        if (pluginConfig.inject_prompt || pluginConfig.instructions) clean.inject_prompt = pluginConfig.inject_prompt || pluginConfig.instructions;
        if (pluginConfig.skill_path) clean.skill_path = pluginConfig.skill_path;
        if (pluginConfig.mcp) clean.mcp = pluginConfig.mcp;
        if (pluginConfig.page) clean.page = pluginConfig.page;
      }
      setEditJson(JSON.stringify(clean, null, 2));
      setEditError('');
      setEditing(true);
    } finally {
      setEditLoading(false);
    }
  }, [plugin.id, plugin.name, api, kind]);

  const handleSaveEdit = useCallback(async () => {
    setEditError('');
    try {
      if (kind === 'mcp') {
        const parsedMcp = parseMcpServersJson(editJson, []);
        if (!parsedMcp.ok) {
          setEditError(parsedMcp.errors.join('\n'));
          return;
        }
        if (parsedMcp.configs.length !== 1 || parsedMcp.configs[0].id !== plugin.id) {
          setEditError(isZh ? '暂不支持修改 MCP id，请删除后重新添加' : 'Changing the MCP id is not supported. Please delete and add it again.');
          return;
        }
        const result = await api.pluginUpdate(plugin.id, { mcp: parsedMcp.configs[0].mcp });
        if (result.success) {
          setEditing(false);
          onRefresh();
        } else {
          setEditError(result.error || (isZh ? '保存失败' : 'Save failed'));
        }
        return;
      }

      const parsed = JSON.parse(editJson);
      if (!parsed.id) { setEditError(isZh ? '缺少 id 字段' : 'Missing id field'); return; }
      // Build update payload
      // Replace the entire config with what the user provided.
      // Fields absent from JSON are explicitly set to null to clear them.
      const updates: any = {
        name: parsed.name ?? plugin.name,
        description: parsed.description ?? '',
        version: parsed.version ?? undefined,
        inject_prompt: parsed.inject_prompt ?? parsed.instructions ?? null,
        mcp: parsed.mcp ?? null,
        page: parsed.page ?? null,
      };

      const result = await api.pluginUpdate(plugin.id, updates);
      if (result.success) {
        setEditing(false);
        onRefresh();
      } else {
        setEditError(result.error || (isZh ? '保存失败' : 'Save failed'));
      }
    } catch (err) {
      setEditError((isZh ? 'JSON 格式错误：' : 'Invalid JSON: ') + String(err).replace('SyntaxError: ', ''));
    }
  }, [editJson, plugin.id, kind, api, onRefresh, isZh]);

  return (
    <div key={plugin.id} className="p-5 space-y-3 panel-slide">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: isRunning ? 'var(--c-accent)' : 'var(--bg-elev)',
              border: '1px solid var(--line-soft)',
              color: isRunning ? 'oklch(0.99 0.005 75)' : 'var(--ink-soft)',
            }}
          >
            <Wrench size={14} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="kz-serif kz-text-ink" style={{ fontSize: 15 }}>{plugin.name}</span>
              {plugin.version && (
                <span className="kz-mono kz-text-faint" style={{ fontSize: 10 }}>v{plugin.version}</span>
              )}
              {updateInfo && updateInfo.current !== updateInfo.latest && (
                <button
                  onClick={handleUpgrade}
                  disabled={upgrading}
                  className="kz-badge kz-badge--info flex items-center gap-1"
                  style={{ opacity: upgrading ? 0.5 : 1 }}
                >
                  <ArrowUpCircle size={10} />
                  {upgrading ? 'Updating...' : `Update v${updateInfo.latest}`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {kind === 'mcp' && (
                <span className="kz-badge kz-badge--info flex items-center gap-1" style={{ textTransform: 'uppercase' }}>
                  <Wrench size={8} /> MCP
                </span>
              )}
              {kind === 'skill' && plugin.hasInstructions && (
                <span className="kz-badge kz-badge--violet flex items-center gap-1" style={{ textTransform: 'uppercase' }}>
                  <FileText size={8} /> {isZh ? '提示词' : 'Prompt'}
                </span>
              )}
              {hybrid && (
                <span className="kz-badge kz-badge--violet flex items-center gap-1" style={{ textTransform: 'uppercase' }}>
                  <FileText size={8} /> {isZh ? '含提示词' : 'With Prompt'}
                </span>
              )}
              {isRunning ? (
                <span className="kz-badge kz-badge--success flex items-center gap-1"><span className="kz-sdot kz-sdot--success" />{s.tools_status_running}</span>
              ) : isError ? (
                <span className="kz-badge kz-badge--danger flex items-center gap-1"><AlertCircle size={10} />{s.tools_status_error}</span>
              ) : (
                <span className="kz-badge kz-badge--mute">{s.tools_status_stopped}</span>
              )}
              {isRunning && plugin.toolCount > 0 && (
                <span className="kz-mono kz-text-faint tabular-nums" style={{ fontSize: 10 }}>· {plugin.toolCount} tools</span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={loading}
          className="flex items-center gap-1.5 kz-mono"
          style={{ fontSize: 11, color: plugin.enabled ? 'var(--c-success)' : 'var(--ink-mute)' }}
        >
          {plugin.enabled ? (
            <><ToggleRight size={18} /><span>{s.tools_enabled}</span></>
          ) : (
            <><ToggleLeft size={18} /><span>{s.tools_disabled}</span></>
          )}
        </button>
      </div>

      {/* Tabs (pill style, matches Settings page) */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-card)',
            width: 'fit-content',
          }}
        >
          {tabs.map((tab) => {
            const Icon = tab === 'overview' ? Info : tab === 'tools' ? Wrench : FileText;
            const label = tab === 'overview' ? s.tools_tab_overview : tab === 'tools' ? 'Tools' : s.tools_tab_logs;
            const on = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 16px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  background: on ? 'var(--c-accent)' : 'transparent',
                  color: on ? 'var(--c-accent-ink)' : 'var(--ink-soft)',
                  border: 0,
                  cursor: 'pointer',
                  transition: 'background 0.14s, color 0.14s',
                }}
              >
                <Icon size={13} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-3">
          {editing ? (
            /* ─── JSON Edit Mode ─── */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="kz-serif-italic kz-text-soft" style={{ fontSize: 12 }}>
                  {kind === 'mcp' ? (isZh ? '编辑 MCP JSON' : 'Edit MCP JSON') : (isZh ? '编辑提示词配置' : 'Edit Prompt Config')}
                </span>
                <div className="flex gap-1.5">
                  <button onClick={() => setEditing(false)} className="kz-btn kz-btn--sm kz-btn--ghost">
                    <X size={11} /> {isZh ? '取消' : 'Cancel'}
                  </button>
                  <button onClick={handleSaveEdit} className="kz-btn kz-btn--sm kz-btn--primary">
                    <Check size={11} /> {isZh ? '保存' : 'Save'}
                  </button>
                </div>
              </div>
              <textarea
                value={editJson}
                onChange={(e) => { setEditJson(e.target.value); setEditError(''); }}
                rows={16}
                className="w-full kz-mono kz-text-ink resize-y leading-relaxed"
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  fontSize: 12,
                  outline: 'none',
                }}
                spellCheck={false}
              />
              {editError && (
                <div className="kz-badge kz-badge--danger" style={{ display: 'block', padding: '8px 12px' }}>{editError}</div>
              )}
            </div>
          ) : (
            /* ─── Normal Overview ─── */
            <>
              {!plugin.enabled && (
                <p className="kz-badge kz-badge--warn" style={{ display: 'block', padding: '8px 12px' }}>{s.tools_mcp_disabled_hint}</p>
              )}
              {plugin.description && <p className="kz-text-soft leading-relaxed" style={{ fontSize: 12.5 }}>{plugin.description}</p>}

              {kind === 'skill' && (
                <div>
                  <div className="kz-serif-italic kz-text-mute mb-1.5" style={{ fontSize: 11 }}>{isZh ? '提示词' : 'Prompt'}</div>
                  <div className="kz-card kz-text-soft whitespace-pre-wrap" style={{ fontSize: 11.5, padding: '10px 12px', maxHeight: 180, overflowY: 'auto' }}>
                    {plugin.skill_path
                      ? (isZh ? `真实 Skill 路径：${plugin.skill_path}` : `Real Skill path: ${plugin.skill_path}`)
                      : (isZh ? '该提示词内容可通过编辑查看和修改。' : 'You can view or modify this prompt from Edit.')}
                  </div>
                </div>
              )}

              {hybrid && (
                <div>
                  <div className="kz-serif-italic kz-text-mute mb-1.5" style={{ fontSize: 11 }}>{isZh ? '附加提示词' : 'Additional Prompt'}</div>
                  <div className="kz-card kz-text-soft" style={{ fontSize: 11.5, padding: '10px 12px' }}>
                    {isZh ? '该 MCP 服务包含额外提示词，编辑完整配置可查看或删除。' : 'This MCP service includes an extra prompt. Edit the full config to view or remove it.'}
                  </div>
                </div>
              )}

              {/* Source info */}
              <div>
                <div className="kz-serif-italic kz-text-mute mb-1.5" style={{ fontSize: 11 }}>Source</div>
                <div className="kz-card kz-mono kz-text-soft" style={{ fontSize: 11, padding: '8px 12px' }}>
                  <span className="kz-text-faint">{plugin.source}</span>
                  {plugin.sourceUri && <span className="ml-2">{plugin.sourceUri}</span>}
                </div>
              </div>

              {/* Server info */}
              {plugin.serverInfo && (
                <div>
                  <div className="kz-serif-italic kz-text-mute mb-1.5" style={{ fontSize: 11 }}>Server</div>
                  <div className="kz-card kz-mono kz-text-soft" style={{ fontSize: 11, padding: '8px 12px' }}>
                    {plugin.serverInfo.name} v{plugin.serverInfo.version}
                  </div>
                </div>
              )}

              {isError && plugin.error && (
                <div
                  className="kz-mono kz-text-ink max-h-[120px] overflow-y-auto"
                  style={{
                    background: 'var(--c-danger-bg)',
                    color: 'var(--c-danger)',
                    border: '1px solid oklch(0.85 0.04 25)',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 11,
                  }}
                >{plugin.error}</div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                {loading ? (
                  <div className="flex items-center gap-1.5 kz-mono kz-text-mute" style={{ fontSize: 11 }}>
                    <Loader2 size={12} className="animate-spin" /> Loading...
                  </div>
                ) : (
                  <>
                    <button onClick={handleStartEdit} disabled={editLoading} className="kz-btn kz-btn--sm" style={{ opacity: editLoading ? 0.5 : 1 }}>
                      {editLoading ? <Loader2 size={10} className="animate-spin" /> : <Pencil size={10} />} {kind === 'mcp' ? (isZh ? '编辑 MCP JSON' : 'Edit MCP JSON') : (isZh ? '编辑提示词' : 'Edit Prompt')}
                    </button>
                    <button onClick={handleUninstall} className="kz-btn kz-btn--sm kz-btn--danger ml-auto">
                      <Trash2 size={10} /> {s.tools_uninstall}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Tools Tab */}
      {activeTab === 'tools' && (
        <div className="space-y-2">
          {tools.length === 0 ? (
            <p className="kz-mono kz-text-mute px-2" style={{ fontSize: 11 }}>{s.tools_tools_empty}</p>
          ) : (
            <div className="space-y-1 max-h-[400px] overflow-y-auto">
              {tools.map((tool, i) => (
                <div
                  key={i}
                  className="kz-mono"
                  style={{
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--line-soft)',
                    borderRadius: 8,
                    padding: '6px 12px',
                    fontSize: 11,
                  }}
                >
                  <span className="kz-text-ink">{tool.name}</span>
                  {tool.description && <span className="kz-text-mute ml-2">— {tool.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <button onClick={handleClearLogs} className="kz-btn kz-btn--ghost kz-btn--sm">{s.tools_logs_clear}</button>
          </div>
          <div
            ref={logContainerRef}
            onScroll={handleLogScroll}
            className="kz-mono max-h-[400px] overflow-y-auto"
            style={{
              background: 'oklch(0.15 0.012 60)',
              borderRadius: 8,
              padding: 12,
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >
            {logs.length === 0 ? (
              <p style={{ color: 'oklch(0.55 0.012 60)' }}>{s.tools_logs_empty}</p>
            ) : (
              logs.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span style={{ color: 'oklch(0.55 0.012 60)' }} className="flex-shrink-0">{formatTime(entry.timestamp)}</span>
                  <span className={LOG_COLORS[entry.level] || 'text-neutral-300'}>{entry.message}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
