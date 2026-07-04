import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { requireId, requireString, requireEnum, optionalString, ValidationError } from './validate';
import { VoiceBrainDB } from '../db/database';
import { getDbPath } from '../paths';
import { computeNextRun, ScheduleParser } from '../scheduler/schedule-parser';
import { createLLMClient, getLLMModel } from '../llm/create-client';
import { loadSettings } from '../settings';
import { PREDEFINED_ACTIONS } from '../scheduler/predefined-actions';

const VALID_TASK_TYPES = ['predefined', 'prompt', 'report', 'extraction', 'reminder', 'custom'] as const;
const VALID_SCHEDULE_TYPES = ['cron', 'interval', 'once'] as const;

export function registerSchedulerHandlers(_ctx: IpcContext): void {
  // ─── scheduler:create ─────────────────────────────────────
  ipcMain.handle('scheduler:create', async (_event, params: any) => {
    if (!params || typeof params !== 'object') {
      throw new ValidationError('params must be an object');
    }

    const name = requireString(params.name, 'name', 200);
    const taskType = requireEnum(params.task_type, [...VALID_TASK_TYPES], 'task_type');
    const action = requireString(params.action, 'action', 2000);
    const scheduleType = requireEnum(params.schedule_type, [...VALID_SCHEDULE_TYPES], 'schedule_type');
    const description = optionalString(params.description, 'description', 2000);
    const actionParams = optionalString(params.action_params, 'action_params', 10000);
    const scheduleExpr = optionalString(params.schedule_expr, 'schedule_expr', 500);
    const scheduleDisplay = optionalString(params.schedule_display, 'schedule_display', 500);

    // Compute next run time
    const nextRunAt = scheduleExpr
      ? computeNextRun(scheduleType, scheduleExpr)
      : null;

    const db = new VoiceBrainDB(getDbPath());
    try {
      const id = db.insertScheduledTask({
        name,
        description,
        task_type: taskType,
        action,
        action_params: actionParams,
        schedule_type: scheduleType,
        schedule_expr: scheduleExpr,
        schedule_display: scheduleDisplay,
        is_recurring: params.is_recurring,
        permission_level: params.permission_level,
        allowed_tools: params.allowed_tools,
        channels_override: params.channels_override,
        missed_policy: params.missed_policy,
        max_miss_hours: params.max_miss_hours,
        max_retries: params.max_retries,
        created_by: params.created_by,
        next_run_at: nextRunAt ?? undefined,
      });
      return db.getScheduledTask(id);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:update ─────────────────────────────────────
  ipcMain.handle('scheduler:update', async (_event, id: unknown, params: any) => {
    const taskId = requireId(id, 'id');
    if (!params || typeof params !== 'object') {
      throw new ValidationError('params must be an object');
    }

    const db = new VoiceBrainDB(getDbPath());
    try {
      const existing = db.getScheduledTask(taskId);
      if (!existing) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }

      // Build update payload from allowed fields
      const updates: Record<string, any> = {};
      if (params.name !== undefined) updates.name = requireString(params.name, 'name', 200);
      if (params.description !== undefined) updates.description = params.description ?? null;
      if (params.task_type !== undefined) updates.task_type = requireEnum(params.task_type, [...VALID_TASK_TYPES], 'task_type');
      if (params.action !== undefined) updates.action = requireString(params.action, 'action', 2000);
      if (params.action_params !== undefined) updates.action_params = params.action_params ?? null;
      if (params.schedule_type !== undefined) updates.schedule_type = requireEnum(params.schedule_type, [...VALID_SCHEDULE_TYPES], 'schedule_type');
      if (params.schedule_expr !== undefined) updates.schedule_expr = params.schedule_expr ?? null;
      if (params.schedule_display !== undefined) updates.schedule_display = params.schedule_display ?? null;
      if (params.is_recurring !== undefined) updates.is_recurring = params.is_recurring ? 1 : 0;
      if (params.permission_level !== undefined) updates.permission_level = params.permission_level;
      if (params.allowed_tools !== undefined) updates.allowed_tools = params.allowed_tools ?? null;
      if (params.channels_override !== undefined) updates.channels_override = params.channels_override ?? null;
      if (params.missed_policy !== undefined) updates.missed_policy = params.missed_policy;
      if (params.max_miss_hours !== undefined) updates.max_miss_hours = params.max_miss_hours;
      if (params.max_retries !== undefined) updates.max_retries = params.max_retries;

      // Recompute nextRunAt if schedule changed
      if (params.schedule_type !== undefined || params.schedule_expr !== undefined) {
        const sType = updates.schedule_type ?? existing.schedule_type;
        const sExpr = updates.schedule_expr ?? existing.schedule_expr;
        if (sExpr) {
          const nextRunAt = computeNextRun(sType, sExpr);
          if (nextRunAt) updates.next_run_at = nextRunAt;
        }
      }

      db.updateScheduledTask(taskId, updates);
      return db.getScheduledTask(taskId);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:delete ─────────────────────────────────────
  ipcMain.handle('scheduler:delete', async (_event, id: unknown) => {
    const taskId = requireId(id, 'id');
    const db = new VoiceBrainDB(getDbPath());
    try {
      const existing = db.getScheduledTask(taskId);
      if (!existing) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }
      db.deleteScheduledTask(taskId);
      return { success: true };
    } finally {
      db.close();
    }
  });

  // ─── scheduler:list ───────────────────────────────────────
  ipcMain.handle('scheduler:list', async (_event, filter?: any) => {
    const db = new VoiceBrainDB(getDbPath());
    try {
      return db.listScheduledTasks(filter);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:get ────────────────────────────────────────
  ipcMain.handle('scheduler:get', async (_event, id: unknown) => {
    const taskId = requireId(id, 'id');
    const db = new VoiceBrainDB(getDbPath());
    try {
      const task = db.getScheduledTask(taskId);
      if (!task) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }
      return task;
    } finally {
      db.close();
    }
  });

  // ─── scheduler:pause ──────────────────────────────────────
  ipcMain.handle('scheduler:pause', async (_event, id: unknown) => {
    const taskId = requireId(id, 'id');
    const db = new VoiceBrainDB(getDbPath());
    try {
      const existing = db.getScheduledTask(taskId);
      if (!existing) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }
      db.updateScheduledTask(taskId, { status: 'paused' });
      return db.getScheduledTask(taskId);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:resume ─────────────────────────────────────
  ipcMain.handle('scheduler:resume', async (_event, id: unknown) => {
    const taskId = requireId(id, 'id');
    const db = new VoiceBrainDB(getDbPath());
    try {
      const existing = db.getScheduledTask(taskId);
      if (!existing) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }

      const updates: Record<string, any> = {
        status: 'active',
        retry_count: 0,
      };

      // Recompute nextRunAt from schedule
      if (existing.schedule_expr) {
        const nextRunAt = computeNextRun(existing.schedule_type, existing.schedule_expr);
        if (nextRunAt) updates.next_run_at = nextRunAt;
      }

      db.updateScheduledTask(taskId, updates);
      return db.getScheduledTask(taskId);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:runNow ─────────────────────────────────────
  ipcMain.handle('scheduler:runNow', async (_event, id: unknown) => {
    const taskId = requireId(id, 'id');
    const db = new VoiceBrainDB(getDbPath());
    try {
      const existing = db.getScheduledTask(taskId);
      if (!existing) {
        throw new ValidationError(`Scheduled task ${taskId} not found`);
      }
      db.updateScheduledTask(taskId, {
        next_run_at: new Date().toISOString(),
        status: 'active',
      });
      return db.getScheduledTask(taskId);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:history ────────────────────────────────────
  ipcMain.handle('scheduler:history', async (_event, taskId: unknown, limit?: unknown) => {
    const id = requireId(taskId, 'taskId');
    const maxResults = typeof limit === 'number' && limit > 0 ? limit : 20;
    const db = new VoiceBrainDB(getDbPath());
    try {
      return db.getTaskExecutions(id, maxResults);
    } finally {
      db.close();
    }
  });

  // ─── scheduler:listActions ────────────────────────────────
  // Single source of truth for the predefined-action list. The frontend
  // (Scheduler page + task modal) fetches this instead of hardcoding the list,
  // so adding/removing an action requires no renderer change.
  ipcMain.handle('scheduler:listActions', async () => {
    return PREDEFINED_ACTIONS.map((a) => ({ name: a.name, label_zh: a.label_zh, label_en: a.label_en }));
  });

  // ─── scheduler:parseSchedule ──────────────────────────────
  ipcMain.handle('scheduler:parseSchedule', async (_event, text: unknown) => {
    const input = requireString(text, 'text', 500);
    const settings = loadSettings();
    const llm = createLLMClient(settings);
    const model = getLLMModel(settings);
    const parser = new ScheduleParser(llm, model);
    return parser.parse(input);
  });
}
