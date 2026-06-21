// Card builder for Feishu interactive card payloads

export interface TranscriptionResult {
  fileName: string;
  durationSeconds: number;
  speakerCount: number;
  summary?: string;
  todoCount: number;
  decisionCount: number;
  mediaType?: string; // 'audio' | 'video' | 'pdf' | 'docx' | 'text' | 'image'
}

export interface QueryResult {
  question: string;
  answer: string;
  sources: Array<{
    segment_id: number;
    speaker: string;
    text: string;
    time: string;
  }>;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function buildTranscriptionCard(result: TranscriptionResult): string {
  const isAudioVideo = !result.mediaType || ['audio', 'video'].includes(result.mediaType);
  const stats: string[] = [];
  if (isAudioVideo && result.durationSeconds > 0) {
    stats.push(`**Duration:** ${formatDuration(result.durationSeconds)}`);
  }
  if (isAudioVideo && result.speakerCount > 0) {
    stats.push(`**Speakers:** ${result.speakerCount}`);
  }
  if (!isAudioVideo && result.mediaType) {
    const typeLabels: Record<string, string> = { pdf: 'PDF', docx: 'Word', text: '文本', image: '图片' };
    stats.push(`**Type:** ${typeLabels[result.mediaType] || result.mediaType}`);
  }
  if (result.todoCount > 0) stats.push(`**TODOs:** ${result.todoCount}`);
  if (result.decisionCount > 0) stats.push(`**Decisions:** ${result.decisionCount}`);

  const elements: any[] = [
    { tag: 'markdown', content: stats.join(' | ') },
  ];

  if (result.summary) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: result.summary });
  }

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `✅ ${result.fileName}` },
        template: 'green',
      },
      elements,
    },
  });
}

export function buildQueryCard(result: QueryResult): string {
  const elements: any[] = [
    { tag: 'markdown', content: result.answer },
  ];

  if (result.sources.length > 0) {
    elements.push({ tag: 'hr' });
    const sourceLines = result.sources.slice(0, 5).map(
      (s) => `• [${s.time}] ${s.speaker}: ${s.text.slice(0, 60)}${s.text.length > 60 ? '...' : ''}`
    ).join('\n');
    elements.push({ tag: 'markdown', content: `📎 **Sources:**\n${sourceLines}` });
  }

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `🔍 ${result.question.slice(0, 30)}${result.question.length > 30 ? '...' : ''}` },
        template: 'blue',
      },
      elements,
    },
  });
}

export function buildTextCard(title: string, content: string, template: string = 'grey'): string {
  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template,
      },
      elements: [{ tag: 'markdown', content }],
    },
  });
}

export type ProcessingStep = 'downloading' | 'transcribing' | 'classifying' | 'executing' | 'thinking';

const STEP_LABELS: Record<ProcessingStep, string> = {
  downloading: '下载语音文件...',
  transcribing: '语音转文字中...',
  classifying: '分析意图中...',
  executing: '执行中...',
  thinking: '正在理解你的意思，请稍候...',
};

export function buildProcessingCard(context: string, step?: ProcessingStep): string {
  if (context === 'thinking' || step === 'thinking') {
    return buildTextCard('💭 正在处理...', STEP_LABELS.thinking, 'blue');
  }
  const stepText = step ? STEP_LABELS[step] : '语音消息已收到，正在处理...';
  return buildTextCard(`⏳ ${context}`, stepText, 'orange');
}

export function buildDailySummaryCard(result: {
  date: string;
  summaryText: string;
  keyEvents?: { todos?: string[]; decisions?: string[] };
}): string {
  const elements: any[] = [
    { tag: 'markdown', content: result.summaryText },
  ];

  const todos = result.keyEvents?.todos;
  const decisions = result.keyEvents?.decisions;

  if (todos && todos.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `📝 **待办事项:**\n${todos.map((t) => `• ${t}`).join('\n')}` });
  }

  if (decisions && decisions.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `✅ **决策记录:**\n${decisions.map((d) => `• ${d}`).join('\n')}` });
  }

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `📋 ${result.date} 语音日报` },
        template: 'blue',
      },
      elements,
    },
  });
}

export function buildTodoCard(todo: {
  content: string;
  dueDate?: string | null;
  relatedPerson?: string | null;
}): string {
  const lines: string[] = [`📋 ${todo.content}`];
  if (todo.relatedPerson) lines.push(`👤 ${todo.relatedPerson}`);
  if (todo.dueDate) lines.push(`📅 ${todo.dueDate}`);

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '✅ 待办已创建' },
        template: 'green',
      },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    },
  });
}

export function buildMemoCard(memo: {
  content: string;
  relatedPerson?: string | null;
}): string {
  const lines: string[] = [memo.content];
  if (memo.relatedPerson) lines.push(`\n👤 ${memo.relatedPerson}`);

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '📝 已记录' },
        template: 'blue',
      },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    },
  });
}

export function buildItemListCard(items: { id: number; type: string; content: string; status: string; due_date?: string | null; related_person?: string | null }[], listType: string): string {
  const typeLabel = listType === 'todo' ? '待办' : listType === 'memo' ? '备忘' : '事项';
  const icon = listType === 'todo' ? '✅' : listType === 'memo' ? '📝' : '🗂';

  if (items.length === 0) {
    return buildTextCard(`${icon} ${typeLabel}列表`, `暂无${typeLabel}事项`, 'grey');
  }

  const lines: string[] = [];
  items.forEach((item, i) => {
    const status = item.status === 'completed' ? '~~' : '';
    const num = i + 1;
    const extra: string[] = [];
    if (item.due_date) extra.push(`📅 ${item.due_date}`);
    if (item.related_person) extra.push(`👤 ${item.related_person}`);
    if (item.type !== listType && listType === 'all') extra.push(`[${item.type}]`);
    const suffix = extra.length > 0 ? `  ${extra.join(' ')}` : '';
    lines.push(`${num}. ${status}${item.content}${status}${suffix}`);
  });

  lines.push('');
  lines.push('> 回复「完成1」标记完成，「删除1」删除事项');

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `${icon} ${typeLabel}列表 (${items.length})` },
        template: listType === 'todo' ? 'green' : listType === 'memo' ? 'blue' : 'indigo',
      },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    },
  });
}

export function buildHelpCard(): string {
  const content = [
    '**DeepSeno 飞书助手功能：**',
    '',
    '💬 **提问** — 直接问问题，查询语音记忆库',
    '> 例：「昨天开会讨论了什么」',
    '',
    '✅ **待办** — 创建待办事项',
    '> 例：「帮我记一下明天3点和张总开会」',
    '',
    '📝 **备忘** — 保存备忘信息',
    '> 例：「记住这个：项目预算200万」',
    '',
    '🗂 **查看事项** — 列出待办/备忘列表',
    '> 例：「显示我的待办」「查看备忘」「查看所有事项」',
    '',
    '✏️ **管理事项** — 完成或删除事项',
    '> 回复「完成1」标记完成，「删除1」删除事项',
    '',
    '📋 **日报/周报** — 生成语音日报或周报',
    '> 例：「生成今天的日报」「生成本周周报」',
    '',
    '🎙️ **语音** — 发送语音消息自动转录处理',
    '> 短指令自动识别意图，长对话归档为录音',
  ].join('\n');

  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🤖 DeepSeno 帮助' },
        template: 'blue',
      },
      elements: [{ tag: 'markdown', content }],
    },
  });
}

export function buildErrorCard(error: string): string {
  return buildTextCard('❌ Error', error, 'red');
}
