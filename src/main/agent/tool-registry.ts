export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema for params
  source: 'builtin' | 'plugin';
  pluginId?: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  images?: Array<{ data: Buffer; mimeType: string }>;
}

export type ToolExecutor = (params: Record<string, any>) => Promise<ToolResult>;

interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, execute: ToolExecutor): void {
    this.tools.set(definition.name, { definition, execute });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Unregister all tools from a specific plugin */
  unregisterByPlugin(pluginId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.definition.pluginId === pluginId) {
        this.tools.delete(name);
      }
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Get all tool definitions (for LLM prompt building) */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /** Execute a tool by name */
  async execute(name: string, params: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }
    try {
      return await tool.execute(params);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  get size(): number {
    return this.tools.size;
  }
}
