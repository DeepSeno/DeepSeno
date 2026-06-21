// Standalone Vite config for previewing the renderer in a regular browser.
// useApi.ts falls back to createMockApi() when window.api is absent (non-Electron).
// Run with: pnpm exec vite --config vite.preview.config.mjs --port 3700
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __HF_TOKEN__: JSON.stringify(''),
  },
  server: {
    port: 3710,
    strictPort: true,
    fs: { strict: true, allow: [__dirname] },
    watch: { ignored: ['**/python/**', '**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/resources/**'] },
  },
  optimizeDeps: {
    entries: ['index.html', 'src/main.tsx', 'src/renderer/**/*.{ts,tsx}'],
    exclude: ['gradio', 'svelte'],
  },
});
