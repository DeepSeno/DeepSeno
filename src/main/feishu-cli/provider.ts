import { FeishuCliService } from './service';
import type { ExternalDocument, ExternalSourceProvider } from '../external-sources/types';

const SOURCE_ID = 'feishu-cli';

// 拉取最近 N 天的数据
const RECENT_DAYS = 30;
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export class FeishuCliProvider implements ExternalSourceProvider {
  id = SOURCE_ID;
  displayName = 'Feishu CLI';
  domains = ['calendar', 'task', 'doc', 'im'];

  private cli = FeishuCliService.getInstance();

  async syncDomain(domain: string): Promise<ExternalDocument[]> {
    switch (domain) {
      case 'calendar':
        return this.syncCalendar();
      case 'task':
      case 'tasks':
        return this.syncTasks();
      case 'doc':
      case 'docs':
        return this.syncDocs();
      case 'im':
        return this.syncIm();
      default:
        throw new Error(`Unsupported Feishu CLI domain: ${domain}`);
    }
  }

  // ── 日历：用 +agenda 拉最近 30 天 ──────────────────────────────
  private async syncCalendar(): Promise<ExternalDocument[]> {
    const startIso = daysAgoIso(RECENT_DAYS);
    const endIso = new Date(Date.now() + 30 * 86400_000).toISOString(); // 往后 30 天
    const raw = await this.cli.getAgenda(startIso, endIso);
    const parsed = JSON.parse(raw);

    if (!parsed.ok) throw new Error(parsed.error?.message || 'Calendar sync failed');

    const items: any[] = Array.isArray(parsed.data) ? parsed.data : (parsed.data?.items || []);
    return items.flatMap((item: any) => {
      const externalId = item.event_id || item.id || '';
      if (!externalId) return [];
      const content = JSON.stringify({
        summary: item.summary || '',
        description: item.description || '',
        start_time: item.start_time || item.start?.timestamp || '',
        end_time: item.end_time || item.end?.timestamp || '',
        organizer: item.organizer || '',
        status: item.status || '',
      });
      return [{
        source: SOURCE_ID,
        domain: 'calendar',
        external_id: externalId,
        title: item.summary || '未命名日程',
        url: item.url || '',
        content,
        metadata_json: JSON.stringify(item),
        updated_at: item.updated_time || new Date().toISOString(),
      }] as ExternalDocument[];
    });
  }

  // ── 任务：用 +get-my-tasks ──────────────────────────────────────
  private async syncTasks(): Promise<ExternalDocument[]> {
    const raw = await this.cli.getTasks();
    const parsed = JSON.parse(raw);

    if (!parsed.ok) throw new Error(parsed.error?.message || 'Task sync failed');

    const items: any[] = Array.isArray(parsed.data)
      ? parsed.data
      : (parsed.data?.items || parsed.data?.tasks || []);

    return items.flatMap((item: any) => {
      const externalId = item.id || item.task_id || item.guid || '';
      if (!externalId) return [];
      const content = JSON.stringify({
        summary: item.summary || item.content || item.description || '',
        due_date: item.due?.timestamp || item.due_date || '',
        status: item.status || item.completion_time ? 'completed' : 'open',
        assignee: item.assignee || '',
      });
      return [{
        source: SOURCE_ID,
        domain: 'task',
        external_id: externalId,
        title: item.summary || item.content || '未命名任务',
        url: item.url || '',
        content,
        metadata_json: JSON.stringify(item),
        updated_at: item.updated_at || item.modified_time || new Date().toISOString(),
      }] as ExternalDocument[];
    });
  }

  // ── 文档：drive 列表 + 逐条 fetch ──────────────────────────────
  private async syncDocs(): Promise<ExternalDocument[]> {
    let items: any[] = [];
    try {
      const raw = await this.cli.getDriveDocs();
      const parsed = JSON.parse(raw);
      if (parsed.ok && parsed.data) {
        items = Array.isArray(parsed.data) ? parsed.data : (parsed.data.files || parsed.data.items || []);
      }
    } catch (err: any) {
      // drive list 失败时跳过 doc 同步，不整体报错
      console.warn('[FeishuCliProvider] doc sync skipped:', err.message);
      return [];
    }

    const docs: ExternalDocument[] = [];
    for (const item of items.slice(0, 10)) {
      const docUrl = item.url || item.token || '';
      if (!docUrl) continue;
      try {
        const doc = await this.fetchDoc(docUrl, item);
        if (doc) docs.push(doc);
      } catch {
        // 单篇文档失败不影响整体
      }
    }
    return docs;
  }

  private async fetchDoc(docUrl: string, fallback: any = {}): Promise<ExternalDocument | null> {
    try {
      const raw = await this.cli.fetchDoc(docUrl);
      const parsed = JSON.parse(raw);
      if (parsed.ok === false || !parsed.data) return null;
      const data = parsed.data;
      return {
        source: SOURCE_ID,
        domain: 'doc',
        external_id: data.doc_token || data.document_id || fallback.token || '',
        title: data.title || fallback.name || fallback.title || '未命名文档',
        url: data.url || docUrl,
        content: typeof data.content === 'string' ? data.content : JSON.stringify(data),
        metadata_json: JSON.stringify(data),
        updated_at: data.updated_time || fallback.modified_time || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  // ── IM 消息：列 chats → 各取最近 50 条消息 ────────────────────
  private async syncIm(): Promise<ExternalDocument[]> {
    let chats: any[] = [];
    try {
      const raw = await this.cli.getImChats();
      const parsed = JSON.parse(raw);
      if (parsed.ok && parsed.data) {
        chats = Array.isArray(parsed.data) ? parsed.data : (parsed.data.chats || []);
      }
    } catch (err: any) {
      throw new Error(`Failed to list chats: ${err.message}`);
    }

    const startIso = daysAgoIso(RECENT_DAYS);
    const docs: ExternalDocument[] = [];

    // 最多同步 20 个群，顺序执行避免并发 fetch 过多
    for (const chat of chats.slice(0, 20)) {
      const chatId: string = chat.chat_id || '';
      if (!chatId) continue;
      try {
        const raw = await this.cli.getImMessages(chatId, startIso);
        const parsed = JSON.parse(raw);
        if (!parsed.ok || !parsed.data) continue;

        const messages: any[] = Array.isArray(parsed.data)
          ? parsed.data
          : (parsed.data.items || parsed.data.messages || []);

        if (messages.length === 0) continue;

        const lines = messages
          .filter((m: any) => !m.deleted && m.msg_type !== 'system' && (m.content || m.body?.content))
          .map((m: any) => {
            // sender.name 不总存在，open_id 截短后缀 6 位作为匿名标识
            const rawId: string = m.sender?.id || '';
            const sender = m.sender?.name || (rawId ? `用户…${rawId.slice(-6)}` : '未知');
            const time = m.create_time || '';
            let text: string = '';
            if (typeof m.content === 'string') {
              text = m.content;
            } else if (m.body?.content) {
              try {
                const body = typeof m.body.content === 'string'
                  ? JSON.parse(m.body.content)
                  : m.body.content;
                text = body?.text || body?.content || JSON.stringify(body);
              } catch {
                text = String(m.body.content);
              }
            }
            return `[${time}] ${sender}: ${text}`;
          })
          .join('\n');

        if (!lines.trim()) continue;

        docs.push({
          source: SOURCE_ID,
          domain: 'im',
          external_id: `chat_${chatId}`,
          title: `飞书群聊：${chat.name || chatId}（近 ${RECENT_DAYS} 天）`,
          url: '',
          content: lines,
          metadata_json: JSON.stringify({ chat_id: chatId, chat_name: chat.name, message_count: messages.length }),
          updated_at: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn(`[FeishuCliProvider] im chat ${chatId} skipped:`, err.message);
      }
    }
    return docs;
  }
}
