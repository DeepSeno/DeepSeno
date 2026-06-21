import fs from 'fs';
import { safeStorage } from 'electron';
import { getSharedSettingsPath, getLocalSettingsPath, getSettingsPath, getOutputDir, getDefaultWatchDir } from './paths';
import type { PluginConfig } from './plugin/types';
export type { PluginConfig } from './plugin/types';

// ─── Shared settings (synced across machines) ──────────────

export interface SharedSettings {
  language: 'en' | 'zh';
  userNickname: string;            // 首页问候语用的称呼，空字符串走 i18n 默认 ('你' / 'you')
  asrLanguage: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  whisperModel: string;
  llmModel: string;
  embedModel: string;
  hfToken: string;
  llmProvider: 'local' | 'openai';   // 'local' = bundled llama-server, 'openai' = cloud API
  cloudApiUrl: string;                  // e.g. 'https://api.deepseek.com/v1'
  cloudApiKey: string;                  // API key (encrypted via safeStorage)
  cloudModel: string;                   // e.g. 'deepseek-chat', 'gpt-4o-mini'
  cloudEmbedModel: string;              // e.g. 'text-embedding-3-small'
  cloudPresetId: string;                // active cloud provider preset id (e.g. 'volcengine')
  cloudProviderConfigs: Record<string, { url: string; apiKey: string; model: string; embedModel: string }>;
  realtimeDailySummary: boolean;  // update daily summary after each recording (uses LLM tokens)
  autoReportDaily: boolean;
  autoReportDailyTime: string;
  autoReportWeekly: boolean;
  autoReportWeeklyDay: number;
  autoReportWeeklyTime: string;
  autoReportMonthly: boolean;
  autoReportMonthlyDay: number;   // 1-28, day of month to run
  autoReportMonthlyTime: string;
  obsidianAutoExport: boolean;
  obsidianWikilinks: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuEnabled: boolean;
  feishuNotifyOnComplete: boolean;
  feishuNotifyDailyDigest: boolean;
  feishuAdminOpenId: string;
  wechatCorpId: string;
  wechatAgentId: string;
  wechatSecret: string;
  wechatEnabled: boolean;
  wechatToken: string;
  wechatEncodingAESKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  dingtalkAppKey: string;
  dingtalkAppSecret: string;
  dingtalkRobotCode: string;
  dingtalkEnabled: boolean;
  openclawWechatEnabled: boolean;
  feishuCliEnabled: boolean;
  notificationSound: boolean;
  soulConfig: string;      // markdown 格式的用户画像
  agentsRules: string;     // markdown 格式的处理规则
  vocabularyContext: string; // 自由文本：专有名词+纠正规则，注入到文本优化提示词
  workflowTodoPush: boolean;
  workflowDecisionPush: boolean;
  workflowUrgentPush: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFromName: string;
  emailRecipient: string;
  emailEnabled: boolean;
  plugins: PluginConfig[];
}

// ─── Pipeline Prompt Customization ────────────────────────
export interface PipelinePrompts {
  textClean: string;
  imageAnalysis: string;
  videoAnalysis: string;
  infoExtract: string;
  dailySummary: string;
  classify: string;
  memoryExtract: string;
  speakerCorrection: string;
}

// ─── Local settings (per-machine, never synced) ────────────

export interface LocalSettings {
  setupComplete: boolean;
  watchDir: string;
  autoProcessWatchDir: boolean;
  outputDir: string;
  llamaServerPort: number;               // port for bundled llama-server (0 = auto-select)
  llamaEmbedPort: number;                // port for embedding llama-server instance
  localLlmModel: string;                 // GGUF file path for local LLM
  localEmbedModel: string;               // GGUF file path for local embedding model
  obsidianVaultDir: string;
  sceneShortcuts: {
    dictation: string;
    local_meeting: string;
    online_meeting: string;
    media: string;
  };
  autoPasteAfterRecording: boolean;
  clipboardContinuous: boolean;
  llmCleanBeforePaste: boolean;
  llmCleanPrompt: string;
  hotwords: string[];
  streamingModel: string;
  pasteCleanModel: string;  // explicit model override for paste-clean (e.g. 'qwen2.5:7b')
  showAllFeatures: boolean;
  firstLaunchTime: number;
  licensing: string;
  licenseKey: string;
  diarizationMethod: 'embedding' | 'legacy';
  pipelinePrompts: PipelinePrompts;
  // ── Public network relay (P2P + server relay fallback) ──
  relayTunnelEnabled: boolean;
  feishuCliInstallPath: string;
  feishuCliLastStatus: string;
  feishuCliSyncScopes: string;
  feishuCliLastSyncAt: string;
}

// ─── Combined (backward-compatible) ────────────────────────

export type AppSettings = SharedSettings & LocalSettings;

const SHARED_KEYS: Set<string> = new Set([
  'language', 'userNickname', 'asrLanguage', 'whisperModel', 'llmModel', 'embedModel', 'hfToken',
  'llmProvider', 'cloudApiUrl', 'cloudApiKey', 'cloudModel', 'cloudEmbedModel',
  'realtimeDailySummary',
  'autoReportDaily', 'autoReportDailyTime', 'autoReportWeekly',
  'autoReportWeeklyDay', 'autoReportWeeklyTime',
  'autoReportMonthly', 'autoReportMonthlyDay', 'autoReportMonthlyTime',
  'obsidianAutoExport', 'obsidianWikilinks',
  'feishuAppId', 'feishuAppSecret', 'feishuEnabled',
  'feishuNotifyOnComplete', 'feishuNotifyDailyDigest', 'feishuAdminOpenId',
  'wechatCorpId', 'wechatAgentId', 'wechatSecret', 'wechatEnabled',
  'wechatToken', 'wechatEncodingAESKey',
  'telegramBotToken', 'telegramChatId', 'telegramEnabled',
  'dingtalkAppKey', 'dingtalkAppSecret', 'dingtalkRobotCode', 'dingtalkEnabled',
  'openclawWechatEnabled',
  'feishuCliEnabled',
  'notificationSound',
  'soulConfig', 'agentsRules', 'vocabularyContext',
  'workflowTodoPush', 'workflowDecisionPush', 'workflowUrgentPush',
  'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFromName', 'emailRecipient', 'emailEnabled',
  'cloudPresetId', 'cloudProviderConfigs',
  'plugins',
]);

function getDefaults(): AppSettings {
  return {
    // Shared
    language: 'zh',
    userNickname: '',
    asrLanguage: 'auto',
    whisperModel: 'sensevoice',
    llmModel: 'qwen3.5:4b',
    embedModel: 'bge-m3',
    hfToken: '',
    llmProvider: 'local',
    cloudApiUrl: '',
    cloudApiKey: '',
    cloudModel: '',
    cloudEmbedModel: '',
    cloudPresetId: '',
    cloudProviderConfigs: {},
    realtimeDailySummary: false, // deprecated: daily summary now runs once/day via scheduled daily_report (action_params { today: true })
    autoReportDaily: true,
    autoReportDailyTime: '22:00',
    autoReportWeekly: false,
    autoReportWeeklyDay: 5,
    autoReportWeeklyTime: '22:00',
    autoReportMonthly: false,
    autoReportMonthlyDay: 1,
    autoReportMonthlyTime: '22:00',
    obsidianAutoExport: false,
    obsidianWikilinks: true,
    feishuAppId: '',
    feishuAppSecret: '',
    feishuEnabled: false,
    feishuNotifyOnComplete: true,
    feishuNotifyDailyDigest: false,
    feishuAdminOpenId: '',
    wechatCorpId: '',
    wechatAgentId: '',
    wechatSecret: '',
    wechatEnabled: false,
    wechatToken: '',
    wechatEncodingAESKey: '',
    telegramBotToken: '',
    telegramChatId: '',
    telegramEnabled: false,
    dingtalkAppKey: '',
    dingtalkAppSecret: '',
    dingtalkRobotCode: '',
    dingtalkEnabled: false,
    openclawWechatEnabled: false,
    feishuCliEnabled: false,
    notificationSound: true,
    soulConfig: '',
    agentsRules: '',
    vocabularyContext: '',
    workflowTodoPush: true,
    workflowDecisionPush: true,
    workflowUrgentPush: true,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    smtpFromName: 'DeepSeno',
    emailRecipient: '',
    emailEnabled: false,
    plugins: [],
    // Local
    setupComplete: false,
    watchDir: getDefaultWatchDir(),
    autoProcessWatchDir: true,
    outputDir: getOutputDir(),
    llamaServerPort: 0,
    llamaEmbedPort: 0,
    localLlmModel: '',
    localEmbedModel: '',
    obsidianVaultDir: '',
    sceneShortcuts: {
      dictation: 'Alt+,',
      local_meeting: 'CommandOrControl+Shift+L',
      online_meeting: 'CommandOrControl+Shift+M',
      media: 'CommandOrControl+Shift+K',
    },
    autoPasteAfterRecording: true,
    clipboardContinuous: true,
    llmCleanBeforePaste: true,
    llmCleanPrompt: '',
    hotwords: [],
    streamingModel: 'base',
    pasteCleanModel: '',
    showAllFeatures: true,
    firstLaunchTime: 0,  // 0 means "set on first load"
    licenseKey: '',
    diarizationMethod: 'embedding',
    relayTunnelEnabled: false,
    feishuCliInstallPath: '',
    feishuCliLastStatus: '',
    feishuCliSyncScopes: 'calendar,task,doc,im',
    feishuCliLastSyncAt: '',
    pipelinePrompts: {
      textClean: '',
      imageAnalysis: '',
      videoAnalysis: '',
      infoExtract: '',
      dailySummary: '',
      classify: '',
      memoryExtract: '',
    },
  };
}

// ─── Credential encryption via Electron safeStorage ─────
const ENCRYPTED_KEYS = ['hfToken', 'feishuAppSecret', 'wechatSecret', 'telegramBotToken', 'dingtalkAppSecret', 'licenseKey', 'cloudApiKey', 'smtpPass'] as const;
const ENCRYPTED_PREFIX = 'enc:';

function encryptSecret(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value;
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.startsWith(ENCRYPTED_PREFIX)) return encoded;
  try {
    if (!safeStorage.isEncryptionAvailable()) return encoded;
    const buf = Buffer.from(encoded.slice(ENCRYPTED_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // Fallback: value might be corrupted, return empty
    return '';
  }
}

function encryptSecrets(obj: Record<string, any>): void {
  for (const key of ENCRYPTED_KEYS) {
    if (obj[key] && typeof obj[key] === 'string' && !obj[key].startsWith(ENCRYPTED_PREFIX)) {
      obj[key] = encryptSecret(obj[key]);
    }
  }
  // Encrypt nested apiKey in cloudProviderConfigs
  // Deep-clone first to avoid mutating the in-memory cache (shallow copy shares nested refs)
  if (obj.cloudProviderConfigs && typeof obj.cloudProviderConfigs === 'object') {
    obj.cloudProviderConfigs = JSON.parse(JSON.stringify(obj.cloudProviderConfigs));
    for (const cfg of Object.values(obj.cloudProviderConfigs) as any[]) {
      if (cfg?.apiKey && typeof cfg.apiKey === 'string' && !cfg.apiKey.startsWith(ENCRYPTED_PREFIX)) {
        cfg.apiKey = encryptSecret(cfg.apiKey);
      }
    }
  }
}

function decryptSecrets(obj: Record<string, any>): void {
  for (const key of ENCRYPTED_KEYS) {
    if (obj[key] && typeof obj[key] === 'string') {
      obj[key] = decryptSecret(obj[key]);
    }
  }
  // Decrypt nested apiKey in cloudProviderConfigs
  if (obj.cloudProviderConfigs && typeof obj.cloudProviderConfigs === 'object') {
    obj.cloudProviderConfigs = JSON.parse(JSON.stringify(obj.cloudProviderConfigs));
    for (const cfg of Object.values(obj.cloudProviderConfigs) as any[]) {
      if (cfg?.apiKey && typeof cfg.apiKey === 'string') {
        cfg.apiKey = decryptSecret(cfg.apiKey);
      }
    }
  }
}

function encryptPluginEnv(settings: Record<string, any>): void {
  const plugins = settings.plugins;
  if (!Array.isArray(plugins)) return;
  for (const plugin of plugins) {
    if (!plugin.mcp?.env || typeof plugin.mcp.env !== 'object') continue;
    for (const [key, val] of Object.entries(plugin.mcp.env)) {
      if (typeof val === 'string' && val && !val.startsWith(ENCRYPTED_PREFIX)) {
        plugin.mcp.env[key] = encryptSecret(val);
      }
    }
  }
}

function decryptPluginEnv(settings: Record<string, any>): void {
  const plugins = settings.plugins;
  if (!Array.isArray(plugins)) return;
  for (const plugin of plugins) {
    if (!plugin.mcp?.env || typeof plugin.mcp.env !== 'object') continue;
    for (const [key, val] of Object.entries(plugin.mcp.env)) {
      if (typeof val === 'string' && val) {
        plugin.mcp.env[key] = decryptSecret(val);
      }
    }
  }
}

function splitSettings(settings: AppSettings): { shared: Partial<SharedSettings>; local: Partial<LocalSettings> } {
  const shared: Record<string, any> = {};
  const local: Record<string, any> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SHARED_KEYS.has(key)) {
      shared[key] = value;
    } else {
      local[key] = value;
    }
  }
  return { shared: shared as Partial<SharedSettings>, local: local as Partial<LocalSettings> };
}

// ─── Migration from legacy single settings.json ────────────

function migrateIfNeeded(): void {
  const legacyPath = getSettingsPath();
  const sharedPath = getSharedSettingsPath();
  const localPath = getLocalSettingsPath();

  // Only migrate if legacy file exists AND new files don't
  if (!fs.existsSync(legacyPath)) return;
  if (fs.existsSync(sharedPath) || fs.existsSync(localPath)) return;

  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const defaults = getDefaults();
    const merged = { ...defaults, ...parsed };
    const { shared, local } = splitSettings(merged);

    fs.writeFileSync(sharedPath, JSON.stringify(shared, null, 2), 'utf-8');
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2), 'utf-8');

    // Rename legacy file
    fs.renameSync(legacyPath, legacyPath + '.bak');
    console.log('[settings] Migrated legacy settings.json → shared + local');
  } catch (err) {
    console.error('[settings] Migration failed:', err);
  }
}

// ─── Load / Save ───────────────────────────────────────────

let cached: AppSettings | null = null;

function readJson(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

export function loadSettings(): AppSettings {
  if (cached) return { ...cached };

  migrateIfNeeded();

  const defaults = getDefaults();
  const shared = readJson(getSharedSettingsPath());
  const local = readJson(getLocalSettingsPath());

  // Decrypt sensitive fields after reading from disk
  decryptSecrets(shared);
  decryptSecrets(local);
  decryptPluginEnv(shared);

  cached = { ...defaults, ...shared, ...local };

  // Migrate old recordingShortcut → sceneShortcuts
  const c = cached as any;
  if (!c.sceneShortcuts || typeof c.sceneShortcuts !== 'object') {
    const oldShortcut = c.recordingShortcut || defaults.sceneShortcuts.dictation;
    c.sceneShortcuts = {
      dictation: oldShortcut,
      local_meeting: defaults.sceneShortcuts.local_meeting,
      online_meeting: defaults.sceneShortcuts.online_meeting,
      media: defaults.sceneShortcuts.media,
    };
  }
  delete c.recordingShortcut;
  // Ensure all scene keys exist (forward compat)
  cached.sceneShortcuts = { ...defaults.sceneShortcuts, ...cached.sceneShortcuts };

  // Migrate outdated LLM model names to current default (qwen3.5 series)
  const OUTDATED_MODELS = new Set([
    'qwen2.5:14b', 'qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b', 'qwen2.5:0.5b',
    'qwen3:8b', 'qwen3:4b', 'qwen3:1.7b', 'qwen3:0.6b', 'qwen3:14b', 'qwen3:30b',
  ]);
  if (cached.llmModel && OUTDATED_MODELS.has(cached.llmModel)) {
    console.log(`[Settings] Migrating outdated model ${cached.llmModel} → ${defaults.llmModel}`);
    cached.llmModel = defaults.llmModel;
  }

  // Migrate empty watchDir to default path (new default adds ~/Documents/deepseno_record)
  if (!cached.watchDir) {
    cached.watchDir = getDefaultWatchDir();
    console.log(`[Settings] Migrated empty watchDir → ${cached.watchDir}`);
  }

  // Migrate llmCleanPrompt → pipelinePrompts.textClean (one-time)
  if (cached.llmCleanPrompt && (!cached.pipelinePrompts || !cached.pipelinePrompts.textClean)) {
    if (!cached.pipelinePrompts) {
      cached.pipelinePrompts = getDefaults().pipelinePrompts;
    }
    cached.pipelinePrompts.textClean = cached.llmCleanPrompt;
    console.log('[Settings] Migrated llmCleanPrompt → pipelinePrompts.textClean');
  }

  return { ...cached };
}

/** Atomic write: write to .tmp then rename (survives power loss). */
function atomicWriteJSON(filePath: string, data: object): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function saveSettings(settings: AppSettings): void {
  cached = { ...settings };
  const { shared, local } = splitSettings(settings);
  // Encrypt sensitive fields before writing to disk
  encryptSecrets(shared as Record<string, any>);
  encryptSecrets(local as Record<string, any>);
  // Deep-clone plugins before encryption to avoid polluting the in-memory cache
  // (shared.plugins may share references with cached.plugins after shallow copy)
  if ((shared as any).plugins) {
    (shared as any).plugins = JSON.parse(JSON.stringify((shared as any).plugins));
  }
  encryptPluginEnv(shared as Record<string, any>);
  atomicWriteJSON(getSharedSettingsPath(), shared);
  atomicWriteJSON(getLocalSettingsPath(), local);
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  saveSettings(merged);
  return { ...merged };
}

/** Clear the settings cache (call when sync dir changes). */
export function clearSettingsCache(): void {
  cached = null;
}
