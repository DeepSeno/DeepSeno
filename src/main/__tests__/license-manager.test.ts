import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LicenseManager } from '../licensing/license-manager';

describe('LicenseManager', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns permanently free status with all features enabled', () => {
    const mgr = new LicenseManager(123);
    const status = mgr.getStatus();

    expect(status.licensed).toBe(true);
    expect(status.tier).toBe('free');
    expect(status.licenseKey).toBeNull();
    expect(status.trial).toEqual({
      active: false,
      daysRemaining: 0,
      firstLaunchTime: 123,
    });
    expect(status.features).toContain('memory');
    expect(status.features).toContain('auto_reports');
    expect(status.features).toContain('channels');
    expect(status.features).toContain('mobile_sync');
    expect(status.features).toContain('streaming_transcription');
  });

  it('does not call a remote validation endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await LicenseManager.validateLicense('anything');
    const mgr = new LicenseManager();
    await mgr.refreshValidation();

    expect(result).toEqual({ valid: true, tier: 'free' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps compatibility APIs as successful no-ops', async () => {
    const mgr = new LicenseManager();
    const activation = await mgr.activate('not-needed');

    expect(activation).toEqual({ success: true, tier: 'free' });
    expect(mgr.isPro()).toBe(true);
    expect(mgr.isFeatureAvailable('unknown_future_feature')).toBe(true);
  });
});
