// DEPRECATED: This file is no longer used. Replaced by TaskScheduler + predefined-actions.ts
import { Notification, BrowserWindow } from 'electron';
import { loadSettings } from '../settings';
import { VoiceBrainDB } from '../db/database';
import { TextOptimizer } from '../llm/text-optimizer';
import { createLLMClient, getLLMModel } from '../llm/create-client';
import { MarkdownGenerator } from '../output/markdown-generator';
import { getDbPath, getOutputDir } from '../paths';
import { buildDailySummaryCard } from '../feishu/card-builder';
import type { InsightEngine } from '../agent/insight-engine';
import type { MessageRouter } from '../channels/router';
import type { TodoTracker } from '../agent/todo-tracker';

export class ReportScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastRun = new Map<string, string>(); // 'daily'|'weekly'|'insight' → date/hour string
  private running = false;
  private feishuNotifier?: (cardJson: string) => Promise<void>;
  private insightEngine?: InsightEngine;
  private router?: MessageRouter;
  private todoTracker?: TodoTracker;

  setFeishuNotifier(notifier: (cardJson: string) => Promise<void>): void {
    this.feishuNotifier = notifier;
  }

  setInsightEngine(engine: InsightEngine): void {
    this.insightEngine = engine;
  }

  setRouter(router: MessageRouter): void {
    this.router = router;
  }

  setTodoTracker(tracker: TodoTracker): void {
    this.todoTracker = tracker;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.checkAndRun(), 60_000);
    console.log('[ReportScheduler] Started (60s interval)');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[ReportScheduler] Stopped');
  }

  private async checkAndRun(): Promise<void> {
    if (this.running) return;

    const settings = loadSettings();
    const now = new Date();
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayStr = now.toISOString().split('T')[0];

    // Todo reminder check (daily at 09:00)
    if (currentHHMM === '09:00') {
      const lastReminder = this.lastRun.get('reminder');
      if (lastReminder !== todayStr) {
        this.lastRun.set('reminder', todayStr);
        if (this.todoTracker) {
          try {
            await this.todoTracker.sendReminders();
          } catch (err: any) {
            console.error('[ReportScheduler] Todo reminder failed:', err.message);
          }
        }
      }
    }

    // Check explicit remind_at reminders
    try {
      const db = new VoiceBrainDB(getDbPath());
      try {
        const reminders = db.getActiveReminders();
        if (reminders.length > 0) {
          const lines = reminders.map((r: any) =>
            `⏰ ${r.content}${r.due_date ? ` (截止: ${r.due_date})` : ''}`,
          );
          const text = `⏰ 提醒 (${reminders.length}项)\n\n${lines.join('\n')}`;
          await this.pushToChannels(text, settings);
          for (const r of reminders) {
            db.markReminderSent(r.id);
          }
          console.log(`[ReportScheduler] Sent ${reminders.length} timed reminders`);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn('[ReportScheduler] Reminder check failed:', err);
    }

    // Daily report check
    if (settings.autoReportDaily && currentHHMM === settings.autoReportDailyTime) {
      const lastDaily = this.lastRun.get('daily');
      if (lastDaily !== todayStr) {
        this.lastRun.set('daily', todayStr);
        await this.generateDaily(settings);
      }
    }

    // Weekly report check
    if (settings.autoReportWeekly && currentHHMM === settings.autoReportWeeklyTime) {
      if (now.getDay() === settings.autoReportWeeklyDay) {
        const lastWeekly = this.lastRun.get('weekly');
        if (lastWeekly !== todayStr) {
          this.lastRun.set('weekly', todayStr);
          await this.generateWeekly(settings);
        }
      }
    }

    // Insight scan (hourly)
    const lastInsight = this.lastRun.get('insight');
    const currentHour = `${todayStr}T${String(now.getHours()).padStart(2, '0')}`;
    if (lastInsight !== currentHour) {
      this.lastRun.set('insight', currentHour);
      try {
        await this.scanInsights();
      } catch (err: any) {
        console.error('[ReportScheduler] Insight scan failed:', err.message);
      }
    }
  }

  private async generateDaily(settings: ReturnType<typeof loadSettings>): Promise<void> {
    this.running = true;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    console.log(`[ReportScheduler] Generating daily report for ${dateStr}`);

    let db: VoiceBrainDB | null = null;
    try {
      db = new VoiceBrainDB(getDbPath());
      const segments = db.getSegmentsByDate(dateStr);

      if (segments.length === 0) {
        console.log(`[ReportScheduler] No segments for ${dateStr}, skipping`);
        return;
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
      const weekday = yesterday.toLocaleDateString('zh-CN', { weekday: 'long' });
      const content = mdGen.buildDailySummary({
        date: dateStr,
        weekday,
        summary: result.summary,
        timeline: result.timeline,
        todos: result.todos,
        decisions: result.decisions,
      });
      mdGen.writeDailySummary(dateStr, content);

      this.notify(
        settings.language === 'zh' ? '日报已生成' : 'Daily Report Generated',
        settings.language === 'zh' ? `${dateStr} 的日报已自动生成` : `Daily report for ${dateStr} generated`,
      );

      // Push to Feishu if configured (card format)
      if (this.feishuNotifier && settings.feishuNotifyDailyDigest) {
        try {
          const card = buildDailySummaryCard({
            date: dateStr,
            summaryText: result.summary,
            keyEvents: { todos: result.todos, decisions: result.decisions },
          });
          await this.feishuNotifier(card);
          console.log(`[ReportScheduler] Pushed daily report to Feishu`);
        } catch (feishuErr: any) {
          console.error(`[ReportScheduler] Feishu push failed:`, feishuErr.message);
        }
      }

      // Push text summary to all enabled channels via MessageRouter
      if (this.router) {
        const textSummary = `[日报] ${dateStr}\n${result.summary}`;
        await this.pushToChannels(textSummary, settings);
      }

      // Auto-sync to Obsidian if enabled
      this.autoSyncObsidian(settings);

      console.log(`[ReportScheduler] Daily report for ${dateStr} completed`);
    } catch (err: any) {
      console.error(`[ReportScheduler] Daily report failed:`, err.message);
    } finally {
      if (db) db.close();
      this.running = false;
    }
  }

  private async generateWeekly(settings: ReturnType<typeof loadSettings>): Promise<void> {
    this.running = true;
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    console.log(`[ReportScheduler] Generating weekly report ${startStr} ~ ${endStr}`);

    let db: VoiceBrainDB | null = null;
    try {
      db = new VoiceBrainDB(getDbPath());
      const dailySummaries = db.getDailySummariesInRange(startStr, endStr);

      if (dailySummaries.length === 0) {
        console.log(`[ReportScheduler] No daily summaries in range, skipping`);
        return;
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

      // Persist so /api/weekly-summary can serve it.
      try {
        db.upsertWeeklySummary(startStr, endStr, JSON.stringify(result));
      } catch (saveErr: any) {
        console.warn(`[ReportScheduler] upsertWeeklySummary failed:`, saveErr.message);
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

      this.notify(
        settings.language === 'zh' ? '周报已生成' : 'Weekly Report Generated',
        settings.language === 'zh' ? `${startStr} ~ ${endStr} 周报已自动生成` : `Weekly report ${startStr} ~ ${endStr} generated`,
      );
      // Auto-sync to Obsidian if enabled
      this.autoSyncObsidian(settings);

      console.log(`[ReportScheduler] Weekly report ${startStr} ~ ${endStr} completed`);
    } catch (err: any) {
      console.error(`[ReportScheduler] Weekly report failed:`, err.message);
    } finally {
      if (db) db.close();
      this.running = false;
    }
  }

  private autoSyncObsidian(settings: ReturnType<typeof loadSettings>): void {
    if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
      try {
        const outputDir = settings.outputDir || getOutputDir();
        const count = MarkdownGenerator.syncAllToVault(outputDir, settings.obsidianVaultDir);
        console.log(`[ReportScheduler] Auto-synced ${count} files to Obsidian vault`);
      } catch (err: any) {
        console.error('[ReportScheduler] Obsidian auto-sync failed:', err.message);
      }
    }
  }

  private async scanInsights(): Promise<void> {
    if (!this.insightEngine) return;
    const insights = await this.insightEngine.scan();
    if (insights.length === 0) return;

    const settings = loadSettings();
    const text = insights.map(i =>
      `[${i.urgency === 'high' ? '❗' : 'ℹ️'}] ${i.title}\n${i.detail}`
    ).join('\n\n');

    await this.pushToChannels(text, settings);
  }

  private async pushToChannels(text: string, settings: ReturnType<typeof loadSettings>): Promise<void> {
    if (!this.router) return;

    if (settings.feishuEnabled && settings.feishuAdminOpenId) {
      try {
        await this.router.sendText('feishu', settings.feishuAdminOpenId, text);
      } catch (err: any) {
        console.error('[ReportScheduler] Feishu push failed:', err.message);
      }
    }

    if (settings.wechatEnabled && settings.wechatCorpId) {
      try {
        await this.router.sendText('wechat', '@all', text);
      } catch (err: any) {
        console.error('[ReportScheduler] WeChat push failed:', err.message);
      }
    }
  }

  private notify(title: string, body: string): void {
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
      console.error('[ReportScheduler] Notification failed:', err.message);
    }
  }
}
