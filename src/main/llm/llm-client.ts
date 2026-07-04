
/**
 * Common interface for LLM clients (Local local, OpenAI-compatible cloud, etc.).
 * Both Object and OpenAIClient satisfy this structurally.
 */
export interface LocalGenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  num_ctx?: number;
  num_predict?: number;
  keep_alive?: string;
  think?: boolean;
  format?: string | Record<string, unknown>;
  images?: string[];
}

export interface LocalTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

export interface LocalChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: 'function';
    function: {
      name: string;
      arguments: Record<string, any> | string;
    };
  }>;
}

export interface ChatWithToolsOptions {
  model: string;
  messages: LocalChatMessage[];
  tools: LocalTool[];
  temperature?: number;
  num_ctx?: number;
  think?: boolean;
}

export interface ChatWithToolsResult {
  content: string;
  toolCalls: Array<{
    id?: string;
    name: string;
    arguments: Record<string, any>;
  }>;
}

export interface LLMClient {
  generate(options: LocalGenerateOptions): Promise<string>;
  generateStream(options: LocalGenerateOptions, onChunk: (text: string) => void, signal?: AbortSignal): Promise<string>;
  generateJSON<T>(options: LocalGenerateOptions): Promise<T>;
  chatWithTools?(options: ChatWithToolsOptions): Promise<ChatWithToolsResult>;
  embed(model: string, input: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
}
