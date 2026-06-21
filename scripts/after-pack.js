/**
 * electron-builder afterPack hook
 *
 * Strips build artifacts from app.asar.unpacked to reduce installer size:
 *   1. sherpa-onnx duplicate libonnxruntime on macOS (~33 MB)
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively delete a directory or file, returning bytes freed.
 */
function rmSize(target) {
  if (!fs.existsSync(target)) return 0;
  let bytes = 0;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(target)) {
      bytes += rmSize(path.join(target, child));
    }
    fs.rmdirSync(target);
  } else {
    bytes = stat.size;
    fs.unlinkSync(target);
  }
  return bytes;
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;

  // Determine app.asar.unpacked path
  let unpackedDir;
  if (platform === 'darwin') {
    unpackedDir = path.join(
      appOutDir,
      `${productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked'
    );
  } else {
    // win32, linux
    unpackedDir = path.join(appOutDir, 'resources', 'app.asar.unpacked');
  }

  if (!fs.existsSync(unpackedDir)) {
    console.log('[afterPack] app.asar.unpacked not found, skipping cleanup');
    return;
  }

  console.log(`[afterPack] Stripping build artifacts from: ${unpackedDir}`);
  let totalSaved = 0;

  // ── 1. Strip non-target sherpa-onnx / sqlite-vec platform packages ──
  // asarUnpack globs `sherpa-onnx-*/**` and `sqlite-vec-*/**` pull in every
  // OS/arch variant. We keep only the current build target's package, and
  // FAIL LOUDLY if it's missing — otherwise we'd ship a DMG with no native
  // binary and the app would crash on first transcription.
  {
    const nodeModules = path.join(unpackedDir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      const archMap = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' };
      const arch = archMap[context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : process.arch] || process.arch;
      // sherpa-onnx-node uses "win" (not "win32") for Windows package names.
      const sherpaPlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
      // sqlite-vec uses "windows" (not "win32") for Windows package names.
      const sqliteVecPlatform = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
      const keepSherpa = `sherpa-onnx-${sherpaPlatform}-${arch}`;
      const keepSqliteVec = `sqlite-vec-${sqliteVecPlatform}-${arch}`;

      // Preflight: verify the platform packages we intend to keep actually exist.
      // pnpm only installs optional deps matching the dev machine's arch unless
      // pnpm.supportedArchitectures is configured. Without it, cross-arch builds
      // (e.g. building x64 DMG on arm64 dev machine) silently produce broken
      // installers because the target-arch package was never installed.
      const sherpaExists = fs.existsSync(path.join(nodeModules, keepSherpa));
      const sqliteVecExists = fs.existsSync(path.join(nodeModules, keepSqliteVec));
      if (!sherpaExists || !sqliteVecExists) {
        const missing = [
          !sherpaExists && keepSherpa,
          !sqliteVecExists && keepSqliteVec,
        ].filter(Boolean);
        throw new Error(
          `[afterPack] Target platform package(s) missing from node_modules for ` +
          `${platform}-${arch} build: ${missing.join(', ')}.\n` +
          `This usually means pnpm did not install the optional dependencies for ` +
          `the target architecture. Ensure package.json contains:\n` +
          `  "pnpm": { "supportedArchitectures": { "os": ["darwin","win32"], "cpu": ["x64","arm64"] } }\n` +
          `then run \`pnpm install\` and rebuild.`
        );
      }

      for (const entry of fs.readdirSync(nodeModules)) {
        const isSherpaPlatform = /^sherpa-onnx-(darwin|linux|win)-/.test(entry);
        const isSqliteVecPlatform = /^sqlite-vec-(darwin|linux|windows)-/.test(entry);
        if ((isSherpaPlatform && entry !== keepSherpa) ||
            (isSqliteVecPlatform && entry !== keepSqliteVec)) {
          const saved = rmSize(path.join(nodeModules, entry));
          if (saved > 0) {
            console.log(`  [strip-arch] Removed ${entry} (${formatMB(saved)} MB)`);
            totalSaved += saved;
          }
        }
      }
    }
  }

  // ── 2. Deduplicate sherpa-onnx libonnxruntime on macOS ────────────
  if (platform === 'darwin') {
    // Look for sherpa-onnx-darwin-arm64 or sherpa-onnx-darwin-x64
    const nodeModules = path.join(unpackedDir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      const sherpaPackages = fs.readdirSync(nodeModules).filter(
        (name) => name.startsWith('sherpa-onnx-darwin-')
      );

      for (const pkg of sherpaPackages) {
        const pkgDir = path.join(nodeModules, pkg);
        // Find the versioned libonnxruntime file
        const files = fs.readdirSync(pkgDir).filter(
          (f) => f.startsWith('libonnxruntime.') && f.endsWith('.dylib') && f !== 'libonnxruntime.dylib'
        );

        if (files.length === 0) continue;

        const versionedFile = files[0]; // e.g. libonnxruntime.1.23.2.dylib
        const symlinkPath = path.join(pkgDir, 'libonnxruntime.dylib');
        const versionedPath = path.join(pkgDir, versionedFile);

        // Only proceed if both exist and the symlink target is a regular file (not already a symlink)
        if (
          fs.existsSync(symlinkPath) &&
          fs.existsSync(versionedPath) &&
          fs.lstatSync(symlinkPath).isFile() &&
          !fs.lstatSync(symlinkPath).isSymbolicLink()
        ) {
          const saved = fs.lstatSync(symlinkPath).size;
          fs.unlinkSync(symlinkPath);
          fs.symlinkSync(versionedFile, symlinkPath);
          console.log(`  [sherpa-onnx] Replaced ${pkg}/libonnxruntime.dylib with symlink -> ${versionedFile} (${formatMB(saved)} MB)`);
          totalSaved += saved;
        }
      }
    }
  }

  console.log(`[afterPack] Total saved: ${formatMB(totalSaved)} MB`);
};
