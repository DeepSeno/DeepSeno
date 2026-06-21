import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import { FeishuChannel } from '../channels/feishu-channel';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

describe('FeishuChannel', () => {
  let mockBot: any;
  let mockHandler: any;
  let channel: FeishuChannel;

  beforeEach(() => {
    mockHandler = {
      sendCard: vi.fn().mockResolvedValue('msg_123'),
    };
    mockBot = {
      status: 'connected',
      stop: vi.fn().mockResolvedValue(undefined),
      getHandler: vi.fn().mockReturnValue(mockHandler),
    };
    channel = new FeishuChannel(mockBot);
  });

  it('has correct id and name', () => {
    expect(channel.id).toBe('feishu');
    expect(channel.name).toBe('飞书');
  });

  it('reports running status from bot', () => {
    expect(channel.isRunning()).toBe(true);
    mockBot.status = 'disconnected';
    expect(channel.isRunning()).toBe(false);
  });

  it('delegates stop to bot', async () => {
    await channel.stop();
    expect(mockBot.stop).toHaveBeenCalled();
  });

  it('sends text as card', async () => {
    await channel.sendText('chat1', 'Hello');
    expect(mockHandler.sendCard).toHaveBeenCalledWith('chat1', expect.any(String));
    const cardJson = JSON.parse(mockHandler.sendCard.mock.calls[0][1]);
    expect(cardJson.card.elements[0].content).toBe('Hello');
  });

  it('sends structured card with header and sections', async () => {
    await channel.sendCard('chat1', {
      title: 'Report',
      sections: [{ header: 'Summary', content: 'All good' }],
    });
    expect(mockHandler.sendCard).toHaveBeenCalled();
    const cardJson = JSON.parse(mockHandler.sendCard.mock.calls[0][1]);
    expect(cardJson.card.header.title.content).toBe('Report');
    expect(cardJson.card.elements[0].content).toContain('**Summary**');
    expect(cardJson.card.elements[0].content).toContain('All good');
  });

  it('sends card sections without header', async () => {
    await channel.sendCard('chat1', {
      title: 'Info',
      sections: [{ content: 'Plain content' }],
    });
    const cardJson = JSON.parse(mockHandler.sendCard.mock.calls[0][1]);
    expect(cardJson.card.elements[0].content).toBe('Plain content');
  });

  it('sends file as card notification', async () => {
    await channel.sendFile('chat1', `${TMP_DIR}/test.wav`);
    expect(mockHandler.sendCard).toHaveBeenCalled();
    const cardJson = JSON.parse(mockHandler.sendCard.mock.calls[0][1]);
    expect(cardJson.card.elements[0].content).toContain(`${TMP_DIR}/test.wav`);
  });

  it('stores message handler', () => {
    const handler = vi.fn();
    channel.onMessage(handler);
    // Handler is stored for future use when FeishuBot message routing is decoupled
  });

  it('handles missing handler gracefully for sendText', async () => {
    mockBot.getHandler.mockReturnValue(null);
    // Should not throw
    await channel.sendText('chat1', 'test');
    expect(mockHandler.sendCard).not.toHaveBeenCalled();
  });

  it('handles missing handler gracefully for sendCard', async () => {
    mockBot.getHandler.mockReturnValue(null);
    await channel.sendCard('chat1', { title: 'test', sections: [] });
    expect(mockHandler.sendCard).not.toHaveBeenCalled();
  });

  it('handles missing handler gracefully for sendFile', async () => {
    mockBot.getHandler.mockReturnValue(null);
    await channel.sendFile('chat1', `${TMP_DIR}/test.wav`);
    expect(mockHandler.sendCard).not.toHaveBeenCalled();
  });

  it('start logs without throwing', async () => {
    await channel.start();
    // No-op, should not throw
  });
});
