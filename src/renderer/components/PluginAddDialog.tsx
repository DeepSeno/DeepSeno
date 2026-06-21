import { useState, useCallback } from 'react';
import { X, Plus, Check, AlertCircle, FileText, Wrench, FolderOpen, GitBranch } from 'lucide-react';
import { useI18n } from '../i18n';
import { parseMcpServersJson } from '../lib/mcp-json';

interface PluginAddDialogProps {
  open: boolean;
  mode: 'skill' | 'mcp';
  existingIds: string[];
  onClose: () => void;
  onInstalled: () => void;
}

const MCP_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "env": {}
    }
  }
}`;

export function PluginAddDialog({ open, mode, existingIds, onClose, onInstalled }: PluginAddDialogProps) {
  const { lang } = useI18n();
  const isZh = lang === 'zh';
  const [rawText, setRawText] = useState(MCP_EXAMPLE);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const [skillSource, setSkillSource] = useState<'folder' | 'github' | 'prompt'>('folder');
  const [githubUrl, setGithubUrl] = useState('');
  const [githubCheck, setGithubCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [skillForm, setSkillForm] = useState({
    id: '',
    name: '',
    description: '',
    injectPrompt: '',
    icon: '',
    menuLabel: '',
    welcomeMessage: '',
  });

  const getApi = useCallback(() => (window as any).api, []);
  const title = mode === 'skill'
    ? (isZh ? '添加提示词' : 'Add Prompt')
    : (isZh ? '添加 MCP 服务' : 'Add MCP Service');
  const subtitle = mode === 'skill'
    ? (isZh ? '创建一段注入 Agent 的提示词' : 'Create an inject prompt for the Agent')
    : (isZh ? '粘贴标准 MCP JSON 配置' : 'Paste standard MCP JSON');
  const Icon = mode === 'skill' ? FileText : Wrench;

  const skillError = mode === 'skill' && skillSource === 'prompt'
    ? !skillForm.id.trim()
      ? (isZh ? '缺少 id' : 'Missing id')
      : !/^[a-zA-Z0-9_-]+$/.test(skillForm.id.trim())
        ? (isZh ? 'id 只能包含字母、数字、下划线和连字符' : 'id can only contain letters, digits, underscore, and hyphen')
        : existingIds.includes(skillForm.id.trim())
          ? (isZh ? '已安装同名能力，请修改 id' : 'An item with this id already exists')
          : !skillForm.injectPrompt.trim()
            ? (isZh ? '请填写提示词内容' : 'Please enter the prompt content')
            : ''
    : '';

  const mcpResult = mode === 'mcp' && rawText.trim()
    ? parseMcpServersJson(rawText, existingIds)
    : null;

  const pageConfig = skillForm.icon.trim() || skillForm.menuLabel.trim() || skillForm.welcomeMessage.trim()
    ? {
        icon: skillForm.icon.trim() || undefined,
        menuLabel: skillForm.menuLabel.trim() || undefined,
        welcomeMessage: skillForm.welcomeMessage.trim() || undefined,
      }
    : undefined;

  const resetAndClose = useCallback(() => {
    setError('');
    onClose();
  }, [onClose]);

  const handleInstall = useCallback(async () => {
    setError('');
    setInstalling(true);

    try {
      const api = getApi();
      if (mode === 'skill') {
        if (skillSource === 'folder') {
          const dir = await api.selectDirectory();
          if (!dir) return;
          const result = await api.skillInstallFromDirectory(dir, pageConfig);
          if (!result.success) {
            setError(result.error || (isZh ? '安装失败' : 'Installation failed'));
            return;
          }
          onInstalled();
          onClose();
          return;
        }
        if (skillSource === 'github') {
          const result = await api.skillInstallFromGithub(githubUrl.trim(), pageConfig);
          if (!result.success) {
            setError(result.error || (isZh ? '安装失败' : 'Installation failed'));
            return;
          }
          onInstalled();
          onClose();
          return;
        }
        if (skillError) {
          setError(skillError);
          return;
        }
        const id = skillForm.id.trim();
        const result = await api.pluginInstall({
          id,
          name: skillForm.name.trim() || id,
          description: skillForm.description.trim(),
          enabled: true,
          inject_prompt: skillForm.injectPrompt.trim(),
          page: pageConfig,
          source: 'manual',
          version: '0.0.0',
        });
        if (!result.success) {
          setError(result.error || (isZh ? '安装失败' : 'Installation failed'));
          return;
        }
        setSkillForm({ id: '', name: '', description: '', injectPrompt: '', icon: '', menuLabel: '', welcomeMessage: '' });
        onInstalled();
        onClose();
        return;
      }

      const parsedMcp = parseMcpServersJson(rawText, existingIds);
      if (!parsedMcp.ok) {
        setError(parsedMcp.errors.join('\n'));
        return;
      }
      const failures: string[] = [];
      let successCount = 0;
      for (const config of parsedMcp.configs) {
        const result = await api.pluginInstall({ ...config, version: '0.0.0' });
        if (result.success) successCount += 1;
        else failures.push(`${config.id}: ${result.error || (isZh ? '安装失败' : 'failed')}`);
      }
      onInstalled();
      if (failures.length > 0) {
        setError(isZh
          ? `已成功安装 ${successCount} 个，失败 ${failures.length} 个：\n${failures.join('\n')}`
          : `${successCount} installed, ${failures.length} failed:\n${failures.join('\n')}`
        );
        return;
      }
      setRawText(MCP_EXAMPLE);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(false);
    }
  }, [existingIds, getApi, githubUrl, isZh, mode, onClose, onInstalled, pageConfig, rawText, skillError, skillForm, skillSource]);

  const handleVerifyGithub = useCallback(async () => {
    setError('');
    setGithubCheck(null);
    if (!githubUrl.trim()) {
      setGithubCheck({ ok: false, error: isZh ? '请输入 GitHub 仓库链接' : 'Please enter a GitHub repo URL' });
      return;
    }
    const result = await getApi().skillVerifyGithub(githubUrl.trim());
    setGithubCheck(result.ok ? { ok: true } : { ok: false, error: result.error || (isZh ? '校验失败' : 'Verification failed') });
  }, [getApi, githubUrl, isZh]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 kz-anim-in"
      style={{ background: 'oklch(0.3 0.02 60 / 0.35)', backdropFilter: 'blur(2px)' }}
      role="dialog"
      aria-modal="true"
    >
      <div className="kz-paper w-[600px] max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'var(--bg-elev)',
                border: '1px solid var(--line)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--c-accent)',
              }}
            >
              <Icon size={14} />
            </div>
            <div>
              <h3 className="kz-serif" style={{ fontSize: '17px' }}>{title}</h3>
              <p className="kz-serif-italic kz-text-mute mt-0.5" style={{ fontSize: '11.5px' }}>{subtitle}</p>
            </div>
          </div>
          <button onClick={resetAndClose} className="kz-btn kz-btn--ghost kz-btn--sm" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="px-5 pb-3 space-y-3 flex-1 overflow-y-auto">
          {mode === 'skill' ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                {([
                  ['folder', FolderOpen, isZh ? '拖拽/选择文件夹' : 'Drag / Select Folder'],
                  ['github', GitBranch, 'GitHub'],
                  ['prompt', FileText, isZh ? '提示词' : 'Prompt'],
                ] as const).map(([key, TabIcon, label]) => (
                  <button key={key} onClick={() => { setSkillSource(key); setError(''); }} className={'kz-chip ' + (skillSource === key ? 'kz-chip--on' : 'kz-chip--outline')}>
                    <TabIcon size={12} /> {label}
                  </button>
                ))}
              </div>

              {skillSource === 'folder' && (
                <div
                  className="kz-card text-center"
                  style={{ padding: 24, borderStyle: 'dashed' }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    const file = Array.from(e.dataTransfer.files)[0];
                    if (!file) return;
                    const filePath = getApi().getPathForFile(file);
                    const result = await getApi().skillInstallFromDirectory(filePath, pageConfig);
                    if (!result.success) setError(result.error || (isZh ? '安装失败' : 'Installation failed'));
                    else { onInstalled(); onClose(); }
                  }}
                >
                  <FolderOpen size={24} className="mx-auto mb-2 kz-text-mute" />
                  <div className="kz-serif kz-text-ink" style={{ fontSize: 14 }}>
                    {isZh ? '拖拽 Skill 文件夹到这里' : 'Drop a Skill folder here'}
                  </div>
                  <div className="kz-text-mute mt-1" style={{ fontSize: 11 }}>
                    {isZh ? '文件夹第一层必须包含 SKILL.md' : 'Must contain SKILL.md at the top level'}
                  </div>
                  <button className="kz-btn kz-btn--primary kz-btn--sm mt-3" onClick={handleInstall}>
                    {isZh ? '选择文件夹' : 'Select Folder'}
                  </button>
                </div>
              )}

              {skillSource === 'github' && (
                <div className="space-y-3">
                  <input
                    className="kz-input w-full"
                    style={{ width: '100%', display: 'block' }}
                    value={githubUrl}
                    onChange={(e) => { setGithubUrl(e.target.value); setGithubCheck(null); setError(''); }}
                    placeholder={isZh ? 'https://github.com/owner/repo 或 /tree/main/path/to/skill' : 'https://github.com/owner/repo or /tree/main/path/to/skill'}
                  />
                  <div className="flex gap-2">
                    <button className="kz-btn kz-btn--sm" onClick={handleVerifyGithub}><Check size={12} /> {isZh ? '检测 SKILL.md' : 'Check SKILL.md'}</button>
                    <button className="kz-btn kz-btn--primary kz-btn--sm" onClick={handleInstall} disabled={!githubUrl.trim() || installing}>
                      <GitBranch size={12} /> {isZh ? '安装' : 'Install'}
                    </button>
                  </div>
                  {githubCheck && (
                    <div className={`kz-badge ${githubCheck.ok ? 'kz-badge--success' : 'kz-badge--warn'}`} style={{ display: 'block', padding: '8px 12px' }}>
                      {githubCheck.ok
                        ? (isZh ? '检测通过：该路径第一层包含 SKILL.md' : 'SKILL.md found at this path')
                        : githubCheck.error}
                    </div>
                  )}
                </div>
              )}

              {skillSource === 'prompt' && <>
              <div className="grid grid-cols-2 gap-2">
                <input className="kz-input" value={skillForm.id} onChange={(e) => { setSkillForm({ ...skillForm, id: e.target.value }); setError(''); }} placeholder="id" />
                <input className="kz-input" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} placeholder={isZh ? '名称' : 'Name'} />
              </div>
              <input className="kz-input" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} placeholder={isZh ? '描述' : 'Description'} />
              <div className="relative" style={{ minHeight: 160 }}>
                <textarea
                  value={skillForm.injectPrompt}
                  onChange={(e) => { setSkillForm({ ...skillForm, injectPrompt: e.target.value }); setError(''); }}
                  placeholder={isZh ? '输入注入到 Agent system prompt 的提示词内容...' : 'Enter prompt content to inject into the Agent system prompt...'}
                  className="kz-input w-full resize-y absolute inset-0"
                  style={{ padding: '12px 14px', fontSize: '12px', lineHeight: 1.6, minHeight: 160 }}
                />
              </div>
              {skillError && (
                <div className="kz-badge kz-badge--warn" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                  <AlertCircle size={13} /> {skillError}
                </div>
              )}
              </>}

              <div className="flex items-baseline gap-2 kz-text-mute" style={{ fontSize: 11, lineHeight: 1.4 }}>
                <span className="kz-serif-italic flex-shrink-0">{isZh ? '常用 Skills 来源：' : 'Skill sources:'}</span>
                {[
                  ['ClawHub', 'https://clawhub.ai/'],
                  ['Skills.sh', 'https://www.skills.sh/'],
                  ['GitHub', 'https://github.com/'],
                ].map(([label, href]) => (
                  <span
                    key={href}
                    onClick={() => getApi().openExternal(href)}
                    className="kz-text-ink"
                    style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, fontSize: 11, lineHeight: 1.4 }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                value={rawText}
                onChange={(e) => { setRawText(e.target.value); setError(''); }}
                rows={14}
                className="kz-input kz-mono w-full resize-y"
                style={{ minHeight: 260, padding: '12px 14px', fontSize: '12px', lineHeight: 1.6 }}
                spellCheck={false}
              />
              {mcpResult && (
                mcpResult.ok ? (
                  <div className="kz-badge kz-badge--success" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                    <Check size={13} /> {isZh ? `将安装 ${mcpResult.configs.length} 个 MCP 服务：` : `Installing ${mcpResult.configs.length} MCP server(s): `}
                    {mcpResult.configs.map((c) => c.id).join(', ')}
                  </div>
                ) : (
                  <div className="kz-badge kz-badge--warn whitespace-pre-wrap" style={{ display: 'block', padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: '11.5px', letterSpacing: 'normal' }}>
                    {mcpResult.errors.join('\n')}
                  </div>
                )
              )}
            </div>
          )}

          {error && (
            <div className="kz-badge kz-badge--danger whitespace-pre-wrap" style={{ display: 'block', padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: '11.5px', letterSpacing: 'normal' }}>
              {error}
            </div>
          )}
        </div>

        {mode === 'skill' && (
          <div style={{ borderTop: '1px solid var(--line-soft)', padding: '14px 20px 12px', background: 'var(--bg-elev)' }}>
            <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 11 }}>
              {isZh ? '可选页面入口' : 'Optional Page Entry'}
            </div>
            <div className="kz-text-mute mt-1 mb-2" style={{ fontSize: 11, lineHeight: 1.5 }}>
              {isZh
                ? '填写后会把这个 Skill 添加到左侧菜单，作为一个独立助手入口；不填写则只在通用 Agent 中作为能力启用。'
                : 'Filled in: adds this Skill to the sidebar as a standalone assistant page. Empty: only acts as prompt injection in the general Agent.'}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input className="kz-input" value={skillForm.icon} onChange={(e) => setSkillForm({ ...skillForm, icon: e.target.value })} placeholder="icon" />
              <input className="kz-input" value={skillForm.menuLabel} onChange={(e) => setSkillForm({ ...skillForm, menuLabel: e.target.value })} placeholder={isZh ? '菜单名' : 'Menu label'} />
              <input className="kz-input" value={skillForm.welcomeMessage} onChange={(e) => setSkillForm({ ...skillForm, welcomeMessage: e.target.value })} placeholder={isZh ? '欢迎语' : 'Welcome'} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 p-5 pt-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <button onClick={resetAndClose} className="kz-btn kz-btn--ghost">{isZh ? '取消' : 'Cancel'}</button>
          <button
            onClick={handleInstall}
            disabled={(mode === 'skill' ? (skillSource === 'prompt' ? !!skillError : skillSource === 'github' ? !githubUrl.trim() : false) : !mcpResult?.ok) || installing}
            className="kz-btn kz-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={13} /> {installing ? (isZh ? '安装中...' : 'Installing...') : (isZh ? '安装' : 'Install')}
          </button>
        </div>
      </div>
    </div>
  );
}
