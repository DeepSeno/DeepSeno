import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedMessageHandler } from '../channels/message-handler';
import type { IncomingMessage } from '../channels/types';
import type { AgentExecutor, AgentResponse } from '../agent/agent-executor';

const mockMsg = (overrides?: Partial<IncomingMessage>): IncomingMessage => ({
  channelId: 'feishu',
  userId: 'u1',
  userName: 'Test',
  chatId: 'c1',
  type: 'text',
  content: 'hello',
  timestamp: Date.now(),
  ...overrides,
});

describe('UnifiedMessageHandler', () => {
  let handler: UnifiedMessageHandler;
  let mockRouter: any;
  let mockAgentExecutor: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockRouter = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
    };
    mockAgentExecutor = {
      execute: vi.fn().mockResolvedValue({
        text: 'Test response',
        toolCalls: [],
        images: [],
      } as AgentResponse),
    };
    mockSessionManager = {
      handleCommand: vi.fn().mockReturnValue(false),
      getOrCreateSession: vi.fn().mockReturnValue({ id: 1, channelId: 'feishu', userId: 'u1', startedAt: Date.now() }),
      addMessage: vi.fn(),
      getContext: vi.fn().mockReturnValue({ activeMessages: [], recentSummaries: [] }),
      closeSession: vi.fn(),
      clear: vi.fn(),
      clearAll: vi.fn(),
    };
    handler = new UnifiedMessageHandler(
      mockRouter,
      mockAgentExecutor as unknown as AgentExecutor,
      mockSessionManager,
    );
  });

  it('delegates text messages to agent executor', async () => {
    await handler.handle(mockMsg({ content: 'test question' }));
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith('feishu', 'u1', 'Test', 'test question');
    expect(mockRouter.sendText).toHaveBeenCalledWith('feishu', 'c1', 'Test response');
  });

  it('handles voice messages with a processing notice', async () => {
    await handler.handle(mockMsg({ type: 'voice', content: '' }));
    expect(mockRouter.sendText).toHaveBeenCalledWith('feishu', 'c1', expect.stringContaining('语音'));
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
  });

  it('skips empty text content', async () => {
    await handler.handle(mockMsg({ content: '' }));
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    expect(mockRouter.sendText).not.toHaveBeenCalled();
  });

  it('skips whitespace-only content', async () => {
    await handler.handle(mockMsg({ content: '   ' }));
    expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    expect(mockRouter.sendText).not.toHaveBeenCalled();
  });

  it('handles agent executor errors gracefully', async () => {
    mockAgentExecutor.execute.mockRejectedValue(new Error('LLM down'));
    await handler.handle(mockMsg());
    expect(mockRouter.sendText).toHaveBeenCalledWith('feishu', 'c1', expect.stringContaining('出错'));
  });

  it('uses chatId for reply target', async () => {
    await handler.handle(mockMsg({ chatId: 'custom-chat', userId: 'u2' }));
    expect(mockRouter.sendText).toHaveBeenCalledWith('feishu', 'custom-chat', 'Test response');
  });

  it('falls back to userId when chatId is missing', async () => {
    await handler.handle(mockMsg({ chatId: undefined, userId: 'u2' }));
    expect(mockRouter.sendText).toHaveBeenCalledWith('feishu', 'u2', 'Test response');
  });

  it('passes correct userName to agent executor', async () => {
    await handler.handle(mockMsg({ userName: 'Alice', content: 'hi' }));
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith('feishu', 'u1', 'Alice', 'hi');
  });

  it('uses default name when userName is empty', async () => {
    await handler.handle(mockMsg({ userName: undefined, content: 'hi' }));
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith('feishu', 'u1', '用户', 'hi');
  });
});
