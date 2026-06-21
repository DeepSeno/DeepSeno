import { MessageChannel, IncomingMessage, MessageCard } from './types';
import { FeishuBot } from '../feishu/bot';

export class FeishuChannel implements MessageChannel {
  readonly id = 'feishu';
  readonly name = '飞书';
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor(private bot: FeishuBot) {}

  async start(): Promise<void> {
    // FeishuBot.start() requires config — but it's already started by main.ts
    // This is a no-op if already running; actual start is handled by initFeishuBot()
    console.log('[FeishuChannel] Channel registered (bot lifecycle managed externally)');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  isRunning(): boolean {
    return this.bot.status === 'connected';
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
    // Note: Currently FeishuBot handles messages internally via EventHandler.
    // Future: decouple EventHandler to route through this handler.
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const handler = this.bot.getHandler();
    if (!handler) {
      console.warn('[FeishuChannel] Cannot send text: handler not ready');
      return;
    }
    const targetId = chatId || handler.getAdminOpenId();
    if (!targetId) {
      console.warn('[FeishuChannel] Cannot send text: no chatId and no adminOpenId');
      return;
    }
    // Send text as a simple card (Feishu SDK uses cards for rich messages)
    const cardJson = JSON.stringify({
      card: {
        elements: [{ tag: 'markdown', content: text }],
      },
    });
    await handler.sendCard(targetId, cardJson);
  }

  async sendCard(chatId: string, card: MessageCard): Promise<void> {
    const handler = this.bot.getHandler();
    if (!handler) {
      console.warn('[FeishuChannel] Cannot send card: handler not ready');
      return;
    }
    const targetId = chatId || handler.getAdminOpenId();
    if (!targetId) return;
    const cardJson = JSON.stringify({
      card: {
        header: { title: { tag: 'plain_text', content: card.title } },
        elements: card.sections.map((s) => ({
          tag: 'markdown',
          content: s.header ? `**${s.header}**\n${s.content}` : s.content,
        })),
      },
    });
    await handler.sendCard(targetId, cardJson);
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    const handler = this.bot.getHandler();
    if (!handler) {
      console.warn('[FeishuChannel] Cannot send file: handler not ready');
      return;
    }
    const targetId = chatId || handler.getAdminOpenId();
    if (!targetId) return;
    const cardJson = JSON.stringify({
      card: {
        elements: [{ tag: 'markdown', content: `File: ${filePath}` }],
      },
    });
    await handler.sendCard(targetId, cardJson);
  }
}
