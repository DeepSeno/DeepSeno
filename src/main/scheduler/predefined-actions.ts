import { Notification, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { loadSettings } from '../settings';
import { VoiceBrainDB } from '../db/database';
import { TextOptimizer } from '../llm/text-optimizer';
import { createLLMClient, getLLMModel, getEmbedModel } from '../llm/create-client';
import { MarkdownGenerator } from '../output/markdown-generator';
import { getDbPath, getOutputDir } from '../paths';
import { buildDailySummaryCard } from '../feishu/card-builder';
import { formatLocalDate } from '../utils/date';
import type { InsightEngine } from '../agent/insight-engine';
import type { MessageRouter } from '../channels/router';
import type { TodoTracker } from '../agent/todo-tracker';
import type { KnowledgeCompiler } from '../agent/knowledge-compiler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionDeps {
  router?: MessageRouter;
  insightEngine?: InsightEngine;
  todoTracker?: TodoTracker;
  feishuNotifier?: (cardJson: string) => Promise<void>;
  knowledgeCompiler?: KnowledgeCompiler;
}

export interface ActionResult {
  success: boolean;
  summary: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Push text to all enabled channels (feishu, wechat, telegram) via router.
 * Returns array of channel names that were notified.
 */
async function pushToChannels(text: string, deps: ActionDeps): Promise<string[]> {
  if (!deps.router) {
    console.warn('[pushToChannels] No router available');
    return [];
  }
  const settings = loadSettings();
  const notified: string[] = [];
  console.log(`[pushToChannels] feishu=${settings.feishuEnabled}(${settings.feishuAdminOpenId}) tg=${settings.telegramEnabled} wechat=${settings.wechatEnabled} dingtalk=${settings.dingtalkEnabled} email=${settings.emailEnabled}`);

  if (settings.feishuEnabled) {
    try {
      await deps.router.sendText('feishu', settings.feishuAdminOpenId || '', text);
      notified.push('feishu');
    } catch (err: any) {
      console.error('[PredefinedActions] Feishu push failed:', err.message);
    }
  }

  if (settings.wechatEnabled && settings.wechatCorpId) {
    try {
      await deps.router.sendText('wechat', '@all', text);
      notified.push('wechat');
    } catch (err: any) {
      console.error('[PredefinedActions] WeChat push failed:', err.message);
    }
  }

  if (settings.telegramEnabled && settings.telegramChatId) {
    try {
      await deps.router.sendText('telegram', settings.telegramChatId, text);
      notified.push('telegram');
    } catch (err: any) {
      console.error('[PredefinedActions] Telegram push failed:', err.message);
    }
  }

  if (settings.dingtalkEnabled) {
    try {
      await deps.router.sendText('dingtalk', '', text);
      notified.push('dingtalk');
    } catch (err: any) {
      console.error('[PredefinedActions] DingTalk push failed:', err.message);
    }
  }

  if (settings.emailEnabled && settings.emailRecipient) {
    try {
      await deps.router.sendText('email', settings.emailRecipient, text);
      notified.push('email');
    } catch (err: any) {
      console.error('[PredefinedActions] Email push failed:', err.message);
    }
  }

  if ((settings as any).openclawWechatEnabled) {
    try {
      await deps.router.sendText('openclaw-wechat', '', text);
      notified.push('openclaw-wechat');
    } catch (err: any) {
      console.error('[PredefinedActions] OpenClaw WeChat push failed:', err.message);
    }
  }

  return notified;
}

/**
 * Push text to specific channels only.
 * Returns array of channel names that were notified.
 */
async function pushToSpecificChannels(
  text: string,
  channelIds: string[],
  deps: ActionDeps,
): Promise<string[]> {
  if (!deps.router) return [];
  const settings = loadSettings();
  const notified: string[] = [];

  for (const id of channelIds) {
    try {
      let chatId: string | undefined;
      if (id === 'feishu' && settings.feishuEnabled) {
        chatId = settings.feishuAdminOpenId;
      } else if (id === 'wechat' && settings.wechatEnabled) {
        chatId = '@all';
      } else if (id === 'telegram' && settings.telegramEnabled) {
        chatId = settings.telegramChatId;
      } else if (id === 'dingtalk' && settings.dingtalkEnabled) {
        chatId = '';
      } else if (id === 'email' && settings.emailEnabled) {
        chatId = settings.emailRecipient;
      } else if (id === 'openclaw-wechat' && (settings as any).openclawWechatEnabled) {
        chatId = ''; // Uses lastActiveUserId internally
      }
      if (chatId !== undefined) {
        await deps.router.sendText(id, chatId, text);
        notified.push(id);
      }
    } catch (err: any) {
      console.error(`[PredefinedActions] Push to ${id} failed:`, err.message);
    }
  }

  return notified;
}

/** Show an Electron desktop notification. */
function notify(title: string, body: string): void {
  try {
    const settings = loadSettings();
    const notification = new Notification({
      title,
      body,
      silent: !settings.notificationSound,
    });
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.show();
        win.focus();
        win.webContents.send('navigate', '/reports');
      }
    });
    notification.show();
  } catch (err: any) {
    console.error('[PredefinedActions] Notification failed:', err.message);
  }
}

/** Auto-sync output Markdown files to Obsidian vault if enabled. */
function autoSyncObsidian(): void {
  const settings = loadSettings();
  if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
    try {
      const outputDir = settings.outputDir || getOutputDir();
      const count = MarkdownGenerator.syncAllToVault(outputDir, settings.obsidianVaultDir);
      console.log(`[PredefinedActions] Auto-synced ${count} files to Obsidian vault`);
    } catch (err: any) {
      console.error('[PredefinedActions] Obsidian auto-sync failed:', err.message);
    }
  }
}

/**
 * Dispatch push to the appropriate channels: if channelsOverride is specified,
 * push to those only; otherwise push to all enabled channels.
 */
export async function pushTextToChannels(
  text: string,
  deps: ActionDeps,
  channelsOverride?: string[],
): Promise<string[]> {
  if (channelsOverride && channelsOverride.length > 0) {
    return pushToSpecificChannels(text, channelsOverride, deps);
  }
  return pushToChannels(text, deps);
}

/** @internal Alias kept for backward compat within this file. */
async function pushText(
  text: string,
  deps: ActionDeps,
  channelsOverride?: string[],
): Promise<string[]> {
  if (channelsOverride && channelsOverride.length > 0) {
    return pushToSpecificChannels(text, channelsOverride, deps);
  }
  return pushToChannels(text, deps);
}

// ---------------------------------------------------------------------------
// Action: Daily Report
// ---------------------------------------------------------------------------

export async function actionDailyReport(
  deps: ActionDeps,
  channelsOverride?: string[],
  /**
   * Which day to summarise:
   * - `forDate` (yyyy-MM-dd): regenerate a specific day (mobile on-demand).
   * - `today: true`: summarise the current day — used by the scheduled
   *   end-of-day task (default 22:00). This replaces the old per-recording
   *   `realtimeDailySummary` regeneration so it runs once/day instead of after
   *   every recording.
   * - neither: default to "yesterday" (classic morning-after report).
   */
  opts?: { forDate?: string; today?: boolean },
): Promise<ActionResult> {
  let dateStr: string;
  let targetDate: Date;
  if (opts?.forDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.forDate)) {
    dateStr = opts.forDate;
    targetDate = new Date(opts.forDate + 'T00:00:00');
  } else if (opts?.today) {
    targetDate = new Date();
    dateStr = formatLocalDate(targetDate);
  } else {
    targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - 1);
    dateStr = formatLocalDate(targetDate);
  }

  console.log(`[PredefinedActions] Generating daily report for ${dateStr}`);

  let db: VoiceBrainDB | null = null;
  try {
    const settings = loadSettings();
    db = new VoiceBrainDB(getDbPath());
    const segments = db.getSegmentsByDate(dateStr);

    if (segments.length === 0) {
      return { success: true, summary: `No segments for ${dateStr}, skipped` };
    }

    const segData = segments.map((s: any) => ({
      start: s.start_time,
      end: s.end_time,
      speaker: s.speaker_name || 'Unknown',
      text: s.clean_text || s.raw_text || '',
    }));

    const llmClient = createLLMClient(settings);
    const optimizer = new TextOptimizer(llmClient, getLLMModel(settings));
    const result = await optimizer.generateDailySummary(dateStr, segData);

    db.upsertDailySummary({
      date: dateStr,
      summary_text: result.summary,
      timeline_json: JSON.stringify(result.timeline),
      key_events_json: JSON.stringify({ todos: result.todos, decisions: result.decisions }),
    });

    // Export Markdown
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir);
    const weekday = targetDate.toLocaleDateString('zh-CN', { weekday: 'long' });
    const content = mdGen.buildDailySummary({
      date: dateStr,
      weekday,
      summary: result.summary,
      timeline: result.timeline,
      todos: result.todos,
      decisions: result.decisions,
    });
    mdGen.writeDailySummary(dateStr, content);

    notify(
      settings.language === 'zh' ? '日报已生成' : 'Daily Report Generated',
      settings.language === 'zh'
        ? `${dateStr} 的日报已自动生成`
        : `Daily report for ${dateStr} generated`,
    );

    // Push Feishu card if configured
    if (deps.feishuNotifier && settings.feishuNotifyDailyDigest) {
      try {
        const card = buildDailySummaryCard({
          date: dateStr,
          summaryText: result.summary,
          keyEvents: { todos: result.todos, decisions: result.decisions },
        });
        await deps.feishuNotifier(card);
        console.log(`[PredefinedActions] Pushed daily report card to Feishu`);
      } catch (feishuErr: any) {
        console.error(`[PredefinedActions] Feishu card push failed:`, feishuErr.message);
      }
    }

    // Push text summary to channels
    const textSummary = `[日报] ${dateStr}\n${result.summary}`;
    const notified = await pushText(textSummary, deps, channelsOverride);

    // Auto-generate memory document for the date
    try {
      const { MemoryDocGenerator } = await import('../agent/memory-doc-generator');
      const memGen = new MemoryDocGenerator(db, llmClient, getLLMModel(settings));
      const memContent = await memGen.generate(dateStr);
      db.saveMemoryDocument(dateStr, memContent, true);
      console.log(`[PredefinedActions] Memory document for ${dateStr} generated`);
    } catch (memErr: any) {
      console.error(`[PredefinedActions] Memory document generation failed:`, memErr.message);
    }

    autoSyncObsidian();

    return {
      success: true,
      summary: `Daily report for ${dateStr} generated (${segments.length} segments). Notified: ${notified.join(', ') || 'none'}`,
    };
  } catch (err: any) {
    console.error(`[PredefinedActions] Daily report failed:`, err.message);
    return { success: false, summary: 'Daily report failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Weekly Report
// ---------------------------------------------------------------------------

export async function actionWeeklyReport(
  deps: ActionDeps,
  channelsOverride?: string[],
  /**
   * When set (yyyy-MM-dd), regenerates the week starting on this date instead
   * of the default "last 7 days ending yesterday". Used by mobile.
   */
  forStartDate?: string,
): Promise<ActionResult> {
  let startDate: Date;
  let endDate: Date;
  if (forStartDate && /^\d{4}-\d{2}-\d{2}$/.test(forStartDate)) {
    startDate = new Date(forStartDate + 'T00:00:00');
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
  } else {
    const now = new Date();
    endDate = new Date(now);
    endDate.setDate(endDate.getDate() - 1);
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);
  }

  const startStr = formatLocalDate(startDate);
  const endStr = formatLocalDate(endDate);

  console.log(`[PredefinedActions] Generating weekly report ${startStr} ~ ${endStr}`);

  let db: VoiceBrainDB | null = null;
  try {
    const settings = loadSettings();
    db = new VoiceBrainDB(getDbPath());
    const dailySummaries = db.getDailySummariesInRange(startStr, endStr);

    if (dailySummaries.length === 0) {
      return { success: true, summary: `No daily summaries in range ${startStr}~${endStr}, skipped` };
    }

    const parsed = dailySummaries.map((ds: any) => ({
      date: ds.date,
      summary: ds.summary_text || '',
      todos: ds.key_events_json ? JSON.parse(ds.key_events_json).todos || [] : [],
      decisions: ds.key_events_json ? JSON.parse(ds.key_events_json).decisions || [] : [],
    }));

    const llmClient = createLLMClient(settings);
    const optimizer = new TextOptimizer(llmClient, getLLMModel(settings));
    const result = await optimizer.generateWeeklySummary(startStr, endStr, parsed);

    // Persist so /api/weekly-summary can serve it later. Previously this only
    // emitted a Markdown file, leaving the mobile app showing "no weekly".
    try {
      db.upsertWeeklySummary(startStr, endStr, JSON.stringify(result));
    } catch (saveErr: any) {
      console.warn(`[PredefinedActions] upsertWeeklySummary failed:`, saveErr.message);
    }

    // Export Markdown
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir);
    const content = mdGen.buildWeeklySummary({
      startDate: startStr,
      endDate: endStr,
      ...result,
    });
    mdGen.writeWeeklySummary(startStr, content);

    notify(
      settings.language === 'zh' ? '周报已生成' : 'Weekly Report Generated',
      settings.language === 'zh'
        ? `${startStr} ~ ${endStr} 周报已自动生成`
        : `Weekly report ${startStr} ~ ${endStr} generated`,
    );

    // Push text summary to channels
    const textSummary = `[周报] ${startStr} ~ ${endStr}\n${result.summary}`;
    const notified = await pushText(textSummary, deps, channelsOverride);

    autoSyncObsidian();

    return {
      success: true,
      summary: `Weekly report ${startStr}~${endStr} generated (${dailySummaries.length} days). Notified: ${notified.join(', ') || 'none'}`,
    };
  } catch (err: any) {
    console.error(`[PredefinedActions] Weekly report failed:`, err.message);
    return { success: false, summary: 'Weekly report failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Monthly Report
// ---------------------------------------------------------------------------

export async function actionMonthlyReport(
  deps: ActionDeps,
  channelsOverride?: string[],
  /**
   * When set (yyyy-MM-dd), regenerates the natural month that this date falls
   * in. Otherwise defaults to the *previous* calendar month — used by the
   * scheduled task that runs on the 1st of each month. The month is summarised
   * by aggregating that month's daily summaries directly (not weekly reports),
   * so it works even when the weekly report is disabled.
   */
  forStartDate?: string,
): Promise<ActionResult> {
  let startDate: Date;
  let endDate: Date;
  if (forStartDate && /^\d{4}-\d{2}-\d{2}$/.test(forStartDate)) {
    const d = new Date(forStartDate + 'T00:00:00');
    startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0); // last day of that month
  } else {
    const now = new Date();
    // Last day of the previous month = day 0 of the current month.
    endDate = new Date(now.getFullYear(), now.getMonth(), 0);
    startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  }

  const startStr = formatLocalDate(startDate);
  const endStr = formatLocalDate(endDate);

  console.log(`[PredefinedActions] Generating monthly report ${startStr} ~ ${endStr}`);

  let db: VoiceBrainDB | null = null;
  try {
    const settings = loadSettings();
    db = new VoiceBrainDB(getDbPath());
    const dailySummaries = db.getDailySummariesInRange(startStr, endStr);

    if (dailySummaries.length === 0) {
      return { success: true, summary: `No daily summaries in range ${startStr}~${endStr}, skipped` };
    }

    const parsed = dailySummaries.map((ds: any) => ({
      date: ds.date,
      summary: ds.summary_text || '',
      todos: ds.key_events_json ? JSON.parse(ds.key_events_json).todos || [] : [],
      decisions: ds.key_events_json ? JSON.parse(ds.key_events_json).decisions || [] : [],
    }));

    const llmClient = createLLMClient(settings);
    const optimizer = new TextOptimizer(llmClient, getLLMModel(settings));
    const result = await optimizer.generateMonthlySummary(startStr, endStr, parsed);

    // Persist so /api/monthly-summary and the desktop Reports page can serve it.
    try {
      db.upsertMonthlySummary(startStr, endStr, JSON.stringify(result));
    } catch (saveErr: any) {
      console.warn(`[PredefinedActions] upsertMonthlySummary failed:`, saveErr.message);
    }

    // Export Markdown
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir);
    const content = mdGen.buildMonthlySummary({
      startDate: startStr,
      endDate: endStr,
      ...result,
    });
    mdGen.writeMonthlySummary(startStr, content);

    notify(
      settings.language === 'zh' ? '月报已生成' : 'Monthly Report Generated',
      settings.language === 'zh'
        ? `${startStr} ~ ${endStr} 月报已自动生成`
        : `Monthly report ${startStr} ~ ${endStr} generated`,
    );

    // Push text summary to channels
    const textSummary = `[月报] ${startStr} ~ ${endStr}\n${result.summary}`;
    const notified = await pushText(textSummary, deps, channelsOverride);

    autoSyncObsidian();

    return {
      success: true,
      summary: `Monthly report ${startStr}~${endStr} generated (${dailySummaries.length} days). Notified: ${notified.join(', ') || 'none'}`,
    };
  } catch (err: any) {
    console.error(`[PredefinedActions] Monthly report failed:`, err.message);
    return { success: false, summary: 'Monthly report failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Insight Scan
// ---------------------------------------------------------------------------

export async function actionInsightScan(
  deps: ActionDeps,
  channelsOverride?: string[],
): Promise<ActionResult> {
  if (!deps.insightEngine) {
    return { success: false, summary: 'InsightEngine not available', error: 'No InsightEngine provided' };
  }

  let db: VoiceBrainDB | null = null;
  try {
    const insights = await deps.insightEngine.scan();
    if (insights.length === 0) {
      return { success: true, summary: 'Insight scan completed, no insights found' };
    }

    // Dedup: don't re-push an insight that was already sent within the last 20h.
    // The scan now runs once/day (not hourly), so this collapses recurring
    // insights (e.g. the same overdue todo) to at most one push per day.
    db = new VoiceBrainDB(getDbPath());
    const keyOf = (i: { type: string; title: string; detail: string }) =>
      `insight|${i.type}|${i.title}|${i.detail}`;
    const recentKeys = db.getRecentlyPushedInsightKeys(20);
    const fresh = insights.filter((i) => !recentKeys.has(keyOf(i)));

    if (fresh.length === 0) {
      return {
        success: true,
        summary: `Insight scan found ${insights.length} insight(s), all already pushed within 20h`,
      };
    }

    const text = fresh
      .map((i) => `[${i.urgency === 'high' ? '❗' : 'ℹ️'}] ${i.title}\n${i.detail}`)
      .join('\n\n');

    const notified = await pushText(text, deps, channelsOverride);

    db.recordPushedInsights(fresh.map(keyOf));
    db.prunePushedInsights(168); // keep dedup history ~7 days

    return {
      success: true,
      summary: `Insight scan found ${insights.length} insight(s), ${fresh.length} new. Notified: ${notified.join(', ') || 'none'}`,
    };
  } catch (err: any) {
    console.error('[PredefinedActions] Insight scan failed:', err.message);
    return { success: false, summary: 'Insight scan failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Todo Reminder
// ---------------------------------------------------------------------------

export async function actionTodoReminder(
  deps: ActionDeps,
  channelsOverride?: string[],
  actionParams?: Record<string, any>,
): Promise<ActionResult> {
  try {
    console.log(`[actionTodoReminder] actionParams=${JSON.stringify(actionParams)} channelsOverride=${JSON.stringify(channelsOverride)} hasRouter=${!!deps.router} hasTodoTracker=${!!deps.todoTracker}`);

    // Specific item reminder (from set_reminder tool)
    if (actionParams?.item_id && actionParams?.content) {
      const text = `⏰ 提醒：${actionParams.content}`;
      console.log(`[actionTodoReminder] Sending specific reminder: "${text}"`);
      const notified = await pushText(text, deps, channelsOverride);
      console.log(`[actionTodoReminder] Notified channels: ${notified.join(', ') || 'none'}`);
      // Mark reminder sent in DB
      try {
        const db = new VoiceBrainDB(getDbPath());
        db.markReminderSent(actionParams.item_id);
        db.close();
      } catch { /* best effort */ }
      return { success: true, summary: `Reminder sent: ${actionParams.content}. Notified: ${notified.join(', ') || 'none'}` };
    }

    // Generic batch: send all pending reminders
    if (!deps.todoTracker) {
      return { success: false, summary: 'TodoTracker not available', error: 'No TodoTracker provided' };
    }
    await deps.todoTracker.sendReminders();
    return { success: true, summary: 'Todo reminders sent' };
  } catch (err: any) {
    console.error('[PredefinedActions] Todo reminder failed:', err.message);
    return { success: false, summary: 'Todo reminder failed', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Action: Todo Summary
// ---------------------------------------------------------------------------

export async function actionTodoSummary(
  deps: ActionDeps,
  channelsOverride?: string[],
): Promise<ActionResult> {
  let db: VoiceBrainDB | null = null;
  try {
    db = new VoiceBrainDB(getDbPath());
    const todayStr = formatLocalDate();

    const activeItems = db.getActiveExtractedItems().filter(
      (item) => item.type === 'todo',
    );
    const overdueItems = activeItems.filter(
      (item) => item.due_date && item.due_date < todayStr,
    );
    const upcomingItems = activeItems.filter(
      (item) => !item.due_date || item.due_date >= todayStr,
    );

    if (activeItems.length === 0) {
      return { success: true, summary: 'No active todos' };
    }

    const lines: string[] = [`📋 待办摘要 (${activeItems.length}项)`];

    if (overdueItems.length > 0) {
      lines.push('', `🔴 逾期 (${overdueItems.length}):`);
      for (const item of overdueItems) {
        const person = item.related_person ? ` (${item.related_person})` : '';
        lines.push(`  - ${item.content}${person} — 截止 ${item.due_date}`);
      }
    }

    if (upcomingItems.length > 0) {
      lines.push('', `🟢 进行中 (${upcomingItems.length}):`);
      for (const item of upcomingItems) {
        const person = item.related_person ? ` (${item.related_person})` : '';
        const due = item.due_date ? ` — 截止 ${item.due_date}` : '';
        lines.push(`  - ${item.content}${person}${due}`);
      }
    }

    const text = lines.join('\n');

    // Dedup: avoid re-pushing the same summary twice within 20h (e.g. when the
    // action is triggered manually or by an agent more than once a day).
    const dedupKey = `todo_summary|${todayStr}|${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
    if (db.getRecentlyPushedInsightKeys(20).has(dedupKey)) {
      return { success: true, summary: 'Todo summary unchanged, skipped re-push' };
    }

    const notified = await pushText(text, deps, channelsOverride);
    db.recordPushedInsights([dedupKey]);

    return {
      success: true,
      summary: `Todo summary: ${overdueItems.length} overdue, ${upcomingItems.length} active. Notified: ${notified.join(', ') || 'none'}`,
    };
  } catch (err: any) {
    console.error('[PredefinedActions] Todo summary failed:', err.message);
    return { success: false, summary: 'Todo summary failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Knowledge Audit
// ---------------------------------------------------------------------------

export async function actionKnowledgeAudit(
  deps: ActionDeps,
): Promise<ActionResult> {
  if (!deps.knowledgeCompiler) {
    return { success: false, summary: 'KnowledgeCompiler not initialized', error: 'KnowledgeCompiler not initialized' };
  }

  let db: VoiceBrainDB | null = null;
  try {
    db = new VoiceBrainDB(getDbPath());
    const compiler = deps.knowledgeCompiler;

    let uncompiled = 0;
    const recordings = db.getAllRecordings().filter((r: any) => r.status === 'completed');
    for (const rec of recordings) {
      if (!db.isRecordingInKnowledgePages(rec.id)) {
        compiler.enqueue(rec.id, -1); // low priority
        uncompiled++;
      }
    }

    const stalePages = db.getStaleKnowledgePages(30);

    const summary = `Audit: ${uncompiled} uncompiled recordings queued, ${stalePages.length} stale pages detected`;
    console.log(`[PredefinedActions] Knowledge audit complete — ${summary}`);

    return { success: true, summary };
  } catch (err: any) {
    console.error('[PredefinedActions] Knowledge audit failed:', err.message);
    return { success: false, summary: 'Knowledge audit failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Action: Memory Compaction
// ---------------------------------------------------------------------------

export async function actionMemoryCompact(
  deps: ActionDeps,
): Promise<ActionResult> {
  let db: VoiceBrainDB | null = null;
  try {
    const settings = loadSettings();
    db = new VoiceBrainDB(getDbPath());
    const llmClient = createLLMClient(settings);
    const model = getLLMModel(settings);

    const { MemoryCompactor } = await import('../agent/memory-compactor');
    const compactor = new MemoryCompactor(db, llmClient, model, getEmbedModel(settings));
    const result = await compactor.compact();

    const summary = `Memory compaction: ${result.decayed} decayed, ${result.merged} merged, ${result.purged} purged`;
    console.log(`[PredefinedActions] ${summary}`);

    return { success: true, summary };
  } catch (err: any) {
    console.error('[PredefinedActions] Memory compaction failed:', err.message);
    return { success: false, summary: 'Memory compaction failed', error: err.message };
  } finally {
    if (db) db.close();
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executePredefinedAction(
  actionName: string,
  deps: ActionDeps,
  channelsOverride?: string[],
  actionParams?: Record<string, any>,
): Promise<ActionResult> {
  switch (actionName) {
    case 'daily_report':
      return actionDailyReport(deps, channelsOverride, actionParams);
    case 'weekly_report':
      return actionWeeklyReport(deps, channelsOverride);
    case 'monthly_report':
      return actionMonthlyReport(deps, channelsOverride);
    case 'insight_scan':
      return actionInsightScan(deps, channelsOverride);
    case 'todo_reminder':
      return actionTodoReminder(deps, channelsOverride, actionParams);
    case 'todo_summary':
      return actionTodoSummary(deps, channelsOverride);
    case 'knowledge_audit':
      return actionKnowledgeAudit(deps);
    case 'memory_compact':
      return actionMemoryCompact(deps);
    default:
      return { success: false, summary: `Unknown action: ${actionName}`, error: `No handler for "${actionName}"` };
  }
}

// ---------------------------------------------------------------------------
// Registry for UI
// ---------------------------------------------------------------------------

export const PREDEFINED_ACTIONS = [
  { name: 'daily_report', label_zh: '生成日报', label_en: 'Daily Report' },
  { name: 'weekly_report', label_zh: '生成周报', label_en: 'Weekly Report' },
  { name: 'monthly_report', label_zh: '生成月报', label_en: 'Monthly Report' },
  { name: 'insight_scan', label_zh: '洞察扫描', label_en: 'Insight Scan' },
  { name: 'todo_reminder', label_zh: '待办提醒', label_en: 'Todo Reminder' },
  { name: 'todo_summary', label_zh: '待办摘要', label_en: 'Todo Summary' },
  { name: 'knowledge_audit', label_zh: '知识审计', label_en: 'Knowledge Audit' },
  { name: 'memory_compact', label_zh: '记忆整理', label_en: 'Memory Compaction' },
] as const;
