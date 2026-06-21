import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import { WeChatChannel } from '../channels/wechat-channel';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

describe('WeChatChannel', () => {
  let channel: WeChatChannel;
  const config = { corpId: 'ww_test_corp', agentId: '1000002', secret: 'test_secret_123' };

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new WeChatChannel(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct id and name', () => {
    expect(channel.id).toBe('wechat');
    expect(channel.name).toBe('企业微信');
  });

  it('isRunning() returns false initially', () => {
    expect(channel.isRunning()).toBe(false);
  });

  it('start() calls getAccessToken and sets running', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));

    await channel.start();

    expect(channel.isRunning()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('gettoken');
    expect(mockFetch.mock.calls[0][0]).toContain('corpid=ww_test_corp');
    expect(mockFetch.mock.calls[0][0]).toContain('corpsecret=test_secret_123');
  });

  it('start() throws on missing corpId', async () => {
    const badChannel = new WeChatChannel({ corpId: '', agentId: '1', secret: 'sec' });
    await expect(badChannel.start()).rejects.toThrow('Missing corpId, agentId, or secret');
  });

  it('start() throws on missing secret', async () => {
    const badChannel = new WeChatChannel({ corpId: 'corp', agentId: '1', secret: '' });
    await expect(badChannel.start()).rejects.toThrow('Missing corpId, agentId, or secret');
  });

  it('start() throws on missing agentId', async () => {
    const badChannel = new WeChatChannel({ corpId: 'corp', agentId: '', secret: 'sec' });
    await expect(badChannel.start()).rejects.toThrow('Missing corpId, agentId, or secret');
  });

  it('start() throws on token API error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 40013,
      errmsg: 'invalid corpid',
    }));

    await expect(channel.start()).rejects.toThrow('Token error: 40013 invalid corpid');
  });

  it('start() throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(channel.start()).rejects.toThrow('Token request failed: HTTP 500');
  });

  it('stop() clears state and sets running to false', async () => {
    // First start
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();
    expect(channel.isRunning()).toBe(true);

    await channel.stop();
    expect(channel.isRunning()).toBe(false);
  });

  it('onMessage stores handler', () => {
    const handler = vi.fn();
    channel.onMessage(handler);
    // Handler is stored internally for future webhook integration
  });

  it('sendText sends correct API format', async () => {
    // Start to get token
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();

    // sendText call
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));
    await channel.sendText('user123', 'Hello World');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('message/send');
    expect(url).toContain('access_token=token_abc');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.touser).toBe('user123');
    expect(body.msgtype).toBe('text');
    expect(body.agentid).toBe(1000002);
    expect(body.text.content).toBe('Hello World');
  });

  it('sendCard sends correct textcard format', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));
    await channel.sendCard('user123', {
      title: 'Daily Report',
      sections: [
        { header: 'Summary', content: 'All tasks completed' },
        { content: 'No issues found' },
      ],
    });

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('message/send');

    const body = JSON.parse(opts.body);
    expect(body.touser).toBe('user123');
    expect(body.msgtype).toBe('textcard');
    expect(body.agentid).toBe(1000002);
    expect(body.textcard.title).toBe('Daily Report');
    expect(body.textcard.description).toContain('<b>Summary</b>');
    expect(body.textcard.description).toContain('All tasks completed');
    expect(body.textcard.description).toContain('No issues found');
  });

  it('sendFile sends file path as text notification', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));
    await channel.sendFile('user123', `${TMP_DIR}/test.wav`);

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe('text');
    expect(body.text.content).toContain(`${TMP_DIR}/test.wav`);
  });

  it('refreshes token on expired token error (42001)', async () => {
    // Initial token
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_old',
      expires_in: 7200,
    }));
    await channel.start();

    // sendText gets 42001 (token expired)
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 42001, errmsg: 'access_token expired' }));
    // Token refresh
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_new',
      expires_in: 7200,
    }));
    // Retry sendText
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));

    await channel.sendText('user123', 'Hello');

    // 1 (start token) + 1 (first send) + 1 (refresh token) + 1 (retry send) = 4
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // The retry request should use the new token
    const retryUrl = mockFetch.mock.calls[3][0];
    expect(retryUrl).toContain('access_token=token_new');
  });

  it('refreshes token on invalid token error (40014)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_old',
      expires_in: 7200,
    }));
    await channel.start();

    // sendText gets 40014 (invalid token)
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 40014, errmsg: 'invalid access_token' }));
    // Token refresh
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_new',
      expires_in: 7200,
    }));
    // Retry
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));

    await channel.sendText('user123', 'Hello');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('throws on non-token API error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 60011, errmsg: 'no privilege to access' }));

    await expect(channel.sendText('user123', 'Hello'))
      .rejects.toThrow('API error: 60011 no privilege to access');
  });

  it('throws on HTTP error during send', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_abc',
      expires_in: 7200,
    }));
    await channel.start();

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 502));

    await expect(channel.sendText('user123', 'Hello'))
      .rejects.toThrow('API call failed: HTTP 502');
  });

  it('automatically refreshes token when near expiry', async () => {
    // Start with a token that expires very soon
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_short',
      expires_in: 100, // Very short
    }));
    await channel.start();

    // Manually expire the token by manipulating time
    // We test by making the next call require a new token
    // The getValidToken() checks tokenExpiresAt - TOKEN_EXPIRE_BUFFER (300s)
    // Since expires_in=100 < 300 buffer, it should immediately refresh on next call

    // Token refresh for the next call
    mockFetch.mockResolvedValueOnce(jsonResponse({
      errcode: 0,
      access_token: 'token_refreshed',
      expires_in: 7200,
    }));
    // The actual send
    mockFetch.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));

    await channel.sendText('user123', 'Hello');

    // The send URL should contain the refreshed token
    const sendUrl = mockFetch.mock.calls[2][0];
    expect(sendUrl).toContain('access_token=token_refreshed');
  });
});
