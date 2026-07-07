import type { ChatWithToolsOptions, ChatWithToolsResult, LLMClient, LocalGenerateOptions } from './llm-client';

const CLOUD_REQUEST_TIMEOUT_MS = 300_000;
const CLOUD_STREAM_TIMEOUT_MS = 600_000;

export function isLocalOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl);
  }
}

function createRequestAbort(timeoutMs: number | null, signal?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs === null) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/** Strip <think>...</think> blocks from thinking model output (Doubao-Seed, DeepSeek-R1, etc.). */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseOpenAIStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const data: any = JSON.parse(payload);
    const content = data.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

export function looksLikeModelNotFound(text: string): boolean {
  return /(model|模型)/i.test(text) &&
    /(not found|does not exist|not exist|no such|unknown model|invalid model|不存在|未找到)/i.test(text);
}

export function isExplicitModelNotFoundResponse(status: number, body: string): boolean {
  return (status === 400 || status === 404) && looksLikeModelNotFound(body);
}

/**
 * OpenAI-compatible API client.
 * Works with Volcengine (Doubao), DeepSeek, OpenAI, etc.
 * Implements the same interface as Object so it can be used as a drop-in replacement.
 */
export class OpenAIClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Ensure baseUrl ends without trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private getRequestTimeoutMs(stream = false): number | null {
    return isLocalOpenAIBaseUrl(this.baseUrl)
      ? null
      : stream ? CLOUD_STREAM_TIMEOUT_MS : CLOUD_REQUEST_TIMEOUT_MS;
  }

  async generate(options: LocalGenerateOptions): Promise<string> {
    const timeoutMs = this.getRequestTimeoutMs(false);
    const abort = createRequestAbort(timeoutMs);
    const startedAt = Date.now();
    const endpoint = timeoutMs === null ? 'local' : 'cloud';
    try {
      console.log(`[OpenAI] generate start model=${options.model} endpoint=${endpoint} timeoutMs=${timeoutMs ?? 'none'} promptChars=${options.prompt.length} imageCount=${options.images?.length || 0}`);
      if (timeoutMs === null) {
        console.log(`[OpenAI] local generate will wait for llama-server model loading until response is ready model=${options.model}`);
      }
      const messages: Array<{ role: string; content: any }> = [];
      if (options.system) {
        messages.push({ role: 'system', content: options.system });
      }
      if (options.images && options.images.length > 0) {
        const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: 'text', text: options.prompt },
          ...options.images.map((img: string) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${img}` },
          })),
        ];
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: options.prompt });
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: false,
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.num_predict !== undefined) body.max_tokens = options.num_predict;
      if (options.think === false) body.chat_template_kwargs = { enable_thinking: false };

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      console.log(`[OpenAI] generate response model=${options.model} endpoint=${endpoint} status=${res.status} elapsedMs=${Date.now() - startedAt}`);

      if (!res.ok) {
        const body = await res.text();
        console.warn(`[OpenAI] generate failed response model=${options.model} status=${res.status} body=${body.slice(0, 300)}`);
        throw new Error(`OpenAI generate failed: ${res.status} ${body}`);
      }
      const data: any = await res.json();
      // Strip reasoning_content (Volcengine) or <think> tags from thinking models
      const raw = data.choices?.[0]?.message?.content || '';
      const content = stripThinkTags(raw);
      console.log(`[OpenAI] generate done model=${options.model} endpoint=${endpoint} chars=${content.length} elapsedMs=${Date.now() - startedAt}`);
      return content;
    } catch (err: any) {
      console.warn(`[OpenAI] generate exception model=${options.model} endpoint=${endpoint} elapsedMs=${Date.now() - startedAt} error=${err?.message || String(err)}`);
      throw err;
    } finally {
      abort.cleanup();
    }
  }

  async generateStream(
    options: LocalGenerateOptions,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const timeoutMs = this.getRequestTimeoutMs(true);
    const abort = createRequestAbort(timeoutMs, signal);
    const startedAt = Date.now();
    const endpoint = timeoutMs === null ? 'local' : 'cloud';
    let firstChunkLogged = false;

    try {
      console.log(`[OpenAI] stream start model=${options.model} endpoint=${endpoint} timeoutMs=${timeoutMs ?? 'none'} promptChars=${options.prompt.length} imageCount=${options.images?.length || 0} externalSignal=${Boolean(signal)}`);
      if (timeoutMs === null) {
        console.log(`[OpenAI] local stream will wait for llama-server model loading until first token is ready model=${options.model}`);
      }
      const messages: Array<{ role: string; content: any }> = [];
      if (options.system) {
        messages.push({ role: 'system', content: options.system });
      }
      if (options.images && options.images.length > 0) {
        const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: 'text', text: options.prompt },
          ...options.images.map((img: string) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${img}` },
          })),
        ];
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: options.prompt });
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.think === false) body.chat_template_kwargs = { enable_thinking: false };

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      console.log(`[OpenAI] stream response model=${options.model} endpoint=${endpoint} status=${res.status} elapsedMs=${Date.now() - startedAt}`);

      if (!res.ok) {
        const body = await res.text();
        console.warn(`[OpenAI] stream failed response model=${options.model} status=${res.status} body=${body.slice(0, 300)}`);
        throw new Error(`OpenAI stream failed: ${res.status} ${body}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      const processLine = (line: string) => {
        const content = parseOpenAIStreamLine(line);
        if (content) {
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            console.log(`[OpenAI] stream first chunk model=${options.model} endpoint=${endpoint} elapsedMs=${Date.now() - startedAt}`);
          }
          fullText += content;
          onChunk(content);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          processLine(line);
        }
      }
      if (buffer.trim()) processLine(buffer);
      const result = stripThinkTags(fullText);
      console.log(`[OpenAI] stream done model=${options.model} endpoint=${endpoint} chars=${result.length} elapsedMs=${Date.now() - startedAt}`);
      return result;
    } catch (err: any) {
      console.warn(`[OpenAI] stream exception model=${options.model} endpoint=${endpoint} elapsedMs=${Date.now() - startedAt} error=${err?.message || String(err)}`);
      throw err;
    } finally {
      abort.cleanup();
    }
  }

  async generateJSON<T>(options: LocalGenerateOptions): Promise<T> {
    const response = await this.generate(options);
    if (!response || !response.trim()) {
      throw new Error('OpenAI generateJSON: empty response from model');
    }
    return this.extractJSON<T>(response);
  }

  /** Extract and parse JSON from model response, handling markdown fences and thinking tags. */
  private extractJSON<T>(response: string): T {
    // Strip <think> tags if present
    let text = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Try direct parse first
    try {
      return JSON.parse(text) as T;
    } catch {
      // Try extracting from markdown code fence
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        return JSON.parse(fenceMatch[1].trim()) as T;
      }
      // Try extracting any JSON object/array
      const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      throw new Error(`OpenAI generateJSON: invalid JSON in response: "${text.slice(0, 100)}"`);
    }
  }

  async chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const timeoutMs = this.getRequestTimeoutMs(false);
    const abort = createRequestAbort(timeoutMs);
    const startedAt = Date.now();
    const endpoint = timeoutMs === null ? 'local' : 'cloud';
    try {
      const { model, messages, tools, temperature, num_ctx } = options;
      console.log(`[OpenAI] chatWithTools start model=${model} endpoint=${endpoint} timeoutMs=${timeoutMs ?? 'none'} messages=${messages.length} tools=${tools.length}`);
      if (timeoutMs === null) {
        console.log(`[OpenAI] local chatWithTools will wait for llama-server model loading until response is ready model=${model}`);
      }
      const openaiTools = tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
      }));
      const openaiMessages = messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          }));
        }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      });

      const body: Record<string, unknown> = {
        model, messages: openaiMessages, tools: openaiTools, stream: false,
      };
      if (temperature !== undefined) body.temperature = temperature;
      if (num_ctx !== undefined) body.max_tokens = num_ctx;

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      console.log(`[OpenAI] chatWithTools response model=${model} endpoint=${endpoint} status=${res.status} elapsedMs=${Date.now() - startedAt}`);
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[OpenAI] chatWithTools failed response model=${model} status=${res.status} body=${body.slice(0, 300)}`);
        throw new Error(`OpenAI chat failed: ${res.status} ${body}`);
      }

      const data: any = await res.json();
      const choice = data.choices?.[0]?.message;
      const content = stripThinkTags(choice?.content || '');
      const toolCalls: ChatWithToolsResult['toolCalls'] = [];
      if (choice?.tool_calls) {
        for (const tc of choice.tool_calls) {
          if (tc.function) {
            let args: Record<string, any> = {};
            if (typeof tc.function.arguments === 'string') {
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                console.warn(`[OpenAI] Failed to parse tool arguments for ${tc.function.name}: ${tc.function.arguments.slice(0, 200)}`);
              }
            } else {
              args = tc.function.arguments || {};
            }
            toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
          }
        }
      }
      console.log(`[OpenAI] chatWithTools done model=${model} endpoint=${endpoint} contentChars=${content.length} toolCalls=${toolCalls.length} elapsedMs=${Date.now() - startedAt}`);
      return { content, toolCalls };
    } catch (err: any) {
      console.warn(`[OpenAI] chatWithTools exception model=${options.model} endpoint=${endpoint} elapsedMs=${Date.now() - startedAt} error=${err?.message || String(err)}`);
      throw err;
    } finally {
      abort.cleanup();
    }
  }

  async embed(model: string, input: string): Promise<number[]> {
    const timeoutMs = this.getRequestTimeoutMs(false);
    const abort = createRequestAbort(timeoutMs);
    const startedAt = Date.now();
    const endpoint = timeoutMs === null ? 'local' : 'cloud';
    try {
      console.log(`[OpenAI] embed start model=${model} endpoint=${endpoint} timeoutMs=${timeoutMs ?? 'none'} inputChars=${input.length}`);
      if (timeoutMs === null) {
        console.log(`[OpenAI] local embed will wait for llama-server embedding model loading until response is ready model=${model}`);
      }
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, input }),
        signal: abort.signal,
      });
      console.log(`[OpenAI] embed response model=${model} endpoint=${endpoint} status=${res.status} elapsedMs=${Date.now() - startedAt}`);
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[OpenAI] embed failed response model=${model} status=${res.status} body=${body.slice(0, 300)}`);
        throw new Error(`OpenAI embed failed: ${res.status} ${body}`);
      }
      const data: any = await res.json();
      const embedding = data.data?.[0]?.embedding || [];
      console.log(`[OpenAI] embed done model=${model} endpoint=${endpoint} dimensions=${Array.isArray(embedding) ? embedding.length : 0} elapsedMs=${Date.now() - startedAt}`);
      return embedding;
    } catch (err: any) {
      console.warn(`[OpenAI] embed exception model=${model} endpoint=${endpoint} elapsedMs=${Date.now() - startedAt} error=${err?.message || String(err)}`);
      throw err;
    } finally {
      abort.cleanup();
    }
  }

  async isAvailable(model?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok && !model) return true;
      if (res.status === 401 || res.status === 403) return false;

      const chatRes = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (chatRes.ok) return true;
      const text = await chatRes.text().catch(() => '');
      return !model && isExplicitModelNotFoundResponse(chatRes.status, text);
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`OpenAI listModels failed: ${res.status} ${await res.text()}`);
    }
    const data: any = await res.json();
    return data.data?.map((m: { id: string }) => m.id).filter(Boolean) || [];
  }
}
