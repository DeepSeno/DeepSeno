import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export interface LocalConfig {
  syncEnabled: boolean;
  syncDir: string;
  machineId: string;
}

const DEFAULTS: LocalConfig = {
  syncEnabled: false,
  syncDir: '',
  machineId: '',
};

let cached: LocalConfig | null = null;

/** Get the local data dir path (never synced). Uses same logic as original dataDir(). */
function getLocalBase(): string {
  if (process.env.DEEPSENO_DATA_DIR) {
    return process.env.DEEPSENO_DATA_DIR;
  }
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'deepseno');
  } catch {
    return path.join(process.env.APPDATA || os.homedir(), 'deepseno');
  }
}

function getConfigPath(): string {
  const dir = getLocalBase();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'local-config.json');
}

export function loadLocalConfig(): LocalConfig {
  if (cached) return { ...cached };
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    // Ensure machineId is set (UUID for uniqueness, hostname is in lock file for display)
    if (!parsed.machineId) {
      parsed.machineId = randomUUID();
      // Persist immediately so it stays stable
      saveLocalConfig({ ...DEFAULTS, ...parsed });
    }
    cached = { ...DEFAULTS, ...parsed };
  } catch {
    cached = { ...DEFAULTS, machineId: randomUUID() };
    // Persist defaults with generated machineId
    saveLocalConfig(cached);
  }
  return { ...cached };
}

export function saveLocalConfig(config: LocalConfig): void {
  cached = { ...config };
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
