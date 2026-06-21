import { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import type { MessageRouter } from '../channels/router';
import { loadSettings } from '../settings';
import { formatLocalDate } from '../utils/date';

export class TodoTracker {
  constructor(
    private db: VoiceBrainDB,
    private llm: LLMClient,
    private model: string,
    private router?: MessageRouter,
  ) {}

  /** Enhance a newly extracted todo: auto-detect due date, priority, assignee */
  async enhance(itemId: number): Promise<void> {
    const item = this.db.getAllExtractedItems().find(i => i.id === itemId);
    if (!item || item.type !== 'todo') return;

    const prompt = `分析以下待办事项，返回 JSON：
待办：${item.content}
今天：${formatLocalDate()}

返回格式：{"due_date":"YYYY-MM-DD或null","priority":"urgent|normal|low","assignee":"人名或null"}
规则：
- 涉及客户/外部人员=urgent，内部事务=normal，可选项=low
- "下周五" "月底前" 等模糊日期转为具体日期
- 如果提到"让XX做"，assignee=XX
只返回JSON，不要其他内容。`;

    try {
      const result = await this.llm.generate({ model: this.model, prompt, temperature: 0, think: false });
      const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] || '{}');
      const updates: Record<string, any> = {};
      if (parsed.due_date && !item.due_date) updates.due_date = parsed.due_date;
      if (parsed.priority) updates.priority = parsed.priority;
      if (parsed.assignee) updates.assignee = parsed.assignee;
      if (Object.keys(updates).length > 0) {
        this.db.updateExtractedItem(itemId, updates);
      }
    } catch {}
  }

  /** Check for auto-completion: if text mentions completing a todo */
  async checkAutoComplete(cleanText: string): Promise<void> {
    const activeTodos = this.db.getExtractedItemsByType('todo')
      .filter((t: any) => t.status === 'active');
    if (activeTodos.length === 0) return;

    const todoList = activeTodos.slice(0, 20)
      .map((t: any, i: number) => `${i + 1}. [ID:${t.id}] ${t.content}`)
      .join('\n');

    const prompt = `以下是当前活跃的待办事项：
${todoList}

以下是最新的语音内容：
"${cleanText.slice(0, 500)}"

如果语音中提到完成了某个待办（如"XX已经做完了""已经回复了XX"），返回该待办的ID。
格式：{"completed_ids":[1,2]} 或 {"completed_ids":[]}
只返回JSON。`;

    try {
      const result = await this.llm.generate({ model: this.model, prompt, temperature: 0, think: false });
      const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] || '{}');
      for (const id of parsed.completed_ids || []) {
        this.db.updateExtractedItemStatus(id, 'completed');
        console.log(`[TodoTracker] Auto-completed todo #${id}`);
      }
    } catch {}
  }

  /** Send reminders for due/overdue todos */
  async sendReminders(): Promise<void> {
    if (!this.router) return;
    const settings = loadSettings();
    const pending = this.db.getPendingReminders();
    const overdue = this.db.getOverdueTodos();
    const activeReminders = this.db.getActiveReminders();

    const seenIds = new Set<number>();
    const items: any[] = [];
    for (const t of overdue) {
      if (!seenIds.has(t.id)) { seenIds.add(t.id); items.push({ ...t, isOverdue: true }); }
    }
    for (const t of pending) {
      if (!seenIds.has(t.id)) { seenIds.add(t.id); items.push({ ...t, isOverdue: false }); }
    }
    for (const t of activeReminders) {
      if (!seenIds.has(t.id)) { seenIds.add(t.id); items.push({ ...t, isOverdue: false }); }
    }

    if (items.length === 0) return;

    const lines = items.map((t: any) => {
      const prefix = t.isOverdue ? '🔴 逾期' : '🟡 即将到期';
      const assignee = t.assignee ? ` (${t.assignee})` : '';
      return `${prefix}: ${t.content}${assignee} — ${t.due_date}`;
    });

    const text = `📋 待办提醒 (${items.length}项)\n\n${lines.join('\n')}`;

    // Push to all enabled channels
    if (settings.feishuEnabled && settings.feishuAdminOpenId) {
      try { await this.router.sendText('feishu', settings.feishuAdminOpenId, text); } catch {}
    }
    if (settings.wechatEnabled && settings.wechatCorpId) {
      try { await this.router.sendText('wechat', '@all', text); } catch {}
    }
    if (settings.telegramEnabled && settings.telegramChatId) {
      try { await this.router.sendText('telegram', settings.telegramChatId, text); } catch {}
    }
    if (settings.dingtalkEnabled) {
      try { await this.router.sendText('dingtalk', '', text); } catch {}
    }
    if (settings.emailEnabled && settings.emailRecipient) {
      try { await this.router.sendText('email', settings.emailRecipient, text); } catch {}
    }

    // Mark reminders sent
    for (const t of items) {
      this.db.markReminderSent(t.id);
    }

    console.log(`[TodoTracker] Sent ${items.length} reminders`);
  }
}
