import { net } from 'electron';
import { MessageChannel, IncomingMessage, MessageCard } from './types';

export interface TelegramConfig {
  botToken: string;
  defaultChatId: string;
}

const API_BASE = 'https://api.telegram.org/bot';

// Use electron.net.fetch so requests go through Chromium's network stack,
// which honours system proxy settings (e.g. Clash, Charles, corporate proxy).
// Native Node.js fetch() bypasses the system proxy and will fail when
// api.telegram.org is only reachable through a proxy.
const efetch: typeof fetch = (...args) => net.fetch(...(args as Parameters<typeof net.fetch>)) as Promise<Response>;

export class TelegramChannel implements MessageChannel {
  readonly id = 'telegram';
  readonly name = 'Telegram';

  private running = false;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private pollOffset = 0;
  private pollAbortController: AbortController | null = null;

  constructor(private config: TelegramConfig) {
    // Trim whitespace from token (common copy-paste issue)
    this.config.botToken = this.config.botToken.trim();
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('[TelegramChannel] Missing botToken');
    }
    const res = await efetch(`${API_BASE}${this.config.botToken}/getMe`);
    if (!res.ok) throw new Error(`[TelegramChannel] HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`[TelegramChannel] API error: ${data.description}`);
    this.running = true;
    console.log(`[TelegramChannel] Started as @${data.result.username}`);
    // Start long polling in background
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
    console.log('[TelegramChannel] Channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.callApi('sendMessage', {
      chat_id: chatId || this.config.defaultChatId,
      text,
      parse_mode: 'Markdown',
    });
  }

  async sendCard(chatId: string, card: MessageCard): Promise<void> {
    // Telegram doesn't have native cards — format as Markdown message
    const parts = [`*${card.title}*`];
    for (const section of card.sections) {
      if (section.header) parts.push(`\n*${section.header}*`);
      parts.push(section.content);
    }
    await this.sendText(chatId, parts.join('\n'));
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    // Send file path as text (same pattern as other channels)
    await this.sendText(chatId, `File: ${filePath}`);
  }

  // ─── Long polling ───────────────────────────────────────

  private startPolling(): void {
    if (!this.messageHandler) {
      console.log('[TelegramChannel] No message handler, skipping polling');
      return;
    }
    this.pollLoop().catch(err => {
      console.error('[TelegramChannel] Poll loop crashed:', err);
    });
  }

  private async pollLoop(): Promise<void> {
    console.log('[TelegramChannel] Long polling started');
    while (this.running) {
      try {
        this.pollAbortController = new AbortController();
        const url = `${API_BASE}${this.config.botToken}/getUpdates?offset=${this.pollOffset}&timeout=30`;
        const res = await efetch(url, { signal: this.pollAbortController.signal });
        if (!res.ok) {
          console.warn(`[TelegramChannel] Poll HTTP ${res.status}`);
          await this.delay(5000);
          continue;
        }
        const data = await res.json();
        if (data.result?.length) {
          console.log(`[TelegramChannel] Received ${data.result.length} update(s)`);
        }
        for (const update of data.result || []) {
          this.pollOffset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            console.error('[TelegramChannel] Update handler error:', err);
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') break; // Stopped
        console.warn('[TelegramChannel] Poll error:', err.message);
        await this.delay(5000);
      }
    }
    console.log('[TelegramChannel] Long polling stopped');
  }

  private async handleUpdate(update: any): Promise<void> {
    if (!this.messageHandler) {
      console.warn('[TelegramChannel] No messageHandler set, dropping update');
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = String(message.chat.id);
    const userId = String(message.from?.id || '');
    const userName = message.from?.first_name || message.from?.username || 'Unknown';
    console.log(`[TelegramChannel] Incoming ${message.voice ? 'voice' : 'text'} from ${userName} (chat=${chatId}): ${message.text?.slice(0, 50) || '[voice]'}`);

    if (message.voice) {
      // Voice message: get file URL
      try {
        const fileRes = await this.callApi('getFile', { file_id: message.voice.file_id });
        const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileRes.result.file_path}`;

        await this.messageHandler({
          channelId: 'telegram',
          userId,
          userName,
          chatId,
          type: 'voice',
          content: '',
          audioUrl: fileUrl,
          timestamp: (message.date || 0) * 1000,
          raw: update,
        });
      } catch (err) {
        console.error('[TelegramChannel] Voice file fetch failed:', err);
      }
    } else if (message.text) {
      await this.messageHandler({
        channelId: 'telegram',
        userId,
        userName,
        chatId,
        type: 'text',
        content: message.text,
        timestamp: (message.date || 0) * 1000,
        raw: update,
      });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── Static helpers ──────────────────────────────────────

  static async testConnection(
    botToken: string,
  ): Promise<{ success: boolean; username?: string; error?: string }> {
    try {
      const token = botToken.trim();
      if (!token || !token.includes(':')) {
        return { success: false, error: 'Invalid token format (expected: 123456:ABC...)' };
      }
      const res = await efetch(`${API_BASE}${token}/getMe`);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      if (!data.ok) return { success: false, error: data.description };
      return { success: true, username: data.result.username };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // ─── Internal helpers ─────────────────────────────────────

  private async callApi(method: string, body: Record<string, unknown>): Promise<any> {
    const url = `${API_BASE}${this.config.botToken}/${method}`;
    const res = await efetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`[TelegramChannel] HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`[TelegramChannel] API error: ${data.description}`);
    return data;
  }
}
