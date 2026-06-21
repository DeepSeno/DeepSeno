/**
 * Resolve a cached npx package's bin entry for direct execution.
 * Searches <npmCacheDir>/_npx/<hash>/node_modules/<pkg>/package.json for the bin field.
 *
 * Shared between PluginEngine and builtin tools so the lookup logic
 * lives in one place.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Platform-correct npm cache root directory.
 * - Windows: %LOCALAPPDATA%\npm-cache (matches `npm config get cache` default)
 * - macOS/Linux: ~/.npm
 *
 * Hardcoding ~/.npm on Windows silently breaks cache reads/clears — npm's
 * default there lives under LocalAppData, not the user home.
 */
export function getNpmCacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'npm-cache');
  }
  return path.join(os.homedir(), '.npm');
}

/** Location of npx's per-package extraction dir inside the npm cache. */
export function getNpxCacheDir(): string {
  return path.join(getNpmCacheDir(), '_npx');
}

export function findCachedNpxBin(pkgName: string): string | null {
  try {
    const npxCacheDir = getNpxCacheDir();
    if (!fs.existsSync(npxCacheDir)) return null;

    for (const entry of fs.readdirSync(npxCacheDir)) {
      // Scoped packages: @playwright/mcp → @playwright/mcp
      const pkgJsonPath = path.join(npxCacheDir, entry, 'node_modules', ...pkgName.split('/'), 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;

      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const bin = pkgJson.bin;
      if (!bin) continue;

      // bin can be a string or { name: path } object
      const binRelative = typeof bin === 'string' ? bin : Object.values(bin)[0] as string;
      if (!binRelative) continue;

      const binAbsolute = path.join(npxCacheDir, entry, 'node_modules', ...pkgName.split('/'), binRelative);
      if (fs.existsSync(binAbsolute)) {
        return binAbsolute;
      }
    }
  } catch (err: any) {
    console.warn(`[npx-resolve] Failed to find cached bin for "${pkgName}":`, err.message);
  }
  return null;
}

/**
 * Remove every npx cache entry that contains a copy of the given package.
 * Returns the number of entries removed. Safe to call when nothing matches.
 */
export function clearCachedNpxPackage(pkgName: string): number {
  let removed = 0;
  try {
    const npxCacheDir = getNpxCacheDir();
    if (!fs.existsSync(npxCacheDir)) return 0;

    for (const entry of fs.readdirSync(npxCacheDir)) {
      const pkgJsonPath = path.join(npxCacheDir, entry, 'node_modules', ...pkgName.split('/'), 'package.json');
      try {
        if (fs.existsSync(pkgJsonPath)) {
          fs.rmSync(path.join(npxCacheDir, entry), { recursive: true, force: true });
          removed++;
        }
      } catch { /* skip individual entry errors */ }
    }
  } catch { /* ignore top-level failures */ }
  return removed;
}
