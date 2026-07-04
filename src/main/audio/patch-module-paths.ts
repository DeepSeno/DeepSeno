/**
 * Patch Node.js module resolution for packaged Electron builds.
 *
 * In packaged builds, code runs from app.asar but native addons (.node files)
 * are in app.asar.unpacked/node_modules/. Worker threads and child processes
 * cannot find them without this patch.
 *
 * Call this BEFORE any require() of native addons (sherpa-onnx-node, etc.).
 */
export function patchModulePathsForPackagedBuild(): void {
  if (!__dirname.includes('app.asar')) return;

  const rootUnpacked = __dirname.replace(/app\.asar[/\\].*/, 'app.asar.unpacked/node_modules');

  // Add to current module's search paths
  if (!module.paths.includes(rootUnpacked)) {
    module.paths.unshift(rootUnpacked);
  }

  // Also patch require.main if available (for worker threads)
  if (require.main && !require.main.paths.includes(rootUnpacked)) {
    require.main.paths.unshift(rootUnpacked);
  }
}
