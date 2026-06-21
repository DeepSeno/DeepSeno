/**
 * Progress reporter for long-running pipeline steps. Emits human-readable
 * progress notes (shown in the recordings-queue UI) at a bounded cadence so
 * users know what's happening during minutes-long ASR / LLM loops.
 */

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export interface ProgressReporterOptions {
  /** Human-readable label shown before counts (e.g. "转写", "文本清洗"). */
  label: string;
  /** Total number of units to be processed. */
  total: number;
  /** Fired with the formatted status line (logs + taskQueue.notes). */
  onTick: (note: string) => void;
  /** Emit a tick every N completed units (default 5, but always on first + last). */
  step?: number;
  /** Wall-clock throttle in ms (default 1500ms) to avoid spamming on fast loops. */
  minIntervalMs?: number;
  /** Override start time (default Date.now() at construction). */
  startMs?: number;
}

export class ProgressReporter {
  private done = 0;
  private readonly total: number;
  private readonly label: string;
  private readonly onTick: (note: string) => void;
  private readonly step: number;
  private readonly minIntervalMs: number;
  private readonly startMs: number;
  private lastEmit = 0;

  constructor(opts: ProgressReporterOptions) {
    this.label = opts.label;
    this.total = Math.max(1, opts.total);
    this.onTick = opts.onTick;
    this.step = Math.max(1, opts.step ?? 5);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 1500);
    this.startMs = opts.startMs ?? Date.now();
  }

  /** Record one unit of progress and maybe emit a tick. */
  advance(delta = 1): void {
    this.done = Math.min(this.total, this.done + delta);
    const now = Date.now();
    const shouldEmit =
      this.done === 1 ||
      this.done === this.total ||
      (this.done % this.step === 0 && now - this.lastEmit >= this.minIntervalMs);
    if (!shouldEmit) return;

    this.lastEmit = now;
    const elapsed = now - this.startMs;
    const etaText =
      this.done >= this.total
        ? ''
        : this.done > 0
          ? `，剩余 ${formatElapsed((elapsed / this.done) * (this.total - this.done))}`
          : '';
    const note = `${this.label} ${this.done}/${this.total}（已用 ${formatElapsed(elapsed)}${etaText}）`;
    try {
      this.onTick(note);
    } catch {
      /* swallow callback errors so the pipeline keeps running */
    }
  }

  /** Force a final tick (done=total), useful after the loop completes. */
  finish(): void {
    const elapsed = Date.now() - this.startMs;
    const note = `${this.label} ${this.total}/${this.total}（用时 ${formatElapsed(elapsed)}）`;
    try {
      this.onTick(note);
    } catch {
      /* ignore */
    }
  }
}
