import * as fs from 'fs';
import * as path from 'path';
import type { ActionDeps, ActionResult } from './predefined-actions';
import { executePredefinedAction, pushTextToChannels } from './predefined-actions';
import type { AgentExecutor } from '../agent/agent-executor';

export class TaskExecutor {
  constructor(
    private deps: ActionDeps,
    private getAgentExecutor: () => AgentExecutor | null = () => null,
  ) {}

  async execute(task: any): Promise<ActionResult> {
    const channelsOverride = task.channels_override ? JSON.parse(task.channels_override) : undefined;

    if (task.task_type === 'predefined') {
      const actionParams = task.action_params ? JSON.parse(task.action_params) : undefined;
      return executePredefinedAction(task.action, this.deps, channelsOverride, actionParams);
    }

    if (task.task_type === 'prompt') {
      return this.executePrompt(task, channelsOverride);
    }

    return { success: false, summary: '', error: `Unknown task_type: ${task.task_type}` };
  }

  private async executePrompt(task: any, channelsOverride?: string[]): Promise<ActionResult> {
    const agent = this.getAgentExecutor();
    if (!agent) {
      return { success: false, summary: '', error: 'AgentExecutor not available' };
    }

    try {
      console.log(`[TaskExecutor] Executing prompt: "${task.action}"`);
      const allowedTools: string[] | undefined = task.allowed_tools
        ? JSON.parse(task.allowed_tools)
        : undefined;
      const response = await agent.execute(
        'scheduler',         // channelId
        'system',            // userId
        '定时任务',           // userName
        task.action,         // the prompt text
        {
          allowedTools,
          skipIntentClassification: true,
          maxIterations: 3,
        },
      );

      const text = response.text || '';
      console.log(`[TaskExecutor] Agent responded: "${text.slice(0, 100)}"`);

      // Deliver result based on output_mode
      if (text) {
        const label = task.name ? `[${task.name}] ` : '';
        const outputMode = task.output_mode || 'push';

        switch (outputMode) {
          case 'append_file': {
            const filePath = task.output_file_path || path.join(
              this.deps.settings?.outputDir || '.',
              `task-${task.id}-output.md`,
            );
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const entry = `\n## ${timestamp}\n\n${text}\n\n---\n`;
            fs.appendFileSync(filePath, entry, 'utf-8');
            console.log(`[TaskExecutor] Result appended to: ${filePath}`);
            break;
          }
          case 'accumulate':
            // Stored in task_executions only, no push
            console.log(`[TaskExecutor] Result accumulated (no push)`);
            break;
          case 'push':
          default: {
            const notified = await pushTextToChannels(`${label}${text}`, this.deps, channelsOverride);
            console.log(`[TaskExecutor] Prompt result pushed to: ${notified.join(', ') || '(none)'}`);
            break;
          }
        }
      }

      return {
        success: true,
        summary: text.slice(0, 500),
      };
    } catch (err: any) {
      console.error(`[TaskExecutor] Prompt execution failed:`, err.message);
      return { success: false, summary: '', error: err.message };
    }
  }
}
