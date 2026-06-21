// Cross-platform dev launcher — sets console code page to UTF-8 on Windows
// before starting electron-vite.
//
// WHY: Electron is a GUI-subsystem binary. On Windows, libuv may not detect
// its stdout as a TTY, so Node.js falls back to WriteFile (raw UTF-8 bytes)
// instead of WriteConsoleW (native Unicode). If the console code page is 936
// (GBK, default on Chinese Windows), UTF-8 bytes are misinterpreted → garbled
// Chinese. Setting code page to 65001 (UTF-8) BEFORE Electron starts ensures
// the console correctly interprets the bytes.
//
// NOTE: The chcp must happen in a console-subsystem process (this Node.js
// script), not inside Electron (GUI subsystem), because GUI apps may not have
// proper console attachment for SetConsoleOutputCP to take effect.

'use strict';

const { execSync, spawn } = require('child_process');

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'pipe' });
  } catch {
    // non-critical — worst case is garbled Chinese in dev logs
  }
}

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_OPTIONS: '--no-deprecation' },
});

child.on('exit', (code) => process.exit(code ?? 0));

// Forward signals for graceful shutdown
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
