import type { MessageRouter } from './router';
import type { AgentExecutor } from '../agent/agent-executor';
import type { IncomingMessage } from './types';
import type { ToolRegistry } from '../agent/tool-registry';
import type { SessionManager } from './session-manager';

export class UnifiedMessageHandler {
  private toolRegistry: ToolRegistry | null = null;

  constructor(
    private router: MessageRouter,
    private agentExecutor: AgentExecutor,
    private sessionManager: SessionManager,
  ) {}

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const { channelId, userId, userName, content, type } = msg;
    console.log(`[MessageHandler] handle() channel=${channelId} type=${type} user=${userName} content=${content?.slice(0, 50) || ''}`);

    // Voice messages: if already transcribed (e.g. WeChat ASR), process as text;
    // otherwise just acknowledge receipt
    if (type === 'voice') {
      if (content?.trim()) {
        console.log(`[MessageHandler] Voice with ASR text, processing as text: ${content.slice(0, 50)}`);
      } else {
        try {
          await this.router.sendText(channelId, msg.chatId || userId, '语音消息已收到，正在处理转写...');
        } catch {}
        return;
      }
    }

    if (!content?.trim()) return;

    // Handle /new command — close session and confirm
    if (this.sessionManager.handleCommand(channelId, userId, content.trim())) {
      try {
        await this.router.sendText(channelId, msg.chatId || userId, '已开启新对话。');
      } catch {}
      return;
    }

    try {
      // @ccn prefix → directly call forward_to_claude tool, bypass LLM
      const trimmedContent = content.trimStart();
      if (trimmedContent.startsWith('@ccn ')) {
        await this.handleCcnCommand(trimmedContent, channelId, msg.chatId || userId);
        return;
      }

      console.log(`[MessageHandler] Calling agentExecutor.execute...`);
      const result = await this.agentExecutor.execute(channelId, userId, userName || '用户', content);
      console.log(`[MessageHandler] Agent replied: ${result.text?.slice(0, 80) || '(empty)'}${result.images?.length ? ` +${result.images.length}img` : ''}`);
      const replyTo = msg.chatId || userId;
      await this.router.sendText(channelId, replyTo, result.text);
      // Send collected images after text
      if (result.images?.length) {
        for (const img of result.images) {
          try {
            await this.router.sendImage(channelId, replyTo, img.data, img.mimeType);
          } catch (imgErr) {
            console.error(`[MessageHandler] Failed to send image:`, imgErr);
          }
        }
      }
      console.log(`[MessageHandler] Reply sent to ${channelId}`);
    } catch (err) {
      console.error(`[MessageHandler] Agent execution failed:`, err);
      try {
        await this.router.sendText(channelId, msg.chatId || userId, '处理消息时出错了，请稍后再试。');
      } catch {}
    }
  }

  private async handleCcnCommand(content: string, channelId: string, replyTo: string): Promise<void> {
    // Parse: "@ccn label message" → label, message
    const withoutPrefix = content.slice(5); // remove "@ccn "
    const spaceIdx = withoutPrefix.indexOf(' ');

    let label: string;
    let message: string;
    if (spaceIdx === -1) {
      label = withoutPrefix;
      message = '';
    } else {
      label = withoutPrefix.slice(0, spaceIdx);
      message = withoutPrefix.slice(spaceIdx + 1);
    }

    console.log(`[MessageHandler] @ccn command: label="${label}" message="${message.slice(0, 50)}"`);

    if (!this.toolRegistry) {
      await this.router.sendText(channelId, replyTo, '工具注册表未就绪，请稍后再试。');
      return;
    }

    // Find the forward_to_claude tool (may be prefixed with mcp server id)
    const toolName = this.toolRegistry.getAllDefinitions()
      .find(t => t.name.endsWith('_forward_to_claude'))?.name;

    if (!toolName) {
      await this.router.sendText(channelId, replyTo, 'Claude Code 通知插件未启动，请检查 VoiceBrain MCP 插件状态。');
      return;
    }

    try {
      const result = await this.toolRegistry.execute(toolName, { label, message });
      const text = typeof result?.data === 'string' ? result.data : JSON.stringify(result);
      console.log(`[MessageHandler] @ccn tool result: ${text.slice(0, 100)}`);
      await this.router.sendText(channelId, replyTo, `已转发给 Claude Code [${label}]。`);
    } catch (err: any) {
      console.error(`[MessageHandler] @ccn tool call failed:`, err);
      await this.router.sendText(channelId, replyTo, `转发失败: ${err.message}`);
    }
  }
}
