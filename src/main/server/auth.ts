import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Request, Response, NextFunction } from 'express';

let serverToken: string | null = null;

/** Get the token file path in the data directory. */
function tokenFilePath(): string {
  let dir: string;
  if (process.env.DEEPSENO_DATA_DIR) {
    dir = process.env.DEEPSENO_DATA_DIR;
  } else {
    try {
      const { app } = require('electron');
      dir = path.join(app.getPath('userData'), 'deepseno');
    } catch {
      dir = path.join(process.env.APPDATA || os.homedir(), 'deepseno');
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'lan-token');
}

/**
 * Generate or load a persistent auth token.
 * If a token file already exists on disk, reuse it so mobile clients
 * don't need to re-pair after a server restart.
 */
export function generateToken(): string {
  const fp = tokenFilePath();
  try {
    const saved = fs.readFileSync(fp, 'utf-8').trim();
    if (saved.length >= 32) {
      serverToken = saved;
      return serverToken;
    }
  } catch {
    // File doesn't exist yet — generate a new token below.
  }
  serverToken = randomBytes(32).toString('hex');
  fs.writeFileSync(fp, serverToken, 'utf-8');
  return serverToken;
}

/** Return the current token (or null if not yet generated). */
export function getToken(): string | null {
  return serverToken;
}

/** Express middleware: reject requests without a valid Bearer token. */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!serverToken || token !== serverToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
