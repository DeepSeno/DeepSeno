
/**
 * Common interface for LLM clients (Local local, OpenAI-compatible cloud, etc.).
 * Both Object and OpenAIClient satisfy this structurally.
 */
export interface LLMClient {
  generate(options: LocalGenerateOptions): Promise<string>;
  generateStream(options: LocalGenerateOptions, onChunk: (text: string) => void, signal?: AbortSignal): Promise<string>;
  generateJSON<T>(options: LocalGenerateOptions): Promise<T>;
  chatWithTools?(options: ChatWithToolsOptions): Promise<ChatWithToolsResult>;
  embed(model: string, input: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
}
