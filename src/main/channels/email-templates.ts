// Email HTML templates for DeepSeno notifications
// All templates use inline CSS for maximum email client compatibility

const BRAND_COLOR = '#18181b'; // zinc-900
const ACCENT_COLOR = '#3f3f46'; // zinc-700
const MUTED_COLOR = '#71717a'; // zinc-500
const BORDER_COLOR = '#e4e4e7'; // zinc-200
const BG_COLOR = '#fafafa'; // zinc-50
const URGENT_COLOR = '#dc2626'; // red-600
const SUCCESS_COLOR = '#16a34a'; // green-600

function footer(): string {
  return `
    <tr>
      <td style="padding: 24px 32px; border-top: 1px solid ${BORDER_COLOR}; text-align: center;">
        <p style="margin: 0; font-size: 12px; color: ${MUTED_COLOR}; font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;">
          DeepSeno &mdash; Your Local AI Voice Second Brain
        </p>
      </td>
    </tr>`;
}

function wrapHtml(title: string, bodyRows: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BG_COLOR}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 640px; margin: 24px auto; background: #ffffff; border: 1px solid ${BORDER_COLOR}; border-radius: 4px;">
    ${bodyRows}
    ${footer()}
  </table>
</body>
</html>`;
}

function headerRow(title: string, subtitle?: string): string {
  return `
    <tr>
      <td style="padding: 24px 32px 16px; border-bottom: 1px solid ${BORDER_COLOR};">
        <h1 style="margin: 0 0 4px; font-size: 18px; font-weight: 600; color: ${BRAND_COLOR}; font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;">
          ${title}
        </h1>
        ${subtitle ? `<p style="margin: 0; font-size: 13px; color: ${MUTED_COLOR};">${subtitle}</p>` : ''}
      </td>
    </tr>`;
}

function sectionTitle(text: string): string {
  return `<h2 style="margin: 16px 0 8px; font-size: 14px; font-weight: 600; color: ${ACCENT_COLOR}; text-transform: uppercase; letter-spacing: 0.5px;">${text}</h2>`;
}

// ---------- Meeting Notes Email ----------

interface MeetingNotesData {
  fileName: string;
  todos: any[];
  decisions: any[];
  meetingNotes?: string;
}

export function buildMeetingNotesEmail(data: MeetingNotesData): string {
  const { fileName, todos, decisions, meetingNotes } = data;

  let contentHtml = '';

  // Meeting notes section
  if (meetingNotes) {
    contentHtml += sectionTitle('Meeting Notes');
    contentHtml += `<div style="font-size: 14px; line-height: 1.6; color: ${BRAND_COLOR}; white-space: pre-wrap;">${escapeHtml(meetingNotes)}</div>`;
  }

  // Todos section
  if (todos.length > 0) {
    contentHtml += sectionTitle(`Todos (${todos.length})`);
    contentHtml += '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">';
    for (const todo of todos) {
      const priorityBadge = todo.priority === 'urgent'
        ? `<span style="display: inline-block; padding: 1px 6px; font-size: 11px; font-weight: 600; color: #fff; background: ${URGENT_COLOR}; border-radius: 2px; margin-left: 6px;">URGENT</span>`
        : '';
      contentHtml += `
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: ${BRAND_COLOR}; border-bottom: 1px solid ${BG_COLOR};">
            &bull; ${escapeHtml(todo.content)}${priorityBadge}
            ${todo.due_date ? `<br><span style="font-size: 12px; color: ${MUTED_COLOR};">Due: ${escapeHtml(todo.due_date)}</span>` : ''}
          </td>
        </tr>`;
    }
    contentHtml += '</table>';
  }

  // Decisions section
  if (decisions.length > 0) {
    contentHtml += sectionTitle(`Decisions (${decisions.length})`);
    contentHtml += '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">';
    for (const d of decisions) {
      contentHtml += `
        <tr>
          <td style="padding: 6px 0; font-size: 14px; color: ${BRAND_COLOR}; border-bottom: 1px solid ${BG_COLOR};">
            &bull; ${escapeHtml(d.content)}
          </td>
        </tr>`;
    }
    contentHtml += '</table>';
  }

  const body = `
    ${headerRow('Meeting Notes', fileName)}
    <tr>
      <td style="padding: 16px 32px 24px;">
        ${contentHtml || '<p style="color: ' + MUTED_COLOR + '; font-size: 14px;">No extracted content for this recording.</p>'}
      </td>
    </tr>`;

  return wrapHtml(`Meeting Notes - ${fileName}`, body);
}

// ---------- Reminder Email ----------

interface ReminderItem {
  content: string;
  due_date: string;
  priority: string;
  assignee?: string;
  isOverdue: boolean;
}

interface ReminderData {
  items: ReminderItem[];
}

export function buildReminderEmail(data: ReminderData): string {
  const { items } = data;
  const overdueCount = items.filter(i => i.isOverdue).length;
  const subtitle = overdueCount > 0
    ? `${items.length} items &middot; ${overdueCount} overdue`
    : `${items.length} items`;

  let contentHtml = '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">';

  for (const item of items) {
    const overdueStyle = item.isOverdue
      ? `color: ${URGENT_COLOR}; font-weight: 600;`
      : `color: ${BRAND_COLOR};`;
    const priorityDot = item.priority === 'urgent'
      ? `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${URGENT_COLOR}; margin-right: 6px; vertical-align: middle;"></span>`
      : item.priority === 'high'
        ? `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ea580c; margin-right: 6px; vertical-align: middle;"></span>`
        : `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${MUTED_COLOR}; margin-right: 6px; vertical-align: middle;"></span>`;

    contentHtml += `
      <tr>
        <td style="padding: 10px 12px; font-size: 14px; ${overdueStyle} border-bottom: 1px solid ${BORDER_COLOR};">
          ${priorityDot}${escapeHtml(item.content)}
          <br>
          <span style="font-size: 12px; color: ${item.isOverdue ? URGENT_COLOR : MUTED_COLOR};">
            Due: ${escapeHtml(item.due_date)}${item.isOverdue ? ' (OVERDUE)' : ''}
            ${item.assignee ? ` &middot; ${escapeHtml(item.assignee)}` : ''}
          </span>
        </td>
      </tr>`;
  }

  contentHtml += '</table>';

  const body = `
    ${headerRow('Todo Reminder', subtitle)}
    <tr>
      <td style="padding: 16px 32px 24px;">
        ${contentHtml}
      </td>
    </tr>`;

  return wrapHtml('DeepSeno - Todo Reminder', body);
}

// ---------- Daily Report Email ----------

interface DailyReportData {
  date: string;
  summary: string;
  timeline: any[];
  todos: any[];
  decisions: any[];
}

export function buildDailyReportEmail(data: DailyReportData): string {
  const { date, summary, timeline, todos, decisions } = data;

  let contentHtml = '';

  // Summary section
  contentHtml += sectionTitle('Summary');
  contentHtml += `<p style="margin: 0 0 16px; font-size: 14px; line-height: 1.6; color: ${BRAND_COLOR};">${escapeHtml(summary)}</p>`;

  // Timeline section
  if (timeline.length > 0) {
    contentHtml += sectionTitle('Timeline');
    contentHtml += '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">';
    for (const entry of timeline) {
      const time = entry.time || entry.start_time || '';
      const text = entry.event || entry.text || entry.content || '';
      contentHtml += `
        <tr>
          <td style="padding: 4px 12px 4px 0; font-size: 13px; color: ${MUTED_COLOR}; white-space: nowrap; vertical-align: top; font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;" width="60">
            ${escapeHtml(String(time))}
          </td>
          <td style="padding: 4px 0; font-size: 14px; color: ${BRAND_COLOR};">
            ${escapeHtml(String(text))}
          </td>
        </tr>`;
    }
    contentHtml += '</table>';
  }

  // Todos section
  if (todos.length > 0) {
    contentHtml += sectionTitle(`Todos (${todos.length})`);
    let todoHtml = '';
    for (const todo of todos) {
      const statusIcon = todo.status === 'done'
        ? `<span style="color: ${SUCCESS_COLOR};">&#10003;</span>`
        : `<span style="color: ${MUTED_COLOR};">&#9675;</span>`;
      todoHtml += `<tr><td style="padding: 4px 0; font-size: 14px; color: ${BRAND_COLOR};">${statusIcon} ${escapeHtml(todo.content)}</td></tr>`;
    }
    contentHtml += `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">${todoHtml}</table>`;
  }

  // Decisions section
  if (decisions.length > 0) {
    contentHtml += sectionTitle(`Decisions (${decisions.length})`);
    let decisionHtml = '';
    for (const d of decisions) {
      decisionHtml += `<tr><td style="padding: 4px 0; font-size: 14px; color: ${BRAND_COLOR};">&bull; ${escapeHtml(d.content)}</td></tr>`;
    }
    contentHtml += `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">${decisionHtml}</table>`;
  }

  const body = `
    ${headerRow('Daily Report', date)}
    <tr>
      <td style="padding: 16px 32px 24px;">
        ${contentHtml}
      </td>
    </tr>`;

  return wrapHtml(`DeepSeno Daily Report - ${date}`, body);
}

// ---------- Utility ----------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
