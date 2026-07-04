import os from 'os';

export interface HardwareInfo {
  totalMemoryGB: number;
  freeMemoryGB: number;
  cpuCores: number;
  platform: string;
  arch: string;
  recommendedLlmModel: string;
  recommendedQuality: 'basic' | 'good' | 'excellent';
}

export function detectHardware(): HardwareInfo {
  const totalGB = Math.round(os.totalmem() / (1024 ** 3));

  // Force smallest model for fast testing
  const model = 'qwen3.5:4b';
  const quality: 'basic' | 'good' | 'excellent' = 'basic';

  return {
    totalMemoryGB: totalGB,
    freeMemoryGB: Math.round(os.freemem() / (1024 ** 3)),
    cpuCores: os.cpus().length,
    platform: process.platform,
    arch: process.arch,
    recommendedLlmModel: model,
    recommendedQuality: quality,
  };
}
