import { CronExpressionParser } from 'cron-parser';
import type { LLMClient } from '../llm/llm-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSchedule {
  type: 'cron' | 'interval' | 'once';
  /** cron: 5-field expression; interval: minutes as string; once: ISO datetime */
  expr: string;
  /** Human-readable description */
  display: string;
  /** ISO string of next execution time, or null if already past / not computable */
  nextRunAt: string | null;
}

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

/**
 * Compute the next execution time for a given schedule type + expression.
 * @param type  'cron' | 'interval' | 'once'
 * @param expr  Cron expression / minutes string / ISO datetime
 * @param after Base time (defaults to now)
 * @returns ISO datetime string, or null if the schedule is in the past / invalid.
 */
export function computeNextRun(
  type: string,
  expr: string,
  after?: Date,
): string | null {
  const base = after ?? new Date();

  try {
    switch (type) {
      case 'cron': {
        const parsed = CronExpressionParser.parse(expr, { currentDate: base });
        return parsed.next().toISOString();
      }
      case 'interval': {
        const minutes = parseInt(expr, 10);
        if (isNaN(minutes) || minutes <= 0) return null;
        return new Date(base.getTime() + minutes * 60_000).toISOString();
      }
      case 'once': {
        const target = new Date(expr);
        if (isNaN(target.getTime())) return null;
        return target.getTime() > base.getTime() ? target.toISOString() : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM system prompt
// ---------------------------------------------------------------------------

const SCHEDULE_SYSTEM_PROMPT = `You are a schedule parser. Convert the user's natural language schedule description into a structured JSON object.

Output JSON format (no extra keys):
{"type": "<cron|interval|once>", "expr": "<expression>", "display": "<human-readable description>"}

Rules:

1. **cron** — Standard 5-field cron: minute hour day-of-month month day-of-week
   - Fields: min(0-59) hour(0-23) dom(1-31) mon(1-12) dow(0-7, 0&7=Sunday)
   - "工作日" or "weekdays" → dow = 1-5
   - "周末" or "weekends" → dow = 0,6
   - Examples:
     - "每天早上9点" → {"type":"cron","expr":"0 9 * * *","display":"每天 09:00"}
     - "每周一上午10点" → {"type":"cron","expr":"0 10 * * 1","display":"每周一 10:00"}
     - "工作日下午6点" → {"type":"cron","expr":"0 18 * * 1-5","display":"工作日 18:00"}
     - "每月1号早上8点" → {"type":"cron","expr":"0 8 1 * *","display":"每月1号 08:00"}
     - "每天下午2点30" → {"type":"cron","expr":"30 14 * * *","display":"每天 14:30"}

2. **interval** — Recurring interval in minutes (as a string).
   - "每3小时" → {"type":"interval","expr":"180","display":"每3小时"}
   - "每30分钟" → {"type":"interval","expr":"30","display":"每30分钟"}
   - "每2小时" → {"type":"interval","expr":"120","display":"每2小时"}

3. **once** — One-time execution, expr is ISO 8601 datetime.
   - "明天下午3点" → compute the actual ISO date, e.g. {"type":"once","expr":"2026-03-11T15:00:00","display":"明天 15:00"}
   - "3月15日上午10点" → {"type":"once","expr":"2026-03-15T10:00:00","display":"3月15日 10:00"}
   - "3分钟后" → compute current_time + 3min, e.g. {"type":"once","expr":"2026-03-10T14:03:00","display":"3分钟后"}
   - "1小时后" → compute current_time + 1h, e.g. {"type":"once","expr":"2026-03-10T15:00:00","display":"1小时后"}
   - "半小时后" → compute current_time + 30min
   - **Any relative time like "X分钟后", "X小时后" is ALWAYS type "once", NOT "interval".**

Important:
- Always use 24-hour time in the cron expression.
- "display" should be concise Chinese or match the input language.
- For "once", use the current year unless specified otherwise. Current time context will be in the user prompt.
- Output valid JSON only. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// ScheduleParser
// ---------------------------------------------------------------------------

export class ScheduleParser {
  constructor(
    private llm: LLMClient,
    private model: string,
  ) {}

  /**
   * Parse a natural-language schedule description into a ParsedSchedule.
   */
  async parse(input: string): Promise<ParsedSchedule> {
    const now = new Date();
    const prompt = `当前时间: ${now.toISOString()}\n\n请解析以下调度描述:\n${input}`;

    const result = await this.llm.generateJSON<{
      type: 'cron' | 'interval' | 'once';
      expr: string;
      display: string;
    }>({
      model: this.model,
      system: SCHEDULE_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      format: 'json',
      think: false,
    });

    const { type, expr, display } = result;
    if (!type || !expr) {
      throw new Error(`ScheduleParser: LLM returned incomplete result: ${JSON.stringify(result)}`);
    }
    const nextRunAt = computeNextRun(type, expr);

    return { type, expr, display: display || expr, nextRunAt };
  }
}
