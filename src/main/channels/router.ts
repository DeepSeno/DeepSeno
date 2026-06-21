import { MessageChannel, IncomingMessage, MessageCard } from './types';

export class MessageRouter {
  private channels: Map<string, MessageChannel> = new Map();
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  register(channel: MessageChannel): void {
    this.channels.set(channel.id, channel);
    channel.onMessage(async (msg) => {
      if (this.handler) await this.handler(msg);
    });
  }

  setHandler(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  getChannel(id: string): MessageChannel | undefined {
    return this.channels.get(id);
  }

  async startAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      try {
        await ch.start();
      } catch (err) {
        console.error(`[Router] Failed to start ${ch.id}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      try {
        await ch.stop();
      } catch {
        // Ignore stop errors
      }
    }
  }

  get channelCount(): number {
    return this.channels.size;
  }

  get channelIds(): string[] {
    return Array.from(this.channels.keys());
  }

  async sendText(channelId: string, chatId: string, text: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) {
      console.warn(`[Router] sendText: channel "${channelId}" not found (available: ${this.channelIds.join(', ')})`);
      return;
    }
    console.log(`[Router] sendText → ${channelId} chatId=${chatId} len=${text.length}`);
    await ch.sendText(chatId, text);
  }

  async sendCard(channelId: string, chatId: string, card: MessageCard): Promise<void> {
    const ch = this.channels.get(channelId);
    if (ch) await ch.sendCard(chatId, card);
  }

  async sendFile(channelId: string, chatId: string, filePath: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) {
      console.warn(`[Router] sendFile: channel "${channelId}" not found`);
      return;
    }
    console.log(`[Router] sendFile → ${channelId} chatId=${chatId} file=${filePath}`);
    await ch.sendFile(chatId, filePath);
  }

  async sendImage(channelId: string, chatId: string, imageData: Buffer, mimeType: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) {
      console.warn(`[Router] sendImage: channel "${channelId}" not found`);
      return;
    }
    console.log(`[Router] sendImage → ${channelId} chatId=${chatId} size=${imageData.length}`);
    await ch.sendImage(chatId, imageData, mimeType);
  }
}
