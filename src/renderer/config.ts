/**
 * Renderer-side build-time configuration.
 * Values are injected by electron-vite via `define` in electron.vite.config.ts.
 */

declare const __API_BASE_URL__: string;

/** Backend API base URL (e.g. https://your-server.example.com/api/v1) */
export const API_BASE_URL = typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : '';

/** Public website base URL (derived from API_BASE_URL by stripping /api/v1) */
export const SITE_BASE_URL = API_BASE_URL.replace(/\/api\/v1$/, '');
