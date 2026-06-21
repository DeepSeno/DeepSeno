import { EventEmitter } from 'events';
import type { MessageRouter } from '../channels/router';
import type { WorkflowEngine } from './workflow-engine';
import { loadSettings } from '../settings';

export interface PipelineCompletedData {
  fileName: string;
  recordingId: number;
  meetingNotes?: { title: string };
  extractedTodos?: Array<{ content: string }>;
}

export class AgentEventBus extends EventEmitter {
  private router?: MessageRouter;
  private workflowEngine?: WorkflowEngine;

  constructor() {
    super();
    this.setupHandlers();
  }

  setRouter(router: MessageRouter): void {
    this.router = router;
  }

  setWorkflowEngine(engine: WorkflowEngine): void {
    this.workflowEngine = engine;
  }

  private setupHandlers(): void {
    this.on('pipeline:completed', async (data: PipelineCompletedData) => {
      try {
        await this.handlePipelineCompleted(data);
      } catch (err: any) {
        console.error('[EventBus] pipeline:completed handler error:', err.message);
      }
    });
  }

  private async handlePipelineCompleted(data: PipelineCompletedData): Promise<void> {
    // Delegate to WorkflowEngine if available (2.0 behavior)
    if (this.workflowEngine) {
      await this.workflowEngine.onPipelineCompleted({
        recordingId: data.recordingId,
        fileName: data.fileName,
        todos: data.extractedTodos || [],
        decisions: [],
        meetingNotes: data.meetingNotes?.title,
      });
      return;
    }

    // Legacy 1.0 behavior (fallback)
    const settings = loadSettings();
    if (!settings.feishuNotifyOnComplete && !settings.wechatEnabled) return;

    const parts: string[] = [];
    parts.push(`Recording processed: ${data.fileName}`);
    if (data.meetingNotes?.title) {
      parts.push(`Meeting: ${data.meetingNotes.title}`);
    }
    if (data.extractedTodos && data.extractedTodos.length > 0) {
      const todoText = data.extractedTodos.map(t => `- ${t.content}`).join('\n');
      parts.push(`New todos:\n${todoText}`);
    }
    const text = parts.join('\n');
    await this.pushToChannels(text, settings);
  }

  private async pushToChannels(text: string, settings: any): Promise<void> {
    if (!this.router) return;

    if (settings.feishuEnabled && settings.feishuNotifyOnComplete && settings.feishuAdminOpenId) {
      try {
        await this.router.sendText('feishu', settings.feishuAdminOpenId, text);
      } catch (err: any) {
        console.error('[EventBus] Feishu push failed:', err.message);
      }
    }

    if (settings.wechatEnabled && settings.wechatCorpId) {
      try {
        await this.router.sendText('wechat', '@all', text);
      } catch (err: any) {
        console.error('[EventBus] WeChat push failed:', err.message);
      }
    }
  }
}
