import { VoiceBrainDB } from '../db/database';
import { TaskExecutor } from './task-executor';
import { computeNextRun } from './schedule-parser';
import { getDbPath } from '../paths';

const POLL_INTERVAL_MS = 30_000;
const TASK_TIMEOUT_MS = 10 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;

export class TaskScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executor: TaskExecutor | null = null;
  private db: VoiceBrainDB | null = null;

  setExecutor(executor: TaskExecutor): void {
    this.executor = executor;
  }

  start(): void {
    if (this.interval) return;

    // Check missed tasks on startup (fire-and-forget)
    this.checkMissedTasks().catch(err =>
      console.error('[TaskScheduler] checkMissedTasks failed:', err.message),
    );

    // Start the main polling loop
    this.interval = setInterval(() => {
      this.poll().catch(err =>
        console.error('[TaskScheduler] poll error:', err.message),
      );
    }, POLL_INTERVAL_MS);

    console.log(`[TaskScheduler] Started (${POLL_INTERVAL_MS / 1000}s interval)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    console.log('[TaskScheduler] Stopped');
  }

  private ensureDb(): VoiceBrainDB {
    if (!this.db) {
      try {
        this.db = new VoiceBrainDB(getDbPath());
      } catch (err: any) {
        console.error('[TaskScheduler] Failed to open DB, will retry next poll:', err.message);
        throw err;
      }
    }
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Main poll loop
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const db = this.ensureDb();

      // 0. Recover tasks stuck in 'running' for longer than timeout
      const stuckTasks = db.listScheduledTasks({ status: 'running' });
      for (const task of stuckTasks) {
        const lastRunTime = task.last_run_at ? new Date(task.last_run_at).getTime() : 0;
        const stuckDuration = Date.now() - lastRunTime;
        // If stuck for more than 2× timeout, recover it
        if (stuckDuration > TASK_TIMEOUT_MS * 2) {
          const isOneShot = !task.is_recurring || task.schedule_type === 'once';
          const newNextRun = isOneShot
            ? null
            : computeNextRun(task.schedule_type, task.schedule_expr);
          db.updateScheduledTask(task.id, {
            status: newNextRun ? 'active' : 'completed',
            last_run_status: 'failed',
            last_run_result: 'Recovered from stuck running state',
            retry_count: 0,
            next_run_at: newNextRun,
          });
          console.warn(`[TaskScheduler] poll: recovered stuck task#${task.id} (${task.name})`);
        }
      }

      // 1. Execute due scheduled tasks
      const allActive = db.listScheduledTasks({ status: 'active' });
      const dueTasks = db.getDueScheduledTasks();
      const nowUtc = new Date().toISOString();
      if (dueTasks.length > 0) {
        console.log(`[TaskScheduler] poll: ${dueTasks.length} due task(s) of ${allActive.length} active`);
      }
      for (const task of dueTasks) {
        console.log(`[TaskScheduler] Executing task#${task.id} action=${task.action} params=${task.action_params}`);
        await this.executeTask(task, db);
      }

      // 2. Check reminders from extracted_items
      await this.checkReminders(db);
    } catch (err: any) {
      console.error('[TaskScheduler] poll error:', err.message);
      // Reset DB connection on error so next poll gets a fresh one
      if (this.db) {
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Execute a single task with timeout + retry
  // ---------------------------------------------------------------------------

  private async executeTask(task: any, db: VoiceBrainDB): Promise<void> {
    if (!this.executor) {
      console.warn('[TaskScheduler] No executor set, skipping task', task.id);
      return;
    }

    const startedAt = new Date().toISOString();

    // 1. Insert execution record
    const execId = db.insertTaskExecution({
      task_id: task.id,
      started_at: startedAt,
      status: 'running',
    });

    // 2. Mark task as running
    db.updateScheduledTask(task.id, { status: 'running' });

    try {
      // 3. Race execution against timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Task execution timed out')), TASK_TIMEOUT_MS);
      });

      const result = await Promise.race([
        this.executor.execute(task),
        timeoutPromise,
      ]);

      // 4. Check result — executor returns { success: false } without throwing for some errors
      if (!result.success) {
        throw new Error(result.error || 'Task returned success=false');
      }

      const finishedAt = new Date().toISOString();

      db.updateTaskExecution(execId, {
        finished_at: finishedAt,
        status: 'success',
        result_summary: result.summary?.slice(0, 2000) || '',
      });

      // Compute next run time (once-type tasks never reschedule)
      // Check multiple signals: is_recurring flag, schedule_type, and action_params.one_shot
      let actionOneShot = false;
      try { actionOneShot = !!JSON.parse(task.action_params || '{}').one_shot; } catch { /* ignore */ }
      const isOneShot = !task.is_recurring || task.schedule_type === 'once' || actionOneShot;
      const nextRunAt = isOneShot
        ? null
        : computeNextRun(task.schedule_type, task.schedule_expr);

      db.updateScheduledTask(task.id, {
        status: nextRunAt ? 'active' : 'completed',
        last_run_at: finishedAt,
        last_run_status: 'success',
        last_run_result: result.summary?.slice(0, 2000) || '',
        run_count: (task.run_count || 0) + 1,
        retry_count: 0,
        next_run_at: nextRunAt,
      });

      console.log(`[TaskScheduler] Task ${task.id} (${task.name}) succeeded`);
    } catch (err: any) {
      // 5. Failure
      const finishedAt = new Date().toISOString();
      const errorMsg = err.message || String(err);

      db.updateTaskExecution(execId, {
        finished_at: finishedAt,
        status: 'failed',
        error_message: errorMsg.slice(0, 2000),
      });

      const newRetryCount = (task.retry_count || 0) + 1;
      const maxRetries = task.max_retries ?? 1;

      if (newRetryCount < maxRetries) {
        // Retries remaining: schedule retry in 5 minutes
        const retryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
        db.updateScheduledTask(task.id, {
          status: 'active',
          last_run_at: finishedAt,
          last_run_status: 'failed',
          last_run_result: errorMsg.slice(0, 2000),
          fail_count: (task.fail_count || 0) + 1,
          retry_count: newRetryCount,
          next_run_at: retryAt,
        });
        console.warn(
          `[TaskScheduler] Task ${task.id} (${task.name}) failed, retry ${newRetryCount}/${maxRetries} in 5min: ${errorMsg}`,
        );
      } else {
        // Max retries exceeded
        const isOneShotF = !task.is_recurring || task.schedule_type === 'once';
        const nextRunAt = isOneShotF
          ? null
          : computeNextRun(task.schedule_type, task.schedule_expr);

        db.updateScheduledTask(task.id, {
          status: nextRunAt ? 'active' : 'failed',
          last_run_at: finishedAt,
          last_run_status: 'failed',
          last_run_result: errorMsg.slice(0, 2000),
          fail_count: (task.fail_count || 0) + 1,
          retry_count: 0,
          next_run_at: nextRunAt,
        });
        console.error(
          `[TaskScheduler] Task ${task.id} (${task.name}) failed after ${maxRetries} retries: ${errorMsg}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Missed-task catch-up on startup
  // ---------------------------------------------------------------------------

  async checkMissedTasks(): Promise<void> {
    try {
      const db = this.ensureDb();

      // 0. Recover tasks stuck in 'running' status (app crashed during execution)
      const stuckTasks = db.listScheduledTasks({ status: 'running' });
      for (const task of stuckTasks) {
        const isOneShot = !task.is_recurring || task.schedule_type === 'once';
        const newNextRun = isOneShot
          ? null
          : computeNextRun(task.schedule_type, task.schedule_expr);

        db.updateScheduledTask(task.id, {
          status: newNextRun ? 'active' : 'completed',
          last_run_status: 'failed',
          last_run_result: 'Recovered from stuck running state (app restart)',
          retry_count: 0,
          next_run_at: newNextRun,
        });

        console.warn(
          `[TaskScheduler] Recovered stuck task#${task.id} (${task.name}) → next_run_at=${newNextRun}`,
        );
      }

      // 1. Handle missed tasks (status = 'active' but next_run_at in the past)
      const dueTasks = db.getDueScheduledTasks();

      if (dueTasks.length === 0) return;

      const now = Date.now();
      let skipped = 0;
      let queued = 0;

      for (const task of dueTasks) {
        const nextRunAt = task.next_run_at ? new Date(task.next_run_at).getTime() : now;
        const hoursAgo = (now - nextRunAt) / (1000 * 60 * 60);

        if (task.missed_policy === 'skip' || hoursAgo > (task.max_miss_hours ?? 24)) {
          // Skip: advance next_run_at to the next scheduled time
          const isOneShotM = !task.is_recurring || task.schedule_type === 'once';
          const newNextRun = isOneShotM
            ? null
            : computeNextRun(task.schedule_type, task.schedule_expr);

          db.updateScheduledTask(task.id, {
            status: newNextRun ? 'active' : 'completed',
            next_run_at: newNextRun,
          });

          // Log skipped execution
          db.insertTaskExecution({
            task_id: task.id,
            started_at: new Date().toISOString(),
            status: 'skipped',
            finished_at: new Date().toISOString(),
            result_summary: `Missed by ${hoursAgo.toFixed(1)}h (policy: ${task.missed_policy})`,
          });

          skipped++;
        } else {
          // Leave for the next poll cycle to pick up (catch_up_latest policy)
          queued++;
        }
      }

      if (stuckTasks.length > 0 || skipped > 0 || queued > 0) {
        console.log(
          `[TaskScheduler] Missed-task check: ${stuckTasks.length} recovered, ${skipped} skipped, ${queued} queued for execution`,
        );
      }
    } catch (err: any) {
      console.error('[TaskScheduler] checkMissedTasks error:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Remind-at reminders from extracted_items
  // ---------------------------------------------------------------------------

  private async checkReminders(db: VoiceBrainDB): Promise<void> {
    try {
      const reminders = db.getActiveReminders();
      if (reminders.length === 0) return;

      console.log(`[TaskScheduler] checkReminders: found ${reminders.length} due reminder(s)`);
      for (const r of reminders) {
        console.log(`[TaskScheduler]   reminder#${r.id} "${r.content}" remind_at=${r.remind_at}`);
        db.markReminderSent(r.id);
      }
      // Note: actual message delivery happens via scheduled_task → actionTodoReminder
      // This method handles items that only have remind_at but no corresponding scheduled_task
    } catch (err: any) {
      console.warn('[TaskScheduler] checkReminders error:', err.message);
    }
  }
}
