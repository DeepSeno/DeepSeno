import path from 'path';
import fs from 'fs';
import os from 'os';

// ─── Local data dir (never synced) ─────────────────────────

function getUserDataDir(): string {
  if (process.env.DEEPSENO_DATA_DIR) {
    return process.env.DEEPSENO_DATA_DIR;
  }
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'deepseno');
  } catch {
    return path.join(
      process.env.APPDATA || os.homedir(),
      'deepseno'
    );
  }
}

let _localDataDir: string | null = null;

/** Always returns the original local data directory (not affected by sync). */
export function getLocalDataDir(): string {
  if (!_localDataDir) {
    _localDataDir = getUserDataDir();
    fs.mkdirSync(_localDataDir, { recursive: true });
  }
  return _localDataDir;
}

// ─── Effective data dir (sync-aware) ───────────────────────

let _effectiveDataDir: string | null = null;

/** Returns syncDir if sync is enabled, otherwise local data dir. */
export function getEffectiveDataDir(): string {
  if (!_effectiveDataDir) {
    try {
      const { loadLocalConfig } = require('./local-config');
      const config = loadLocalConfig();
      if (config.syncEnabled && config.syncDir) {
        // Validate sync dir exists
        if (fs.existsSync(config.syncDir)) {
          _effectiveDataDir = config.syncDir;
        } else {
          console.warn(`[paths] Sync dir not accessible: ${config.syncDir}, falling back to local`);
          _effectiveDataDir = getLocalDataDir();
        }
      } else {
        _effectiveDataDir = getLocalDataDir();
      }
    } catch {
      _effectiveDataDir = getLocalDataDir();
    }
    fs.mkdirSync(_effectiveDataDir, { recursive: true });
  }
  return _effectiveDataDir;
}

/** Reset cached effective dir (called when sync is enabled/disabled). */
export function resetEffectiveDataDir(): void {
  _effectiveDataDir = null;
}

// ─── Path helpers ──────────────────────────────────────────

export function getDbPath(): string {
  return process.env.DEEPSENO_DB_PATH || path.join(getEffectiveDataDir(), 'deepseno.db');
}

export function getVecDbPath(): string {
  return process.env.DEEPSENO_VEC_DB_PATH || path.join(getEffectiveDataDir(), 'deepseno-vec.db');
}

/** Temp dir is always local (processing artifacts, never synced). */
export function getTempDir(): string {
  const dir = path.join(getLocalDataDir(), 'temp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Default watch directory: ~/Documents/deepseno_record
 * Cross-platform: Windows → Documents/deepseno_record, macOS → Documents/deepseno_record.
 * The directory is NOT created here; it's only resolved as a default path.
 */
export function getDefaultWatchDir(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('documents'), 'deepseno_record');
  } catch {
    return path.join(os.homedir(), 'Documents', 'deepseno_record');
  }
}

/** Output dir uses effective (synced) data dir. */
export function getOutputDir(): string {
  const dir = path.join(getEffectiveDataDir(), 'output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Directory for mobile-companion uploads (audio / photo / video / groups).
 * MUST be a persistent location: `os.tmpdir()` on macOS lives under
 * `/var/folders/.../T/` which the OS periodically clears, silently destroying
 * user content. Uses the effective (synced) data dir so uploads ride along
 * with the rest of the user's data if sync is enabled.
 */
export function getUploadsDir(): string {
  const dir = path.join(getEffectiveDataDir(), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Settings paths ────────────────────────────────────────

/** Shared settings (synced across machines). */
export function getSharedSettingsPath(): string {
  return path.join(getEffectiveDataDir(), 'settings-shared.json');
}

/** Local settings (per-machine, never synced). */
export function getLocalSettingsPath(): string {
  return path.join(getLocalDataDir(), 'settings-local.json');
}

/** Legacy settings path (for migration). */
export function getSettingsPath(): string {
  return path.join(getLocalDataDir(), 'settings.json');
}

/** Directory for sherpa-onnx ONNX models (always local, never synced). */
export function getSherpaModelsDir(): string {
  const dir = path.join(getLocalDataDir(), 'sherpa-models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory for downloaded FFmpeg binaries (always local). */
export function getFFmpegDir(): string {
  const dir = path.join(getLocalDataDir(), 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory for downloaded GGUF LLM models (always local). */
export function getLLMModelsDir(): string {
  const dir = path.join(getLocalDataDir(), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
