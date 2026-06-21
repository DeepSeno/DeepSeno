import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MarkdownGenerator, formatTime } from '../markdown-generator';

describe('formatTime', () => {
  it('should format 0 seconds as 00:00:00', () => {
    expect(formatTime(0)).toBe('00:00:00');
  });

  it('should format seconds correctly', () => {
    expect(formatTime(65)).toBe('00:01:05');
  });

  it('should format hours correctly', () => {
    expect(formatTime(3661)).toBe('01:01:01');
  });
});

describe('MarkdownGenerator', () => {
  let tmpDir: string;
  let generator: MarkdownGenerator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseno-test-'));
    generator = new MarkdownGenerator(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildDailySummary', () => {
    const sampleData = {
      date: '2026-02-17',
      weekday: '星期二',
      summary: '今天主要讨论了项目进度和下一步计划。',
      timeline: [
        { time: '09:00', event: '晨会讨论项目进度', transcriptLink: './transcripts/2026-02-17/morning.md' },
        { time: '14:00', event: '技术方案评审' },
      ],
      todos: [
        { content: '完成前端页面开发', due_date: '2026-02-20', person: '张三' },
        { content: '准备周报' },
      ],
      decisions: ['采用 React 框架', '下周一发布 v1.0'],
    };

    it('should include the date and weekday in the title', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('2026-02-17');
      expect(md).toContain('星期二');
    });

    it('should include the summary section', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('## 概要');
      expect(md).toContain('项目进度');
    });

    it('should include timeline items', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('## 时间线');
      expect(md).toContain('09:00');
      expect(md).toContain('晨会讨论项目进度');
      expect(md).toContain('14:00');
      expect(md).toContain('技术方案评审');
    });

    it('should include transcript links when provided', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('[详情]');
      expect(md).toContain('morning.md');
    });

    it('should include todo items with checkbox format', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('## 待办事项');
      expect(md).toContain('- [ ] 完成前端页面开发');
      expect(md).toContain('截止: 2026-02-20');
      expect(md).toContain('@张三');
    });

    it('should include decision records', () => {
      const md = generator.buildDailySummary(sampleData);
      expect(md).toContain('## 决策记录');
      expect(md).toContain('采用 React 框架');
      expect(md).toContain('下周一发布 v1.0');
    });

    it('should show placeholder when no todos', () => {
      const md = generator.buildDailySummary({ ...sampleData, todos: [] });
      expect(md).toContain('_无待办事项_');
    });

    it('should show placeholder when no decisions', () => {
      const md = generator.buildDailySummary({ ...sampleData, decisions: [] });
      expect(md).toContain('_无决策记录_');
    });
  });

  describe('buildTranscript', () => {
    const sampleData = {
      date: '2026-02-17',
      title: '晨会记录',
      segments: [
        { start: 0, end: 15, speaker: 'Alice', text: '大家早上好', clean_text: '大家早上好。' },
        { start: 15, end: 45, speaker: 'Bob', text: '我来汇报一下进度' },
      ],
    };

    it('should include the title', () => {
      const md = generator.buildTranscript(sampleData);
      expect(md).toContain('# 晨会记录');
    });

    it('should include the date', () => {
      const md = generator.buildTranscript(sampleData);
      expect(md).toContain('2026-02-17');
    });

    it('should include speaker names', () => {
      const md = generator.buildTranscript(sampleData);
      expect(md).toContain('Alice');
      expect(md).toContain('Bob');
    });

    it('should include segment text', () => {
      const md = generator.buildTranscript(sampleData);
      // clean_text is preferred when available
      expect(md).toContain('大家早上好。');
      expect(md).toContain('我来汇报一下进度');
    });

    it('should include formatted timestamps', () => {
      const md = generator.buildTranscript(sampleData);
      expect(md).toContain('00:00:00');
      expect(md).toContain('00:00:15');
      expect(md).toContain('00:00:45');
    });
  });

  describe('buildTranscript (document mode)', () => {
    it('should omit timestamps and speakers for PDF captureScene', () => {
      const md = generator.buildTranscript({
        date: '2026-03-10',
        title: 'test-document',
        captureScene: 'pdf',
        segments: [
          { start: 0, end: 0, speaker: '', text: 'First paragraph content.', clean_text: 'First paragraph cleaned.' },
          { start: 0, end: 0, speaker: '', text: 'Second paragraph content.' },
        ],
      });
      expect(md).toContain('# test-document');
      expect(md).toContain('PDF 文档');
      expect(md).toContain('First paragraph cleaned.');
      expect(md).toContain('Second paragraph content.');
      // Should NOT have timestamp formatting
      expect(md).not.toContain('00:00:00');
      expect(md).not.toContain('**[');
    });

    it('should use document tag in frontmatter for docx', () => {
      const md = generator.buildTranscript({
        date: '2026-03-10',
        title: 'word-doc',
        captureScene: 'docx',
        segments: [{ start: 0, end: 0, speaker: '', text: 'Content.' }],
      });
      expect(md).toContain('- document');
      expect(md).not.toContain('- transcript');
      expect(md).toContain('Word 文档');
    });

    it('should use document tag for text captureScene', () => {
      const md = generator.buildTranscript({
        date: '2026-03-10',
        title: 'notes',
        captureScene: 'text',
        segments: [{ start: 0, end: 0, speaker: '', text: 'Plain text.' }],
      });
      expect(md).toContain('- document');
      expect(md).toContain('文本文件');
    });

    it('should still use timestamps for audio captureScene', () => {
      const md = generator.buildTranscript({
        date: '2026-03-10',
        title: 'audio-transcript',
        segments: [
          { start: 10, end: 25, speaker: 'Alice', text: 'Hello' },
        ],
      });
      expect(md).toContain('00:00:10');
      expect(md).toContain('Alice');
      expect(md).toContain('**[');
    });
  });

  describe('writeDailySummary', () => {
    it('should write the file to the correct path', () => {
      const content = '# Test Daily Summary';
      const filePath = generator.writeDailySummary('2026-02-17', content);

      const expectedPath = path.join(tmpDir, 'daily', '2026-02-17.md');
      expect(filePath).toBe(expectedPath);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    });

    it('should create nested directories automatically', () => {
      const content = '# Another Summary';
      const filePath = generator.writeDailySummary('2026-03-01', content);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('writeTranscript', () => {
    it('should write the file to the correct path', () => {
      const content = '# Test Transcript';
      const filePath = generator.writeTranscript('2026-02-17', 'morning-meeting', content);

      const expectedPath = path.join(tmpDir, 'transcripts', '2026-02-17', 'morning-meeting.md');
      expect(filePath).toBe(expectedPath);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    });

    it('should create nested directories automatically', () => {
      const content = '# Another Transcript';
      const filePath = generator.writeTranscript('2026-03-01', 'standup', content);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
