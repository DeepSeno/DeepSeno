import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Search, Loader2,
  Sparkles, Terminal,
  Wrench, FileText,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useNotifications } from '../components/NotificationCenter';
import { PluginAddDialog } from '../components/PluginAddDialog';
import { PluginDetailPanel } from '../components/PluginDetailPanel';
import { getMarketItemKind, getPluginKind, isRealSkill } from '../lib/capability';

// ─── Types ──────────────────────────────────────────
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

interface MarketItem {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  sourceUri: string;
  tags?: string[];
  icon?: string;
  config_json?: string;
  // v2 新字段（后端直接返回，避免客户端解析 config_json）
  inject_prompt?: string;
  skill_path?: string;
  github_url?: string;
  plugin_type?: string;
}

// Built-in tool keys
const BUILTIN_TOOL_KEYS = [
  'create_todo', 'complete_todo', 'delete_todo', 'list_todos',
  'create_memo', 'generate_report', 'query_knowledge', 'update_memory',
  'list_memories', 'search_recordings', 'set_reminder', 'list_reminders',
  'send_email', 'web_search',
  'create_pptx', 'create_docx', 'read_pdf', 'create_pdf', 'send_file',
] as const;

// Prompt presets for market items that are prompt-only plugins
// (carried over from old recommended prompt definitions)
const SKILL_INSTRUCTIONS: Record<string, string> = {
  meeting_expert: '你是一位会议纪要专家。当用户提到会议内容时：\n1. 提取所有议题和讨论要点\n2. 明确列出做出的决策\n3. 整理行动项（负责人 + 截止日期）\n4. 按时间线组织内容\n5. 标注关键参与者和他们的观点',
  email_writer: '你是一位专业邮件撰写助手。当用户要求写邮件时：\n1. 根据要点生成结构清晰的专业邮件\n2. 注意称呼的恰当性（Dear/Hi/您好）\n3. 保持语气得体、简洁明了\n4. 包含明确的行动呼吁（CTA）\n5. 提供中英文两个版本（如需要）',
  weekly_reporter: '你是一位周报生成器。当用户要求生成周报时：\n1. 汇总本周的所有录音和讨论内容\n2. 分类整理：完成事项、进行中的工作、下周计划\n3. 提取关键数据和指标\n4. 列出待办事项及其优先级\n5. 格式化为清晰的 Markdown 结构',
  task_planner: '你是一位任务规划师。当用户提出模糊需求时：\n1. 将需求拆解为具体可执行的步骤\n2. 为每个步骤估算优先级（P0/P1/P2）\n3. 识别依赖关系和前置条件\n4. 建议合理的时间安排\n5. 标注需要其他人配合的环节',
  pptx_designer: `你是一位专业演示文稿设计师。当用户要求制作PPT时，调用 create_pptx 工具，并遵循以下设计准则：

## 配色方案（根据内容选择最适合的一套）
- Midnight Executive: 深蓝1E2761 + 冰蓝CADCFC + 白色（正式汇报）
- Forest & Moss: 森林绿2C5F2D + 苔绿97BC62（环保/农业）
- Coral Energy: 珊瑚F96167 + 金F9E795（活力/营销）
- Warm Terracotta: 赤陶B85042 + 沙色E7E8D1（温暖/文化）
- Ocean Gradient: 深蓝065A82 + 青1C7293（科技/海洋）
- Teal Trust: 青028090 + 薄荷02C39A（医疗/信任）

## 内容结构
1. 标题页：大标题 + 副标题/日期，深色背景
2. 内容页：每页一个核心观点，配图/图标/数据
3. 结尾页：总结/感谢，深色背景呼应标题页

## 设计原则
- 每张幻灯片必须有视觉元素（图形、色块、数据）
- 不要重复相同的布局
- 正文左对齐，只有标题居中
- 字号对比：标题36-44pt，正文14-16pt
- 留白充分，不要填满每一寸空间`,
};

// Default page config for skill-type market items
const SKILL_DEFAULT_PAGES: Record<string, { icon: string }> = {
  meeting_expert: { icon: 'clipboard' },
  email_writer: { icon: 'mail' },
  weekly_reporter: { icon: 'chart' },
  task_planner: { icon: 'lightbulb' },
  pptx_designer: { icon: 'presentation' },
};

export default function PluginMarket() {
  const { t, lang } = useI18n();
  const isZh = lang === 'zh';
  const api = useApi();
  const { toast } = useNotifications();
  const s = t.settings as unknown as Record<string, string>;

  // ─── State ──────────────────────────────────────────
  const [plugins, setPlugins] = useState<PluginStatusInfo[]>([]);
  const [marketItems, setMarketItems] = useState<MarketItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginStatusInfo | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [recInstalling, setRecInstalling] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'skills' | 'mcp' | 'builtin'>('skills');

  // ─── Load data ──────────────────────────────────────
  const refreshPlugins = useCallback(async () => {
    try {
      const all = await api.pluginGetAll();
      setPlugins(all as PluginStatusInfo[]);
    } catch {
      toast('error', (t.common as any).load_failed);
    }
  }, [api, toast, t]);

  const refreshMarket = useCallback(async () => {
    try {
      const items = await api.pluginGetMarket();
      setMarketItems(items);
    } catch {
      // Market might not be available, silently fail
    }
  }, [api]);

  useEffect(() => { refreshPlugins(); refreshMarket(); }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Derived data ───────────────────────────────────
  const builtinItems = useMemo(() => {
    return BUILTIN_TOOL_KEYS.map((key) => ({
      id: `builtin_${key}`,
      name: key,
      description: s[`builtin_${key}`] || key,
    }));
  }, [s]);

  const uninstalledMarket = useMemo(() => {
    const installedIds = new Set(plugins.map((p) => p.id));
    return marketItems.filter((m) => !installedIds.has(m.id));
  }, [marketItems, plugins]);

  const realSkillPlugins = useMemo(() => plugins.filter((p) => isRealSkill(p)), [plugins]);
  const skillPlugins = useMemo(() => plugins.filter((p) => getPluginKind(p) === 'skill' && !isRealSkill(p)), [plugins]);
  const mcpPlugins = useMemo(() => plugins.filter((p) => getPluginKind(p) === 'mcp'), [plugins]);
  const skillMarket = useMemo(() => uninstalledMarket.filter((m) => getMarketItemKind(m) === 'skill'), [uninstalledMarket]);
  const mcpMarket = useMemo(() => uninstalledMarket.filter((m) => getMarketItemKind(m) === 'mcp'), [uninstalledMarket]);
  const currentPlugins = activeTab === 'skills' ? [...realSkillPlugins, ...skillPlugins] : activeTab === 'mcp' ? mcpPlugins : [];
  const currentMarket = activeTab === 'skills' ? skillMarket : activeTab === 'mcp' ? mcpMarket : [];

  const filteredPlugins = useMemo(() => {
    if (!debouncedQuery) return currentPlugins;
    const q = debouncedQuery.toLowerCase();
    return currentPlugins.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  }, [currentPlugins, debouncedQuery]);

  const filteredMarket = useMemo(() => {
    if (!debouncedQuery) return currentMarket;
    const q = debouncedQuery.toLowerCase();
    return currentMarket.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
  }, [currentMarket, debouncedQuery]);

  const filteredBuiltins = useMemo(() => {
    if (!debouncedQuery) return builtinItems;
    const q = debouncedQuery.toLowerCase();
    return builtinItems.filter((b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q));
  }, [builtinItems, debouncedQuery]);

  // ─── Install handlers ───────────────────────────────
  const handleInstallMarketItem = useCallback(async (item: MarketItem) => {
    setRecInstalling((prev) => ({ ...prev, [item.id]: true }));
    try {
      // ── Path 1: 远程 Skill 包（v2: skill_path 是 COS 下载 URL）──
      if (item.skill_path && item.skill_path.startsWith('http')) {
        const result = await api.pluginInstallFromRemoteSkill(item.skill_path, {
          id: item.id,
          name: item.name,
          description: item.description,
          version: item.version || '1.0.0',
          github_url: item.github_url,
        });
        if (result.success) {
          await refreshPlugins();
          setActiveTab('skills');
        }
        return;
      }

      // ── Path 2: v2 后端直接返回 inject_prompt ──
      // 优先用后端返回的 inject_prompt，不需要解析 config_json
      if (item.inject_prompt) {
        const config: any = {
          id: item.id,
          name: item.name,
          description: item.description,
          version: item.version || '1.0.0',
          enabled: true,
          inject_prompt: item.inject_prompt,
          source: 'market',
        };
        // 如果同时有 MCP 配置（hybrid），从 config_json 解析 mcp 部分
        if (item.config_json) {
          try {
            const cfg = JSON.parse(item.config_json);
            if (cfg.mcp) {
              config.mcp = {
                command: cfg.mcp.command || 'npx',
                args: cfg.mcp.args || [],
                env: cfg.mcp.env || undefined,
                autoStart: cfg.mcp.autoStart !== false,
              };
            }
            if (cfg.page) config.page = cfg.page;
          } catch { /* malformed config_json, ignore */ }
        }
        if (item.github_url) config.sourceUri = item.github_url;
        const result = await api.pluginInstall(config);
        if (result.success) {
          await refreshPlugins();
          setActiveTab(config.mcp ? 'mcp' : 'skills');
        }
        return;
      }

      // ── Path 3: 旧后端 config_json（向后兼容）──
      if (item.config_json) {
        try {
          const cfg = JSON.parse(item.config_json);
          const config: any = {
            id: item.id,
            name: item.name,
            description: item.description,
            version: item.version || '1.0.0',
            enabled: true,
            source: 'market',
            sourceUri: item.sourceUri || undefined,
          };
          // Map inject_prompt（优先）或 instructions（旧字段名）
          const prompt = cfg.inject_prompt || cfg.instructions;
          if (prompt) config.inject_prompt = prompt;
          if (cfg.mcp) {
            config.mcp = {
              command: cfg.mcp.command || 'npx',
              args: cfg.mcp.args || [],
              env: cfg.mcp.env || undefined,
              autoStart: cfg.mcp.autoStart !== false,
            };
          }
          if (cfg.page) config.page = cfg.page;
          if (cfg.skill_path && cfg.skill_path.startsWith('http')) {
            // config_json 里有 skill_path URL → 远程 Skill 包
            const result = await api.pluginInstallFromRemoteSkill(cfg.skill_path, {
              id: item.id,
              name: item.name,
              description: item.description,
              version: item.version || '1.0.0',
            });
            if (result.success) {
              await refreshPlugins();
              setActiveTab('skills');
            }
            return;
          }
          if (!config.inject_prompt && !config.mcp) {
            throw new Error('config_json has neither inject_prompt nor mcp');
          }
          const result = await api.pluginInstall(config);
          if (result.success) {
            await refreshPlugins();
            setActiveTab(config.mcp ? 'mcp' : 'skills');
          }
          return;
        } catch {
          // Malformed config_json — fall through to legacy logic below
        }
      }

      // ── Path 4: BUILTIN_LIST fallback（离线兜底）──
      // 仅在远程拉取失败、使用硬编码 BUILTIN_LIST 时走到这里
      const injectPrompt = SKILL_INSTRUCTIONS[item.id];
      const defaultPage = SKILL_DEFAULT_PAGES[item.id];

      if (item.sourceUri && !injectPrompt) {
        // MCP-type: install as plugin with MCP server
        const config: any = {
          id: item.id,
          name: item.name,
          description: item.description,
          enabled: true,
          mcp: { command: 'npx', args: ['-y', item.sourceUri], autoStart: true },
          source: 'market',
          sourceUri: item.sourceUri,
        };
        const result = await api.pluginInstall(config);
        if (result.success) {
          await refreshPlugins();
          setActiveTab('mcp');
        }
      } else if (injectPrompt) {
        // Prompt-type: install as plugin with inject_prompt
        const config: any = {
          id: item.id,
          name: item.name,
          description: item.description,
          inject_prompt: injectPrompt,
          enabled: true,
          source: 'market',
        };
        if (defaultPage) config.page = defaultPage;
        if (item.sourceUri) {
          config.mcp = { command: 'npx', args: ['-y', item.sourceUri], autoStart: true };
          config.sourceUri = item.sourceUri;
        }
        const result = await api.pluginInstall(config);
        if (result.success) {
          await refreshPlugins();
          setActiveTab(config.mcp ? 'mcp' : 'skills');
        }
      } else if (item.sourceUri) {
        // Fallback: install via sourceUri if available
        const config: any = {
          id: item.id,
          name: item.name,
          description: item.description,
          enabled: true,
          mcp: { command: 'npx', args: ['-y', item.sourceUri], autoStart: true },
          source: 'market',
          sourceUri: item.sourceUri,
        };
        const result = await api.pluginInstall(config);
        if (result.success) {
          await refreshPlugins();
          setActiveTab('mcp');
        }
      }
    } finally {
      setRecInstalling((prev) => ({ ...prev, [item.id]: false }));
    }
  }, [api, refreshPlugins]);

  // ─── Render ─────────────────────────────────────────
  if (plugins === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-mono kz-text-mute" style={{ fontSize: 13 }}>{(t.common as any).loading}</div>
      </div>
    );
  }

  const tabDefs = [
    { key: 'skills' as const, label: isZh ? 'Skills / 提示词' : 'Skills / Prompts', count: realSkillPlugins.length + skillPlugins.length + skillMarket.length, icon: <FileText size={13} /> },
    { key: 'mcp' as const, label: isZh ? 'MCP 服务' : 'MCP Services', count: mcpPlugins.length + mcpMarket.length, icon: <Wrench size={13} /> },
    { key: 'builtin' as const, label: s.skill_market_tab_builtin, count: builtinItems.length, icon: <Terminal size={13} /> },
  ];

  return (
    <div className="flex flex-col gap-5 h-full">
      {/* Header bar: filter chips + search + add (design uses chips, not tabs, for sub-section filters) */}
      <div className="flex items-center justify-between">
        <div style={{ display: 'flex', gap: 6 }}>
          {tabDefs.map((tab) => {
            const on = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setSearchQuery(''); setSelectedPlugin(null); }}
                className={'kz-chip' + (on ? ' kz-chip--on' : ' kz-chip--outline')}
              >
                {tab.label}
                <span className="kz-chip__count">{tab.count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {activeTab !== 'builtin' && (
            <div className="kz-search-wrap" style={{ width: 220 }}>
              <Search size={13} className="kz-text-mute" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={s.skill_market_search}
                className="kz-mono"
              />
            </div>
          )}
          {activeTab !== 'builtin' && (
            <button onClick={() => setShowAddDialog(true)} className="kz-btn kz-btn--primary kz-btn--sm">
              <Plus size={13} strokeWidth={2.5} />
              {activeTab === 'mcp' ? (isZh ? '添加 MCP' : 'Add MCP') : (isZh ? '添加 Skill' : 'Add Skill')}
            </button>
          )}
        </div>
      </div>

      {/* Tab content: Skills / MCP */}
      {(activeTab === 'skills' || activeTab === 'mcp') && (
        <div className="kz-anim-in">
          {filteredMarket.length > 0 && (
            <div className="grid grid-cols-4 gap-3 mb-4">
              {filteredMarket.map((item, idx) => {
                const isMcp = getMarketItemKind(item) === 'mcp';
                return (
                  <div
                    key={item.id}
                    className="kz-card kz-anim-in group flex flex-col justify-between"
                    style={{ padding: 16, animationDelay: `${idx * 40}ms` }}
                  >
                    <div>
                      <div className="flex items-center gap-2.5 mb-2">
                        <div
                          className="flex items-center justify-center"
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            background: 'var(--bg-elev)',
                            border: '1px solid var(--line-soft)',
                            color: 'var(--ink-soft)',
                          }}
                        >
                          {isMcp ? <Wrench size={14} /> : <Sparkles size={14} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="kz-serif kz-text-ink truncate" style={{ fontSize: 14 }}>{item.name}</div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`kz-badge ${isMcp ? 'kz-badge--info' : 'kz-badge--violet'}`} style={{ textTransform: 'uppercase' }}>
                              {isMcp ? 'MCP' : 'PROMPT'}
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className="kz-text-mute leading-relaxed line-clamp-2" style={{ fontSize: 11.5 }}>{item.description}</p>
                    </div>
                    <div className="mt-3">
                      <button
                        onClick={() => handleInstallMarketItem(item)}
                        disabled={recInstalling[item.id]}
                        className="kz-btn kz-btn--primary kz-btn--sm w-full justify-center"
                        style={{ opacity: recInstalling[item.id] ? 0.4 : 1 }}
                      >
                        {recInstalling[item.id] ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={2.5} />}
                        {s.tools_install}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {filteredPlugins.length === 0 ? (
            filteredMarket.length > 0 ? (
              <div className="kz-serif-italic kz-text-mute text-center" style={{ fontSize: 12, padding: '16px 0' }}>
                {isZh ? '点击上方卡片安装，或点右上角手动添加' : 'Click a card above to install, or add manually'}
              </div>
            ) : (
              <div className="kz-empty">
                <div className="kz-empty__icon">{activeTab === 'mcp' ? <Wrench size={20} /> : <FileText size={20} />}</div>
                <div>
                  <div className="kz-empty__title">{activeTab === 'mcp' ? (isZh ? '尚未安装 MCP 服务' : 'No MCP services installed') : (isZh ? '尚未安装 Skills / 提示词' : 'No Skills / prompts installed')}</div>
                </div>
              </div>
            )
          ) : (
            <div className="kz-paper flex overflow-hidden flex-1" style={{ padding: 0 }}>
              {/* Left: list */}
              <div className="overflow-y-auto" style={{ width: '58%', borderRight: '1px solid var(--line-soft)' }}>
                {filteredPlugins.map((plugin, idx) => {
                  const isActive = selectedPlugin?.id === plugin.id;
                  const isRunning = plugin.status === 'running' || plugin.status === 'active';
                  const isError = plugin.status === 'error';
                  return (
                    <button
                      key={plugin.id}
                      onClick={() => setSelectedPlugin(plugin)}
                      className={`w-full text-left kz-row-hover ${isActive ? 'kz-row-selected' : ''}`}
                      style={{
                        padding: '14px 16px',
                        borderBottom: '1px solid var(--line-soft)',
                        animationDelay: `${idx * 20}ms`,
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="flex items-center justify-center flex-shrink-0"
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 8,
                              background: 'var(--bg-elev)',
                              border: '1px solid var(--line-soft)',
                              color: 'var(--ink-soft)',
                            }}
                          >
                            {plugin.hasMCP ? <Wrench size={13} /> : <FileText size={13} />}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="kz-serif kz-text-ink truncate" style={{ fontSize: 14 }}>{plugin.name}</span>
                              {(isRunning || (plugin.enabled && plugin.hasInstructions && !plugin.hasMCP)) && (
                                <span className="kz-sdot kz-sdot--success flex-shrink-0" />
                              )}
                              {isError && (
                                <span className="kz-sdot kz-sdot--danger flex-shrink-0" />
                              )}
                            </div>
                            {plugin.description && (
                              <div className="kz-text-mute truncate mt-0.5" style={{ fontSize: 11 }}>{plugin.description}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                          {isRunning && plugin.toolCount > 0 && (
                            <span className="kz-mono kz-text-faint tabular-nums" style={{ fontSize: 10 }}>{plugin.toolCount} tools</span>
                          )}
                          <div className="flex items-center gap-1">
                            {plugin.hasMCP && (
                              <span className="kz-badge kz-badge--info" style={{ textTransform: 'uppercase' }}>MCP</span>
                            )}
                            {plugin.hasInstructions && (
                              <span className="kz-badge kz-badge--violet" style={{ textTransform: 'uppercase' }}>PROMPT</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Right: detail drawer */}
              <div className="overflow-y-auto" style={{ width: '42%', background: 'var(--bg-elev)' }}>
                {!selectedPlugin ? (
                  <div className="kz-empty h-full">
                    <div className="kz-empty__icon"><Search size={18} /></div>
                    <div>
                      <div className="kz-empty__sub">{s.skill_market_empty_detail}</div>
                    </div>
                  </div>
                ) : (
                  <PluginDetailPanel
                    plugin={selectedPlugin}
                    onClose={() => setSelectedPlugin(null)}
                    onRefresh={() => {
                      refreshPlugins().then(() => {
                        // Re-select the plugin with updated data
                        api.pluginGetAll().then((all) => {
                          const updated = (all as PluginStatusInfo[]).find((p) => p.id === selectedPlugin.id);
                          setSelectedPlugin(updated || null);
                        });
                      });
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab content: Built-in Tools */}
      {activeTab === 'builtin' && (
        <div className="kz-anim-in">
          <div
            className="grid grid-cols-3 overflow-hidden"
            style={{
              gap: 1,
              background: 'var(--line)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
            }}
          >
            {filteredBuiltins.map((item) => (
              <div key={item.id} style={{ background: 'var(--bg-card)', padding: '12px 16px' }}>
                <div className="flex items-center gap-2">
                  <Terminal size={12} className="kz-text-faint flex-shrink-0" />
                  <span className="kz-mono kz-text-ink" style={{ fontSize: 12 }}>{item.name}</span>
                </div>
                <p className="kz-text-mute leading-relaxed mt-1 ml-5 line-clamp-1" style={{ fontSize: 11 }}>{item.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 kz-serif-italic kz-text-mute" style={{ fontSize: 11 }}>
            {s.skill_market_builtin_footer}
          </div>
        </div>
      )}

      {/* Add Plugin Dialog */}
      <PluginAddDialog
        open={showAddDialog}
        mode={activeTab === 'mcp' ? 'mcp' : 'skill'}
        existingIds={plugins.map((p) => p.id)}
        onClose={() => setShowAddDialog(false)}
        onInstalled={refreshPlugins}
      />
    </div>
  );
}
