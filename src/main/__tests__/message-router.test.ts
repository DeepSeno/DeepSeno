import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouter } from '../channels/router';
import type { MessageChannel, IncomingMessage } from '../channels/types';

function createMockChannel(
  id: string
): MessageChannel & { triggerMessage: (msg: IncomingMessage) => Promise<void> } {
  let handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  return {
    id,
    name: `Mock ${id}`,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    onMessage: vi.fn((h) => {
      handler = h;
    }),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    triggerMessage: async (msg) => {
      if (handler) await handler(msg);
    },
  };
}

const mockMsg: IncomingMessage = {
  channelId: 'test',
  userId: 'u1',
  userName: 'Test User',
  chatId: 'c1',
  type: 'text',
  content: 'hello',
  timestamp: Date.now(),
};

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
  });

  it('registers channel and retrieves it', () => {
    const ch = createMockChannel('feishu');
    router.register(ch);
    expect(router.getChannel('feishu')).toBe(ch);
  });

  it('routes messages to handler', async () => {
    const ch = createMockChannel('feishu');
    const handler = vi.fn().mockResolvedValue(undefined);
    router.register(ch);
    router.setHandler(handler);
    await ch.triggerMessage(mockMsg);
    expect(handler).toHaveBeenCalledWith(mockMsg);
  });

  it('starts all channels', async () => {
    const ch1 = createMockChannel('ch1');
    const ch2 = createMockChannel('ch2');
    router.register(ch1);
    router.register(ch2);
    await router.startAll();
    expect(ch1.start).toHaveBeenCalled();
    expect(ch2.start).toHaveBeenCalled();
  });

  it('sends text to correct channel', async () => {
    const ch = createMockChannel('feishu');
    router.register(ch);
    await router.sendText('feishu', 'chat1', 'hello');
    expect(ch.sendText).toHaveBeenCalledWith('chat1', 'hello');
  });

  it('ignores sendText to unknown channel', async () => {
    await router.sendText('unknown', 'chat1', 'hello');
    // Should not throw
  });

  it('stops all channels', async () => {
    const ch1 = createMockChannel('ch1');
    const ch2 = createMockChannel('ch2');
    router.register(ch1);
    router.register(ch2);
    await router.stopAll();
    expect(ch1.stop).toHaveBeenCalled();
    expect(ch2.stop).toHaveBeenCalled();
  });

  it('sends card to correct channel', async () => {
    const ch = createMockChannel('feishu');
    router.register(ch);
    const card = { title: 'Test', sections: [{ content: 'body' }] };
    await router.sendCard('feishu', 'chat1', card);
    expect(ch.sendCard).toHaveBeenCalledWith('chat1', card);
  });

  it('continues starting other channels when one fails', async () => {
    const ch1 = createMockChannel('ch1');
    const ch2 = createMockChannel('ch2');
    ch1.start = vi.fn().mockRejectedValue(new Error('fail'));
    router.register(ch1);
    router.register(ch2);
    await router.startAll();
    expect(ch2.start).toHaveBeenCalled();
  });
});
