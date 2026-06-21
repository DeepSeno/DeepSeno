import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

const mockFetch = vi.fn();
vi.mock('electron', () => ({
  net: { fetch: (...args: any[]) => mockFetch(...args) },
}));

import { TelegramChannel } from '../channels/telegram-channel';

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

describe('TelegramChannel', () => {
  let channel: TelegramChannel;
  const config = { botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', defaultChatId: '-1001234567890' };

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new TelegramChannel(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct id and name', () => {
    expect(channel.id).toBe('telegram');
    expect(channel.name).toBe('Telegram');
  });

  it('isRunning() returns false initially', () => {
    expect(channel.isRunning()).toBe(false);
  });

  it('start() validates bot token via getMe', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));

    await channel.start();

    expect(channel.isRunning()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/getMe');
    expect(mockFetch.mock.calls[0][0]).toContain(config.botToken);
  });

  it('start() throws on missing token', async () => {
    const badChannel = new TelegramChannel({ botToken: '', defaultChatId: '123' });
    await expect(badChannel.start()).rejects.toThrow('Missing botToken');
  });

  it('start() throws on API error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: false,
      description: 'Unauthorized',
    }));

    await expect(channel.start()).rejects.toThrow('API error: Unauthorized');
  });

  it('start() throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(channel.start()).rejects.toThrow('HTTP 500');
  });

  it('stop() clears running state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();
    expect(channel.isRunning()).toBe(true);

    await channel.stop();
    expect(channel.isRunning()).toBe(false);
  });

  it('isRunning() reflects state correctly', async () => {
    expect(channel.isRunning()).toBe(false);

    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();
    expect(channel.isRunning()).toBe(true);

    await channel.stop();
    expect(channel.isRunning()).toBe(false);
  });

  it('onMessage stores handler', () => {
    const handler = vi.fn();
    channel.onMessage(handler);
    // Handler is stored internally for future polling integration
  });

  it('sendText sends correct API format', async () => {
    // Start to validate
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    // sendText call
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    await channel.sendText('999', 'Hello World');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('/sendMessage');
    expect(url).toContain(config.botToken);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('999');
    expect(body.text).toBe('Hello World');
    expect(body.parse_mode).toBe('Markdown');
  });

  it('sendText uses defaultChatId when chatId is empty', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    await channel.sendText('', 'Hello default');

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(config.defaultChatId);
  });

  it('sendCard formats as markdown message', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 2 } }));
    await channel.sendCard('999', {
      title: 'Daily Report',
      sections: [
        { header: 'Summary', content: 'All tasks completed' },
        { content: 'No issues found' },
      ],
    });

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('999');
    expect(body.text).toContain('*Daily Report*');
    expect(body.text).toContain('*Summary*');
    expect(body.text).toContain('All tasks completed');
    expect(body.text).toContain('No issues found');
    expect(body.parse_mode).toBe('Markdown');
  });

  it('sendFile sends file path as text', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 3 } }));
    await channel.sendFile('999', `${TMP_DIR}/test.wav`);

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.text).toContain(`${TMP_DIR}/test.wav`);
  });

  it('callApi handles HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 502));

    await expect(channel.sendText('999', 'Hello'))
      .rejects.toThrow('HTTP 502');
  });

  it('callApi handles API errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({
      ok: false,
      description: 'Bad Request: chat not found',
    }));

    await expect(channel.sendText('999', 'Hello'))
      .rejects.toThrow('API error: Bad Request: chat not found');
  });

  describe('testConnection', () => {
    it('returns success with username', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { id: 123456, is_bot: true, first_name: 'DeepSeno', username: 'deepseno_bot' },
      }));

      const result = await TelegramChannel.testConnection(config.botToken);

      expect(result.success).toBe(true);
      expect(result.username).toBe('deepseno_bot');
      expect(result.error).toBeUndefined();
    });

    it('handles invalid token format', async () => {
      const result = await TelegramChannel.testConnection('bad_token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid token format');
    });

    it('handles HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

      const result = await TelegramChannel.testConnection('123456:bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 401');
    });

    it('handles API error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: false,
        description: 'Unauthorized',
      }));

      const result = await TelegramChannel.testConnection('123456:bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('handles network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await TelegramChannel.testConnection(config.botToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });
});
