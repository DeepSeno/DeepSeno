import { useEffect, useState, useCallback } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'deepseno.theme';
const DEFAULT_THEME: Theme = 'dark';

// A theme forced at startup via the KZ_THEME env var (wired through the main
// process as a --kz-theme=<dark|light> additionalArgument, exposed by preload).
// Lets the app launch in a specific theme regardless of the stored preference
// (useful for screenshots / testing). Returns null when not forced.
export function getForcedTheme(): Theme | null {
  try {
    const f = (window as unknown as { __kzForcedTheme?: unknown }).__kzForcedTheme;
    if (f === 'light' || f === 'dark') return f;
  } catch {}
  return null;
}

export function readStoredTheme(): Theme {
  const forced = getForcedTheme();
  if (forced) return forced;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return DEFAULT_THEME;
}

export function applyTheme(theme: Theme) {
  document.body.dataset.theme = theme;
  // Notify the Electron main process so OS-level window chrome
  // (backgroundColor, titleBarOverlay) tracks the theme. No-op in browser preview.
  try { (window as any).api?.setTheme?.(theme); } catch {}
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    // Don't persist when the theme is forced at startup (KZ_THEME) — keep the
    // user's stored preference untouched.
    if (!getForcedTheme()) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(() => setThemeState((p) => (p === 'dark' ? 'light' : 'dark')), []);

  return { theme, setTheme, toggle };
}
