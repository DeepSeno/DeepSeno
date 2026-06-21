import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LicenseManager } from '../licensing/license-manager';

// Mock global fetch for server API calls
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockServerResponse(valid: boolean, tier: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ valid, tier }),
  } as Response);
}

function mockServerError() {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 500,
    json: async () => ({}),
  } as Response);
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

describe('LicenseManager', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateLicense — client-side format check', () => {
    it('rejects empty string (no server call)', async () => {
      const result = await LicenseManager.validateLicense('');
      expect(result.valid).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects wrong format: missing VB prefix', async () => {
      const result = await LicenseManager.validateLicense('XX-AAAA-BBBB-CCCC-DDDD');
      expect(result.valid).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects wrong format: too few segments', async () => {
      const result = await LicenseManager.validateLicense('VB-AAAA-BBBB-CCCC');
      expect(result.valid).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects wrong format: lowercase chars', async () => {
      const result = await LicenseManager.validateLicense('VB-aaaa-bbbb-cccc-dddd');
      expect(result.valid).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls server for well-formed key and returns valid', async () => {
      mockServerResponse(true, 'professional');
      const result = await LicenseManager.validateLicense('VB-AAAA-BBBB-CCCC-DDDD');
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('professional');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('calls server for well-formed key and returns invalid', async () => {
      mockServerResponse(false, '');
      const result = await LicenseManager.validateLicense('VB-ZZZZ-YYYY-XXXX-WWWW');
      expect(result.valid).toBe(false);
      expect(result.tier).toBe('');
    });

    it('handles server error gracefully', async () => {
      mockServerError();
      const result = await LicenseManager.validateLicense('VB-AAAA-BBBB-CCCC-DDDD');
      expect(result.valid).toBe(false);
    });

    it('handles network error gracefully', async () => {
      mockNetworkError();
      const result = await LicenseManager.validateLicense('VB-AAAA-BBBB-CCCC-DDDD');
      expect(result.valid).toBe(false);
    });
  });

  describe('refreshValidation', () => {
    it('sets cached validation from server response', async () => {
      mockServerResponse(true, 'professional');
      const mgr = new LicenseManager(Date.now(), 'VB-AAAA-BBBB-CCCC-DDDD');
      await mgr.refreshValidation();
      expect(mgr.getStatus().licensed).toBe(true);
      expect(mgr.getStatus().tier).toBe('professional');
    });

    it('clears cache when no license key', async () => {
      const mgr = new LicenseManager(Date.now(), null);
      await mgr.refreshValidation();
      expect(mgr.getStatus().licensed).toBe(false);
      expect(mgr.isPro()).toBe(true); // trial active
    });

    it('handles server validation failure', async () => {
      mockServerResponse(false, '');
      const mgr = new LicenseManager(Date.now(), 'VB-AAAA-BBBB-CCCC-DDDD');
      await mgr.refreshValidation();
      expect(mgr.getStatus().licensed).toBe(false);
    });
  });

  describe('getTrialStatus', () => {
    it('trial is active within 14 days', () => {
      const now = Date.now();
      const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(threeDaysAgo);
      const status = mgr.getTrialStatus();
      expect(status.active).toBe(true);
      expect(status.daysRemaining).toBe(11);
      expect(status.firstLaunchTime).toBe(threeDaysAgo);
    });

    it('trial is expired after 14 days', () => {
      const now = Date.now();
      const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fifteenDaysAgo);
      const status = mgr.getTrialStatus();
      expect(status.active).toBe(false);
      expect(status.daysRemaining).toBe(0);
    });

    it('boundary: exactly 14 days is expired', () => {
      const now = Date.now();
      const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fourteenDaysAgo);
      const status = mgr.getTrialStatus();
      expect(status.active).toBe(false);
      expect(status.daysRemaining).toBe(0);
    });

    it('new launch has 14 days remaining', () => {
      const mgr = new LicenseManager(Date.now());
      const status = mgr.getTrialStatus();
      expect(status.active).toBe(true);
      expect(status.daysRemaining).toBe(14);
    });
  });

  describe('getStatus', () => {
    it('returns trial status when no license and no cached validation', () => {
      const mgr = new LicenseManager(Date.now(), null);
      const status = mgr.getStatus();
      expect(status.licensed).toBe(false);
      expect(status.tier).toBe('trial');
      expect(status.licenseKey).toBeNull();
      expect(status.trial.active).toBe(true);
    });

    it('returns free tier after trial expires without license', () => {
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fifteenDaysAgo, null);
      const status = mgr.getStatus();
      expect(status.licensed).toBe(false);
      expect(status.tier).toBe('free');
      expect(status.trial.active).toBe(false);
    });

    it('returns licensed status when cached validation is valid', async () => {
      mockServerResponse(true, 'professional');
      const mgr = new LicenseManager(Date.now(), 'VB-AAAA-BBBB-CCCC-DDDD');
      await mgr.refreshValidation();
      const status = mgr.getStatus();
      expect(status.licensed).toBe(true);
      expect(status.tier).toBe('professional');
      expect(status.licenseKey).toBe('VB-AAAA-BBBB-CCCC-DDDD');
    });

    it('falls back to trial when server says invalid', async () => {
      mockServerResponse(false, '');
      const mgr = new LicenseManager(Date.now(), 'VB-BADK-EYSS-LEEP-XXXX');
      await mgr.refreshValidation();
      const status = mgr.getStatus();
      expect(status.licensed).toBe(false);
      // Trial still active because within 14 days
      expect(status.tier).toBe('trial');
    });
  });

  describe('isPro', () => {
    it('returns true during trial', () => {
      const mgr = new LicenseManager(Date.now(), null);
      expect(mgr.isPro()).toBe(true);
    });

    it('returns true with cached valid license', async () => {
      mockServerResponse(true, 'personal');
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fifteenDaysAgo, 'VB-AAAA-BBBB-CCCC-DDDD');
      await mgr.refreshValidation();
      // Even after trial expiry, license keeps pro access
      expect(mgr.isPro()).toBe(true);
    });

    it('returns false after trial expires without license', () => {
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fifteenDaysAgo, null);
      expect(mgr.isPro()).toBe(false);
    });

    it('returns false with key but no cached validation (not yet refreshed)', () => {
      // Before refreshValidation() is called, no cached state
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(fifteenDaysAgo, 'VB-AAAA-BBBB-CCCC-DDDD');
      // Trial expired + no validation yet = false
      expect(mgr.isPro()).toBe(false);
    });
  });

  describe('activate', () => {
    it('succeeds with server-validated key', async () => {
      mockServerResponse(true, 'lifetime');
      const mgr = new LicenseManager();
      const result = await mgr.activate('VB-AAAA-BBBB-CCCC-DDDD');
      expect(result.success).toBe(true);
      expect(result.tier).toBe('lifetime');
      const status = mgr.getStatus();
      expect(status.licensed).toBe(true);
      expect(status.tier).toBe('lifetime');
    });

    it('fails when server rejects the key', async () => {
      mockServerResponse(false, '');
      const mgr = new LicenseManager();
      const result = await mgr.activate('VB-BADK-EYSS-LEEP-XXXX');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid license key');
      expect(mgr.getStatus().licensed).toBe(false);
    });

    it('fails with malformed key (no server call)', async () => {
      const mgr = new LicenseManager();
      const result = await mgr.activate('not-a-license');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid license key');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles server error during activation', async () => {
      mockServerError();
      const mgr = new LicenseManager();
      const result = await mgr.activate('VB-AAAA-BBBB-CCCC-DDDD');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid license key');
    });
  });

  describe('isFeatureAvailable', () => {
    it('all features available during active trial', () => {
      const mgr = new LicenseManager(Date.now(), null);
      expect(mgr.isFeatureAvailable('recording')).toBe(true);
      expect(mgr.isFeatureAvailable('basic_rag')).toBe(true);
      expect(mgr.isFeatureAvailable('speaker_diarization')).toBe(true);
      expect(mgr.isFeatureAvailable('memory')).toBe(true);
      expect(mgr.isFeatureAvailable('auto_reports')).toBe(true);
    });

    it('only free features after trial expires', () => {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(thirtyDaysAgo, null);
      expect(mgr.isFeatureAvailable('recording')).toBe(true);
      expect(mgr.isFeatureAvailable('transcription')).toBe(true);
      expect(mgr.isFeatureAvailable('playback')).toBe(true);
      expect(mgr.isFeatureAvailable('export_text')).toBe(true);
      expect(mgr.isFeatureAvailable('speaker_diarization')).toBe(true);
      expect(mgr.isFeatureAvailable('memory')).toBe(false);
      expect(mgr.isFeatureAvailable('auto_reports')).toBe(false);
      expect(mgr.isFeatureAvailable('meeting_notes')).toBe(false);
    });

    it('all features available with valid cached license after trial expiry', async () => {
      mockServerResponse(true, 'personal');
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const mgr = new LicenseManager(thirtyDaysAgo, 'VB-AAAA-BBBB-CCCC-DDDD');
      await mgr.refreshValidation();
      expect(mgr.isFeatureAvailable('recording')).toBe(true);
      expect(mgr.isFeatureAvailable('basic_rag')).toBe(true);
      expect(mgr.isFeatureAvailable('memory')).toBe(true);
      expect(mgr.isFeatureAvailable('auto_reports')).toBe(true);
    });
  });
});
