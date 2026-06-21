/**
 * Download mirror configuration.
 * Default: always use ModelScope for better download speed in China.
 */

export type MirrorRegion = 'global' | 'china';

/** Always return 'china' since we default to ModelScope. */
export function getEffectiveMirror(): MirrorRegion {
  return 'china';
}

// ─── GitHub Release Mirrors ──────────────────────────────────

const GITHUB_PROXY = 'https://ghfast.top';

/** Resolve a GitHub URL, optionally via China proxy. */
export function resolveGitHubUrl(url: string): string {
  if (url.includes('github.com')) {
    return `${GITHUB_PROXY}/${url}`;
  }
  return url;
}

// ─── Sherpa / HuggingFace Mirrors ────────────────────────────

/** Always use ModelScope as primary download source. */
export function getSherpaModelMirror(): 'modelscope' {
  return 'modelscope';
}
