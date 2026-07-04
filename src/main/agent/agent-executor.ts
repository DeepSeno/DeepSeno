import type { LLMClient, LocalChatMessage, LocalTool } from '../llm/llm-client';
import type { ToolRegistry, ToolResult, ToolDefinition } from './tool-registry';
import { loadSoulContext, buildSoulSystemPrompt } from './soul';
import { loadSettings } from '../settings';
import type { PluginConfig } from '../plugin/types';
import { getPromptText, readSkillPrompt } from '../skill/skill-file';
import type { SessionManager } from '../channels/session-manager';
import { getStr, getLang } from '../i18n';

interface AgentAction {
  action: string; // tool name, or 'respond' to send final text
  params?: Record<string, any>;
  text?: string; // only when action === 'respond'
  [key: string]: any; // LLM may flatten params to top-level
}

/** Merge top-level keys (that LLM flattened) back into params */
function extractToolParams(action: AgentAction): Record<string, any> {
  const merged = { ...(action.params || {}) };
  const reserved = new Set(['action', 'params', 'text']);
  for (const [k, v] of Object.entries(action)) {
    if (!reserved.has(k) && !(k in merged)) {
      merged[k] = v;
    }
  }
  return merged;
}

/** Convert ToolDefinition[] to Local native tool format */
function toLocalTools(defs: ToolDefinition[]): LocalTool[] {
  return defs.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface AgentResponse {
  text: string;
  toolCalls: Array<{ tool: string; params: any; result: ToolResult }>;
  images: Array<{ data: Buffer; mimeType: string }>;
}

const MAX_ITERATIONS = 5;

// Intent categories for routing
type IntentCategory = 'chat' | 'items' | 'memory' | 'knowledge' | 'report' | 'email' | 'web' | 'document' | 'all';

// Tool names belonging to each category
const TOOL_CATEGORIES: Record<Exclude<IntentCategory, 'chat' | 'all'>, string[]> = {
  items:     ['create_todo', 'complete_todo', 'delete_items', 'list_items', 'create_memo', 'set_reminder', 'list_reminders', 'create_scheduled_task', 'list_scheduled_tasks', 'manage_scheduled_task'],
  memory:    ['update_memory', 'list_memories'],
  knowledge: ['query_knowledge', 'search_recordings', 'lookup_person'],
  report:    ['generate_report'],
  email:     ['send_email'],
  web:       ['web_search', 'screenshot_webpage'],
  document:  ['create_pptx', 'create_docx', 'read_pdf', 'send_file', 'create_pdf', 'screenshot_webpage'],
};

export class AgentExecutor {
  constructor(
    private llm: LLMClient,
    private model: string,
    private registry: ToolRegistry,
    private sessionManager: SessionManager,
  ) {}

  private injectSummaries(systemPrompt: string, summaries: string[]): string {
    if (!summaries.length) return systemPrompt;
    const section = '## 近期对话背景\n' + summaries
      .map((s, i) => `[会话${i + 1}] ${s}`)
      .join('\n');
    return systemPrompt + '\n\n' + section;
  }

  async execute(
    channelId: string,
    userId: string,
    userName: string,
    message: string,
    options?: {
      allowedTools?: string[];
      skipIntentClassification?: boolean;
      maxIterations?: number;
    },
  ): Promise<AgentResponse> {
    const t0 = Date.now();
    const maxIter = options?.maxIterations ?? MAX_ITERATIONS;

    // 1. Classify intent to choose tool subset (skip for scheduled tasks)
    let intent: IntentCategory;
    if (options?.skipIntentClassification) {
      intent = 'all';
      console.log(`[Agent] intent=all (skipped classification) +${Date.now() - t0}ms`);
    } else if (message.trimStart().startsWith('@')) {
      // Messages starting with @ are plugin directives (e.g. @ccn) — skip
      // classification and use all tools so MCP tools can handle them
      intent = 'all';
      console.log(`[Agent] intent=all (@-directive detected) +${Date.now() - t0}ms`);
    } else {
      intent = await this.classifyIntent(message);
      console.log(`[Agent] intent=${intent} +${Date.now() - t0}ms`);
    }

    // 2. Fast path: pure conversation, no tools needed
    if (intent === 'chat') {
      return this.executeChatPath(channelId, userId, userName, message, t0);
    }

    // 3. Get relevant tools: category-matched builtins + plugin tools + cross-cutting tools
    const ALWAYS_AVAILABLE = channelId === 'scheduler'
      ? ['send_file']
      : ['create_scheduled_task', 'set_reminder', 'send_file'];
    const allDefs = this.registry.getAllDefinitions();
    const pluginCount = allDefs.filter(t => t.source === 'plugin').length;
    let toolDefs = intent === 'all'
      ? allDefs
      : allDefs.filter(t =>
          t.source === 'plugin' ||
          TOOL_CATEGORIES[intent]?.includes(t.name) ||
          ALWAYS_AVAILABLE.includes(t.name),
        );

    // Block ALL scheduling tools when executing FROM a scheduled task to prevent
    // infinite task creation (the category filter can leak them back in)
    if (channelId === 'scheduler') {
      const SCHEDULER_BLOCKED = new Set([
        'create_scheduled_task', 'set_reminder',
        'manage_scheduled_task', 'list_scheduled_tasks', 'list_reminders',
      ]);
      toolDefs = toolDefs.filter(t => !SCHEDULER_BLOCKED.has(t.name));
    }

    // Apply allowed_tools whitelist if specified
    if (options?.allowedTools?.length) {
      const allowed = new Set(options.allowedTools);
      toolDefs = toolDefs.filter(t => allowed.has(t.name) || t.source === 'plugin');
    }

    console.log(`[Agent] registry: ${allDefs.length} total (${pluginCount} plugin), filtered: ${toolDefs.length} for intent=${intent}`);

    // 4. Use native tool calling if available, otherwise fall back to JSON prompting
    if (this.llm.chatWithTools) {
      return this.executeWithNativeTools(channelId, userId, userName, message, toolDefs, t0, maxIter);
    }
    return this.executeWithJSONPrompting(channelId, userId, userName, message, toolDefs, t0, maxIter);
  }

  /** Native tool calling path via Local /api/chat with tools parameter */
  private async executeWithNativeTools(
    channelId: string,
    userId: string,
    _userName: string,
    message: string,
    toolDefs: ToolDefinition[],
    t0: number,
    maxIter: number = MAX_ITERATIONS,
  ): Promise<AgentResponse> {
    const tools = toLocalTools(toolDefs);
    const systemPrompt = this.buildNativeSystemPrompt();
    console.log(`[Agent] native tool-calling: ${tools.length} tools, system=${systemPrompt.length}chars`);

    this.sessionManager.addMessage(channelId, userId, 'user', message);
    const context = this.sessionManager.getContext(channelId, userId);
    const systemWithSummaries = this.injectSummaries(systemPrompt, context.recentSummaries);
    const toolCalls: AgentResponse['toolCalls'] = [];
    const images: AgentResponse['images'] = [];

    // Build messages from conversation history
    const messages: LocalChatMessage[] = [
      { role: 'system', content: systemWithSummaries },
    ];
    for (const entry of context.activeMessages) {
      messages.push({
        role: entry.role === 'user' ? 'user' : 'assistant',
        content: entry.content,
      });
    }

    for (let i = 0; i < maxIter; i++) {
      const tIter = Date.now();
      console.log(`[Agent] iteration ${i} start (+${tIter - t0}ms)`);

      try {
        const result = await this.llm.chatWithTools!({
          model: this.model,
          messages,
          tools,
          temperature: 0.3,
          num_ctx: 16384,
          think: false,
        });

        // If model chose to respond with text (no tool calls)
        if (result.toolCalls.length === 0) {
          const responseText = result.content.trim() || '好的。';
          this.sessionManager.addMessage(channelId, userId, 'assistant', responseText);
          console.log(`[Agent] respond after ${i + 1} iteration(s), total=${Date.now() - t0}ms`);
          return { text: responseText, toolCalls, images: images.slice(0, 10) };
        }

        // Execute each tool call
        for (const tc of result.toolCalls) {
          const toolParams = { ...tc.arguments, _sourceChannel: channelId, _chatId: userId };
          const tTool = Date.now();
          console.log(`[Agent] tool call: ${tc.name}`, JSON.stringify(tc.arguments));
          const toolResult = await this.registry.execute(tc.name, toolParams);
          console.log(`[Agent] tool done: ${tc.name} ${Date.now() - tTool}ms success=${toolResult.success}`);
          toolCalls.push({ tool: tc.name, params: toolParams, result: toolResult });
          if (toolResult.images?.length) {
            images.push(...toolResult.images);
          }

          // Add assistant message with tool call, then tool result message
          const callId = tc.id || `call_${Math.random().toString(36).slice(2, 10)}`;
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: callId, function: { name: tc.name, arguments: tc.arguments } }],
          });
          const observation = toolResult.success
            ? JSON.stringify(toolResult.data ?? '操作成功')
            : `错误: ${toolResult.error}`;
          messages.push({ role: 'tool', content: observation, tool_call_id: callId, name: tc.name });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
        console.warn('[AgentExecutor] chatWithTools failed:', errMsg);
        const errorText = '抱歉，处理请求时出错了，请稍后再试。';
        this.sessionManager.addMessage(channelId, userId, 'assistant', errorText);
        return { text: errorText, toolCalls, images: images.slice(0, 10) };
      }
    }

    // Max iterations reached — generate final text response (no tools)
    let finalText: string;
    try {
      const finalResult = await this.llm.chatWithTools!({
        model: this.model,
        messages,
        tools: [], // No tools = force text response
        temperature: 0.3,
        num_ctx: 16384,
        think: false,
      });
      finalText = finalResult.content.trim() || '已完成操作。';
    } catch {
      finalText = '已完成操作。';
    }
    this.sessionManager.addMessage(channelId, userId, 'assistant', finalText);
    return { text: finalText, toolCalls, images: images.slice(0, 10) };
  }

  /** Fallback: JSON prompting path (for LLM clients without native tool calling) */
  private async executeWithJSONPrompting(
    channelId: string,
    userId: string,
    userName: string,
    message: string,
    toolDefs: ToolDefinition[],
    t0: number,
    maxIter: number = MAX_ITERATIONS,
  ): Promise<AgentResponse> {
    const systemPrompt = this.buildSystemPrompt(undefined, toolDefs);
    console.log(`[Agent] JSON-prompting: ${toolDefs.length} tools, system=${systemPrompt.length}chars`);

    this.sessionManager.addMessage(channelId, userId, 'user', message);
    const toolCalls: AgentResponse['toolCalls'] = [];
    const images: AgentResponse['images'] = [];
    const scratchpad: string[] = [];

    for (let i = 0; i < maxIter; i++) {
      const userPrompt = this.buildUserPrompt(channelId, userId, userName, scratchpad);
      const tIter = Date.now();
      console.log(`[Agent] iteration ${i} start (+${tIter - t0}ms)`);

      let action: AgentAction;
      try {
        action = await this.llm.generateJSON<AgentAction>({
          model: this.model,
          prompt: userPrompt,
          system: systemPrompt,
          temperature: 0.3,
          num_ctx: 16384,
          think: false,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
        console.warn('[AgentExecutor] generateJSON failed:', errMsg);
        const errorText = '抱歉，处理请求时出错了，请稍后再试。';
        this.sessionManager.addMessage(channelId, userId, 'assistant', errorText);
        return { text: errorText, toolCalls, images: images.slice(0, 10) };
      }

      if (action.action === 'respond') {
        const responseText = (action.text || '').trim() || '好的。';
        this.sessionManager.addMessage(channelId, userId, 'assistant', responseText);
        console.log(`[Agent] respond after ${i + 1} iteration(s), total=${Date.now() - t0}ms`);
        return { text: responseText, toolCalls, images: images.slice(0, 10) };
      }

      const toolName = action.action;
      const mergedParams = extractToolParams(action);
      const toolParams = { ...mergedParams, _sourceChannel: channelId, _chatId: userId };
      const tTool = Date.now();
      console.log(`[Agent] tool call: ${toolName}`, JSON.stringify(mergedParams));
      const result = await this.registry.execute(toolName, toolParams);
      console.log(`[Agent] tool done: ${toolName} ${Date.now() - tTool}ms success=${result.success}`);
      toolCalls.push({ tool: toolName, params: toolParams, result });
      if (result.images?.length) {
        images.push(...result.images);
      }

      const observation = result.success
        ? JSON.stringify(result.data ?? '操作成功')
        : `错误: ${result.error}`;
      scratchpad.push(
        `工具调用: ${toolName}(${JSON.stringify(mergedParams)})\n观察结果: ${observation}`,
      );
    }

    // Max iterations — force text response
    const summaryPrompt = this.buildUserPrompt(channelId, userId, userName, scratchpad);
    let finalText: string;
    try {
      const finalAction = await this.llm.generateJSON<AgentAction>({
        model: this.model,
        prompt: summaryPrompt,
        system: systemPrompt + '\n\n' + (getStr('agent.max_iter_notice') as string),
        temperature: 0.3,
        num_ctx: 16384,
        think: false,
      });
      finalText = (finalAction.text || '').trim() || '已完成操作。';
    } catch {
      finalText = '已完成操作。';
    }
    this.sessionManager.addMessage(channelId, userId, 'assistant', finalText);
    return { text: finalText, toolCalls, images: images.slice(0, 10) };
  }

  /** Execute with only a specific plugin's injected prompt (for plugin-scoped pages) */
  async executeWithPlugin(
    channelId: string,
    userId: string,
    userName: string,
    message: string,
    plugin: PluginConfig,
  ): Promise<AgentResponse> {
    const allToolDefs = this.registry.getAllDefinitions();

    // Use native tool calling if available
    if (this.llm.chatWithTools) {
      const tools = toLocalTools(allToolDefs);
      const soul = loadSoulContext();
      const soulPrompt = buildSoulSystemPrompt(soul);
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const prompt = readSkillPrompt(plugin);
      const systemPrompt = [
        getStr('agent.tool_system_native') as string,
        soulPrompt || '',
        `当前时间：${now}`,
        prompt ? `## 提示词\n### ${plugin.name}\n${prompt}` : '',
      ].filter(Boolean).join('\n\n');

      this.sessionManager.addMessage(channelId, userId, 'user', message);
      const pluginContext = this.sessionManager.getContext(channelId, userId);
      const pluginSystemPrompt = this.injectSummaries(systemPrompt, pluginContext.recentSummaries);
      const toolCalls: AgentResponse['toolCalls'] = [];
      const images: AgentResponse['images'] = [];
      const messages: LocalChatMessage[] = [
        { role: 'system', content: pluginSystemPrompt },
      ];
      for (const entry of pluginContext.activeMessages) {
        messages.push({ role: entry.role === 'user' ? 'user' : 'assistant', content: entry.content });
      }

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        try {
          const result = await this.llm.chatWithTools!({
            model: this.model, messages, tools, temperature: 0.3, num_ctx: 16384, think: false,
          });
          if (result.toolCalls.length === 0) {
            const responseText = result.content.trim() || '好的。';
            this.sessionManager.addMessage(channelId, userId, 'assistant', responseText);
            return { text: responseText, toolCalls, images: images.slice(0, 10) };
          }
          for (const tc of result.toolCalls) {
            const toolParams = { ...tc.arguments, _sourceChannel: channelId, _chatId: userId };
            console.log(`[Agent] plugin tool call: ${tc.name}`, JSON.stringify(tc.arguments));
            const toolResult = await this.registry.execute(tc.name, toolParams);
            toolCalls.push({ tool: tc.name, params: toolParams, result: toolResult });
            if (toolResult.images?.length) {
              images.push(...toolResult.images);
            }
            const callId = tc.id || `call_${Math.random().toString(36).slice(2, 10)}`;
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: callId, function: { name: tc.name, arguments: tc.arguments } }] });
            const obs = toolResult.success ? JSON.stringify(toolResult.data ?? '操作成功') : `错误: ${toolResult.error}`;
            messages.push({ role: 'tool', content: obs, tool_call_id: callId, name: tc.name });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
          console.warn('[AgentExecutor] plugin chatWithTools failed:', errMsg);
          const errorText = '抱歉，处理请求时出错了。';
          this.sessionManager.addMessage(channelId, userId, 'assistant', errorText);
          return { text: errorText, toolCalls, images: images.slice(0, 10) };
        }
      }
      const finalResult = await this.llm.chatWithTools!({
        model: this.model, messages, tools: [], temperature: 0.3, num_ctx: 16384, think: false,
      });
      const finalText = finalResult.content.trim() || '已完成操作。';
      this.sessionManager.addMessage(channelId, userId, 'assistant', finalText);
      return { text: finalText, toolCalls, images: images.slice(0, 10) };
    }

    // Fallback: JSON prompting
    const systemPrompt = this.buildSystemPrompt(getPromptText(plugin) ? [plugin] : undefined);
    this.sessionManager.addMessage(channelId, userId, 'user', message);
    const toolCalls: AgentResponse['toolCalls'] = [];
    const images: AgentResponse['images'] = [];
    const scratchpad: string[] = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const userPrompt = this.buildUserPrompt(channelId, userId, userName, scratchpad);
      let action: AgentAction;
      try {
        action = await this.llm.generateJSON<AgentAction>({
          model: this.model, prompt: userPrompt, system: systemPrompt,
          temperature: 0.3, num_ctx: 16384, think: false,
        });
      } catch {
        const errorText = '抱歉，处理请求时出错了。';
        this.sessionManager.addMessage(channelId, userId, 'assistant', errorText);
        return { text: errorText, toolCalls, images: images.slice(0, 10) };
      }
      if (action.action === 'respond') {
        const responseText = (action.text || '').trim() || '好的。';
        this.sessionManager.addMessage(channelId, userId, 'assistant', responseText);
        return { text: responseText, toolCalls, images: images.slice(0, 10) };
      }
      const toolName = action.action;
      const llmParams = extractToolParams(action);
      const toolParams = { ...llmParams, _sourceChannel: channelId, _chatId: userId };
      const result = await this.registry.execute(toolName, toolParams);
      toolCalls.push({ tool: toolName, params: toolParams, result });
      if (result.images?.length) {
        images.push(...result.images);
      }
      const obs = result.success ? JSON.stringify(result.data ?? '操作成功') : `错误: ${result.error}`;
      scratchpad.push(`工具调用: ${toolName}(${JSON.stringify(llmParams)})\n观察结果: ${obs}`);
    }
    const finalText = '已完成操作。';
    this.sessionManager.addMessage(channelId, userId, 'assistant', finalText);
    return { text: finalText, toolCalls, images: images.slice(0, 10) };
  }

  /**
   * Classify the user's message intent with a tiny LLM call (~200ms).
   * Returns the routing category so we can select the right tool subset.
   */
  private async classifyIntent(message: string): Promise<IntentCategory> {
    const system = getStr('agent.intent_system') as string;

    try {
      const result = await this.llm.generateJSON<{ intent: string }>({
        model: this.model,
        system,
        prompt: message,
        temperature: 0,
        num_ctx: 16384,
        think: false,
      });
      const valid: IntentCategory[] = ['chat', 'items', 'memory', 'knowledge', 'report', 'email', 'web', 'document', 'all'];
      return valid.includes(result.intent as IntentCategory)
        ? (result.intent as IntentCategory)
        : 'all';
    } catch {
      return 'all'; // fail-safe: use full tool set
    }
  }

  /** Fast path for pure conversational messages — no tool schema, plain text output. */
  private async executeChatPath(
    channelId: string,
    userId: string,
    userName: string,
    message: string,
    t0: number,
  ): Promise<AgentResponse> {
    const soul = loadSoulContext();
    const soulPrompt = buildSoulSystemPrompt(soul);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const systemPrompt = [
      getStr('agent.chat_system') as string,
      soulPrompt || '',
      `当前时间：${now}`,
    ].filter(Boolean).join('\n\n');

    console.log(`[Agent] chat-path systemPrompt=${systemPrompt.length}chars (+${Date.now() - t0}ms)`);

    this.sessionManager.addMessage(channelId, userId, 'user', message);
    const chatContext = this.sessionManager.getContext(channelId, userId);
    const finalSystemPrompt = this.injectSummaries(systemPrompt, chatContext.recentSummaries);
    // Build user prompt directly from activeMessages (don't use buildUserPrompt which also injects summaries)
    const historyParts: string[] = [];
    for (const entry of chatContext.activeMessages) {
      const role = entry.role === 'user' ? userName || '用户' : '助手';
      historyParts.push(`${role}: ${entry.content}`);
    }
    const userPrompt = historyParts.join('\n');

    const text = await this.llm.generate({
      model: this.model,
      prompt: userPrompt,
      system: finalSystemPrompt,
      temperature: 0.7,
      num_ctx: 16384,
      think: false,
    });

    const responseText = text.trim() || '好的。';
    this.sessionManager.addMessage(channelId, userId, 'assistant', responseText);
    console.log(`[Agent] chat-path done, total=${Date.now() - t0}ms`);
    return { text: responseText, toolCalls: [], images: [] };
  }

  private buildSystemPrompt(pluginOverride?: PluginConfig[], toolSubset?: ReturnType<ToolRegistry['getAllDefinitions']>): string {
    const soul = loadSoulContext();
    const soulPrompt = buildSoulSystemPrompt(soul);

    const toolDefs = toolSubset ?? this.registry.getAllDefinitions();
    const toolsSection =
      toolDefs.length > 0
        ? toolDefs
            .map((t) => {
              const props = t.parameters?.properties || {};
              const required: string[] = t.parameters?.required || [];
              const paramsStr = Object.entries(props)
                .map(([k, v]: [string, any]) => {
                  const typeInfo = v.enum ? v.enum.join('|') : (v.type || 'any');
                  return `${k}${required.includes(k) ? '*' : ''}(${typeInfo})`;
                })
                .join(', ');
              return `- **${t.name}**: ${t.description}${paramsStr ? ` | ${paramsStr}` : ''}`;
            })
            .join('\n')
        : '当前没有可用工具。';

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const parts = [
      getStr('agent.tool_system') as string,
      '',
      soulPrompt ? soulPrompt + '\n' : '',
      `## ${getLang() === 'zh' ? '当前时间' : 'Current Time'}\n${now}`,
      '',
      `## ${getLang() === 'zh' ? '可用工具' : 'Available Tools'}\n${toolsSection}`,
      '',
      getStr('agent.tool_rules') as string,
    ].filter(Boolean);

    // Inject enabled prompt plugins (or override with specific plugins)
    const plugins = pluginOverride
      || (loadSettings().plugins || []).filter(p => p.enabled && getPromptText(p));
    if (plugins.length > 0) {
      parts.push('\n## 提示词');
      for (const plugin of plugins) {
        const prompt = readSkillPrompt(plugin);
        if (prompt) {
          parts.push(`### ${plugin.name}\n${prompt}`);
        }
      }
    }

    return parts.join('\n');
  }

  /** System prompt for native tool calling — tools are in API param, not in prompt text */
  private buildNativeSystemPrompt(): string {
    const soul = loadSoulContext();
    const soulPrompt = buildSoulSystemPrompt(soul);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const nativeSystem = getStr('agent.tool_system_native') as string;
    const nativeRules = getStr('agent.tool_rules_native') as string;

    const parts = [
      nativeSystem,
      soulPrompt || '',
      `当前时间：${now}`,
      nativeRules,
    ].filter(Boolean);

    // Inject enabled prompt plugins
    const plugins = (loadSettings().plugins || []).filter(p => p.enabled && getPromptText(p));
    if (plugins.length > 0) {
      parts.push('\n## 提示词');
      for (const plugin of plugins) {
        const prompt = readSkillPrompt(plugin);
        if (prompt) {
          parts.push(`### ${plugin.name}\n${prompt}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  private buildUserPrompt(
    channelId: string,
    userId: string,
    userName: string,
    scratchpad: string[],
  ): string {
    const context = this.sessionManager.getContext(channelId, userId);

    const parts: string[] = [];

    // Recent session summaries
    if (context.recentSummaries.length > 0) {
      parts.push('## 近期对话背景');
      context.recentSummaries.forEach((s, i) => {
        parts.push(`[会话${i + 1}] ${s}`);
      });
      parts.push('');
    }

    // Conversation history
    if (context.activeMessages.length > 0) {
      parts.push('## 对话历史');
      for (const entry of context.activeMessages) {
        const role = entry.role === 'user' ? userName || '用户' : '助手';
        parts.push(`${role}: ${entry.content}`);
      }
      parts.push('');
    }

    // Tool call scratchpad (observations from this execution round)
    if (scratchpad.length > 0) {
      parts.push('## 工具调用记录');
      for (const obs of scratchpad) {
        parts.push(obs);
      }
      parts.push('');
      parts.push('请根据以上工具调用结果，生成最终回复。使用 {"action":"respond","text":"..."} 格式。');
    }

    return parts.join('\n');
  }
}
