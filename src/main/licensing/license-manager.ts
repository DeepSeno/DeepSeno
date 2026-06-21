/**
 * License Manager — Open Core licensing with server-side validation.
 *
 * Architecture:
 * - License validation happens server-side (POST /api/v1/license/verify).
 *   The HMAC signing secret never appears in client code.
 * - Validation results are cached in memory for synchronous feature-gating.
 * - Trial logic (14-day) is computed locally from firstLaunchTime.
 * - No license key generation code exists on the client.
 */

import { app } from 'electron';

declare const __API_BASE_URL__: string;
const API_BASE = typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : '';

// Open Core feature definitions
const FREE_FEATURES = [
  'recording', 'transcription', 'playback', 'export_text',
  'basic_rag', 'speaker_diarization', 'llm_optimization',
  'markdown_export', 'obsidian_export',
] as const;

const PRO_FEATURES = [
  'memory', 'insights', 'workflow', 'todo_tracking',
  'meeting_notes', 'auto_reports', 'channels', 'mobile_sync',
  'streaming_transcription', 'relationship_graph',
  'emotion_analysis', 'speaker_embedding',
] as const;

export type LicenseTier = 'free' | 'trial' | 'personal' | 'professional' | 'lifetime';

export interface TrialStatus {
  active: boolean;
  daysRemaining: number;
  firstLaunchTime: number;
}

export interface LicenseStatus {
  licensed: boolean;
  trial: TrialStatus;
  licenseKey: string | null;
  tier: LicenseTier;
  features: string[];
}

export class LicenseManager {
  private firstLaunchTime: number;
  private licenseKey: string | null;
  /** Cached server validation result for the current license key */
  private cachedValidation: { valid: boolean; tier: string } | null = null;

  constructor(firstLaunchTime?: number, licenseKey?: string | null) {
    if (!app.isPackaged) this.firstLaunchTime = Date.now();
    else this.firstLaunchTime = firstLaunchTime || Date.now();
    this.licenseKey = licenseKey || null;
  }

  // ─── Trial ─────────────────────────────────────────────────

  getTrialStatus(): TrialStatus {
    const elapsed = Date.now() - this.firstLaunchTime;
    const daysUsed = Math.floor(elapsed / (1000 * 60 * 60 * 24));
    return {
      active: daysUsed < 14,
      daysRemaining: Math.max(0, 14 - daysUsed),
      firstLaunchTime: this.firstLaunchTime,
    };
  }

  // ─── Server-side validation ─────────────────────────────────

  /**
   * Validate a license key against the server API.
   * Results are cached so repeated calls don't hit the network.
   */
  static async validateLicense(key: string): Promise<{ valid: boolean; tier: string }> {
    // Basic format check client-side (fast rejection for clearly invalid keys)
    if (!key.match(/^VB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) {
      return { valid: false, tier: '' };
    }

    try {
      const resp = await fetch(`${API_BASE}/license/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!resp.ok) {
        console.warn(`[LicenseManager] Server returned ${resp.status} for license validation`);
        return { valid: false, tier: '' };
      }
      const data = await resp.json();
      return {
        valid: (data as { valid?: boolean }).valid === true,
        tier: (data as { tier?: string }).tier || '',
      };
    } catch (err) {
      console.warn('[LicenseManager] License validation failed (network error):', (err as Error).message);
      return { valid: false, tier: '' };
    }
  }

  /**
   * Refresh the cached validation by calling the server.
   * Called on startup and when the license key changes.
   */
  async refreshValidation(): Promise<void> {
    if (this.licenseKey) {
      this.cachedValidation = await LicenseManager.validateLicense(this.licenseKey);
    } else {
      this.cachedValidation = null;
    }
  }

  // ─── Feature gating (synchronous — reads from cache) ────────

  /** Get all features available based on cached validation result. */
  private getAvailableFeatures(): string[] {
    const allFeatures = [...FREE_FEATURES, ...PRO_FEATURES];
    if (this.isPro()) return allFeatures;
    return [...FREE_FEATURES];
  }

  /**
   * Returns the current license status (synchronous, from cache).
   * Call refreshValidation() first to get the latest server state.
   */
  getStatus(): LicenseStatus {
    const trial = this.getTrialStatus();

    if (this.licenseKey && this.cachedValidation?.valid) {
      return {
        licensed: true,
        trial,
        licenseKey: this.licenseKey,
        tier: this.cachedValidation.tier as LicenseTier,
        features: [...FREE_FEATURES, ...PRO_FEATURES],
      };
    }

    // During trial, all features available but tier is 'trial'
    if (trial.active) {
      return {
        licensed: false,
        trial,
        licenseKey: null,
        tier: 'trial',
        features: [...FREE_FEATURES, ...PRO_FEATURES],
      };
    }

    // Trial expired, no license → free tier
    return {
      licensed: false,
      trial,
      licenseKey: null,
      tier: 'free',
      features: [...FREE_FEATURES],
    };
  }

  /** Quick check: does the user have access to Pro features? (synchronous, from cache) */
  isPro(): boolean {
    if (this.licenseKey && this.cachedValidation?.valid) return true;
    return this.getTrialStatus().active;
  }

  /** Check if a specific feature is available (synchronous, from cache) */
  isFeatureAvailable(feature: string): boolean {
    return this.getAvailableFeatures().includes(feature);
  }

  // ─── License activation ─────────────────────────────────────

  /** Activate a license key by validating with the server. */
  async activate(key: string): Promise<{ success: boolean; tier?: string; error?: string }> {
    const result = await LicenseManager.validateLicense(key);
    if (!result.valid) {
      return { success: false, error: 'Invalid license key' };
    }
    this.licenseKey = key;
    this.cachedValidation = result;
    return { success: true, tier: result.tier };
  }
}
