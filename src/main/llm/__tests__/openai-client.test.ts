import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalOpenAIBaseUrl, OpenAIClient } from '../openai-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIClient.isAvailable', () => {
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

  it('does not accept a generic 404 as an OpenAI-compatible endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/wrong', 'key');

    await expect(client.isAvailable()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('checks the configured cloud model when provided', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('model not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'key');

    await expect(client.isAvailable('missing-model')).resolves.toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toBe('missing-model');
  });

  it('does not hide auth failures behind the fallback check', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'bad-key');

    await expect(client.isAvailable()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAIClient request timeouts', () => {
  it('recognizes local llama-server base URLs', () => {
    expect(isLocalOpenAIBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocalOpenAIBaseUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLocalOpenAIBaseUrl('http://[::1]:8080/v1')).toBe(true);
    expect(isLocalOpenAIBaseUrl('https://api.example.com/v1')).toBe(false);
  });

  it('does not add an internal timeout signal for local model generation', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'Qwen3.5-4B-Q4_K_M' }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('http://127.0.0.1:8080/v1', '');

    await expect(client.generate({ model: 'Qwen3.5-4B-Q4_K_M', prompt: 'hi' })).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8080/v1/models');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(fetchMock.mock.calls[1][1]?.signal).toBeUndefined();
  });

  it('keeps a timeout signal for cloud generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'key');

    await expect(client.generate({ model: 'cloud-model', prompt: 'hi' })).resolves.toBe('ok');
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('OpenAIClient.generateStream', () => {
  it('flushes a final SSE data frame without a trailing newline', async () => {
    const payload = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient('https://api.example.com/v1', 'key');
    const chunks: string[] = [];
    const result = await client.generateStream(
      { model: 'test-model', prompt: 'hello' },
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual(['hello']);
    expect(result).toBe('hello');
  });
});
