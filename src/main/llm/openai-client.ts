import type { ChatWithToolsOptions, ChatWithToolsResult, LLMClient, LocalGenerateOptions } from './llm-client';

const DEFAULT_TIMEOUT = 300_000;

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

  async generate(options: LocalGenerateOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
      console.log(`[OpenAI] generate → ${options.model} (${options.prompt.length} chars)`);
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
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`OpenAI generate failed: ${res.status} ${await res.text()}`);
      }
      const data: any = await res.json();
      // Strip reasoning_content (Volcengine) or <think> tags from thinking models
      const raw = data.choices?.[0]?.message?.content || '';
      const content = stripThinkTags(raw);
      console.log(`[OpenAI] generate done (${content.length} chars)`);
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStream(
    options: LocalGenerateOptions,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const STREAM_TIMEOUT = 600_000; // 10 minutes
    const internal = new AbortController();
    const timer = setTimeout(() => internal.abort(), STREAM_TIMEOUT);
    const combined = signal
      ? AbortSignal.any([internal.signal, signal])
      : internal.signal;

    try {
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
        signal: combined,
      });

      if (!res.ok) {
        throw new Error(`OpenAI stream failed: ${res.status} ${await res.text()}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      const processLine = (line: string) => {
        const content = parseOpenAIStreamLine(line);
        if (content) {
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
      return stripThinkTags(fullText);
    } finally {
      clearTimeout(timer);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
      const { model, messages, tools, temperature, num_ctx } = options;
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
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`);

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
      return { content, toolCalls };
    } finally {
      clearTimeout(timer);
    }
  }

  async embed(model: string, input: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
    }
    const data: any = await res.json();
    return data.data?.[0]?.embedding || [];
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
