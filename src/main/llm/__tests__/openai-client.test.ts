import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../openai-client';

describe('OpenAIClient.isAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts providers that expose /models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'key');

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/models');
  });

  it('falls back to chat completions when /models is unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('model not found', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'key');

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.example.com/v1/chat/completions');
  });

  it('does not hide auth failures behind the fallback check', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'bad-key');

    await expect(client.isAvailable()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
