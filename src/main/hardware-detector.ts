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

// Model catalog sorted by size — Qwen 3.5 series only
const MODEL_CATALOG: { name: string; runGB: number; perf: number }[] = [
  { name: 'qwen3.5:4b',   runGB: 6,  perf: 70 },
  { name: 'qwen3.5:9b',   runGB: 10, perf: 78 },
  { name: 'qwen3.5:27b',  runGB: 22, perf: 86 },
  { name: 'qwen3.5:35b',  runGB: 30, perf: 85 },
  { name: 'qwen3.5:122b', runGB: 88, perf: 90 },
];

const SYSTEM_OVERHEAD_GB = 6;

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
