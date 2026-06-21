import fs from 'fs';
import path from 'path';
import type { VoiceBrainDB } from '../db/database';

// ── 辅助函数 ──

export function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatWallClock(recordedAt: string, offsetSeconds: number): string {
  const base = new Date(recordedAt);
  if (isNaN(base.getTime())) return '';
  const wall = new Date(base.getTime() + offsetSeconds * 1000);
  const mm = String(wall.getMonth() + 1).padStart(2, '0');
  const dd = String(wall.getDate()).padStart(2, '0');
  const HH = String(wall.getHours()).padStart(2, '0');
  const MM = String(wall.getMinutes()).padStart(2, '0');
  const SS = String(wall.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${HH}:${MM}:${SS}`;
}

// ── MarkdownGenerator 类 ──

export class MarkdownGenerator {
  private useWikilinks: boolean;

  constructor(private outputDir: string, useWikilinks: boolean = false) {
    this.useWikilinks = useWikilinks;
  }

  /** Build an Obsidian wikilink [[path|display]] or regular markdown link */
  private link(target: string, display?: string): string {
    if (!this.useWikilinks) return display || target;
    return display ? `[[${target}|${display}]]` : `[[${target}]]`;
  }

  private buildFrontmatter(data: {
    title: string;
    date: string;
    tags?: string[];
    speakers?: string[];
    persons?: string[];
    type: 'daily-summary' | 'transcript' | 'weekly-summary' | 'monthly-summary';
  }): string {
    const lines = ['---'];
    lines.push(`title: "${data.title}"`);
    lines.push(`date: ${data.date}`);
    lines.push(`type: ${data.type}`);
    if (data.tags && data.tags.length > 0) {
      lines.push('tags:');
      for (const tag of data.tags) {
        lines.push(`  - ${tag}`);
      }
    }
    if (data.speakers && data.speakers.length > 0) {
      lines.push('speakers:');
      for (const spk of data.speakers) {
        lines.push(`  - "${spk}"`);
      }
    }
    if (data.persons && data.persons.length > 0) {
      lines.push('persons:');
      for (const person of data.persons) {
        lines.push(`  - "${person}"`);
      }
    }
    lines.push(`created: ${new Date().toISOString()}`);
    lines.push('---');
    lines.push('');
    return lines.join('\n');
  }

  buildDailySummary(data: {
    date: string;
    weekday: string;
    summary: string;
    timeline: Array<{ time: string; event: string; transcriptLink?: string }>;
    todos: Array<{ content: string; due_date?: string; person?: string }>;
    decisions: string[];
  }): string {
    const frontmatter = this.buildFrontmatter({
      title: `${data.date} ${data.weekday} 日报`,
      date: data.date,
      tags: ['daily-summary', 'deepseno'],
      type: 'daily-summary',
    });

    const lines: string[] = [frontmatter];

    lines.push(`# ${data.date} ${data.weekday} 日报`);
    lines.push('');
    lines.push('## 概要');
    lines.push('');
    lines.push(data.summary);
    lines.push('');

    lines.push('## 时间线');
    lines.push('');
    for (const item of data.timeline) {
      const link = item.transcriptLink
        ? (this.useWikilinks ? ` ${this.link(item.transcriptLink, '详情')}` : ` [详情](${item.transcriptLink})`)
        : '';
      lines.push(`- **${item.time}** ${item.event}${link}`);
    }
    lines.push('');

    lines.push('## 待办事项');
    lines.push('');
    if (data.todos.length === 0) {
      lines.push('_无待办事项_');
    } else {
      for (const todo of data.todos) {
        const due = todo.due_date ? ` (截止: ${todo.due_date})` : '';
        const person = todo.person ? ` @${todo.person}` : '';
        lines.push(`- [ ] ${todo.content}${due}${person}`);
      }
    }
    lines.push('');

    lines.push('## 决策记录');
    lines.push('');
    if (data.decisions.length === 0) {
      lines.push('_无决策记录_');
    } else {
      for (const decision of data.decisions) {
        lines.push(`- ${decision}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  buildTranscript(data: {
    date: string;
    title: string;
    captureScene?: string;
    recordedAt?: string;
    segments: Array<{
      start: number;
      end: number;
      speaker: string;
      text: string;
      clean_text?: string;
      source?: string;
    }>;
  }): string {
    const isDocument = ['pdf', 'docx', 'text'].includes(data.captureScene || '');
    const speakers = isDocument ? [] : [...new Set(data.segments.map((s) => s.speaker).filter(Boolean))];
    const typeTag = isDocument ? 'document' : 'transcript';
    const frontmatter = this.buildFrontmatter({
      title: data.title,
      date: data.date,
      tags: [typeTag, 'deepseno'],
      speakers: speakers.length > 0 ? speakers : undefined,
      type: 'transcript',
    });

    const lines: string[] = [frontmatter];

    lines.push(`# ${data.title}`);
    lines.push('');
    lines.push(`> 日期: ${data.date}`);
    if (data.captureScene && data.captureScene !== 'dictation') {
      const sceneLabels: Record<string, string> = {
        local_meeting: '现场会议',
        online_meeting: '线上会议',
        media: '媒体转写',
        monitor: '系统监听',
        pdf: 'PDF 文档',
        docx: 'Word 文档',
        text: '文本文件',
      };
      lines.push(`> **模式**: ${sceneLabels[data.captureScene] || data.captureScene}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    if (isDocument) {
      // Document mode: output clean text paragraphs without timestamps/speakers
      for (const seg of data.segments) {
        const displayText = seg.clean_text || seg.text;
        lines.push(displayText);
        lines.push('');
      }
    } else {
      // Audio/video mode: include timestamps and speaker labels
      for (const seg of data.segments) {
        const startStr = formatTime(seg.start);
        const endStr = formatTime(seg.end);
        const displayText = seg.clean_text || seg.text;
        const speakerName = seg.speaker || (seg.source === 'system' ? '对方' : '我');
        const wallStr = data.recordedAt ? formatWallClock(data.recordedAt, seg.start) : '';
        const timeLabel = wallStr ? `${startStr} / ${wallStr}` : startStr;
        lines.push(`**[${timeLabel} - ${endStr}] ${speakerName}:**`);
        lines.push('');
        lines.push(displayText);
        lines.push('');
      }
    }

    // Backlink to daily summary
    if (this.useWikilinks) {
      lines.push('---');
      lines.push('');
      lines.push(`> ${this.link(`daily/${data.date}`, `${data.date} 日报`)}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  buildWeeklySummary(data: {
    startDate: string;
    endDate: string;
    summary: string;
    highlights: string[];
    todos_summary: Array<{ content: string; status?: string; person?: string }>;
    decisions: string[];
    next_week_focus: string[];
  }): string {
    const frontmatter = this.buildFrontmatter({
      title: `周报 ${data.startDate} ~ ${data.endDate}`,
      date: data.startDate,
      tags: ['weekly-summary', 'deepseno'],
      type: 'weekly-summary',
    });

    const lines: string[] = [frontmatter];

    lines.push(`# 周报 ${data.startDate} ~ ${data.endDate}`);
    lines.push('');
    lines.push('## 本周概要');
    lines.push('');
    lines.push(data.summary);
    lines.push('');

    lines.push('## 本周亮点');
    lines.push('');
    if (data.highlights.length === 0) {
      lines.push('_无_');
    } else {
      for (const h of data.highlights) {
        lines.push(`- ${h}`);
      }
    }
    lines.push('');

    lines.push('## 待办事项汇总');
    lines.push('');
    if (data.todos_summary.length === 0) {
      lines.push('_无待办事项_');
    } else {
      for (const todo of data.todos_summary) {
        const status = todo.status === 'completed' ? '[x]' : '[ ]';
        const person = todo.person ? ` @${todo.person}` : '';
        lines.push(`- ${status} ${todo.content}${person}`);
      }
    }
    lines.push('');

    lines.push('## 决策记录');
    lines.push('');
    if (data.decisions.length === 0) {
      lines.push('_无决策记录_');
    } else {
      for (const d of data.decisions) {
        lines.push(`- ${d}`);
      }
    }
    lines.push('');

    lines.push('## 下周重点');
    lines.push('');
    if (data.next_week_focus.length === 0) {
      lines.push('_待定_');
    } else {
      for (const f of data.next_week_focus) {
        lines.push(`- ${f}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  buildMonthlySummary(data: {
    startDate: string;
    endDate: string;
    summary: string;
    highlights: string[];
    todos_summary: Array<{ content: string; status?: string; person?: string }>;
    decisions: string[];
    next_month_focus: string[];
  }): string {
    const frontmatter = this.buildFrontmatter({
      title: `月报 ${data.startDate} ~ ${data.endDate}`,
      date: data.startDate,
      tags: ['monthly-summary', 'deepseno'],
      type: 'monthly-summary',
    });

    const lines: string[] = [frontmatter];

    lines.push(`# 月报 ${data.startDate} ~ ${data.endDate}`);
    lines.push('');
    lines.push('## 本月概要');
    lines.push('');
    lines.push(data.summary);
    lines.push('');

    lines.push('## 本月亮点');
    lines.push('');
    if (data.highlights.length === 0) {
      lines.push('_无_');
    } else {
      for (const h of data.highlights) {
        lines.push(`- ${h}`);
      }
    }
    lines.push('');

    lines.push('## 待办事项汇总');
    lines.push('');
    if (data.todos_summary.length === 0) {
      lines.push('_无待办事项_');
    } else {
      for (const todo of data.todos_summary) {
        const status = todo.status === 'completed' ? '[x]' : '[ ]';
        const person = todo.person ? ` @${todo.person}` : '';
        lines.push(`- ${status} ${todo.content}${person}`);
      }
    }
    lines.push('');

    lines.push('## 决策记录');
    lines.push('');
    if (data.decisions.length === 0) {
      lines.push('_无决策记录_');
    } else {
      for (const d of data.decisions) {
        lines.push(`- ${d}`);
      }
    }
    lines.push('');

    lines.push('## 下月重点');
    lines.push('');
    if (data.next_month_focus.length === 0) {
      lines.push('_待定_');
    } else {
      for (const f of data.next_month_focus) {
        lines.push(`- ${f}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  buildMeetingNotes(data: {
    date: string;
    title: string;
    duration: number;
    participants: Array<{ name: string; speakingTime: number }>;
    decisions: string[];
    actionItems: Array<{ assignee: string; task: string; dueDate?: string }>;
    discussionSummary: string;
    keyTopics: string[];
  }): string {
    const frontmatter = this.buildFrontmatter({
      title: data.title,
      date: data.date,
      tags: ['meeting-notes', 'deepseno'],
      speakers: data.participants.map(p => p.name),
      type: 'transcript', // reuse transcript type for Obsidian compatibility
    });

    const lines: string[] = [frontmatter];

    lines.push(`# ${data.title}`);
    lines.push('');
    lines.push(`> ${data.date} · ${Math.round(data.duration / 60)} min · ${data.participants.length} participants`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Participants
    lines.push('## Participants');
    lines.push('');
    for (const p of data.participants) {
      const min = Math.floor(p.speakingTime / 60);
      const sec = Math.floor(p.speakingTime % 60);
      const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
      lines.push(`- **${p.name}** (${timeStr})`);
    }
    lines.push('');

    // Key Decisions
    lines.push('## Key Decisions');
    lines.push('');
    if (data.decisions.length === 0) {
      lines.push('_None_');
    } else {
      for (let i = 0; i < data.decisions.length; i++) {
        lines.push(`${i + 1}. ${data.decisions[i]}`);
      }
    }
    lines.push('');

    // Action Items
    lines.push('## Action Items');
    lines.push('');
    if (data.actionItems.length === 0) {
      lines.push('_None_');
    } else {
      for (const item of data.actionItems) {
        const due = item.dueDate ? ` (due: ${item.dueDate})` : '';
        lines.push(`- [ ] **${item.assignee}**: ${item.task}${due}`);
      }
    }
    lines.push('');

    // Discussion Summary
    lines.push('## Discussion Summary');
    lines.push('');
    lines.push(data.discussionSummary);
    lines.push('');

    // Key Topics
    if (data.keyTopics.length > 0) {
      lines.push('## Key Topics');
      lines.push('');
      lines.push(data.keyTopics.map(t => `\`${t}\``).join(' · '));
      lines.push('');
    }

    return lines.join('\n');
  }

  writeMeetingNotes(date: string, fileName: string, content: string): string {
    const filePath = path.join(this.outputDir, 'meeting-notes', date, `${fileName}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  writeDailySummary(date: string, content: string): string {
    const filePath = path.join(this.outputDir, 'daily', `${date}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  writeTranscript(date: string, fileName: string, content: string): string {
    const filePath = path.join(this.outputDir, 'transcripts', date, `${fileName}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  writeWeeklySummary(startDate: string, content: string): string {
    const filePath = path.join(this.outputDir, 'weekly', `${startDate}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  writeMonthlySummary(startDate: string, content: string): string {
    const filePath = path.join(this.outputDir, 'monthly', `${startDate}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Build and write a Map of Content (MOC) index for Obsidian vault */
  updateMOC(entries: Array<{
    type: 'transcript' | 'daily-summary' | 'weekly-summary' | 'monthly-summary';
    date: string;
    title: string;
    relativePath: string;
  }>): string {
    const lines: string[] = [
      '---',
      'title: "DeepSeno Index"',
      'type: moc',
      'tags:',
      '  - deepseno',
      '  - moc',
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
      '# DeepSeno 索引',
      '',
    ];

    // Group by type
    const dailies = entries.filter((e) => e.type === 'daily-summary').sort((a, b) => b.date.localeCompare(a.date));
    const weeklies = entries.filter((e) => e.type === 'weekly-summary').sort((a, b) => b.date.localeCompare(a.date));
    const monthlies = entries.filter((e) => e.type === 'monthly-summary').sort((a, b) => b.date.localeCompare(a.date));
    const transcripts = entries.filter((e) => e.type === 'transcript').sort((a, b) => b.date.localeCompare(a.date));

    if (dailies.length > 0) {
      lines.push('## 日报');
      lines.push('');
      for (const e of dailies) {
        lines.push(`- ${this.link(e.relativePath, e.title)}`);
      }
      lines.push('');
    }

    if (weeklies.length > 0) {
      lines.push('## 周报');
      lines.push('');
      for (const e of weeklies) {
        lines.push(`- ${this.link(e.relativePath, e.title)}`);
      }
      lines.push('');
    }

    if (monthlies.length > 0) {
      lines.push('## 月报');
      lines.push('');
      for (const e of monthlies) {
        lines.push(`- ${this.link(e.relativePath, e.title)}`);
      }
      lines.push('');
    }

    if (transcripts.length > 0) {
      lines.push('## 转录记录');
      lines.push('');
      // Group transcripts by month
      const byMonth = new Map<string, typeof transcripts>();
      for (const e of transcripts) {
        const month = e.date.slice(0, 7); // YYYY-MM
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month)!.push(e);
      }
      for (const [month, items] of byMonth) {
        lines.push(`### ${month}`);
        lines.push('');
        for (const e of items) {
          lines.push(`- ${this.link(e.relativePath, e.title)}`);
        }
        lines.push('');
      }
    }

    const filePath = path.join(this.outputDir, 'DeepSeno MOC.md');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  /** Sync a file to an Obsidian vault directory (copy with same relative structure) */
  static syncToVault(sourceOutputDir: string, vaultDir: string, relativePath: string): string {
    const src = path.join(sourceOutputDir, relativePath);
    const dest = path.join(vaultDir, 'DeepSeno', relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return dest;
  }

  /** Generate an Obsidian-compatible Markdown file for a person */
  generatePersonFile(
    person: {
      name: string | null;
      company: string | null;
      title: string | null;
      tags: string | null; // JSON array string
      profile_markdown: string | null;
      created_at: string;
    },
    identifiers: {
      type: string;
      value: string | null;
    }[],
    recentContent: {
      role: string;
      file_name: string;
    }[]
  ): string {
    const displayName = person.name || 'Unknown';
    const lines: string[] = ['---'];

    // title
    lines.push(`title: "${displayName}"`);

    // aliases from name_alias identifiers
    const aliases = identifiers
      .filter((id) => id.type === 'name_alias' && id.value)
      .map((id) => id.value!);
    if (aliases.length > 0) {
      lines.push('aliases:');
      for (const alias of aliases) {
        lines.push(`  - "${alias}"`);
      }
    }

    // phone, wechat, email from identifiers
    const phone = identifiers.find((id) => id.type === 'phone' && id.value);
    if (phone) lines.push(`phone: "${phone.value}"`);

    const wechat = identifiers.find((id) => id.type === 'wechat' && id.value);
    if (wechat) lines.push(`wechat: "${wechat.value}"`);

    const email = identifiers.find((id) => id.type === 'email' && id.value);
    if (email) lines.push(`email: "${email.value}"`);

    // company
    if (person.company) {
      lines.push(`company: "${person.company}"`);
    }

    // title_role (not "title" to avoid YAML conflict)
    if (person.title) {
      lines.push(`title_role: "${person.title}"`);
    }

    // tags from JSON array string
    let parsedTags: string[] = [];
    if (person.tags) {
      try {
        parsedTags = JSON.parse(person.tags);
      } catch {
        // ignore malformed tags JSON
      }
    }
    if (parsedTags.length > 0) {
      lines.push(`tags: ${JSON.stringify(parsedTags)}`);
    }

    // created date
    const createdDate = person.created_at ? person.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    lines.push(`created: ${createdDate}`);

    lines.push('---');
    lines.push('');

    // Body: h1 with person name
    lines.push(`# ${displayName}`);
    lines.push('');

    // Profile markdown content
    if (person.profile_markdown) {
      lines.push(person.profile_markdown);
      lines.push('');
    }

    // Recent Interactions
    if (recentContent.length > 0) {
      lines.push('## Recent Interactions');
      lines.push('');
      // Deduplicate by file_name, keep first occurrence (most recent)
      const seen = new Set<string>();
      for (const item of recentContent) {
        if (seen.has(item.file_name)) continue;
        seen.add(item.file_name);
        const baseName = item.file_name.replace(/\.[^/.]+$/, '');
        if (this.useWikilinks) {
          lines.push(`- [[${baseName}]] (${item.role})`);
        } else {
          lines.push(`- ${baseName} (${item.role})`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Write a person file to the People/ subdirectory */
  writePersonFile(personName: string | null, personId: number, content: string): string {
    const fileName = personName || `PERSON-${personId}`;
    const filePath = path.join(this.outputDir, 'People', `${fileName}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Sync entire output directory to Obsidian vault */
  static syncAllToVault(sourceOutputDir: string, vaultDir: string): number {
    const vbDir = path.join(vaultDir, 'DeepSeno');
    fs.mkdirSync(vbDir, { recursive: true });

    let count = 0;
    function walkSync(dir: string, rel: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(dir, entry.name);
        const relPath = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walkSync(srcPath, relPath);
        } else if (entry.name.endsWith('.md')) {
          const destPath = path.join(vbDir, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          count++;
        }
      }
    }
    walkSync(sourceOutputDir, '');
    return count;
  }

  /** Build a knowledge page markdown string with YAML frontmatter */
  static buildKnowledgePage(page: {
    title: string;
    type: string;
    content_markdown: string;
    tags: string;
    last_compiled_at: string;
    source_recording_ids: string;
    slug: string;
  }, useWikilinks: boolean = true): string {
    const tags = JSON.parse(page.tags || '[]');
    const recCount = JSON.parse(page.source_recording_ids || '[]').length;

    const frontmatter = [
      '---',
      `title: "${page.title}"`,
      `type: ${page.type}`,
      `tags: [${[page.type, ...tags].join(', ')}]`,
      `last_compiled: ${page.last_compiled_at?.split('T')[0] || 'unknown'}`,
      `source_recordings: ${recCount}`,
      '---',
    ].join('\n');

    let content = page.content_markdown;

    // Convert [[type/name]] to Obsidian wikilinks [[name]]
    if (useWikilinks) {
      content = content.replace(/\[\[([^\]]+\/)?([^\]]+)\]\]/g, '[[$2]]');
    }

    return `${frontmatter}\n\n# ${page.title}\n\n${content}\n`;
  }

  /** Sync knowledge pages to an Obsidian vault directory and generate a MOC index */
  static async syncKnowledgePagesToVault(
    pages: Array<{
      title: string;
      type: string;
      content_markdown: string;
      tags: string;
      last_compiled_at: string;
      source_recording_ids: string;
      slug: string;
    }>,
    vaultDir: string,
    useWikilinks: boolean = true,
  ): Promise<number> {
    const knowledgeDir = path.join(vaultDir, 'DeepSeno', 'Knowledge');

    for (const type of ['person', 'topic', 'project', 'concept']) {
      const typeDir = path.join(knowledgeDir, type);
      if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });
    }

    let synced = 0;
    for (const page of pages) {
      const md = MarkdownGenerator.buildKnowledgePage(page, useWikilinks);
      const safeName = page.title.replace(/[/\\:*?"<>|]/g, '_');
      const filePath = path.join(knowledgeDir, page.type, `${safeName}.md`);
      fs.writeFileSync(filePath, md, 'utf-8');
      synced++;
    }

    // Generate MOC (Map of Content)
    const mocLines = ['# Knowledge Base\n'];
    for (const type of ['person', 'topic', 'project', 'concept']) {
      const typePages = pages.filter(p => p.type === type);
      if (typePages.length === 0) continue;
      mocLines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}\n`);
      for (const p of typePages) {
        mocLines.push(`- [[${p.title}]]`);
      }
      mocLines.push('');
    }
    fs.writeFileSync(path.join(knowledgeDir, 'index.md'), mocLines.join('\n'), 'utf-8');

    return synced;
  }
}

// ── Standalone export function ──

/**
 * Export all persons from the database as Obsidian-compatible Markdown files
 * into {outputDir}/People/{person_name}.md
 */
export function exportAllPersonFiles(outputDir: string, db: VoiceBrainDB, useWikilinks: boolean = true): number {
  const generator = new MarkdownGenerator(outputDir, useWikilinks);
  const persons = db.getAllPersons();

  let count = 0;
  for (const person of persons) {
    const identifiers = db.getPersonIdentifiers(person.id);
    const rawContent = db.getContentByPerson(person.id, 20);
    const recentContent = rawContent.map((c) => ({
      role: c.role,
      file_name: c.file_name,
    }));

    const content = generator.generatePersonFile(person, identifiers, recentContent);
    generator.writePersonFile(person.name, person.id, content);
    count++;
  }

  return count;
}
