import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IpcContext } from './context';
import { MarkdownGenerator } from '../output/markdown-generator';
import { FeishuBot } from '../feishu/bot';
import { WeChatChannel } from '../channels/wechat-channel';
import { DingTalkChannel } from '../channels/dingtalk-channel';
import { FeishuChannel } from '../channels/feishu-channel';
import { TelegramChannel } from '../channels/telegram-channel';
import { EmailChannel } from '../channels/email-channel';
import { OpenClawWeChatChannel } from '../channels/openclaw-wechat-channel';
import { MessageRouter } from '../channels/router';
import { UnifiedMessageHandler } from '../channels/message-handler';
import { SessionManager } from '../channels/session-manager';
import { ToolRegistry } from '../agent/tool-registry';
import { registerBuiltinTools } from '../agent/builtin-tools';
import { AgentExecutor } from '../agent/agent-executor';
import { PluginEngine } from '../plugin/plugin-engine';
import { PluginInstaller } from '../plugin/plugin-installer';
import { PluginRegistry } from '../plugin/plugin-registry';
import type { PluginConfig } from '../plugin/types';
import { loadSettings, saveSettings } from '../settings';
import { FeishuCliService } from '../feishu-cli/service';
import { ExternalSourceSyncService } from '../external-sources/sync-service';
import { getExternalSourceProvider, listExternalSourceProviders } from '../external-sources/registry';
import { createLLMClient, createEmbedClient, getLLMModel } from '../llm/create-client';
import { TextOptimizer } from '../llm/text-optimizer';
import { getOutputDir } from '../paths';
import { MemoryManager } from '../agent/memory-manager';
import { requirePro } from '../licensing/require-pro';
import { requireId, requireString, requireEnum, requireDate, requirePort, sanitizePath, ValidationError } from './validate';

// ─── Feishu Bot State ───────────────────────────────────────

let feishuBot: FeishuBot | null = null;

export function getFeishuBot(): FeishuBot | null {
  return feishuBot;
}

export async function initFeishuBot(ctx: IpcContext): Promise<void> {
  const settings = loadSettings();
  if (settings.feishuEnabled && settings.feishuAppId && settings.feishuAppSecret) {
    // Stop existing bot first and WAIT for it to fully disconnect
    if (feishuBot) {
      try { await feishuBot.stop(); } catch { /* best-effort */ }
      feishuBot = null;
    }
    feishuBot = new FeishuBot(ctx.getProcessor, ctx.getQueryEngine, ctx.getDb, ctx.getSherpaEngine, ctx.getMemoryManager);
    feishuBot.start({
      appId: settings.feishuAppId,
      appSecret: settings.feishuAppSecret,
      adminOpenId: settings.feishuAdminOpenId,
    }).catch((err) => {
      console.error('[Feishu] Failed to auto-start bot:', err);
    });
    // Register FeishuChannel with MessageRouter so scheduled tasks can send messages
    if (messageRouter) {
      feishuChannel = new FeishuChannel(feishuBot);
      messageRouter.register(feishuChannel);
      console.log(`[integration] Feishu channel registered (router has ${messageRouter.channelCount} channel(s))`);
    }
  }
}

export function stopFeishuBot(): void {
  if (feishuBot) {
    const bot = feishuBot;
    feishuBot = null;
    bot.stop().catch((err) => {
      console.error('[Feishu] Failed to stop bot:', err);
    });
  }
}

// ─── Unified Channel Infrastructure ─────────────────────────

let _ctx: IpcContext | null = null;
let messageRouter: MessageRouter | null = null;
let messageHandler: UnifiedMessageHandler | null = null;
let feishuChannel: FeishuChannel | null = null;
let dingtalkChannel: DingTalkChannel | null = null;
let wechatChannel: WeChatChannel | null = null;
let telegramChannel: TelegramChannel | null = null;
let emailChannel: EmailChannel | null = null;
let openclawWechatChannel: OpenClawWeChatChannel | null = null;
let toolRegistry: ToolRegistry | null = null;
let pluginEngine: PluginEngine | null = null;
let pluginInstaller: PluginInstaller | null = null;
let pluginRegistry: PluginRegistry | null = null;
let agentExecutor: AgentExecutor | null = null;

export function getMessageRouter(): MessageRouter | null {
  return messageRouter;
}

export function getMessageHandler(): UnifiedMessageHandler | null {
  return messageHandler;
}

export function getDingTalkChannel(): DingTalkChannel | null {
  return dingtalkChannel;
}

export function getWeChatChannel(): WeChatChannel | null {
  return wechatChannel;
}

export function getPluginEngine(): PluginEngine | null {
  return pluginEngine;
}

export function getToolRegistry(): ToolRegistry | null {
  return toolRegistry;
}

export function getAgentExecutor(): AgentExecutor | null {
  return agentExecutor;
}

/** Reinitialize agent executor, tool registry, and feishu bot with current LLM settings. */
export async function resetAgentInfrastructure(): Promise<void> {
  if (!_ctx) return;
  const existingPluginEngine = pluginEngine; // preserve running plugin connections
  agentExecutor = null;
  toolRegistry = null;
  pluginEngine = null;
  await initMessageInfrastructure(_ctx, existingPluginEngine);

  // Restart feishu bot so it picks up the new LLM client
  if (feishuBot && feishuBot.status !== 'disconnected') {
    await initFeishuBot(_ctx);
  }

  console.log('[integration] Agent infrastructure reset with new LLM settings');
}

export async function stopPlugins(): Promise<void> {
  if (pluginEngine) {
    await pluginEngine.shutdownAll();
  }
}

/**
 * Initialize the unified message routing infrastructure:
 * MessageRouter + AgentExecutor + UnifiedMessageHandler + channels.
 * Called once during app startup from integration-handlers registration.
 */
async function initMessageInfrastructure(ctx: IpcContext, existingPluginEngine?: PluginEngine): Promise<void> {
  console.log(`[integration] initMessageInfrastructure called (existingPluginEngine=${!!existingPluginEngine})`);
  // Stop existing channels before rebuilding to prevent duplicate pollers
  if (messageRouter) {
    messageRouter.stopAll().catch(() => {});
  }

  _ctx = ctx;
  const settings = loadSettings();

  // Create core components
  messageRouter = new MessageRouter();

  // Build the agent infrastructure
  toolRegistry = new ToolRegistry();
  pluginInstaller = new PluginInstaller();
  pluginRegistry = new PluginRegistry();
  // Fetch remote plugin registry (async, non-blocking — falls back to BUILTIN_LIST on failure)
  pluginRegistry.fetchRemote().catch(err => console.warn('[Plugin] fetchRemote failed:', err));

  if (existingPluginEngine) {
    // Preserve running plugin connections, re-register their tools to the new registry
    pluginEngine = existingPluginEngine;
    await pluginEngine.setToolRegistry(toolRegistry);
  } else {
    pluginEngine = new PluginEngine(toolRegistry);
    // Auto-start enabled plugins on first init
    pluginEngine.autoStartAll().catch(err => console.warn('[Plugin] autoStartAll failed:', err));
  }

  const llmClient = createLLMClient(settings);
  const model = getLLMModel(settings);

  // Create a ToolContext for built-in tools
  let memoryManager: MemoryManager | null = null;
  let textOptimizer: TextOptimizer | null = null;

  registerBuiltinTools(toolRegistry, {
    getDb: () => ctx.getDb(),
    getQueryEngine: () => {
      try { return ctx.getQueryEngine(); } catch { return null; }
    },
    getMemoryManager: () => {
      if (!memoryManager) {
        try {
          memoryManager = new MemoryManager(ctx.getDb(), ctx.getLLM(), createEmbedClient(settings));
        } catch { /* not available */ }
      }
      return memoryManager;
    },
    getTextOptimizer: () => {
      if (!textOptimizer) {
        try {
          textOptimizer = new TextOptimizer(ctx.getLLM(), getLLMModel(loadSettings()));
        } catch { /* not available */ }
      }
      return textOptimizer;
    },
    getSettings: () => loadSettings(),
    getMessageRouter: () => messageRouter,
  });

  const sessionManager = new SessionManager(ctx.getDb().getRawDb());
  sessionManager.setLLM(llmClient, model);
  sessionManager.cleanup(); // Close expired sessions from previous run

  // Periodic cleanup: close expired sessions + purge old messages
  const cleanupInterval = setInterval(() => {
    try {
      sessionManager.cleanup();
    } catch (err) {
      console.error('[integration] Session cleanup error:', err);
    }
  }, 60 * 60 * 1000); // every hour

  agentExecutor = new AgentExecutor(llmClient, model, toolRegistry, sessionManager);
  messageHandler = new UnifiedMessageHandler(messageRouter, agentExecutor, sessionManager);
  messageHandler.setToolRegistry(toolRegistry);

  // Set handler on router
  messageRouter.setHandler((msg) => messageHandler!.handle(msg));

  // Clean up interval on app quit
  app.on('before-quit', () => {
    clearInterval(cleanupInterval);
  });

  // Register DingTalk channel if enabled
  if (settings.dingtalkEnabled && settings.dingtalkAppKey && settings.dingtalkAppSecret) {
    dingtalkChannel = new DingTalkChannel({
      appKey: settings.dingtalkAppKey,
      appSecret: settings.dingtalkAppSecret,
      robotCode: settings.dingtalkRobotCode || '',
    });
    messageRouter.register(dingtalkChannel);
    dingtalkChannel.start().catch((err) => {
      console.warn('[integration] DingTalk channel start failed:', err);
    });
    console.log('[integration] DingTalk channel registered');
  }

  // Register WeChat channel if enabled
  if (settings.wechatEnabled && settings.wechatCorpId && settings.wechatSecret) {
    wechatChannel = new WeChatChannel({
      corpId: settings.wechatCorpId,
      agentId: settings.wechatAgentId || '',
      secret: settings.wechatSecret,
    });
    messageRouter.register(wechatChannel);
    wechatChannel.start().catch((err) => {
      console.warn('[integration] WeChat channel start failed:', err);
    });
    console.log('[integration] WeChat channel registered');
  }

  // Register Telegram channel if enabled
  if (settings.telegramEnabled && settings.telegramBotToken) {
    telegramChannel = new TelegramChannel({
      botToken: settings.telegramBotToken,
      defaultChatId: settings.telegramChatId || '',
    });
    messageRouter.register(telegramChannel);
    telegramChannel.start().catch((err) => {
      console.warn('[integration] Telegram channel start failed:', err);
    });
    console.log('[integration] Telegram channel registered');
  }

  // Register Email channel if enabled
  if (settings.emailEnabled && settings.smtpHost && settings.smtpUser) {
    emailChannel = new EmailChannel({
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpUser: settings.smtpUser,
      smtpPass: settings.smtpPass,
      fromName: settings.smtpFromName || 'DeepSeno',
      defaultRecipient: settings.emailRecipient || '',
    });
    messageRouter.register(emailChannel);
    emailChannel.start().catch((err) => {
      console.warn('[integration] Email channel start failed:', err);
    });
    console.log('[integration] Email channel registered');
  }

  // Register OpenClaw WeChat (personal) channel if enabled
  if ((settings as any).openclawWechatEnabled) {
    openclawWechatChannel = new OpenClawWeChatChannel();
    openclawWechatChannel.setPipelineEnqueue((filePath) => {
      try { ctx.getProcessor().enqueue(filePath); } catch (err: any) {
        console.error('[integration] OpenClaw WeChat pipeline enqueue failed:', err.message);
      }
    });
    messageRouter.register(openclawWechatChannel);
    openclawWechatChannel.start().catch((err) => {
      console.warn('[integration] OpenClaw WeChat channel start failed:', err);
    });
    // Wire pipeline completion → push result back to WeChat (delayed to ensure Processor is ready)
    setTimeout(() => {
      try {
        const tq = ctx.getProcessor().getTaskQueue();
        const ch = openclawWechatChannel;
        tq.on('task:completed', (task: any) => {
          console.log(`[integration] task:completed filePath=${task.filePath} recordingId=${task.recordingId}`);
          if (!ch) return;
          try {
            const db = ctx.getDb();
            // Try multiple lookup strategies: recordingId → exact path → filename match
            let rec = task.recordingId ? db.getRecording(task.recordingId) : undefined;
            if (!rec) rec = db.getRecordingByPath(task.filePath);
            if (!rec) {
              const fileName = require('path').basename(task.filePath);
              rec = db.db.prepare('SELECT * FROM recordings WHERE file_name = ? ORDER BY id DESC LIMIT 1').get(fileName) as any;
            }
            if (rec) {
              const segments = db.getSegmentsByRecording(rec.id);
              const text = segments.map((s: any) => s.clean_text || s.raw_text).filter(Boolean).join('\n');
              const summary = text ? `✅ 处理完成：${rec.file_name}\n\n${text.slice(0, 2000)}` : `✅ 处理完成：${rec.file_name}`;
              ch.onPipelineComplete(task.filePath, summary).catch((e) => console.error('[integration] onPipelineComplete error:', e));
            } else {
              // No recording found — still notify with basic completion
              ch.onPipelineComplete(task.filePath, `✅ 处理完成`).catch(() => {});
            }
          } catch (err: any) {
            console.error('[integration] task:completed handler error:', err.message);
          }
        });
        console.log('[integration] Wired task:completed → OpenClaw WeChat push');
      } catch (err: any) {
        console.error('[integration] Failed to wire task:completed:', err.message);
      }
    }, 3000);
    console.log('[integration] OpenClaw WeChat (personal) channel registered');
  }

  console.log('[integration] Unified message infrastructure initialized');
}

/** Cleanup channel infrastructure on app quit. */
export function stopChannels(): void {
  if (messageRouter) {
    messageRouter.stopAll().catch(() => {});
    messageRouter = null;
  }
  feishuChannel = null;
  dingtalkChannel = null;
  wechatChannel = null;
  telegramChannel = null;
  emailChannel = null;
  messageHandler = null;
}

export function registerIntegrationHandlers(ctx: IpcContext): void {
  // ─── Obsidian ─────────────────────────────────────────────
  ipcMain.handle('obsidian:syncAll', async () => {
    const settings = loadSettings();
    if (!settings.obsidianVaultDir) return { success: false, error: 'no_vault' };
    const outputDir = settings.outputDir || getOutputDir();
    // Rebuild MOC first
    const mdGen = new MarkdownGenerator(outputDir, settings.obsidianWikilinks);
    const mocEntries: Array<{ type: 'transcript' | 'daily-summary' | 'weekly-summary' | 'monthly-summary'; date: string; title: string; relativePath: string }> = [];

    // Collect daily summaries
    const dailies = ctx.getDb().getAllDailySummaries();
    for (const d of dailies) {
      mocEntries.push({ type: 'daily-summary', date: d.date, title: `${d.date} 日报`, relativePath: path.join('daily', `${d.date}.md`) });
    }

    // Collect weekly summaries
    const weeklies = ctx.getDb().getAllWeeklySummaries();
    for (const w of weeklies) {
      mocEntries.push({ type: 'weekly-summary', date: w.start_date, title: `周报 ${w.start_date} ~ ${w.end_date}`, relativePath: path.join('weekly', `${w.start_date}.md`) });
    }

    // Collect monthly summaries
    const monthlies = ctx.getDb().getAllMonthlySummaries();
    for (const m of monthlies) {
      mocEntries.push({ type: 'monthly-summary', date: m.start_date, title: `月报 ${m.start_date} ~ ${m.end_date}`, relativePath: path.join('monthly', `${m.start_date}.md`) });
    }

    // Collect transcripts from recordings
    const recordings = ctx.getDb().getAllRecordings();
    for (const r of recordings) {
      if (r.status !== 'completed') continue;
      const dateStr = r.recorded_at?.split('T')[0] || '';
      const name = r.file_name.replace(/\.[^.]+$/, '');
      mocEntries.push({ type: 'transcript', date: dateStr, title: name, relativePath: path.join('transcripts', dateStr, `${name}.md`) });
    }

    mdGen.updateMOC(mocEntries);

    const count = MarkdownGenerator.syncAllToVault(outputDir, settings.obsidianVaultDir);
    return { success: true, count };
  });

  ipcMain.handle('obsidian:syncFile', async (_event, relativePath: string) => {
    const validPath = sanitizePath(relativePath, 'relativePath');
    const settings = loadSettings();
    if (!settings.obsidianVaultDir) return { success: false, error: 'no_vault' };
    const outputDir = settings.outputDir || getOutputDir();
    const dest = MarkdownGenerator.syncToVault(outputDir, settings.obsidianVaultDir, validPath);
    return { success: true, dest };
  });

  // ─── Audio ──────────────────────────────────────────────────
  ipcMain.handle('audio:getPath', async (_event, recordingId: number) => {
    try {
      const rec = ctx.getDb().getRecording(recordingId);
      return rec?.file_path || null;
    } catch {
      return null;
    }
  });

  // ─── Feishu Bot ──────────────────────────────────────────
  ipcMain.handle('feishu:getStatus', async () => {
    return {
      status: feishuBot?.status || 'disconnected',
    };
  });

  ipcMain.handle('feishu:testConnection', async (_event, appId: string, appSecret: string) => {
    return FeishuBot.testConnection(appId, appSecret);
  });

  ipcMain.handle('feishu:restart', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    const settings = loadSettings();
    if (!settings.feishuAppId || !settings.feishuAppSecret) {
      stopFeishuBot();
      return { status: 'disconnected' };
    }
    if (!feishuBot) {
      feishuBot = new FeishuBot(ctx.getProcessor, ctx.getQueryEngine, ctx.getDb, ctx.getSherpaEngine, ctx.getMemoryManager);
    }
    try {
      await feishuBot.restart({
        appId: settings.feishuAppId,
        appSecret: settings.feishuAppSecret,
        adminOpenId: settings.feishuAdminOpenId,
      });
      return { status: feishuBot.status };
    } catch (err: any) {
      return { status: 'error', error: err.message };
    }
  });

  // ─── Feishu Simulation (dev/test only) ────────────────────

  ipcMain.handle('feishu:simulate', async (_event, params: { type: string; text?: string; wavPath?: string; msgType?: string }) => {
    const bot = getFeishuBot();
    if (!bot) return { success: false, error: 'Bot not initialized' };
    return bot.simulate(params);
  });

  ipcMain.handle('feishu:runTestSuite', async () => {
    const bot = getFeishuBot();
    if (!bot || bot.status !== 'connected') {
      return { success: false, error: `Bot status: ${bot?.status || 'null'}` };
    }

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const results: { case: string; result: any }[] = [];

    const testCases: { name: string; params: { type: string; text?: string; wavPath?: string; msgType?: string } }[] = [
      { name: 'help', params: { type: 'text', text: '帮助' } },
      { name: 'query', params: { type: 'text', text: '昨天开会讨论了什么' } },
      { name: 'todo', params: { type: 'text', text: '提醒我明天下午3点和张三开会' } },
      { name: 'memo', params: { type: 'text', text: '记住李四的手机号是00000000000' } },
      { name: 'list_items', params: { type: 'text', text: '查看待办' } },
      { name: 'report', params: { type: 'text', text: '生成今日日报' } },
      { name: 'quick_complete', params: { type: 'text', text: '完成1' } },
      { name: 'quick_delete', params: { type: 'text', text: '删除1' } },
      { name: 'unsupported', params: { type: 'unsupported', msgType: 'image' } },
      { name: 'empty_text', params: { type: 'text', text: '' } },
      { name: 'long_text', params: { type: 'text', text: '今天我们开了一个关于产品路线图的会议，讨论了很多重要的内容。首先是关于新功能的优先级排序，我们决定先做语音转录的实时功能，然后再做多设备同步。其次讨论了技术架构的选择，决定继续使用本地优先的方案，所有AI处理都在本地运行。最后还讨论了市场推广的计划。' } },
    ];

    // Find a WAV file for voice test
    const path = await import('path');
    const watchDir = loadSettings().watchDir || path.join(app.getPath('documents'), 'deepseno');
    const wavFiles = fs.existsSync(watchDir)
      ? fs.readdirSync(watchDir).filter((f: string) => f.toLowerCase().endsWith('.wav')).sort()
      : [];
    if (wavFiles.length > 0) {
      // Pick the smallest WAV file for faster testing
      const sorted = wavFiles.map((f: string) => {
        const stat = fs.statSync(path.join(watchDir, f));
        return { name: f, size: stat.size };
      }).sort((a: any, b: any) => a.size - b.size);
      testCases.push({
        name: 'voice',
        params: { type: 'voice', wavPath: path.join(watchDir, sorted[0].name) },
      });
    }

    console.log(`[Feishu:Test] Starting test suite: ${testCases.length} cases`);

    for (const tc of testCases) {
      console.log(`[Feishu:Test] ── Case: ${tc.name} ──`);
      try {
        const result = await bot.simulate(tc.params);
        results.push({ case: tc.name, result });
        console.log(`[Feishu:Test] ${tc.name}: ${result.success ? 'OK' : 'FAIL'} ${result.intent ? `(intent=${result.intent})` : ''} ${result.error || ''}`);
      } catch (err: any) {
        results.push({ case: tc.name, result: { success: false, error: err.message } });
        console.error(`[Feishu:Test] ${tc.name}: ERROR`, err.message);
      }
      await delay(3000);
    }

    console.log(`[Feishu:Test] Suite complete: ${results.filter((r) => r.result.success).length}/${results.length} passed`);
    return { success: true, results };
  });

  // ─── External Source Providers ──────────────────────────────
  const feishuCli = FeishuCliService.getInstance();

  ipcMain.handle('externalSources:listProviders', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return listExternalSourceProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      domains: provider.domains,
    }));
  });

  ipcMain.handle('externalSources:getStatus', async (_event, source: string) => {
    try {
      if (source === 'feishu-cli') return await feishuCli.getFullStatus();
      getExternalSourceProvider(source);
      const dbAny = ctx.getDb() as any;
      const row = dbAny.getExternalSource ? dbAny.getExternalSource(source) : null;
      return { source, connected: row?.status === 'connected', lastSyncAt: row?.last_sync_at || null };
    } catch (err: any) {
      return { source, connected: false, lastSyncAt: null, error: err.message };
    }
  });

  ipcMain.handle('externalSources:syncNow', async (_event, source: string, domains?: string[]) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    try {
      const syncService = new ExternalSourceSyncService(ctx.getDb(), ctx.getVectorStore(), createEmbedClient(loadSettings()));
      return await syncService.sync(source, domains);
    } catch (err: any) {
      return { ok: false, documents: 0, chunks: 0, error: err.message };
    }
  });

  // Backward-compatible Feishu-specific IPC aliases.

  ipcMain.handle('feishuCli:getStatus', async () => {
    try {
      return await feishuCli.getFullStatus();
    } catch (err: any) {
      return { installed: false, installPath: null, configured: false, loggedIn: false, user: null, lastSyncAt: null, error: err.message };
    }
  });

  ipcMain.handle('feishuCli:install', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return feishuCli.install();
  });

  ipcMain.handle('feishuCli:initConfig', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return feishuCli.initConfig();
  });

  ipcMain.handle('feishuCli:login', async (_event, scopes?: string[]) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return feishuCli.login(scopes);
  });

  ipcMain.handle('feishuCli:pollLogin', async (_event, deviceCode: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return feishuCli.pollLogin(deviceCode);
  });

  ipcMain.handle('feishuCli:logout', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return feishuCli.logout();
  });

  ipcMain.handle('feishuCli:syncNow', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    try {
      const raw = (loadSettings() as any).feishuCliSyncScopes || 'calendar,task,doc';
      const domains = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
      const syncService = new ExternalSourceSyncService(ctx.getDb(), ctx.getVectorStore(), createEmbedClient(loadSettings()));
      return await syncService.sync('feishu-cli', domains);
    } catch (err: any) {
      return { ok: false, documents: 0, chunks: 0, error: err.message };
    }
  });

  // ─── WeChat ─────────────────────────────────────────────────
  ipcMain.handle('wechat:testConnection', async (_event, corpId: string, secret: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return WeChatChannel.testConnection(corpId, secret);
  });

  // ─── DingTalk ─────────────────────────────────────────────
  ipcMain.handle('dingtalk:testConnection', async (_event, appKey: string, appSecret: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return DingTalkChannel.testConnection(appKey, appSecret);
  });

  // ─── Telegram ──────────────────────────────────────────────
  ipcMain.handle('telegram:testConnection', async (_event, botToken: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return TelegramChannel.testConnection(botToken);
  });

  // ─── Email ────────────────────────────────────────────────
  ipcMain.handle('email:testConnection', async (_event, host: string, port: number, user: string, pass: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    requireString(host, 'host', 500);
    requirePort(port, 'port');
    requireString(user, 'user', 500);
    requireString(pass, 'pass', 500);
    const { EmailService } = await import('../channels/email-service');
    return EmailService.testConnection(host, port, user, pass);
  });

  // ─── OpenClaw WeChat (Personal) ─────────────────────────────
  ipcMain.handle('openclawWechat:getQRCode', async () => {
    console.log('[IPC] openclawWechat:getQRCode called');
    requirePro(ctx.getLicenseManager(), 'channels');
    const ch = openclawWechatChannel || new OpenClawWeChatChannel();
    try {
      const result = await ch.getClient().getQRCode();
      console.log('[IPC] openclawWechat:getQRCode result: qrcodeId=', result.qrcodeId ? 'present' : 'missing',
        'qrcodeImage=', result.qrcodeImage ? `${result.qrcodeImage.length} chars` : 'missing');
      return result;
    } catch (err: any) {
      console.error('[IPC] openclawWechat:getQRCode error:', err.message);
      throw err;
    }
  });

  ipcMain.handle('openclawWechat:getQRCodeStatus', async (_event, qrcodeId: string) => {
    requirePro(ctx.getLicenseManager(), 'channels');
    requireString(qrcodeId, 'qrcodeId', 500);
    const ch = openclawWechatChannel || new OpenClawWeChatChannel();
    const result = await ch.getClient().getQRCodeStatus(qrcodeId);

    // Auto-start channel after successful QR scan (only once)
    if (result.status === 'confirmed' && !openclawWechatChannel?.isRunning()) {
      console.log('[IPC] openclawWechat: QR confirmed, auto-starting channel...');
      try {
        // Save enabled setting
        const settings = loadSettings();
        saveSettings({ ...settings, openclawWechatEnabled: true } as any);

        // Start channel and register with router
        if (!openclawWechatChannel) {
          openclawWechatChannel = new OpenClawWeChatChannel();
        }
        openclawWechatChannel.setPipelineEnqueue((filePath) => {
          try { ctx.getProcessor().enqueue(filePath); } catch (err: any) {
            console.error('[integration] OpenClaw WeChat pipeline enqueue failed:', err.message);
          }
        });
        if (messageRouter) {
          messageRouter.register(openclawWechatChannel);
        }
        await openclawWechatChannel.start();
        // Wire pipeline completion → push result back to WeChat
        setTimeout(() => {
          try {
            const tq = ctx.getProcessor().getTaskQueue();
            const wch = openclawWechatChannel;
            tq.on('task:completed', (task: any) => {
              console.log(`[integration] task:completed filePath=${task.filePath}`);
              if (!wch) return;
              try {
                const db = ctx.getDb();
                const rec = db.getRecordingByPath(task.filePath);
                if (rec) {
                  const segments = db.getSegmentsByRecording(rec.id);
                  const text = segments.map((s: any) => s.clean_text || s.raw_text).filter(Boolean).join('\n');
                  const summary = text ? `✅ 处理完成：${rec.file_name}\n\n${text.slice(0, 2000)}` : `✅ 处理完成：${rec.file_name}`;
                  wch.onPipelineComplete(task.filePath, summary).catch((e) => console.error('[integration] onPipelineComplete error:', e));
                } else {
                  console.warn(`[integration] No recording found for ${task.filePath}`);
                }
              } catch (err: any) {
                console.error('[integration] task:completed handler error:', err.message);
              }
            });
            console.log('[integration] Wired task:completed → OpenClaw WeChat push (QR flow)');
          } catch (err: any) {
            console.error('[integration] Failed to wire task:completed (QR flow):', err.message);
          }
        }, 3000);
        console.log('[IPC] openclawWechat: Channel started and registered');
      } catch (err: any) {
        console.error('[IPC] openclawWechat: Auto-start failed:', err.message);
      }
    }

    return result;
  });

  ipcMain.handle('openclawWechat:testConnection', async () => {
    requirePro(ctx.getLicenseManager(), 'channels');
    return OpenClawWeChatChannel.testConnection();
  });

  ipcMain.handle('openclawWechat:logout', async () => {
    if (openclawWechatChannel) {
      await openclawWechatChannel.stop();
      openclawWechatChannel.getClient().logout();
    } else {
      const client = new (await import('../channels/ilink-client')).ILinkClient();
      client.logout();
    }
    return { success: true };
  });

  ipcMain.handle('openclawWechat:getStatus', async () => {
    if (openclawWechatChannel?.isRunning()) {
      return { status: 'connected' };
    }
    const client = new (await import('../channels/ilink-client')).ILinkClient();
    if (client.loadCredentials()) {
      return { status: 'authenticated' };
    }
    return { status: 'disconnected' };
  });

  // ─── Sync ──────────────────────────────────────────────────
  ipcMain.handle('sync:getStatus', async () => {
    return ctx.syncManager.getStatus();
  });

  ipcMain.handle('sync:enable', async (_event, syncDir: string) => {
    requirePro(ctx.getLicenseManager(), 'mobile_sync');
    return ctx.syncManager.enableSync(syncDir);
  });

  ipcMain.handle('sync:disable', async () => {
    requirePro(ctx.getLicenseManager(), 'mobile_sync');
    return ctx.syncManager.disableSync();
  });

  ipcMain.handle('sync:tryAcquireLock', async () => {
    const acquired = ctx.syncManager.tryAcquireLock();
    if (acquired) {
      // Re-init to switch from read-only to read-write
      ctx.reinitSingletons();
    }
    return { acquired };
  });

  // ─── Agent Memory ──────────────────────────────────────
  ipcMain.handle('memory:getAll', async () => {
    requirePro(ctx.getLicenseManager(), 'memory');
    return ctx.getDb().getAllMemories();
  });

  ipcMain.handle('memory:getStats', async () => {
    requirePro(ctx.getLicenseManager(), 'memory');
    return ctx.getDb().getMemoryStats();
  });

  ipcMain.handle('memory:promote', async (_event, id: number, layer: string) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    const validId = requireId(id, 'id');
    const validLayer = requireEnum(layer, ['core', 'active', 'archive'], 'layer');
    ctx.getDb().promoteMemory(validId, validLayer);
    return { success: true };
  });

  ipcMain.handle('memory:delete', async (_event, id: number) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    ctx.getDb().deleteMemory(id);
    return { success: true };
  });

  ipcMain.handle('memory:update', async (_event, id: number, fact: string) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    const validId = requireId(id, 'id');
    const validFact = requireString(fact, 'fact', 5000);
    ctx.getDb().updateMemoryFact(validId, validFact);
    return { success: true };
  });

  // ─── Memory Documents ──────────────────────────────────

  ipcMain.handle('memory:getDocumentDates', async () => {
    requirePro(ctx.getLicenseManager(), 'memory');
    const db = ctx.getDb();
    const docDates = db.getMemoryDocumentDates();
    const recDates = db.getDatesWithRecordings(90);
    // Merge: all doc dates + recording dates that have no doc
    const dateSet = new Map<string, { date: string; has_recordings: boolean; recording_count: number }>(
      docDates.map(d => [d.date, d])
    );
    for (const rd of recDates) {
      const existing = dateSet.get(rd.date);
      if (existing) {
        // Update count from recordings table (more accurate than LEFT JOIN)
        existing.recording_count = rd.recording_count;
        existing.has_recordings = rd.recording_count > 0;
      } else {
        dateSet.set(rd.date, { date: rd.date, has_recordings: true, recording_count: rd.recording_count });
      }
    }
    return Array.from(dateSet.values()).sort((a, b) => b.date.localeCompare(a.date));
  });

  ipcMain.handle('memory:getDocument', async (_event, date: string) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    return ctx.getDb().getMemoryDocument(date) || null;
  });

  ipcMain.handle('memory:saveDocument', async (_event, date: string, content: string) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    const validDate = requireDate(date, 'date');
    const validContent = requireString(content, 'content', 100000);
    ctx.getDb().saveMemoryDocument(validDate, validContent, false);
    return { success: true };
  });

  ipcMain.handle('memory:generateDocument', async (_event, date: string) => {
    requirePro(ctx.getLicenseManager(), 'memory');
    try {
      const settings = loadSettings();
      const llm = createLLMClient(settings);
      const model = getLLMModel(settings);
      const { MemoryDocGenerator } = await import('../agent/memory-doc-generator');
      const generator = new MemoryDocGenerator(ctx.getDb(), llm, model);
      const content = await generator.generate(date);
      ctx.getDb().saveMemoryDocument(date, content, true);
      return { content };
    } catch (err) {
      console.error('[memory:generateDocument]', err);
      return { content: `# ${date} 记忆\n\n> 生成失败，请手动编写\n\n## 笔记\n\n` };
    }
  });

  // ─── Plugins ──────────────────────────────────────────────

  ipcMain.handle('plugin:getAll', async () => {
    if (!pluginEngine) return [];
    return pluginEngine.getAll();
  });

  ipcMain.handle('plugin:install', async (_, config: PluginConfig) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      await pluginEngine.install(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('skill:installFromDirectory', async (_, dirPath: string, page?: PluginConfig['page']) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      const { installSkillFromDirectory } = await import('../skill/skill-file');
      const config = { ...installSkillFromDirectory(dirPath), page };
      await pluginEngine.install(config);
      return { success: true, plugin: config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('skill:verifyGithub', async (_, url: string) => {
    const { verifyGithubSkillUrl } = await import('../skill/skill-file');
    return verifyGithubSkillUrl(url);
  });

  ipcMain.handle('skill:installFromGithub', async (_, url: string, page?: PluginConfig['page']) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      const { installSkillFromGithub } = await import('../skill/skill-file');
      const config = { ...installSkillFromGithub(url), page };
      await pluginEngine.install(config);
      return { success: true, plugin: config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:installFromUrl', async (_, url: string) => {
    if (!pluginInstaller || !pluginEngine) return { success: false, error: 'Plugin system not initialized' };
    try {
      const config = await pluginInstaller.fromUrl(url);
      await pluginEngine.install(config);
      return { success: true, plugin: config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 从远程 Skill 包 URL 下载安装（真实 Skill 包，zip 格式）
  ipcMain.handle('plugin:installFromRemoteSkill', async (_, skillPathUrl: string, meta: { id: string; name: string; description: string; version?: string; github_url?: string }) => {
    if (!pluginInstaller || !pluginEngine) return { success: false, error: 'Plugin system not initialized' };
    try {
      const config = await pluginInstaller.fromRemoteSkillPackage(skillPathUrl, meta);
      await pluginEngine.install(config);
      return { success: true, plugin: config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:uninstall', async (_, id: string) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      await pluginEngine.uninstall(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:update', async (_, id: string, updates: Partial<PluginConfig>) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      await pluginEngine.update(id, updates);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:enable', async (_, id: string) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      const settings = loadSettings();
      const plugins = settings.plugins || [];
      const idx = plugins.findIndex(p => p.id === id);
      if (idx === -1) return { success: false, error: 'Plugin not found' };
      plugins[idx] = { ...plugins[idx], enabled: true };
      saveSettings({ ...settings, plugins });
      await pluginEngine.enable(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:disable', async (_, id: string) => {
    if (!pluginEngine) return { success: false, error: 'PluginEngine not initialized' };
    try {
      await pluginEngine.disable(id);
      const settings = loadSettings();
      const plugins = settings.plugins || [];
      const idx = plugins.findIndex(p => p.id === id);
      if (idx !== -1) {
        plugins[idx] = { ...plugins[idx], enabled: false };
        saveSettings({ ...settings, plugins });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plugin:getTools', async (_, id: string) => {
    if (!pluginEngine) return [];
    return pluginEngine.getTools(id);
  });

  ipcMain.handle('plugin:getLogs', async (_, id: string) => {
    if (!pluginEngine) return [];
    return pluginEngine.getLogs(id);
  });

  ipcMain.handle('plugin:clearLogs', async (_, id: string) => {
    if (pluginEngine) pluginEngine.clearLogs(id);
    return { success: true };
  });

  ipcMain.handle('plugin:checkUpdate', async (_, pluginId: string) => {
    const settings = loadSettings();
    const config = (settings.plugins || []).find(p => p.id === pluginId);
    if (!config?.mcp || config.mcp.command !== 'npx') return null;

    const pkg = (config.mcp.args || []).find((a: string) => !a.startsWith('-'));
    if (!pkg) return null;
    const pkgName = pkg.replace(/@(latest|[\d.]+.*)$/, '');

    try {
      const { execSync } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      const { getNpxCacheDir } = require('../utils/npx-resolve');

      // Get latest version from npm registry
      const latest = execSync(`npm view ${pkgName} version`, { timeout: 10000 }).toString().trim();

      // Get currently installed version from npx cache
      let current: string | undefined;
      const npxCacheDir = getNpxCacheDir();
      if (fs.existsSync(npxCacheDir)) {
        for (const entry of fs.readdirSync(npxCacheDir)) {
          const pkgJsonPath = path.join(npxCacheDir, entry, 'node_modules', ...pkgName.split('/'), 'package.json');
          if (fs.existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            current = pkgJson.version;
            break;
          }
        }
      }

      return { package: pkgName, latest, current: current || undefined };
    } catch {
      return null;
    }
  });

  ipcMain.handle('plugin:upgrade', async (_, pluginId: string) => {
    const settings = loadSettings();
    const config = (settings.plugins || []).find(p => p.id === pluginId);
    if (!config?.mcp || config.mcp.command !== 'npx') {
      return { success: false, error: 'Only npx-based plugins can be upgraded' };
    }

    const pkg = (config.mcp.args || []).find((a: string) => !a.startsWith('-'));
    if (!pkg) return { success: false, error: 'Cannot determine package name' };
    const pkgName = pkg.replace(/@(latest|[\d.]+.*)$/, '');

    // 1. Stop if running
    if (pluginEngine) {
      try { await pluginEngine.disable(pluginId); } catch {}
    }

    // 2. Clear npx cache for this package
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { clearCachedNpxPackage } = require('../utils/npx-resolve') as typeof import('../utils/npx-resolve');
      const removed = clearCachedNpxPackage(pkgName);
      if (removed > 0) console.log(`[Plugin] Cleared ${removed} npx cache entr${removed === 1 ? 'y' : 'ies'} for "${pkgName}"`);
    } catch (err) {
      console.warn('[Plugin] Failed to clear npx cache:', err);
    }

    // 3. Restart
    if (pluginEngine) {
      try {
        await pluginEngine.enable(pluginId);
        return { success: true };
      } catch (err) {
        return { success: false, error: `Upgrade cache cleared but restart failed: ${err}` };
      }
    }
    return { success: true };
  });

  ipcMain.handle('plugin:getMarket', async () => {
    if (!pluginRegistry) return [];
    return pluginRegistry.getList();
  });

  // ─── Agent Chat (in-app, uses AgentExecutor with Plugin tools) ────

  ipcMain.handle('agent:chat', async (_, question: string) => {
    if (!agentExecutor) return { success: false, error: 'Agent not initialized' };
    try {
      const result = await agentExecutor.execute('app', 'local-user', '用户', question);
      return { success: true, text: result.text, toolCalls: result.toolCalls };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('agent:chatWithPlugin', async (_, pluginId: string, question: string) => {
    if (!agentExecutor) return { success: false, error: 'Agent not initialized' };
    const settings = loadSettings();
    const plugin = (settings.plugins || []).find(p => p.id === pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    try {
      const result = await agentExecutor.executeWithPlugin(
        `plugin:${pluginId}`, 'local-user', '用户', question, plugin,
      );
      return { success: true, text: result.text, toolCalls: result.toolCalls };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ─── Initialize Unified Message Infrastructure ──────────────
  // Create MessageRouter + UnifiedMessageHandler + channels (DingTalk, WeChat)
  // after all IPC handlers are registered
  try {
    initMessageInfrastructure(ctx).catch(err =>
      console.warn('[integration] Message infrastructure init failed:', err),
    );
  } catch (err) {
    console.warn('[integration] Message infrastructure init failed:', err);
  }
}
