/**
 * Built-in tool definitions and executors for the VoiceBrain Agent platform.
 * Registers 15 internal tools into the ToolRegistry.
 */

import type { VoiceBrainDB } from '../db/database';
import type { ToolRegistry, ToolResult } from './tool-registry';
import type { MemoryManager } from './memory-manager';
import type { TextOptimizer } from '../llm/text-optimizer';
import type { QueryEngine } from '../rag/query-engine';
import { formatLocalDate } from '../utils/date';
import type { AppSettings } from '../settings';
import type { MessageRouter } from '../channels/router';
import { getStr } from '../i18n';

export interface ToolContext {
  getDb: () => VoiceBrainDB;
  getQueryEngine: () => QueryEngine | null;
  getMemoryManager: () => MemoryManager | null;
  getTextOptimizer: () => TextOptimizer | null;
  getSettings: () => AppSettings;
  getMessageRouter?: () => MessageRouter | null;
}

// ─── Helper ──────────────────────────────────────────────

function ok(data: any): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, error };
}

function todayStr(): string {
  return formatLocalDate();
}

/** Compute Monday–Sunday range for a given date (defaults to today). */
function weekRange(dateStr?: string): { start: string; end: string } {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const day = d.getDay(); // 0=Sun
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: formatLocalDate(monday),
    end: formatLocalDate(sunday),
  };
}

// ─── Registration ────────────────────────────────────────

export function registerBuiltinTools(registry: ToolRegistry, ctx: ToolContext): void {
  // ── 1. create_todo ──────────────────────────────────────
  registry.register(
    {
      name: 'create_todo',
      description: getStr('tool.create_todo.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: getStr('tool.create_todo.param_content') as string },
          due_date: { type: 'string', description: getStr('tool.create_todo.param_due_date') as string },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: getStr('tool.create_todo.param_priority') as string,
          },
          assignee: { type: 'string', description: getStr('tool.create_todo.param_assignee') as string },
          remind_at: {
            type: 'string',
            description: getStr('tool.create_todo.param_remind_at') as string,
          },
        },
        required: ['content'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const id = db.insertExtractedItem({
          type: 'todo',
          content: params.content,
          due_date: params.due_date,
          priority: params.priority || 'normal',
          assignee: params.assignee,
          status: 'active',
          source: 'agent',
        });
        // Set remind_at if provided (separate update because insertExtractedItem doesn't accept remind_at)
        if (params.remind_at) {
          db.updateExtractedItem(id, { remind_at: params.remind_at });
        }
        return ok({ id, message: getStr('tool.create_todo.success')(params.content) });
      } catch (err) {
        return fail(getStr('tool.create_todo.error')(String(err)));
      }
    },
  );

  // ── 2. complete_todo ────────────────────────────────────
  registry.register(
    {
      name: 'complete_todo',
      description: getStr('tool.complete_todo.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'number', description: getStr('tool.complete_todo.param_todo_id') as string },
          content_match: {
            type: 'string',
            description: getStr('tool.complete_todo.param_content_match') as string,
          },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();

        if (params.todo_id) {
          db.updateExtractedItemStatus(params.todo_id, 'completed');
          return ok({ id: params.todo_id, message: getStr('tool.complete_todo.success')(params.todo_id) });
        }

        if (params.content_match) {
          const todos = db.getExtractedItemsByType('todo').filter(
            (t) => t.status === 'active' && t.content.includes(params.content_match),
          );
          if (todos.length === 0) {
            return fail(getStr('tool.complete_todo.not_found')(params.content_match));
          }
          if (todos.length > 1) {
            const list = todos.map((t) => `#${t.id}: ${t.content}`).join('\n');
            return fail(getStr('tool.complete_todo.ambiguous')(list));
          }
          db.updateExtractedItemStatus(todos[0].id, 'completed');
          return ok({ id: todos[0].id, message: getStr('tool.complete_todo.success_by_content')(todos[0].content) });
        }

        return fail(getStr('tool.complete_todo.missing_param') as string);
      } catch (err) {
        return fail(getStr('tool.complete_todo.error')(String(err)));
      }
    },
  );

  // ── 3. delete_items ─────────────────────────────────────
  registry.register(
    {
      name: 'delete_items',
      description: getStr('tool.delete_items.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'number', description: getStr('tool.delete_items.param_item_id') as string },
          item_type: {
            type: 'string',
            enum: ['todo', 'memo', 'decision', 'contact', 'all'],
            description: getStr('tool.delete_items.param_item_type') as string,
          },
          content_match: { type: 'string', description: getStr('tool.delete_items.param_content_match') as string },
          status: {
            type: 'string',
            enum: ['active', 'completed', 'all'],
            description: getStr('tool.delete_items.param_status') as string,
          },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();

        // Mode 1: delete by ID
        if (params.item_id) {
          db.deleteExtractedItem(params.item_id);
          return ok({ count: 1, message: getStr('tool.delete_items.success_single')(params.item_id) });
        }

        // Mode 2 & 3: filter then delete
        let items = params.item_type && params.item_type !== 'all'
          ? db.getExtractedItemsByType(params.item_type)
          : db.getAllExtractedItems();

        if (params.status && params.status !== 'all') {
          items = items.filter((t: any) => t.status === params.status);
        }
        if (params.content_match) {
          const kw = params.content_match.toLowerCase();
          items = items.filter((t: any) => t.content?.toLowerCase().includes(kw));
        }

        if (items.length === 0) {
          return ok({ count: 0, message: getStr('tool.delete_items.not_found') as string });
        }

        for (const item of items) {
          db.deleteExtractedItem(item.id);
        }
        return ok({ count: items.length, message: getStr('tool.delete_items.success_batch')(items.length) });
      } catch (err) {
        return fail(getStr('tool.delete_items.error')(String(err)));
      }
    },
  );

  // ── 4. list_items ───────────────────────────────────────
  registry.register(
    {
      name: 'list_items',
      description: getStr('tool.list_items.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          item_type: {
            type: 'string',
            enum: ['todo', 'memo', 'decision', 'contact', 'all'],
            description: getStr('tool.list_items.param_item_type') as string,
          },
          status: {
            type: 'string',
            enum: ['active', 'completed', 'all'],
            description: getStr('tool.list_items.param_status') as string,
          },
          content_match: { type: 'string', description: getStr('tool.list_items.param_content_match') as string },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const status = params.status || 'active';
        const itemType = params.item_type || 'all';
        let items = itemType === 'all'
          ? db.getAllExtractedItems()
          : db.getExtractedItemsByType(itemType);

        if (status !== 'all') {
          items = items.filter((t: any) => t.status === status);
        }
        if (params.content_match) {
          const kw = params.content_match.toLowerCase();
          items = items.filter((t: any) => t.content?.toLowerCase().includes(kw));
        }

        const list = items.map((t: any) => ({
          id: t.id,
          type: t.type,
          content: t.content,
          status: t.status,
          due_date: t.due_date,
          priority: t.priority,
          assignee: t.assignee,
          remind_at: t.remind_at,
        }));

        return ok({
          count: list.length,
          items: list,
          message: list.length > 0
            ? getStr('tool.list_items.success')(list.length)
            : getStr('tool.list_items.empty') as string,
        });
      } catch (err) {
        return fail(getStr('tool.list_items.error')(String(err)));
      }
    },
  );

  // ── 5. create_memo ──────────────────────────────────────
  registry.register(
    {
      name: 'create_memo',
      description: getStr('tool.create_memo.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: getStr('tool.create_memo.param_content') as string },
        },
        required: ['content'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const id = db.insertExtractedItem({
          type: 'memo',
          content: params.content,
          status: 'active',
          source: 'agent',
        });
        return ok({ id, message: getStr('tool.create_memo.success')(params.content) });
      } catch (err) {
        return fail(getStr('tool.create_memo.error')(String(err)));
      }
    },
  );

  // ── 6. generate_report ──────────────────────────────────
  registry.register(
    {
      name: 'generate_report',
      description: getStr('tool.generate_report.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['daily', 'weekly'],
            description: getStr('tool.generate_report.param_type') as string,
          },
          date: {
            type: 'string',
            description: getStr('tool.generate_report.param_date') as string,
          },
        },
        required: ['type'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const optimizer = ctx.getTextOptimizer();
        if (!optimizer) {
          return fail(getStr('tool.generate_report.no_optimizer') as string);
        }
        const db = ctx.getDb();
        const date = params.date || todayStr();

        if (params.type === 'daily') {
          // Get segments for the date
          const segments = db.getSegmentsByDate(date);
          if (segments.length === 0) {
            return ok({ message: getStr('tool.generate_report.no_data')(date) });
          }
          const mapped = segments.map((s) => ({
            start: s.start_time,
            end: s.end_time,
            speaker: s.speaker_name || 'Unknown',
            text: s.clean_text || s.raw_text || '',
          }));
          const result = await optimizer.generateDailySummary(date, mapped);
          return ok({ date, report: result, message: getStr('tool.generate_report.daily_done')(date) });
        }

        if (params.type === 'weekly') {
          const range = weekRange(date);
          const dailySummaries = db.getDailySummariesInRange(range.start, range.end);
          if (dailySummaries.length === 0) {
            return ok({
              message: getStr('tool.generate_report.no_weekly_data')(range.start, range.end),
            });
          }
          const mapped = dailySummaries.map((ds) => {
            let todos: any[] = [];
            let decisions: string[] = [];
            if (ds.key_events_json) {
              try {
                const ke = JSON.parse(ds.key_events_json);
                todos = ke.todos || [];
                decisions = ke.decisions || [];
              } catch { /* ignore */ }
            }
            return {
              date: ds.date,
              summary: ds.summary_text || '',
              todos,
              decisions,
            };
          });
          const result = await optimizer.generateWeeklySummary(range.start, range.end, mapped);
          return ok({
            start_date: range.start,
            end_date: range.end,
            report: result,
            message: getStr('tool.generate_report.weekly_done')(range.start, range.end),
          });
        }

        return fail(getStr('tool.generate_report.unsupported_type')(params.type));
      } catch (err) {
        return fail(getStr('tool.generate_report.error')(String(err)));
      }
    },
  );

  // ── 7. query_knowledge ──────────────────────────────────
  registry.register(
    {
      name: 'query_knowledge',
      description: getStr('tool.query_knowledge.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: getStr('tool.query_knowledge.param_question') as string },
        },
        required: ['question'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const qe = ctx.getQueryEngine();
        if (!qe) {
          return fail(getStr('tool.query_knowledge.no_engine') as string);
        }
        const result = await qe.query(params.question);
        return ok({
          answer: result.answer,
          sources: result.sources,
          message: result.answer,
        });
      } catch (err) {
        return fail(getStr('tool.query_knowledge.error')(String(err)));
      }
    },
  );

  // ── 8. update_memory ────────────────────────────────────
  registry.register(
    {
      name: 'update_memory',
      description: getStr('tool.update_memory.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: getStr('tool.update_memory.param_fact') as string },
          category: {
            type: 'string',
            enum: ['personal', 'preference', 'work', 'relationship', 'health', 'other'],
            description: getStr('tool.update_memory.param_category') as string,
          },
        },
        required: ['fact'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const mm = ctx.getMemoryManager();
        if (!mm) {
          return fail(getStr('tool.update_memory.no_manager') as string);
        }
        const category = params.category || 'other';
        const id = await mm.addFact(params.fact, category, 0.9, []);
        return ok({ id, message: getStr('tool.update_memory.success')(params.fact) });
      } catch (err) {
        return fail(getStr('tool.update_memory.error')(String(err)));
      }
    },
  );

  // ── 9. list_memories ────────────────────────────────────
  registry.register(
    {
      name: 'list_memories',
      description: getStr('tool.list_memories.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: getStr('tool.list_memories.param_query') as string,
          },
          category: {
            type: 'string',
            enum: ['personal', 'preference', 'work', 'relationship', 'health', 'other'],
            description: getStr('tool.list_memories.param_category') as string,
          },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        let memories = db.getAllMemories();

        if (params.category) {
          memories = memories.filter((m: any) => m.category === params.category);
        }
        if (params.query) {
          const kw = params.query.toLowerCase();
          memories = memories.filter((m: any) => m.fact?.toLowerCase().includes(kw));
        }

        const list = memories.map((m: any) => ({
          id: m.id,
          fact: m.fact,
          category: m.category,
          layer: m.layer,
          confidence: m.confidence,
          last_seen: m.last_seen,
        }));

        return ok({
          count: list.length,
          memories: list,
          message: list.length > 0
            ? getStr('tool.list_memories.success')(list.length)
            : getStr('tool.list_memories.empty') as string,
        });
      } catch (err) {
        return fail(getStr('tool.list_memories.error')(String(err)));
      }
    },
  );

  // ── 10. search_recordings ───────────────────────────────
  registry.register(
    {
      name: 'search_recordings',
      description: getStr('tool.search_recordings.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: getStr('tool.search_recordings.param_keyword') as string },
          limit: { type: 'number', description: getStr('tool.search_recordings.param_limit') as string },
        },
        required: ['keyword'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const limit = params.limit || 10;
        // LLM may use "keyword", "query", or "search" as the param name
        const rawKeyword = params.keyword || params.query || params.search || '';
        if (!rawKeyword) {
          return fail('缺少搜索关键词参数 (keyword)');
        }
        // Wrap in double-quotes for safe FTS5 MATCH (handles CJK, special chars)
        const safeKeyword = `"${rawKeyword.replace(/"/g, '""')}"`;
        const results = db.searchSegments(safeKeyword);
        const limited = results.slice(0, limit);

        const list = limited.map((r: any) => ({
          id: r.id,
          speaker: r.speaker_name || 'Unknown',
          text: r.clean_text || r.raw_text || '',
          recording: r.recording_name || r.file_name || '',
          start_time: r.start_time,
        }));

        return ok({
          count: list.length,
          total: results.length,
          results: list,
          message:
            list.length > 0
              ? getStr('tool.search_recordings.success')(results.length, list.length)
              : getStr('tool.search_recordings.not_found')(params.keyword),
        });
      } catch (err) {
        console.error('[search_recordings] Error:', err);
        return fail(getStr('tool.search_recordings.error')(String(err)));
      }
    },
  );

  // ── 10b. lookup_person ─────────────────────────────────
  registry.register(
    {
      name: 'lookup_person',
      description: getStr('tool.lookup_person.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: getStr('tool.lookup_person.param_name') as string },
        },
        required: ['name'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const queryName = params.name || params.keyword || params.query || '';
        if (!queryName) {
          return fail('缺少人物姓名参数 (name)');
        }

        // Try exact match first, then fuzzy (LIKE)
        let person = db.getPersonByName(queryName);
        if (!person) {
          const all = db.getAllPersons();
          person = all.find((p: any) => p.name && p.name.includes(queryName)) as any;
          if (!person) {
            // Also try if queryName is a substring of any person name, or vice versa
            person = all.find((p: any) => p.name && queryName.includes(p.name)) as any;
          }
        }

        if (!person) {
          return ok({
            found: false,
            message: (getStr('tool.lookup_person.not_found') as Function)(queryName),
          });
        }

        // Get related content
        const contents = db.getContentByPerson(person.id, 10);
        const recentTexts = contents
          .map((c: any) => c.clean_text || c.raw_text || '')
          .filter(Boolean)
          .slice(0, 5);

        // Get relationships
        const relationships = db.getPersonRelationships(person.id);
        const relList = relationships.map((r: any) => ({
          related_person: r.related_person_name || r.mentioned_name || 'Unknown',
          relationship: r.relationship || '',
          context: r.context || '',
        }));

        return ok({
          found: true,
          person: {
            id: person.id,
            name: person.name,
            gender: person.gender || null,
            company: person.company || null,
            title: person.title || null,
            tags: person.tags || '[]',
            profile: person.profile_markdown || null,
          },
          recent_content: recentTexts,
          relationships: relList,
          content_count: contents.length,
        });
      } catch (err) {
        console.error('[lookup_person] Error:', err);
        return fail((getStr('tool.lookup_person.error') as Function)(String(err)));
      }
    },
  );

  // ── 11. set_reminder ────────────────────────────────────
  registry.register(
    {
      name: 'set_reminder',
      description: getStr('tool.set_reminder.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: getStr('tool.set_reminder.param_content') as string,
          },
          schedule: {
            type: 'string',
            description: getStr('tool.set_reminder.param_schedule') as string,
          },
        },
        required: ['content', 'schedule'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const { ScheduleParser } = await import('../scheduler/schedule-parser');
        const { createLLMClient, getLLMModel } = await import('../llm/create-client');
        const settings = ctx.getSettings();
        const llmClient = createLLMClient(settings);
        const model = getLLMModel(settings);
        const parser = new ScheduleParser(llmClient, model);
        const parsed = await parser.parse(params.schedule);

        const db = ctx.getDb();
        const id = db.insertExtractedItem({
          type: 'todo',
          content: params.content,
          status: 'active',
          source: 'agent',
        });
        const remindAt = parsed.nextRunAt ?? parsed.display;
        db.updateExtractedItem(id, { remind_at: remindAt });

        // Reminders from set_reminder are always one-shot, regardless of parser type.
        // Recurring schedules should be created via create_scheduled_task instead.
        const isRecurring = parsed.type === 'cron' || parsed.type === 'interval';
        const srcChannel = params._sourceChannel;
        const chOverride = srcChannel && srcChannel !== 'app' && srcChannel !== 'scheduler'
          ? JSON.stringify([srcChannel])
          : undefined;
        db.insertScheduledTask({
          name: params.content.length > 60 ? params.content.slice(0, 57) + '...' : params.content,
          description: params.content,
          task_type: 'predefined',
          action: 'todo_reminder',
          action_params: JSON.stringify({ item_id: id, content: params.content, one_shot: true }),
          schedule_type: isRecurring ? parsed.type : 'once',
          schedule_expr: parsed.expr,
          schedule_display: parsed.display,
          is_recurring: isRecurring,
          permission_level: 'readonly',
          created_by: 'agent',
          next_run_at: parsed.nextRunAt ?? undefined,
          channels_override: chOverride,
        });

        return ok({
          id,
          schedule: parsed.display,
          next_run: parsed.nextRunAt,
          is_recurring: isRecurring,
          message: getStr('tool.set_reminder.success')(params.content, parsed.display),
        });
      } catch (err) {
        return fail(getStr('tool.set_reminder.error')(String(err)));
      }
    },
  );

  // ── 12. list_reminders ──────────────────────────────────
  registry.register(
    {
      name: 'list_reminders',
      description: getStr('tool.list_reminders.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          include_sent: {
            type: 'boolean',
            description: getStr('tool.list_reminders.param_include_sent') as string,
          },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();

        if (params.include_sent) {
          // Return all items that have a remind_at set
          const all = db.getAllExtractedItems().filter((item) => item.remind_at);
          const list = all.map((item) => ({
            id: item.id,
            content: item.content,
            remind_at: item.remind_at,
            status: item.status,
            reminder_sent: !!item.reminder_sent,
          }));
          return ok({
            count: list.length,
            reminders: list,
            message: list.length > 0
              ? getStr('tool.list_reminders.success_all')(list.length)
              : getStr('tool.list_reminders.empty_all') as string,
          });
        }

        // Default: only active, unsent reminders
        const reminders = db.getActiveReminders();
        const list = reminders.map((item: any) => ({
          id: item.id,
          content: item.content,
          remind_at: item.remind_at,
          status: item.status,
        }));

        // Also include upcoming reminders (not yet triggered)
        const upcoming = db.getAllExtractedItems().filter(
          (item) => item.remind_at && item.status === 'active' && !item.reminder_sent,
        );
        const upcomingList = upcoming
          .filter((item) => !list.some((r: any) => r.id === item.id))
          .map((item) => ({
            id: item.id,
            content: item.content,
            remind_at: item.remind_at,
            status: item.status,
          }));

        const merged = [...list, ...upcomingList];
        return ok({
          count: merged.length,
          reminders: merged,
          message: merged.length > 0
            ? getStr('tool.list_reminders.success')(merged.length)
            : getStr('tool.list_reminders.empty') as string,
        });
      } catch (err) {
        return fail(getStr('tool.list_reminders.error')(String(err)));
      }
    },
  );

  // ── 13. create_scheduled_task ──────────────────────────
  registry.register(
    {
      name: 'create_scheduled_task',
      description: getStr('tool.create_scheduled_task.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: getStr('tool.create_scheduled_task.param_name') as string },
          task_type: {
            type: 'string',
            enum: ['predefined', 'prompt'],
            description: getStr('tool.create_scheduled_task.param_task_type') as string,
          },
          action: {
            type: 'string',
            description: getStr('tool.create_scheduled_task.param_action') as string,
          },
          schedule: {
            type: 'string',
            description: getStr('tool.create_scheduled_task.param_schedule') as string,
          },
          permission_level: {
            type: 'string',
            enum: ['readonly', 'readwrite'],
            description: getStr('tool.create_scheduled_task.param_permission_level') as string,
          },
        },
        required: ['name', 'task_type', 'action', 'schedule'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const { ScheduleParser } = await import('../scheduler/schedule-parser');
        const { createLLMClient, getLLMModel } = await import('../llm/create-client');
        const settings = ctx.getSettings();
        const llmClient = createLLMClient(settings);
        const model = getLLMModel(settings);
        const parser = new ScheduleParser(llmClient, model);
        const parsed = await parser.parse(params.schedule);

        const db = ctx.getDb();
        // Route result back to the channel that created the task
        const sourceChannel = params._sourceChannel;
        const channelsOverride = sourceChannel && sourceChannel !== 'app' && sourceChannel !== 'scheduler'
          ? JSON.stringify([sourceChannel])
          : undefined;
        const id = db.insertScheduledTask({
          name: params.name,
          task_type: params.task_type,
          action: params.action,
          schedule_type: parsed.type,
          schedule_expr: parsed.expr,
          schedule_display: parsed.display,
          is_recurring: parsed.type !== 'once',
          permission_level: params.permission_level || 'readonly',
          next_run_at: parsed.nextRunAt ?? undefined,
          created_by: 'agent',
          channels_override: channelsOverride,
        });

        return ok({
          id,
          name: params.name,
          schedule: parsed.display,
          next_run: parsed.nextRunAt,
          message: getStr('tool.create_scheduled_task.success')(params.name, parsed.display),
        });
      } catch (err) {
        return fail(getStr('tool.create_scheduled_task.error')(String(err)));
      }
    },
  );

  // ── 14. list_scheduled_tasks ─────────────────────────────
  registry.register(
    {
      name: 'list_scheduled_tasks',
      description: getStr('tool.list_scheduled_tasks.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'paused', 'all'],
            description: getStr('tool.list_scheduled_tasks.param_status') as string,
          },
        },
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const status = params.status || 'active';
        const tasks = db.listScheduledTasks({ status });

        const list = tasks.map((t: any) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          schedule: t.schedule_display || t.schedule_expr,
          type: t.task_type,
          next_run: t.next_run_at,
          last_run: t.last_run_at,
          last_status: t.last_run_status,
        }));

        return ok({
          count: list.length,
          tasks: list,
          message: list.length > 0
            ? getStr('tool.list_scheduled_tasks.success')(list.length)
            : getStr('tool.list_scheduled_tasks.empty') as string,
        });
      } catch (err) {
        return fail(getStr('tool.list_scheduled_tasks.error')(String(err)));
      }
    },
  );

  // ── 15. manage_scheduled_task ────────────────────────────
  registry.register(
    {
      name: 'manage_scheduled_task',
      description: getStr('tool.manage_scheduled_task.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: getStr('tool.manage_scheduled_task.param_id') as string },
          operation: {
            type: 'string',
            enum: ['pause', 'resume', 'delete'],
            description: getStr('tool.manage_scheduled_task.param_operation') as string,
          },
        },
        required: ['id', 'operation'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const db = ctx.getDb();
        const task = db.getScheduledTask(params.id);
        if (!task) {
          return fail(getStr('tool.manage_scheduled_task.not_found')(params.id));
        }

        switch (params.operation) {
          case 'pause':
            db.updateScheduledTask(params.id, { status: 'paused' });
            return ok({ id: params.id, status: 'paused', message: getStr('tool.manage_scheduled_task.paused')(task.name) });

          case 'resume': {
            const { computeNextRun } = await import('../scheduler/schedule-parser');
            const nextRun = computeNextRun(task.schedule_type, task.schedule_expr);
            db.updateScheduledTask(params.id, { status: 'active', next_run_at: nextRun });
            return ok({
              id: params.id,
              status: 'active',
              next_run: nextRun,
              message: getStr('tool.manage_scheduled_task.resumed')(task.name),
            });
          }

          case 'delete':
            db.deleteScheduledTask(params.id);
            return ok({ id: params.id, message: getStr('tool.manage_scheduled_task.deleted')(task.name) });

          default:
            return fail(getStr('tool.manage_scheduled_task.unsupported_op')(params.operation));
        }
      } catch (err) {
        return fail(getStr('tool.manage_scheduled_task.error')(String(err)));
      }
    },
  );

  // ── 16. send_email ─────────────────────────────────────
  registry.register(
    {
      name: 'send_email',
      description: getStr('tool.send_email.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: getStr('tool.send_email.param_to') as string,
          },
          subject: {
            type: 'string',
            description: getStr('tool.send_email.param_subject') as string,
          },
          content: { type: 'string', description: getStr('tool.send_email.param_content') as string },
        },
        required: ['content'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const settings = ctx.getSettings();
        if (!settings.emailEnabled) {
          return fail(getStr('tool.send_email.not_enabled') as string);
        }

        const router = ctx.getMessageRouter?.();
        if (!router) {
          return fail(getStr('tool.send_email.no_router') as string);
        }

        // Ignore hallucinated placeholder emails from LLM
        const isRealEmail = params.to && /^[^@]+@[^@]+\.[^@]+$/.test(params.to) && !params.to.includes('example.');
        const recipient = isRealEmail ? params.to : settings.smtpUser;
        if (!recipient) {
          return fail(getStr('tool.send_email.no_recipient') as string);
        }

        // Build email text: first line is subject (used by EmailChannel), rest is body
        const subject = params.subject || params.content.split('\n')[0].slice(0, 60) || 'DeepSeno 通知';
        const emailText = `${subject}\n\n${params.content}`;
        await router.sendText('email', recipient, emailText);

        return ok({ message: getStr('tool.send_email.success')(recipient) });
      } catch (err) {
        return fail(getStr('tool.send_email.error')(String(err)));
      }
    },
  );

  // ─── Web Search ──────────────────────────────────────────
  registry.register(
    {
      name: 'web_search',
      description: 'Search the web for current information. Use when the user asks about recent events, news, prices, weather, or anything that requires up-to-date data beyond your training knowledge.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
        },
        required: ['query'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const query = params.query;
        if (!query) return fail('Missing search query');

        // Use DuckDuckGo HTML search (no API key needed, works globally)
        const encoded = encodeURIComponent(query);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DeepSeno/1.0)',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);

        const html = await res.text();

        // Extract search results from DuckDuckGo HTML
        const results: { title: string; snippet: string; url: string }[] = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
          const url = match[1].replace(/.*uddg=([^&]+).*/, (_, u) => decodeURIComponent(u));
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          const snippet = match[3].replace(/<[^>]+>/g, '').trim();
          if (title && snippet) {
            results.push({ title, url, snippet });
          }
        }

        if (results.length === 0) {
          return ok({ message: `No results found for "${query}"`, results: [] });
        }

        console.log(`[web_search] "${query}" → ${results.length} results`);
        return ok({ query, results });
      } catch (err: any) {
        return fail(`Web search failed: ${err.message}`);
      }
    },
  );

  // web_fetch removed — replaced by MCP Fetch plugin (@modelcontextprotocol/server-fetch)

  // ─── Create PPTX ──────────────────────────────────────────
  registry.register(
    {
      name: 'create_pptx',
      description: getStr('tool.create_pptx.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: getStr('tool.create_pptx.param_title') as string },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
              },
            },
            description: getStr('tool.create_pptx.param_slides') as string,
          },
          filename: { type: 'string', description: getStr('tool.create_pptx.param_filename') as string },
          style: {
            type: 'string',
            enum: ['business', 'casual'],
            description: '文档风格。business=正式商务（简历/汇报/方案），casual=轻松简约（日报/备忘）。根据内容自动判断，不要问用户。',
          },
        },
        required: ['title', 'slides'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const { generatePptx, normalizeSlides } = await import('../document/pptx-generator');
        const settings = ctx.getSettings();
        const { getOutputDir } = await import('../paths');
        const outDir = settings.outputDir || getOutputDir();

        // Use cloud LLM for custom PPT generation if configured (any provider)
        let genCtx: { llmClient?: any; model?: string } | undefined;
        if (settings.cloudApiUrl && settings.cloudApiKey) {
          const { OpenAIClient } = await import('../llm/openai-client');
          genCtx = {
            llmClient: new OpenAIClient(settings.cloudApiUrl, settings.cloudApiKey),
            model: settings.cloudModel || settings.llmModel,
          };
        }

        const filePath = await generatePptx({
          title: params.title,
          slides: normalizeSlides(params.slides),
          style: params.style,
          filename: params.filename,
        }, outDir, genCtx);

        let fileSent = false;
        const srcChannel = params._sourceChannel;
        if (srcChannel && srcChannel !== 'app' && srcChannel !== 'scheduler') {
          const router = ctx.getMessageRouter?.();
          if (router) {
            try {
              await router.sendFile(srcChannel, params._chatId || '', filePath);
              fileSent = true;
              console.log(`[create_pptx] File sent via ${srcChannel}`);
            } catch (e: any) {
              console.warn(`[create_pptx] sendFile failed: ${e.message}`);
            }
          }
        }

        const msg = fileSent ? 'PPT 已生成并已发送给用户' : getStr('tool.create_pptx.success')(filePath);
        return ok({ path: filePath, fileSent, message: msg });
      } catch (err: any) {
        return fail(getStr('tool.create_pptx.error')(err.message));
      }
    },
  );

  // ─── Create DOCX ──────────────────────────────────────────
  registry.register(
    {
      name: 'create_docx',
      description: getStr('tool.create_docx.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: getStr('tool.create_docx.param_title') as string },
          content: { type: 'string', description: getStr('tool.create_docx.param_content') as string },
          filename: { type: 'string', description: getStr('tool.create_docx.param_filename') as string },
          style: {
            type: 'string',
            enum: ['business', 'casual'],
            description: '文档风格。business=正式商务（简历/汇报/方案），casual=轻松简约（日报/备忘）。根据内容自动判断，不要问用户。',
          },
        },
        required: ['title', 'content'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const { generateDocx } = await import('../document/docx-generator');
        const settings = ctx.getSettings();
        const { getOutputDir } = await import('../paths');
        const outDir = settings.outputDir || getOutputDir();

        const filePath = await generateDocx({
          title: params.title,
          content: params.content,
          style: params.style,
          filename: params.filename,
        }, outDir);

        let fileSent = false;
        const srcChannel = params._sourceChannel;
        if (srcChannel && srcChannel !== 'app' && srcChannel !== 'scheduler') {
          const router = ctx.getMessageRouter?.();
          if (router) {
            try {
              await router.sendFile(srcChannel, params._chatId || '', filePath);
              fileSent = true;
              console.log(`[create_docx] File sent via ${srcChannel}`);
            } catch (e: any) {
              console.warn(`[create_docx] sendFile failed: ${e.message}`);
            }
          }
        }

        const msg = fileSent ? 'Word 文档已生成并已发送给用户' : getStr('tool.create_docx.success')(filePath);
        return ok({ path: filePath, fileSent, message: msg });
      } catch (err: any) {
        return fail(getStr('tool.create_docx.error')(err.message));
      }
    },
  );

  // ─── Read PDF ──────────────────────────────────────────────
  registry.register(
    {
      name: 'read_pdf',
      description: getStr('tool.read_pdf.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: getStr('tool.read_pdf.param_file_path') as string },
          max_pages: { type: 'number', description: getStr('tool.read_pdf.param_max_pages') as string },
        },
        required: ['file_path'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const fs = await import('fs');
        const filePath = params.file_path;
        if (!fs.existsSync(filePath)) {
          return fail(getStr('tool.read_pdf.not_found')(filePath));
        }

        // Use require() for CJS compatibility in Electron main process
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(filePath);
        const opts: any = {};
        if (params.max_pages) {
          opts.max = params.max_pages;
        }
        const data = await pdfParse(buffer, opts);

        // Truncate to avoid token overflow (~12K chars)
        const MAX_CHARS = 12000;
        const truncated = data.text.length > MAX_CHARS;
        const text = truncated ? data.text.slice(0, MAX_CHARS) + '\n\n[... content truncated]' : data.text;

        console.log(`[read_pdf] ${filePath} → ${data.numpages} pages, ${data.text.length} chars`);
        return ok({
          text,
          pages: data.numpages,
          truncated,
          originalLength: data.text.length,
          message: getStr('tool.read_pdf.success')(data.numpages, data.text.length),
        });
      } catch (err: any) {
        return fail(getStr('tool.read_pdf.error')(err.message));
      }
    },
  );

  // ─── Create PDF ──────────────────────────────────────────────
  registry.register(
    {
      name: 'create_pdf',
      description: getStr('tool.create_pdf.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: getStr('tool.create_pdf.param_title') as string },
          content: { type: 'string', description: getStr('tool.create_pdf.param_content') as string },
          style: {
            type: 'string',
            enum: ['business', 'casual'],
            description: getStr('tool.create_pdf.param_style') as string,
          },
          filename: { type: 'string', description: getStr('tool.create_pdf.param_filename') as string },
        },
        required: ['title', 'content'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const { generatePdf } = await import('../document/pdf-generator');
        const settings = ctx.getSettings();
        const { getOutputDir } = await import('../paths');
        const outDir = settings.outputDir || getOutputDir();

        const filePath = await generatePdf({
          title: params.title,
          content: params.content,
          style: params.style,
          filename: params.filename,
        }, outDir);

        let fileSent = false;
        const srcChannel = params._sourceChannel;
        if (srcChannel && srcChannel !== 'app' && srcChannel !== 'scheduler') {
          const router = ctx.getMessageRouter?.();
          if (router) {
            try {
              await router.sendFile(srcChannel, params._chatId || '', filePath);
              fileSent = true;
              console.log(`[create_pdf] File sent via ${srcChannel}`);
            } catch (e: any) {
              console.warn(`[create_pdf] sendFile failed: ${e.message}`);
            }
          }
        }

        const msg = fileSent ? 'PDF 已生成并已发送给用户' : getStr('tool.create_pdf.success')(filePath);
        return ok({ path: filePath, fileSent, message: msg });
      } catch (err: any) {
        return fail(getStr('tool.create_pdf.error')(err.message));
      }
    },
  );

  // ─── Send File ──────────────────────────────────────────────
  registry.register(
    {
      name: 'send_file',
      description: getStr('tool.send_file.desc') as string,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: getStr('tool.send_file.param_file_path') as string },
        },
        required: ['file_path'],
      },
      source: 'builtin',
    },
    async (params) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = params.file_path;
        if (!filePath || !fs.existsSync(filePath)) {
          return fail(getStr('tool.send_file.not_found')(filePath || ''));
        }

        const srcChannel = params._sourceChannel;
        if (!srcChannel || srcChannel === 'app' || srcChannel === 'scheduler') {
          return fail(getStr('tool.send_file.no_channel') as string);
        }

        const router = ctx.getMessageRouter?.();
        if (!router) {
          return fail(getStr('tool.send_file.no_channel') as string);
        }

        await router.sendFile(srcChannel, params._chatId || '', filePath);
        const fileName = path.basename(filePath);
        console.log(`[send_file] Sent ${fileName} via ${srcChannel}`);
        return ok({ path: filePath, message: getStr('tool.send_file.success')(fileName) });
      } catch (err: any) {
        return fail(getStr('tool.send_file.error')(err.message));
      }
    },
  );

  // ── screenshot_webpage ─────────────────────────────────
  // Combines Playwright MCP navigate + take_screenshot in one step.
  // Returns the screenshot image via ToolResult.images so it can be
  // sent back to the user as a native image message.
  let playwrightBin: string | null | undefined; // resolved once, cached across calls
  registry.register(
    {
      name: 'screenshot_webpage',
      description: '截取网页截图。传入 URL，自动打开页面并截图返回。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要截图的网页 URL' },
        },
        required: ['url'],
      },
      source: 'builtin',
    },
    async (params) => {
      const { url } = params;
      if (!url) return fail('缺少 url 参数');

      try {
        // Spawn an isolated Playwright MCP process. Resolve cached bin path
        // directly because macOS GUI apps (Electron) don't have npx on PATH.
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const { findCachedNpxBin } = require('../utils/npx-resolve');

        const cachedBin = playwrightBin ?? (playwrightBin = findCachedNpxBin('@playwright/mcp'));
        const command = cachedBin ? process.execPath : 'npx';
        const args = cachedBin ? [cachedBin, '--isolated'] : ['-y', '@playwright/mcp', '--isolated'];
        const env = cachedBin
          ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          : { ...process.env };

        const transport = new StdioClientTransport({ command, args, env });
        const client = new Client({ name: 'screenshot', version: '1.0' });
        await client.connect(transport);

        try {
          // 1. Navigate
          console.log(`[screenshot_webpage] Navigating to ${url}`);
          await client.callTool({ name: 'browser_navigate', arguments: { url } });

          // 2. Take screenshot
          console.log(`[screenshot_webpage] Taking screenshot...`);
          const result = await client.callTool({ name: 'browser_take_screenshot', arguments: {} });
          const contentArr = (result.content as any[]) || [];

          // Extract image from MCP response
          const images: Array<{ data: Buffer; mimeType: string }> = [];
          for (const c of contentArr) {
            if (c.type === 'image' && c.data) {
              images.push({ data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType || 'image/png' });
            }
          }
          const textContent = contentArr
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');

          console.log(`[screenshot_webpage] Done: ${images.length} image(s), text=${textContent.length}chars`);
          return {
            success: true,
            data: textContent.slice(0, 200) || '页面已截图',
            images: images.length ? images : undefined,
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (err: any) {
        return fail(`截图异常: ${err.message}`);
      }
    },
  );

  console.log(`[BuiltinTools] Registered ${registry.size} tools`);
}
