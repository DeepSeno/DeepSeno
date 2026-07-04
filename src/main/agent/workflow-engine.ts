import { VoiceBrainDB } from '../db/database';
import { loadSettings } from '../settings';
import type { MessageRouter } from '../channels/router';
import type { EmailService } from '../channels/email-service';
import { buildMeetingNotesEmail } from '../channels/email-templates';
import type { TodoTracker } from './todo-tracker';

interface PipelineResult {
  recordingId: number;
  fileName: string;
  todos: any[];
  decisions: any[];
  meetingNotes?: string;
  tags?: string[];
}

export class WorkflowEngine {
  constructor(
    _db: VoiceBrainDB,
    private router?: MessageRouter,
    private todoTracker?: TodoTracker,
    private emailService?: EmailService,
  ) {
    void _db;
  }

  async onPipelineCompleted(result: PipelineResult): Promise<void> {
    const settings = loadSettings();

    // Rule 1: Todo extracted -> enhance + push
    if (settings.workflowTodoPush !== false && result.todos.length > 0) {
      for (const todo of result.todos) {
        if (this.todoTracker) {
          try { await this.todoTracker.enhance(todo.id); } catch {}
        }
      }
      const text = `\u{1F4DD} \u65B0\u5F55\u97F3\u63D0\u53D6 ${result.todos.length} \u6761\u5F85\u529E:\n` +
        result.todos.map((t: any) => `\u2022 ${t.content}`).join('\n');
      await this.pushToChannels(text, settings);
    }

    // Rule 2: Decision detected -> push
    if (settings.workflowDecisionPush !== false && result.decisions.length > 0) {
      const text = `\u{1F4CC} \u65B0\u5F55\u97F3\u5305\u542B ${result.decisions.length} \u6761\u51B3\u7B56:\n` +
        result.decisions.map((d: any) => `\u2022 ${d.content}`).join('\n');
      await this.pushToChannels(text, settings);
    }

    // Rule 3: Urgent priority -> immediate push
    const urgentTodos = result.todos.filter((t: any) => t.priority === 'urgent');
    if (urgentTodos.length > 0) {
      const text = `\u{1F534} \u7D27\u6025\u5F85\u529E:\n` +
        urgentTodos.map((t: any) => `\u2022 ${t.content}`).join('\n');
      await this.pushToChannels(text, settings);
    }

    // Rule 4: Email meeting notes when email is enabled
    if (settings.emailEnabled && this.emailService?.isReady() && result.meetingNotes) {
      try {
        const html = buildMeetingNotesEmail({
          fileName: result.fileName,
          todos: result.todos,
          decisions: result.decisions,
          meetingNotes: result.meetingNotes,
        });
        const recipient = settings.smtpUser;
        if (recipient) {
          await this.emailService.sendMeetingNotes(
            [recipient],
            `Meeting Notes - ${result.fileName}`,
            html,
          );
        }
      } catch {}
    }
  }

  private async pushToChannels(text: string, settings: ReturnType<typeof loadSettings>): Promise<void> {
    if (!this.router) return;
    if (settings.feishuEnabled && settings.feishuAdminOpenId) {
      try { await this.router.sendText('feishu', settings.feishuAdminOpenId, text); } catch {}
    }
    if (settings.wechatEnabled && settings.wechatCorpId) {
      try { await this.router.sendText('wechat', '@all', text); } catch {}
    }
    if (settings.telegramEnabled && settings.telegramChatId) {
      try { await this.router.sendText('telegram', settings.telegramChatId, text); } catch {}
    }
  }
}
