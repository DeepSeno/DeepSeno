import type { LicenseManager } from './license-manager';

export class ProFeatureError extends Error {
  code = 'PRO_REQUIRED' as const;
  feature: string;
  constructor(feature: string) {
    super(`Pro feature required: ${feature}`);
    this.feature = feature;
  }
}

export function requirePro(lm: LicenseManager, feature: string): void {
  if (!lm.isFeatureAvailable(feature)) {
    throw new ProFeatureError(feature);
  }
}
