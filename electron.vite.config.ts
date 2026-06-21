import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json';

function loadEnvValue(key: string, fallback = ''): string {
  const envPath = resolve(__dirname, '.env');
  if (!existsSync(envPath)) return process.env[key] || fallback;
  try {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : process.env[key] || fallback;
  } catch {
    return process.env[key] || fallback;
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['chokidar', '@modelcontextprotocol/sdk'] })],
    define: {
      __API_BASE_URL__: JSON.stringify(loadEnvValue('API_BASE_URL', '')),
    },
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          'sherpa-engine-worker': resolve(__dirname, 'src/main/audio/sherpa-engine-worker.ts'),
          'diarize-subprocess': resolve(__dirname, 'src/main/audio/diarize-subprocess.ts'),
          'embed-subprocess': resolve(__dirname, 'src/main/audio/embed-subprocess.ts'),
          'vad-embed-subprocess': resolve(__dirname, 'src/main/audio/vad-embed-subprocess.ts'),
        },
        onwarn(warning, warn) {
          // Suppress "dynamically imported by X but also statically imported by Y" noise
          if (warning.code === 'PLUGIN_WARNING' && warning.message?.includes('dynamically imported by')) return;
          warn(warning);
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
          recorder: resolve(__dirname, 'electron/recorder-preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          recorder: resolve(__dirname, 'src/renderer/recorder.html'),
        },
      },
    },
    plugins: [tailwindcss(), react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __API_BASE_URL__: JSON.stringify(loadEnvValue('API_BASE_URL', '')),
    },
  },
});
