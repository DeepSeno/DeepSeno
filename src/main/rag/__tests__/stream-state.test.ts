import { describe, expect, it } from 'vitest';
import { RagStreamRegistry } from '../stream-state';

describe('RagStreamRegistry', () => {
  it('keeps active global stream text and status for renderer reattachment', () => {
    const registry = new RagStreamRegistry();

    registry.startGlobal({ question: '最近有什么待办？', sessionId: 7 });
    registry.setGlobalStatus('searching');
    registry.appendGlobalChunk('正在搜索相关记录...');
    registry.setGlobalStatus('generating');
    registry.appendGlobalChunk('\n找到 2 条待办。');

    expect(registry.getGlobal(7)).toMatchObject({
      kind: 'global',
      sessionId: 7,
      question: '最近有什么待办？',
      status: 'generating',
      text: '正在搜索相关记录...\n找到 2 条待办。',
      active: true,
    });
    expect(registry.getGlobal(8)).toBeNull();
  });

  it('keeps active scoped stream text for the selected recording only', () => {
    const registry = new RagStreamRegistry();

    registry.startScoped({ question: '这个视频说了什么？', recordingId: 99 });
    registry.setScopedStatus('searching');
    registry.appendScopedChunk('视频里提到了项目进展。');

    expect(registry.getScoped(99)).toMatchObject({
      kind: 'scoped',
      recordingId: 99,
      status: 'searching',
      text: '视频里提到了项目进展。',
      active: true,
    });
    expect(registry.getScoped(100)).toBeNull();
  });
});
