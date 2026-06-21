import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressReporter, formatElapsed } from '../progress-reporter';

describe('formatElapsed', () => {
  it('formats sub-minute values in seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('1s');
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('formats whole-minute values without seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(120_000)).toBe('2m');
  });

  it('formats minute+second values', () => {
    expect(formatElapsed(65_000)).toBe('1m5s');
    expect(formatElapsed(125_000)).toBe('2m5s');
  });

  it('clamps negative durations to 0s', () => {
    expect(formatElapsed(-1000)).toBe('0s');
  });
});

describe('ProgressReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a tick on first advance', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: '转写', total: 100, onTick, step: 5 });
    r.advance();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0]).toMatch(/^转写 1\/100/);
  });

  it('emits a tick every `step` units once throttle expires', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: '清洗', total: 100, onTick, step: 10, minIntervalMs: 100 });
    r.advance(); // done=1, first tick always fires
    onTick.mockClear();

    // Advance 9 more (done=10) — multiple of step, throttle expired
    vi.setSystemTime(new Date('2026-04-22T00:00:01Z')); // +1s
    for (let i = 0; i < 9; i++) r.advance();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0]).toMatch(/^清洗 10\/100/);
  });

  it('throttles ticks within minIntervalMs', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: 'X', total: 100, onTick, step: 1, minIntervalMs: 5000 });
    r.advance(); // first — always emits
    onTick.mockClear();

    // Second advance 100ms later — multiple of step=1 but throttled
    vi.setSystemTime(new Date('2026-04-22T00:00:00.100Z'));
    r.advance();
    expect(onTick).not.toHaveBeenCalled();
  });

  it('always emits on the last advance (done===total)', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: 'Y', total: 3, onTick, step: 999, minIntervalMs: 99_999 });
    r.advance(); // first — emits
    r.advance(); // middle — no emit (not multiple of 999, not last)
    r.advance(); // done=3=total — emits
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick.mock.calls[1][0]).toMatch(/^Y 3\/3/);
  });

  it('includes elapsed + ETA when mid-run', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: '转写', total: 10, onTick, step: 1 });
    r.advance(); // first
    vi.setSystemTime(new Date('2026-04-22T00:00:30Z')); // +30s
    r.advance(); // done=2, 30s elapsed → 150s ETA (30/2*8)
    const last = onTick.mock.calls[onTick.mock.calls.length - 1][0];
    expect(last).toContain('转写 2/10');
    expect(last).toContain('已用');
    expect(last).toContain('剩余');
  });

  it('omits ETA on the final tick', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: 'Z', total: 2, onTick, step: 1 });
    r.advance();
    vi.setSystemTime(new Date('2026-04-22T00:00:30Z'));
    r.advance();
    const last = onTick.mock.calls[onTick.mock.calls.length - 1][0];
    expect(last).toContain('Z 2/2');
    expect(last).not.toContain('剩余');
  });

  it('finish() emits a done-with-total note', () => {
    const onTick = vi.fn();
    const r = new ProgressReporter({ label: 'W', total: 5, onTick });
    vi.setSystemTime(new Date('2026-04-22T00:01:00Z'));
    r.finish();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0]).toMatch(/^W 5\/5（用时 1m）/);
  });
});
