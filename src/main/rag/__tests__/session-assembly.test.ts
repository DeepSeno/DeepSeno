import { describe, it, expect, vi } from 'vitest';
import { assembleSession } from '../session-assembly';

function mockDb(opts: {
  activeSession?: { id: number; date: string; started_at: string; ended_at: string } | null;
  members?: Array<{ id: number; duration_seconds: number | null }>;
} = {}) {
  return {
    findActiveCaptureSession: vi.fn().mockReturnValue(opts.activeSession ?? null),
    getCaptureSessionMembers: vi.fn().mockReturnValue(opts.members ?? []),
    getRecordingTranscriptText: vi.fn((id: number) => `text-${id}`),
    createCaptureSession: vi.fn().mockReturnValue(99),
    addRecordingToCaptureSession: vi.fn(),
    updateCaptureSession: vi.fn(),
  };
}

const baseInput = {
  recordingId: 100,
  transcript: 'long enough transcript for assembly',
  durationSec: 30,
  captureScene: 'dictation',
  date: '2026-05-16',
  recordedAt: '2026-05-16T10:00:00Z',
};

describe('assembleSession', () => {
  it('creates new session when no active candidate exists', async () => {
    const db = mockDb({});
    const opt = { detectSessionTopic: vi.fn() };
    await assembleSession(db as any, opt as any, baseInput);
    expect(db.createCaptureSession).toHaveBeenCalledOnce();
    expect(db.addRecordingToCaptureSession).toHaveBeenCalledWith(100, 99, baseInput.recordedAt);
    expect(opt.detectSessionTopic).not.toHaveBeenCalled();
  });

  it('joins active session + updates topic when LLM says coherent', async () => {
    const db = mockDb({
      activeSession: { id: 5, date: '2026-05-16', started_at: 'a', ended_at: 'b' },
      members: [{ id: 1, duration_seconds: 30 }],
    });
    const opt = {
      detectSessionTopic: vi.fn().mockResolvedValue({ topic: 'T', summary: 'S', isCoherent: true }),
    };
    await assembleSession(db as any, opt as any, baseInput);
    expect(opt.detectSessionTopic).toHaveBeenCalledOnce();
    expect(db.addRecordingToCaptureSession).toHaveBeenCalledWith(100, 5, baseInput.recordedAt);
    expect(db.updateCaptureSession).toHaveBeenCalledWith(5, expect.objectContaining({ topic: 'T', summary: 'S' }));
    expect(db.createCaptureSession).not.toHaveBeenCalled();
  });

  it('finalizes old session + creates new when LLM says incoherent', async () => {
    const db = mockDb({
      activeSession: { id: 5, date: '2026-05-16', started_at: 'a', ended_at: 'b' },
      members: [{ id: 1, duration_seconds: 10 }],
    });
    const opt = {
      detectSessionTopic: vi.fn().mockResolvedValue({ topic: '', summary: '', isCoherent: false }),
    };
    await assembleSession(db as any, opt as any, baseInput);
    expect(db.updateCaptureSession).toHaveBeenCalledWith(5, { is_finalized: 1 });
    expect(db.createCaptureSession).toHaveBeenCalledOnce();
    expect(db.addRecordingToCaptureSession).toHaveBeenCalledWith(100, 99, baseInput.recordedAt);
  });

  it('skips session assembly for non-audio/video media', async () => {
    const db = mockDb({});
    const opt = { detectSessionTopic: vi.fn() };
    await assembleSession(db as any, opt as any, { ...baseInput, mediaType: 'image' });
    expect(db.createCaptureSession).not.toHaveBeenCalled();
    expect(db.addRecordingToCaptureSession).not.toHaveBeenCalled();
    expect(db.findActiveCaptureSession).not.toHaveBeenCalled();
  });

  it('uses db.getRecordingTranscriptText to hydrate existing member texts', async () => {
    const db = mockDb({
      activeSession: { id: 5, date: '2026-05-16', started_at: 'a', ended_at: 'b' },
      members: [
        { id: 1, duration_seconds: 30 },
        { id: 2, duration_seconds: 20 },
      ],
    });
    const opt = {
      detectSessionTopic: vi.fn().mockResolvedValue({ topic: 'T', summary: 'S', isCoherent: true }),
    };
    await assembleSession(db as any, opt as any, baseInput);
    // Hydrated transcripts for member ids 1 and 2
    expect(db.getRecordingTranscriptText).toHaveBeenCalledWith(1);
    expect(db.getRecordingTranscriptText).toHaveBeenCalledWith(2);
    // detectSessionTopic called with 3 members (2 existing + new)
    const call = opt.detectSessionTopic.mock.calls[0][0];
    expect(call).toHaveLength(3);
    expect(call[0].transcript).toBe('text-1');
    expect(call[2].transcript).toBe(baseInput.transcript);
  });
});
