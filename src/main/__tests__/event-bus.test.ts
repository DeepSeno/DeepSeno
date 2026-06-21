import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentEventBus, PipelineCompletedData } from '../agent/event-bus';
import type { MessageRouter } from '../channels/router';

// Mock loadSettings
vi.mock('../settings', () => ({
  loadSettings: vi.fn(),
}));

import { loadSettings } from '../settings';
const mockLoadSettings = loadSettings as ReturnType<typeof vi.fn>;

function createMockRouter(): MessageRouter {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
    setHandler: vi.fn(),
    getChannel: vi.fn(),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function defaultSettings(overrides: Record<string, any> = {}) {
  return {
    feishuEnabled: false,
    feishuNotifyOnComplete: false,
    feishuAdminOpenId: '',
    wechatEnabled: false,
    wechatCorpId: '',
    ...overrides,
  };
}

const baseData: PipelineCompletedData = {
  fileName: 'R20260225-120000.WAV',
  recordingId: 1,
};

describe('AgentEventBus', () => {
  let bus: AgentEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSettings.mockReturnValue(defaultSettings());
    bus = new AgentEventBus();
  });

  it('registers pipeline:completed handler on construction', () => {
    expect(bus.listenerCount('pipeline:completed')).toBe(1);
  });

  it('pushes to feishu when feishu is enabled', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    bus.emit('pipeline:completed', baseData);
    // Allow async handler to complete
    await new Promise(r => setTimeout(r, 50));

    expect(router.sendText).toHaveBeenCalledWith(
      'feishu',
      'ou_admin123',
      expect.stringContaining('R20260225-120000.WAV'),
    );
  });

  it('pushes to wechat when wechat is enabled', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      wechatEnabled: true,
      wechatCorpId: 'corp123',
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    bus.emit('pipeline:completed', baseData);
    await new Promise(r => setTimeout(r, 50));

    expect(router.sendText).toHaveBeenCalledWith(
      'wechat',
      '@all',
      expect.stringContaining('R20260225-120000.WAV'),
    );
  });

  it('pushes to both channels when both are enabled', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
      wechatEnabled: true,
      wechatCorpId: 'corp123',
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    bus.emit('pipeline:completed', baseData);
    await new Promise(r => setTimeout(r, 50));

    expect(router.sendText).toHaveBeenCalledTimes(2);
    expect(router.sendText).toHaveBeenCalledWith('feishu', 'ou_admin123', expect.any(String));
    expect(router.sendText).toHaveBeenCalledWith('wechat', '@all', expect.any(String));
  });

  it('does not push when notifyOnComplete is false and wechat disabled', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: false,
      feishuAdminOpenId: 'ou_admin123',
      wechatEnabled: false,
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    bus.emit('pipeline:completed', baseData);
    await new Promise(r => setTimeout(r, 50));

    expect(router.sendText).not.toHaveBeenCalled();
  });

  it('includes meeting notes title in notification', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    const data: PipelineCompletedData = {
      ...baseData,
      meetingNotes: { title: 'Sprint Planning' },
    };
    bus.emit('pipeline:completed', data);
    await new Promise(r => setTimeout(r, 50));

    expect(router.sendText).toHaveBeenCalledWith(
      'feishu',
      'ou_admin123',
      expect.stringContaining('Sprint Planning'),
    );
  });

  it('includes extracted todos in notification', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      wechatEnabled: true,
      wechatCorpId: 'corp123',
    }));
    const router = createMockRouter();
    bus.setRouter(router);

    const data: PipelineCompletedData = {
      ...baseData,
      extractedTodos: [
        { content: 'Review PR #42' },
        { content: 'Deploy to staging' },
      ],
    };
    bus.emit('pipeline:completed', data);
    await new Promise(r => setTimeout(r, 50));

    const sentText = (router.sendText as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(sentText).toContain('Review PR #42');
    expect(sentText).toContain('Deploy to staging');
    expect(sentText).toContain('New todos:');
  });

  it('handles router errors gracefully', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
    }));
    const router = createMockRouter();
    (router.sendText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    bus.setRouter(router);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    bus.emit('pipeline:completed', baseData);
    await new Promise(r => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[EventBus] Feishu push failed:',
      'Network error',
    );
    consoleSpy.mockRestore();
  });

  it('works without router set (no crash)', async () => {
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
    }));

    // No router set — should not throw
    bus.emit('pipeline:completed', baseData);
    await new Promise(r => setTimeout(r, 50));
    // If we reach here, no crash occurred
  });

  it('setRouter stores the router', () => {
    const router = createMockRouter();
    bus.setRouter(router);
    // Verify by triggering a push and checking the router is used
    mockLoadSettings.mockReturnValue(defaultSettings({
      feishuEnabled: true,
      feishuNotifyOnComplete: true,
      feishuAdminOpenId: 'ou_admin123',
    }));
    bus.emit('pipeline:completed', baseData);
    // The router was stored — we'll verify it gets called
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(router.sendText).toHaveBeenCalled();
        resolve();
      }, 50);
    });
  });
});
