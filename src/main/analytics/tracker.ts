/**
 * AnalyticsTracker — no-op stub.
 *
 * All telemetry has been removed from the open-source build.
 * This file is kept as an empty shell so existing imports remain valid.
 */
export class AnalyticsTracker {
  static getInstance(): AnalyticsTracker {
    return new AnalyticsTracker();
  }
  start(): void {}
  stop(): void {}
  track(_event: string, _props?: Record<string, any>): void {}
}
