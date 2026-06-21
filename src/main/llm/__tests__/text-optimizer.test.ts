import { describe, it, expect, vi } from 'vitest';
import {
  buildCleanPrompt,
  buildExtractPrompt,
  buildDailySummaryPrompt,
  buildMonthlySummaryPrompt,
  buildMeetingNotesPrompt,
  TextOptimizer,
} from '../text-optimizer';
import type { MeetingSegment, MeetingNotes } from '../text-optimizer';

describe('buildCleanPrompt', () => {
  it('should include the raw text in the prompt', () => {
    const raw = '嗯那个我觉得这个方案可以啊';
    const prompt = buildCleanPrompt(raw);
    expect(prompt).toContain(raw);
  });

  it('should include instruction about removing filler words (语气词)', () => {
    const prompt = buildCleanPrompt('测试文本');
    expect(prompt).toContain('语气词');
  });

  it('should include instruction about punctuation (标点)', () => {
    const prompt = buildCleanPrompt('测试文本');
    expect(prompt).toContain('标点');
  });
});

describe('buildExtractPrompt', () => {
  it('should include the clean text in the prompt', () => {
    const text = '明天下午三点开会讨论新项目';
    const prompt = buildExtractPrompt(text);
    expect(prompt).toContain(text);
  });

  it('should mention todo extraction (待办)', () => {
    const prompt = buildExtractPrompt('任意文本');
    expect(prompt).toContain('待办');
  });

  it('should request JSON format output', () => {
    const prompt = buildExtractPrompt('任意文本');
    expect(prompt).toContain('JSON');
  });

  it('should mention all extraction types', () => {
    const prompt = buildExtractPrompt('任意文本');
    expect(prompt).toContain('meeting');
    expect(prompt).toContain('decision');
    expect(prompt).toContain('contact');
    expect(prompt).toContain('contact');
  });
});

describe('buildDailySummaryPrompt', () => {
  const segments = [
    { start: 0, end: 30, speaker: 'Alice', text: '我们开始讨论项目进度' },
    { start: 30, end: 65, speaker: 'Bob', text: '前端部分已经完成了百分之八十' },
  ];

  it('should include the date in the prompt', () => {
    const prompt = buildDailySummaryPrompt('2026-02-17', segments);
    expect(prompt).toContain('2026-02-17');
  });

  it('should include formatted timeline with speaker names', () => {
    const prompt = buildDailySummaryPrompt('2026-02-17', segments);
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('Bob');
  });

  it('should include formatted time strings in timeline', () => {
    const prompt = buildDailySummaryPrompt('2026-02-17', segments);
    // 0 seconds = 00:00:00, 30 seconds = 00:00:30
    expect(prompt).toContain('00:00:00');
    expect(prompt).toContain('00:00:30');
    // 65 seconds = 00:01:05
    expect(prompt).toContain('00:01:05');
  });

  it('should include segment text content', () => {
    const prompt = buildDailySummaryPrompt('2026-02-17', segments);
    expect(prompt).toContain('项目进度');
    expect(prompt).toContain('百分之八十');
  });
});

describe('buildMeetingNotesPrompt', () => {
  const segments: MeetingSegment[] = [
    { speaker: '张三', startTime: 0, endTime: 120, cleanText: '我们来讨论一下新产品的发布计划' },
    { speaker: '李四', startTime: 120, endTime: 300, cleanText: '前端开发已经完成，后端还需要两周' },
    { speaker: '张三', startTime: 300, endTime: 450, cleanText: '好的，那我们定在三月十五号上线' },
  ];
  const meta = { date: '2026-02-24', duration: 450 };

  it('should include all speaker names', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    expect(prompt).toContain('张三');
    expect(prompt).toContain('李四');
  });

  it('should include segment text content', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    expect(prompt).toContain('新产品的发布计划');
    expect(prompt).toContain('前端开发已经完成');
    expect(prompt).toContain('三月十五号上线');
  });

  it('should include date and duration', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    expect(prompt).toContain('2026-02-24');
    expect(prompt).toContain('7:30');
  });

  it('should request JSON format', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    expect(prompt).toContain('JSON');
  });

  it('should use MM:SS format for timestamps', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    // 0 seconds = 0:00, 120 seconds = 2:00, 300 seconds = 5:00
    expect(prompt).toContain('0:00');
    expect(prompt).toContain('2:00');
    expect(prompt).toContain('5:00');
  });

  it('should include speaker statistics', () => {
    const prompt = buildMeetingNotesPrompt(segments, meta);
    // 张三 total = 120 + 150 = 270s = 4:30, 李四 total = 180s = 3:00
    expect(prompt).toContain('4:30');
    expect(prompt).toContain('3:00');
  });
});

describe('TextOptimizer.generateMeetingNotes', () => {
  const segments: MeetingSegment[] = [
    { speaker: '张三', startTime: 0, endTime: 120, cleanText: '讨论产品发布计划' },
    { speaker: '李四', startTime: 120, endTime: 300, cleanText: '前端已完成，后端还需两周' },
    { speaker: '张三', startTime: 300, endTime: 450, cleanText: '定在三月十五号上线' },
  ];
  const meta = { date: '2026-02-24', duration: 450 };

  it('should return structured meeting notes', async () => {
    const mockNotes: MeetingNotes = {
      title: '产品发布计划会议',
      participants: [
        { name: '张三', speakingTime: 0 },
        { name: '李四', speakingTime: 0 },
      ],
      decisions: ['定在三月十五号上线'],
      actionItems: [{ assignee: '李四', task: '完成后端开发', dueDate: '2026-03-01' }],
      discussionSummary: '讨论了新产品的发布计划，确认前端已完成，后端还需两周。',
      keyTopics: ['产品发布', '开发进度'],
    };

    const mockClient = {
      generateJSON: vi.fn().mockResolvedValue(mockNotes),
    } as any;

    const optimizer = new TextOptimizer(mockClient, 'qwen2.5:14b');
    const result = await optimizer.generateMeetingNotes(segments, meta);

    expect(result.title).toBe('产品发布计划会议');
    expect(result.decisions).toContain('定在三月十五号上线');
    expect(result.actionItems).toHaveLength(1);
    expect(result.keyTopics).toContain('产品发布');
  });

  it('should merge speaker times from actual segment data', async () => {
    const mockNotes: MeetingNotes = {
      title: '测试会议',
      participants: [
        { name: '张三', speakingTime: 999 },
        { name: '李四', speakingTime: 999 },
      ],
      decisions: [],
      actionItems: [],
      discussionSummary: '测试',
      keyTopics: [],
    };

    const mockClient = {
      generateJSON: vi.fn().mockResolvedValue(mockNotes),
    } as any;

    const optimizer = new TextOptimizer(mockClient, 'qwen2.5:14b');
    const result = await optimizer.generateMeetingNotes(segments, meta);

    // 张三: (120-0) + (450-300) = 270s, 李四: (300-120) = 180s
    expect(result.participants.find((p) => p.name === '张三')?.speakingTime).toBe(270);
    expect(result.participants.find((p) => p.name === '李四')?.speakingTime).toBe(180);
  });

  it('should call generateJSON with correct parameters', async () => {
    const mockNotes: MeetingNotes = {
      title: '测试',
      participants: [],
      decisions: [],
      actionItems: [],
      discussionSummary: '测试',
      keyTopics: [],
    };

    const mockClient = {
      generateJSON: vi.fn().mockResolvedValue(mockNotes),
    } as any;

    const optimizer = new TextOptimizer(mockClient, 'qwen2.5:14b');
    await optimizer.generateMeetingNotes(segments, meta);

    expect(mockClient.generateJSON).toHaveBeenCalledTimes(1);
    const callArgs = mockClient.generateJSON.mock.calls[0][0];
    expect(callArgs.model).toBe('qwen2.5:14b');
    expect(callArgs.temperature).toBe(0.2);
    expect(callArgs.prompt).toContain('2026-02-24');
  });
});

describe('TextOptimizer cleanup-model routing', () => {
  // cleanText, batchClean and analyzeSentiment are mechanical tasks that should run
  // on a smaller model when the main model is heavy. extractInfo and
  // generateMeetingNotes need the main model because they require deeper reasoning.

  function makeOptimizer(generateMock: any, generateJSONMock?: any) {
    const mockClient = { generate: generateMock, generateJSON: generateJSONMock ?? vi.fn() } as any;
    const opt = new TextOptimizer(mockClient, 'qwen3.5:35b');
    return { opt, mockClient };
  }

  it('routes cleanText through the cleanup model with its keep_alive', async () => {
    const gen = vi.fn().mockResolvedValue('明天下午三点开会讨论新项目。');
    const { opt, mockClient } = makeOptimizer(gen);
    opt.setCleanupModel('qwen3.5:4b', '5m');

    await opt.cleanText('明天下午三点开会讨论新项目');

    expect(mockClient.generate).toHaveBeenCalledTimes(1);
    const args = mockClient.generate.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:4b');
    expect(args.keep_alive).toBe('5m');
  });

  it('routes batchClean through the cleanup model', async () => {
    const gen = vi.fn().mockResolvedValue('清洗后的文本');
    const { opt, mockClient } = makeOptimizer(gen);
    opt.setCleanupModel('qwen3.5:4b', '5m');

    await opt.batchClean('片段一。片段二。');

    expect(mockClient.generate).toHaveBeenCalled();
    const args = mockClient.generate.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:4b');
    expect(args.keep_alive).toBe('5m');
  });

  it('routes analyzeSentiment through the cleanup model', async () => {
    const gen = vi.fn();
    const genJSON = vi.fn().mockResolvedValue({ score: 0, label: 'neutral' });
    const { opt, mockClient } = makeOptimizer(gen, genJSON);
    opt.setCleanupModel('qwen3.5:4b', '5m');

    await opt.analyzeSentiment('一段测试文本');

    const args = mockClient.generateJSON.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:4b');
    expect(args.keep_alive).toBe('5m');
  });

  it('keeps extractInfo on the main model even when cleanup model is set', async () => {
    const gen = vi.fn();
    const genJSON = vi.fn().mockResolvedValue({ items: [], relationships: [] });
    const { opt, mockClient } = makeOptimizer(gen, genJSON);
    opt.setCleanupModel('qwen3.5:4b', '5m');

    await opt.extractInfo('任意短文本');

    const args = mockClient.generateJSON.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:35b');
    expect(args.keep_alive).toBeUndefined();
  });

  it('falls back to main model when cleanup model is not configured', async () => {
    const gen = vi.fn().mockResolvedValue('清洗后');
    const { opt, mockClient } = makeOptimizer(gen);
    // no setCleanupModel() call

    await opt.cleanText('原文');

    const args = mockClient.generate.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:35b');
    expect(args.keep_alive).toBeUndefined();
  });

  it('clears cleanup override when set to undefined', async () => {
    const gen = vi.fn().mockResolvedValue('结果');
    const { opt, mockClient } = makeOptimizer(gen);
    opt.setCleanupModel('qwen3.5:4b', '5m');
    opt.setCleanupModel(undefined);

    await opt.cleanText('原文');

    const args = mockClient.generate.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:35b');
  });

  it('lets an explicit keepAlive arg override the cleanup keepAlive', async () => {
    const gen = vi.fn().mockResolvedValue('结果');
    const { opt, mockClient } = makeOptimizer(gen);
    opt.setCleanupModel('qwen3.5:4b', '5m');

    await opt.cleanText('原文', undefined, '1h');

    const args = mockClient.generate.mock.calls[0][0];
    expect(args.model).toBe('qwen3.5:4b');
    expect(args.keep_alive).toBe('1h');
  });
});

describe('buildMonthlySummaryPrompt', () => {
  const dailies = [
    { date: '2026-05-01', summary: '启动新项目', todos: [{ content: '写方案' }], decisions: ['采用方案A'] },
    { date: '2026-05-15', summary: '完成第一阶段', todos: [], decisions: [] },
  ];

  it('should mention month report (月报) and the date range', () => {
    const prompt = buildMonthlySummaryPrompt('2026-05-01', '2026-05-31', dailies);
    expect(prompt).toContain('月报');
    expect(prompt).toContain('2026-05-01');
    expect(prompt).toContain('2026-05-31');
  });

  it('should embed each daily summary and request next_month_focus JSON', () => {
    const prompt = buildMonthlySummaryPrompt('2026-05-01', '2026-05-31', dailies);
    expect(prompt).toContain('启动新项目');
    expect(prompt).toContain('完成第一阶段');
    expect(prompt).toContain('next_month_focus');
    expect(prompt).toContain('JSON');
  });
});

describe('TextOptimizer.generateMonthlySummary', () => {
  it('returns the parsed MonthlySummaryResult from generateJSON', async () => {
    const mockResult = {
      summary: '本月概要',
      highlights: ['亮点1'],
      todos_summary: [{ content: '待办', status: 'pending' }],
      decisions: ['决策1'],
      next_month_focus: ['下月重点1'],
    };
    const mockClient = { generateJSON: vi.fn().mockResolvedValue(mockResult) } as any;
    const optimizer = new TextOptimizer(mockClient, 'qwen3.5:35b');

    const result = await optimizer.generateMonthlySummary('2026-05-01', '2026-05-31', [
      { date: '2026-05-01', summary: 'x', todos: [], decisions: [] },
    ]);

    expect(result).toEqual(mockResult);
    expect(mockClient.generateJSON).toHaveBeenCalledTimes(1);
    expect(mockClient.generateJSON.mock.calls[0][0].model).toBe('qwen3.5:35b');
  });
});
