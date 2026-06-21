// DEPRECATED: Tests for the old ReportScheduler. Replaced by TaskScheduler + predefined-actions.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Mock electron before importing ReportScheduler
vi.mock('electron', () => ({
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    on: vi.fn(),
  })),
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

// Mock settings
const mockSettings = {
  language: 'zh' as const,
  feishuEnabled: false,
  feishuAdminOpenId: '',
  feishuNotifyOnComplete: false,
  feishuNotifyDailyDigest: false,
  wechatEnabled: false,
  wechatCorpId: '',
  wechatAgentId: '',
  wechatSecret: '',
  autoReportDaily: false,
  autoReportDailyTime: '22:00',
  autoReportWeekly: false,
  autoReportWeeklyDay: 5,
  autoReportWeeklyTime: '22:00',
  llmProvider: 'local' as const,
  cloudApiUrl: '',
  cloudApiKey: '',
  cloudModel: '',
  cloudEmbedModel: '',
  whisperModel: 'sensevoice',
  llmModel: 'qwen2.5:14b',
  embedModel: 'bge-m3',
  hfToken: '',
  obsidianAutoExport: false,
  obsidianWikilinks: true,
  feishuAppId: '',
  feishuAppSecret: '',
  soulConfig: '',
  agentsRules: '',
  setupComplete: true,
  watchDir: '',
  outputDir: '/tmp/deepseno-test',
  obsidianVaultDir: '',
  recordingShortcut: 'Alt+,',
  autoPasteAfterRecording: true,
  clipboardContinuous: true,
  llmCleanBeforePaste: true,
  llmCleanPrompt: '',
  hotwords: [] as string[],
  streamingModel: 'base',
  showAllFeatures: true,
  firstLaunchTime: 0,
  licenseKey: '',
};

vi.mock('../settings', () => ({
  loadSettings: vi.fn(() => ({ ...mockSettings })),
}));

vi.mock('../db/database', () => ({
  VoiceBrainDB: vi.fn(),
}));

vi.mock('../llm/create-client', () => ({
  createLLMClient: vi.fn(),
  getLLMModel: vi.fn().mockReturnValue('qwen2.5:14b'),
}));

vi.mock('../paths', () => ({
  getDbPath: vi.fn().mockReturnValue('/tmp/test.db'),
  getOutputDir: vi.fn().mockReturnValue('/tmp/deepseno-test'),
}));

vi.mock('../feishu/card-builder', () => ({
  buildDailySummaryCard: vi.fn().mockReturnValue('{"card":"mock"}'),
}));

import { ReportScheduler } from '../scheduler/report-scheduler';
import { loadSettings } from '../settings';
import type { InsightEngine, Insight } from '../agent/insight-engine';
import type { MessageRouter } from '../channels/router';

function createMockInsightEngine(insights: Insight[] = []): InsightEngine {
  return {
    scan: vi.fn().mockResolvedValue(insights),
  } as unknown as InsightEngine;
}

function createMockRouter(): MessageRouter & { sendText: ReturnType<typeof vi.fn>; sendCard: ReturnType<typeof vi.fn> } {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessageRouter & { sendText: ReturnType<typeof vi.fn>; sendCard: ReturnType<typeof vi.fn> };
}

describe('ReportScheduler', () => {
  let scheduler: ReportScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockSettings to defaults
    mockSettings.feishuEnabled = false;
    mockSettings.feishuAdminOpenId = '';
    mockSettings.wechatEnabled = false;
    mockSettings.wechatCorpId = '';
    scheduler = new ReportScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  // ─── setInsightEngine / setRouter ──────────────────────────

  describe('setInsightEngine and setRouter', () => {
    it('stores InsightEngine dependency', () => {
      const engine = createMockInsightEngine();
      scheduler.setInsightEngine(engine);
      // Verify it's stored by triggering scanInsights (indirectly via checkAndRun)
      // The engine is private, so we verify it works through behavior
      expect(() => scheduler.setInsightEngine(engine)).not.toThrow();
    });

    it('stores MessageRouter dependency', () => {
      const router = createMockRouter();
      scheduler.setRouter(router);
      expect(() => scheduler.setRouter(router)).not.toThrow();
    });
  });

  // ─── scanInsights ──────────────────────────────────────────

  describe('scanInsights (via checkAndRun)', () => {
    it('pushes insights to feishu when enabled', async () => {
      const insights: Insight[] = [
        { type: 'todo_reminder', title: '待办即将到期', detail: '测试待办', urgency: 'high' },
      ];
      const engine = createMockInsightEngine(insights);
      const router = createMockRouter();

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin123';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      // Access private method via type cast
      await (scheduler as any).scanInsights();

      expect(engine.scan).toHaveBeenCalled();
      expect(router.sendText).toHaveBeenCalledWith(
        'feishu',
        'ou_admin123',
        expect.stringContaining('待办即将到期'),
      );
    });

    it('pushes insights to wechat when enabled', async () => {
      const insights: Insight[] = [
        { type: 'anomaly', title: '逾期待办', detail: '3个待办已过截止日期', urgency: 'high' },
      ];
      const engine = createMockInsightEngine(insights);
      const router = createMockRouter();

      mockSettings.wechatEnabled = true;
      mockSettings.wechatCorpId = 'wk_corp123';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      expect(router.sendText).toHaveBeenCalledWith(
        'wechat',
        '@all',
        expect.stringContaining('逾期待办'),
      );
    });

    it('pushes to both feishu and wechat when both enabled', async () => {
      const insights: Insight[] = [
        { type: 'todo_reminder', title: '提醒', detail: '测试', urgency: 'medium' },
      ];
      const engine = createMockInsightEngine(insights);
      const router = createMockRouter();

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';
      mockSettings.wechatEnabled = true;
      mockSettings.wechatCorpId = 'wk_corp';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      expect(router.sendText).toHaveBeenCalledTimes(2);
      expect(router.sendText).toHaveBeenCalledWith('feishu', 'ou_admin', expect.any(String));
      expect(router.sendText).toHaveBeenCalledWith('wechat', '@all', expect.any(String));
    });

    it('does nothing when no insights found', async () => {
      const engine = createMockInsightEngine([]); // empty insights
      const router = createMockRouter();

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      expect(engine.scan).toHaveBeenCalled();
      expect(router.sendText).not.toHaveBeenCalled();
    });

    it('does nothing when no InsightEngine set', async () => {
      const router = createMockRouter();
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      expect(router.sendText).not.toHaveBeenCalled();
    });

    it('formats high urgency insights with exclamation mark', async () => {
      const insights: Insight[] = [
        { type: 'todo_reminder', title: 'Urgent', detail: 'Due now', urgency: 'high' },
      ];
      const engine = createMockInsightEngine(insights);
      const router = createMockRouter();

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      const sentText = router.sendText.mock.calls[0][2];
      expect(sentText).toContain('❗');
      expect(sentText).toContain('Urgent');
      expect(sentText).toContain('Due now');
    });

    it('formats non-high urgency insights with info icon', async () => {
      const insights: Insight[] = [
        { type: 'person_frequency', title: 'Info', detail: 'Some detail', urgency: 'low' },
      ];
      const engine = createMockInsightEngine(insights);
      const router = createMockRouter();

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';

      scheduler.setInsightEngine(engine);
      scheduler.setRouter(router);

      await (scheduler as any).scanInsights();

      const sentText = router.sendText.mock.calls[0][2];
      expect(sentText).toContain('ℹ️');
      expect(sentText).toContain('Info');
    });
  });

  // ─── pushToChannels error handling ─────────────────────────

  describe('pushToChannels error handling', () => {
    it('handles feishu push error gracefully', async () => {
      const router = createMockRouter();
      router.sendText.mockRejectedValueOnce(new Error('Feishu API error'));

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';

      scheduler.setRouter(router);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw
      await (scheduler as any).pushToChannels('test message', { ...mockSettings });

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ReportScheduler] Feishu push failed:',
        'Feishu API error',
      );
      consoleSpy.mockRestore();
    });

    it('handles wechat push error gracefully', async () => {
      const router = createMockRouter();
      router.sendText.mockRejectedValueOnce(new Error('WeChat API error'));

      mockSettings.wechatEnabled = true;
      mockSettings.wechatCorpId = 'wk_corp';

      scheduler.setRouter(router);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await (scheduler as any).pushToChannels('test message', { ...mockSettings });

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ReportScheduler] WeChat push failed:',
        'WeChat API error',
      );
      consoleSpy.mockRestore();
    });

    it('continues to wechat even if feishu fails', async () => {
      const router = createMockRouter();
      router.sendText
        .mockRejectedValueOnce(new Error('Feishu fail'))
        .mockResolvedValueOnce(undefined);

      mockSettings.feishuEnabled = true;
      mockSettings.feishuAdminOpenId = 'ou_admin';
      mockSettings.wechatEnabled = true;
      mockSettings.wechatCorpId = 'wk_corp';

      scheduler.setRouter(router);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await (scheduler as any).pushToChannels('test message', { ...mockSettings });

      expect(router.sendText).toHaveBeenCalledTimes(2);
      expect(router.sendText).toHaveBeenCalledWith('wechat', '@all', 'test message');
      consoleSpy.mockRestore();
    });

    it('does nothing when no router set', async () => {
      // No router set — should not throw
      await (scheduler as any).pushToChannels('test', { ...mockSettings });
      // If we get here without error, test passes
    });

    it('does nothing when channels are disabled', async () => {
      const router = createMockRouter();
      scheduler.setRouter(router);

      mockSettings.feishuEnabled = false;
      mockSettings.wechatEnabled = false;

      await (scheduler as any).pushToChannels('test', { ...mockSettings });

      expect(router.sendText).not.toHaveBeenCalled();
    });
  });

  // ─── checkAndRun insight scanning ──────────────────────────

  describe('checkAndRun calls scanInsights hourly', () => {
    it('calls scanInsights on first run', async () => {
      const engine = createMockInsightEngine([]);
      scheduler.setInsightEngine(engine);

      await (scheduler as any).checkAndRun();

      expect(engine.scan).toHaveBeenCalledTimes(1);
    });

    it('does not call scanInsights again in the same hour', async () => {
      const engine = createMockInsightEngine([]);
      scheduler.setInsightEngine(engine);

      await (scheduler as any).checkAndRun();
      await (scheduler as any).checkAndRun();

      // Only once because the hour key is the same
      expect(engine.scan).toHaveBeenCalledTimes(1);
    });

    it('catches scanInsights errors without crashing', async () => {
      const engine = createMockInsightEngine([]);
      (engine.scan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Scan boom'));
      scheduler.setInsightEngine(engine);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw
      await (scheduler as any).checkAndRun();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ReportScheduler] Insight scan failed:',
        'Scan boom',
      );
      consoleSpy.mockRestore();
    });
  });

  // ─── Existing feishuNotifier still works ───────────────────

  describe('backward compatibility', () => {
    it('setFeishuNotifier still works', () => {
      const notifier = vi.fn().mockResolvedValue(undefined);
      expect(() => scheduler.setFeishuNotifier(notifier)).not.toThrow();
    });

    it('start and stop work without new dependencies', () => {
      expect(() => scheduler.start()).not.toThrow();
      expect(() => scheduler.stop()).not.toThrow();
    });
  });
});
