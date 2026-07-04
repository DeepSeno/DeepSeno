const FREE_FEATURES = [
  'recording', 'transcription', 'playback', 'export_text',
  'basic_rag', 'speaker_diarization', 'llm_optimization',
  'markdown_export', 'obsidian_export',
  'memory', 'insights', 'workflow', 'todo_tracking',
  'meeting_notes', 'auto_reports', 'channels', 'mobile_sync',
  'streaming_transcription', 'relationship_graph',
  'emotion_analysis', 'speaker_embedding',
] as const;

export type LicenseTier = 'free';

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
  private readonly firstLaunchTime: number;

  constructor(firstLaunchTime?: number) {
    this.firstLaunchTime = firstLaunchTime || Date.now();
  }

  getTrialStatus(): TrialStatus {
    return {
      active: false,
      daysRemaining: 0,
      firstLaunchTime: this.firstLaunchTime,
    };
  }

  static async validateLicense(_key: string): Promise<{ valid: boolean; tier: LicenseTier }> {
    return { valid: true, tier: 'free' };
  }

  async refreshValidation(): Promise<void> {
    // Desktop is permanently free; no server validation is performed.
  }

  getStatus(): LicenseStatus {
    return {
      licensed: true,
      trial: this.getTrialStatus(),
      licenseKey: null,
      tier: 'free',
      features: [...FREE_FEATURES],
    };
  }

  isPro(): boolean {
    return true;
  }

  isFeatureAvailable(_feature: string): boolean {
    return true;
  }

  async activate(_key: string): Promise<{ success: boolean; tier: LicenseTier }> {
    return { success: true, tier: 'free' };
  }
}
