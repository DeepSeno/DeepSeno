import { VoiceBrainDB } from '../db/database';
import { getDbPath } from '../paths';
import { loadSettings } from '../settings';
import { computeNextRun } from './schedule-parser';

/**
 * Seed predefined scheduled tasks from user settings on first upgrade.
 *
 * Runs once: if the `scheduled_tasks` table already has rows, this is a no-op.
 * Otherwise it creates 4 default tasks (daily report, weekly report, insight scan,
 * todo reminder) with schedules derived from the current settings. Tasks whose
 * corresponding setting is disabled are created with status 'paused'.
 */
export function seedPredefinedTasks(): void {
  let db: VoiceBrainDB | null = null;
  try {
    db = new VoiceBrainDB(getDbPath());

    // Check if tasks already exist — if so, only add missing predefined tasks
    const count = db.db.prepare('SELECT COUNT(*) AS cnt FROM scheduled_tasks').get() as { cnt: number };
    if (count.cnt > 0) {
      console.log('[seedTasks] scheduled_tasks already populated, checking for missing tasks');
      seedMissingTasks(db);
      return;
    }

    const settings = loadSettings();

    // ── 1. Daily Report ──────────────────────────────────────
    const dailyTime = settings.autoReportDailyTime || '22:00';
    const [dailyHour, dailyMin] = dailyTime.split(':').map(Number);
    const dailyCron = `${dailyMin} ${dailyHour} * * *`;
    const dailyNextRun = computeNextRun('cron', dailyCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '每日报告' : 'Daily Report',
      description: settings.language === 'zh' ? '每天定时汇总当天的日报' : 'Summarise the current day, once daily',
      task_type: 'predefined',
      action: 'daily_report',
      // Summarise the current day (replaces the old per-recording regeneration).
      action_params: JSON.stringify({ today: true }),
      schedule_type: 'cron',
      schedule_expr: dailyCron,
      schedule_display: settings.language === 'zh' ? `每天 ${dailyTime}` : `Daily at ${dailyTime}`,
      is_recurring: true,
      missed_policy: 'catch_up_latest',
      max_retries: 1,
      created_by: 'system',
      next_run_at: dailyNextRun ?? undefined,
    });
    if (!settings.autoReportDaily) {
      // Pause the task we just created (it's the last inserted row)
      const lastId = db.db.prepare('SELECT MAX(id) AS id FROM scheduled_tasks').get() as { id: number };
      db.updateScheduledTask(lastId.id, { status: 'paused' });
    }

    // ── 2. Weekly Report ─────────────────────────────────────
    const weeklyTime = settings.autoReportWeeklyTime || '22:00';
    const weeklyDay = settings.autoReportWeeklyDay ?? 5; // default Friday
    const [weeklyHour, weeklyMin] = weeklyTime.split(':').map(Number);
    const weeklyCron = `${weeklyMin} ${weeklyHour} * * ${weeklyDay}`;
    const weeklyNextRun = computeNextRun('cron', weeklyCron);

    const dayNames_zh = ['日', '一', '二', '三', '四', '五', '六'];
    const dayNames_en = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '每周报告' : 'Weekly Report',
      description: settings.language === 'zh' ? '自动生成上周的周报' : 'Auto-generate weekly report for previous week',
      task_type: 'predefined',
      action: 'weekly_report',
      schedule_type: 'cron',
      schedule_expr: weeklyCron,
      schedule_display: settings.language === 'zh'
        ? `每周${dayNames_zh[weeklyDay]} ${weeklyTime}`
        : `${dayNames_en[weeklyDay]} at ${weeklyTime}`,
      is_recurring: true,
      missed_policy: 'catch_up_latest',
      max_retries: 1,
      created_by: 'system',
      next_run_at: weeklyNextRun ?? undefined,
    });
    if (!settings.autoReportWeekly) {
      const lastId = db.db.prepare('SELECT MAX(id) AS id FROM scheduled_tasks').get() as { id: number };
      db.updateScheduledTask(lastId.id, { status: 'paused' });
    }

    // ── 3. Monthly Report ────────────────────────────────────
    const monthlyTime = settings.autoReportMonthlyTime || '22:00';
    const monthlyDay = settings.autoReportMonthlyDay ?? 1; // default 1st of month
    const [monthlyHour, monthlyMin] = monthlyTime.split(':').map(Number);
    const monthlyCron = `${monthlyMin} ${monthlyHour} ${monthlyDay} * *`;
    const monthlyNextRun = computeNextRun('cron', monthlyCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '每月报告' : 'Monthly Report',
      description: settings.language === 'zh' ? '自动生成上月的月报' : 'Auto-generate monthly report for previous month',
      task_type: 'predefined',
      action: 'monthly_report',
      schedule_type: 'cron',
      schedule_expr: monthlyCron,
      schedule_display: settings.language === 'zh'
        ? `每月 ${monthlyDay} 日 ${monthlyTime}`
        : `Day ${monthlyDay} of each month at ${monthlyTime}`,
      is_recurring: true,
      missed_policy: 'catch_up_latest',
      max_retries: 1,
      created_by: 'system',
      next_run_at: monthlyNextRun ?? undefined,
    });
    if (!settings.autoReportMonthly) {
      const lastId = db.db.prepare('SELECT MAX(id) AS id FROM scheduled_tasks').get() as { id: number };
      db.updateScheduledTask(lastId.id, { status: 'paused' });
    }

    // ── 4. Insight Scan ──────────────────────────────────────
    const insightCron = '0 8 * * *'; // daily 08:00 (was hourly; downfreq + dedup, see actionInsightScan)
    const insightNextRun = computeNextRun('cron', insightCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '洞察扫描' : 'Insight Scan',
      description: settings.language === 'zh' ? '每天扫描新洞察并推送（已去重）' : 'Daily scan for new insights (deduped push)',
      task_type: 'predefined',
      action: 'insight_scan',
      schedule_type: 'cron',
      schedule_expr: insightCron,
      schedule_display: settings.language === 'zh' ? '每天 08:00' : 'Daily at 08:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: insightNextRun ?? undefined,
    });

    // ── 5. Todo Reminder ─────────────────────────────────────
    const todoCron = '0 9 * * *'; // daily 09:00
    const todoNextRun = computeNextRun('cron', todoCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '待办提醒' : 'Todo Reminder',
      description: settings.language === 'zh' ? '每天上午9点发送待办提醒' : 'Send todo reminders daily at 09:00',
      task_type: 'predefined',
      action: 'todo_reminder',
      schedule_type: 'cron',
      schedule_expr: todoCron,
      schedule_display: settings.language === 'zh' ? '每天 09:00' : 'Daily at 09:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: todoNextRun ?? undefined,
    });

    // ── 6. Memory Compaction ───────────────────────────────────
    const compactCron = '0 2 * * *'; // daily 02:00
    const compactNextRun = computeNextRun('cron', compactCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '记忆整理' : 'Memory Compaction',
      description: settings.language === 'zh' ? '每天凌晨2点整理记忆：衰减过期、合并重复、清理溢出' : 'Daily memory maintenance: decay stale, merge duplicates, purge excess',
      task_type: 'predefined',
      action: 'memory_compact',
      schedule_type: 'cron',
      schedule_expr: compactCron,
      schedule_display: settings.language === 'zh' ? '每天 02:00' : 'Daily at 02:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: compactNextRun ?? undefined,
    });

    // ── 7. Knowledge Audit ─────────────────────────────────────
    const auditCron = '0 3 * * *'; // daily 03:00 (after memory compaction); silent, no push
    const auditNextRun = computeNextRun('cron', auditCron);

    db.insertScheduledTask({
      name: settings.language === 'zh' ? '知识审计' : 'Knowledge Audit',
      description: settings.language === 'zh' ? '每天凌晨3点把未编译录音入队、检测过期知识页' : 'Daily: queue uncompiled recordings, detect stale knowledge pages',
      task_type: 'predefined',
      action: 'knowledge_audit',
      schedule_type: 'cron',
      schedule_expr: auditCron,
      schedule_display: settings.language === 'zh' ? '每天 03:00' : 'Daily at 03:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: auditNextRun ?? undefined,
    });

    console.log('[seedTasks] Seeded 7 predefined scheduled tasks');
  } catch (err: any) {
    console.error('[seedTasks] Failed to seed tasks:', err.message);
  } finally {
    if (db) db.close();
  }
}

/**
 * For existing users: add any new predefined tasks that don't exist yet.
 */
function seedMissingTasks(db: VoiceBrainDB): void {
  const settings = loadSettings();
  const existing = db.db.prepare(
    "SELECT action FROM scheduled_tasks WHERE task_type = 'predefined'"
  ).all() as { action: string }[];
  const existingActions = new Set(existing.map(e => e.action));

  // Migration: the daily report used to summarise "yesterday" and the live
  // daily summary ran per-recording. Switch the existing daily_report task to
  // summarise "today" (action_params { today: true }) and activate it so users
  // keep getting an automatic daily summary now that the per-recording one is
  // gone. Idempotent — only runs until the task already carries { today: true }.
  try {
    const dailyTasks = db.db.prepare(
      "SELECT id, action_params, status FROM scheduled_tasks WHERE action = 'daily_report' AND task_type = 'predefined'"
    ).all() as { id: number; action_params: string | null; status: string }[];
    for (const t of dailyTasks) {
      let isToday = false;
      try { isToday = !!JSON.parse(t.action_params || '{}').today; } catch { /* treat as not-today */ }
      if (isToday) continue;
      db.updateScheduledTask(t.id, {
        action_params: JSON.stringify({ today: true }),
        description: settings.language === 'zh' ? '每天定时汇总当天的日报' : 'Summarise the current day, once daily',
        status: 'active',
      });
      console.log(`[seedTasks] Migrated daily_report task #${t.id} → summarise today + active`);
    }
  } catch (err) {
    console.warn('[seedTasks] daily_report migration failed (non-fatal):', err);
  }

  if (!existingActions.has('memory_compact')) {
    const compactCron = '0 2 * * *';
    const compactNextRun = computeNextRun('cron', compactCron);
    db.insertScheduledTask({
      name: settings.language === 'zh' ? '记忆整理' : 'Memory Compaction',
      description: settings.language === 'zh' ? '每天凌晨2点整理记忆：衰减过期、合并重复、清理溢出' : 'Daily memory maintenance: decay stale, merge duplicates, purge excess',
      task_type: 'predefined',
      action: 'memory_compact',
      schedule_type: 'cron',
      schedule_expr: compactCron,
      schedule_display: settings.language === 'zh' ? '每天 02:00' : 'Daily at 02:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: compactNextRun ?? undefined,
    });
    console.log('[seedTasks] Added missing task: memory_compact');
  }

  // Migration: the insight scan used to run hourly (0 * * * *) and pushed with
  // no dedup → flooded channels and the LLM queue. Downfreq existing tasks to
  // daily 08:00. Idempotent — only the old hourly value is rewritten.
  try {
    const insightTasks = db.db.prepare(
      "SELECT id, schedule_expr FROM scheduled_tasks WHERE action = 'insight_scan' AND task_type = 'predefined'"
    ).all() as { id: number; schedule_expr: string }[];
    const newInsightCron = '0 8 * * *';
    for (const t of insightTasks) {
      if (t.schedule_expr !== '0 * * * *') continue;
      db.updateScheduledTask(t.id, {
        schedule_expr: newInsightCron,
        schedule_display: settings.language === 'zh' ? '每天 08:00' : 'Daily at 08:00',
        description: settings.language === 'zh' ? '每天扫描新洞察并推送（已去重）' : 'Daily scan for new insights (deduped push)',
        next_run_at: computeNextRun('cron', newInsightCron),
      });
      console.log(`[seedTasks] Migrated insight_scan task #${t.id} → daily 08:00`);
    }
  } catch (err) {
    console.warn('[seedTasks] insight_scan migration failed (non-fatal):', err);
  }

  if (!existingActions.has('monthly_report')) {
    const monthlyTime = settings.autoReportMonthlyTime || '22:00';
    const monthlyDay = settings.autoReportMonthlyDay ?? 1;
    const [monthlyHour, monthlyMin] = monthlyTime.split(':').map(Number);
    const monthlyCron = `${monthlyMin} ${monthlyHour} ${monthlyDay} * *`;
    db.insertScheduledTask({
      name: settings.language === 'zh' ? '每月报告' : 'Monthly Report',
      description: settings.language === 'zh' ? '自动生成上月的月报' : 'Auto-generate monthly report for previous month',
      task_type: 'predefined',
      action: 'monthly_report',
      schedule_type: 'cron',
      schedule_expr: monthlyCron,
      schedule_display: settings.language === 'zh'
        ? `每月 ${monthlyDay} 日 ${monthlyTime}`
        : `Day ${monthlyDay} of each month at ${monthlyTime}`,
      is_recurring: true,
      missed_policy: 'catch_up_latest',
      max_retries: 1,
      created_by: 'system',
      next_run_at: computeNextRun('cron', monthlyCron) ?? undefined,
    });
    if (!settings.autoReportMonthly) {
      const lastId = db.db.prepare('SELECT MAX(id) AS id FROM scheduled_tasks').get() as { id: number };
      db.updateScheduledTask(lastId.id, { status: 'paused' });
    }
    console.log('[seedTasks] Added missing task: monthly_report');
  }

  if (!existingActions.has('knowledge_audit')) {
    const auditCron = '0 3 * * *';
    db.insertScheduledTask({
      name: settings.language === 'zh' ? '知识审计' : 'Knowledge Audit',
      description: settings.language === 'zh' ? '每天凌晨3点把未编译录音入队、检测过期知识页' : 'Daily: queue uncompiled recordings, detect stale knowledge pages',
      task_type: 'predefined',
      action: 'knowledge_audit',
      schedule_type: 'cron',
      schedule_expr: auditCron,
      schedule_display: settings.language === 'zh' ? '每天 03:00' : 'Daily at 03:00',
      is_recurring: true,
      missed_policy: 'skip',
      max_retries: 1,
      created_by: 'system',
      next_run_at: computeNextRun('cron', auditCron) ?? undefined,
    });
    console.log('[seedTasks] Added missing task: knowledge_audit');
  }
}
