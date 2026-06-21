import express from 'express';
import type { Server } from 'http';
import https from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { generateToken, getToken, authMiddleware } from './auth';
import { CertManager } from './cert-manager';
import { MessageQueuedError } from '../channels/openclaw-wechat-channel';
import { getUploadsDir } from '../paths';
import { deriveLanKey, processProxyRequest } from './proxy-dispatcher';

/**
 * LAN HTTP server for mobile companion sync.
 *
 * Runs on port 18526 (configurable) and provides REST endpoints
 * for uploading audio, querying recordings, retrieving meeting notes,
 * and executing RAG queries — all authenticated via a random bearer token.
 *
 * Also provides a WebSocket server on the same port for real-time events
 * (pipeline progress, recording status changes, etc.).
 */
export class LanServer {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private httpsServer: Server | null = null;   // Server type already imported from 'http'
  private httpsWss: WebSocketServer | null = null;
  private certManager = new CertManager();
  private authenticatedClients: Set<WebSocket> = new Set();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private port: number;
  private httpsPort: number;

  // Callbacks to be wired up by the main process
  onFileUploaded: ((filePath: string) => string | null) | null = null;
  onGetRecordings: (() => any[]) | null = null;
  onGetSegments: ((recordingId: number) => any[]) | null = null;
  onSearchSegments: ((query: string) => any[]) | null = null;
  onGetMeetingNotes: ((recordingId: number) => any) | null = null;
  onGetRecordingFilePath: ((recordingId: number) => string | null) | null = null;
  onQuery: ((question: string) => Promise<any>) | null = null;

  // New v2 callbacks
  onGetDailySummary: ((date: string) => any) | null = null;
  onGetWeeklySummary: ((startDate: string) => any) | null = null;
  onGetMonthlySummary: ((startDate: string) => any) | null = null;
  onGetExtractedItems: ((opts?: { type?: string; status?: string; recordingId?: number }) => any[]) | null = null;
  onUpdateExtractedItemStatus: ((id: number, status: string) => void) | null = null;
  onGetChatSessions: (() => any[]) | null = null;
  onCreateChatSession: ((title?: string) => any) | null = null;
  onGetSessionMessages: ((sessionId: number) => any[]) | null = null;
  onQueryStream: ((question: string, onChunk: (text: string) => void, onStatus?: (s: string) => void) => Promise<any>) | null = null;
  onSaveChatMessage: ((sessionId: number, role: string, content: string, sourcesJson?: string) => any) | null = null;

  // Mobile companion callbacks
  onCreateTextNote: ((content: string) => any) | null = null;
  onGetBriefing: ((date: string) => any) | null = null;
  /**
   * On-demand regeneration trigger from mobile. mode is 'daily' (regenerate
   * date's daily summary) or 'weekly' (regenerate week starting at date).
   * Returns the rebuilt briefing so the client doesn't need a second fetch.
   */
  onRegenerateBriefing: ((mode: 'daily' | 'weekly', date: string) => Promise<any>) | null = null;

  // Channel webhook callbacks (no auth — platforms verify differently)
  onWechatWebhook?: (req: any, res: any) => void;
  onWechatVerify?: (req: any, res: any) => void;
  onDingtalkWebhook?: (req: any, res: any) => void;

  // External message sending callback
  onSendMessage: ((channelId: string, chatId: string, text: string) => Promise<void>) | null = null;

  constructor(port = 18526, httpsPort = 18527) {
    this.port = port;
    this.httpsPort = httpsPort;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // ─── Public: device discovery ─────────────────────────
    this.app.get('/api/ping', (_req, res) => {
      res.json({
        name: 'DeepSeno',
        version: '2.0',
        platform: process.platform,
      });
    });

    // ─── Protected: upload audio file ─────────────────────
    this.app.post(
      '/api/upload',
      authMiddleware,
      express.raw({ type: '*/*', limit: '500mb' }),
      async (req, res) => {
        try {
          // Decode filename — mobile clients may URL-encode it for non-ASCII safety
          let filename = `mobile-${Date.now()}.wav`;
          const rawHeader = req.headers['x-filename'] as string | undefined;
          if (rawHeader) {
            try {
              filename = decodeURIComponent(rawHeader);
            } catch {
              filename = rawHeader;
            }
          }
          // Persistent location (was os.tmpdir() — macOS purges that, see paths.ts)
          const uploadsDir = getUploadsDir();
          const filePath = path.join(uploadsDir, filename);
          fs.writeFileSync(filePath, req.body);

          // Enqueue for processing via callback
          const taskId = this.onFileUploaded?.(filePath) || null;

          res.json({ success: true, filePath, taskId });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
      },
    );

    // ─── Protected: upload multiple images as a group ─────
    const multiUpload = multer({
      dest: getUploadsDir(),
      limits: { fileSize: 500 * 1024 * 1024 },
    });

    this.app.post(
      '/api/upload-multi',
      authMiddleware,
      multiUpload.array('files', 20),
      async (req, res) => {
        try {
          const files = req.files as Express.Multer.File[];
          if (!files || files.length === 0) {
            res.status(400).json({ error: 'No files uploaded' });
            return;
          }

          const groupName =
            (req.headers['x-group-name'] as string) || `group-${Date.now()}`;
          const groupDir = path.join(getUploadsDir(), groupName);
          fs.mkdirSync(groupDir, { recursive: true });

          // Move multer temp files to group directory with original names
          for (const file of files) {
            const ext = path.extname(file.originalname) || '.jpg';
            const destName = `${String(files.indexOf(file) + 1).padStart(2, '0')}${ext}`;
            const destPath = path.join(groupDir, destName);
            fs.renameSync(file.path, destPath);
          }

          // Enqueue the group directory for processing
          const taskId = this.onFileUploaded?.(groupDir) || null;

          res.json({ success: true, filePath: groupDir, taskId, count: files.length });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
      },
    );

    // ─── Protected: serve recording images ────────────────
    this.app.get('/api/recordings/:id/image{/:index}', authMiddleware, (req, res) => {
      const recordingId = parseInt(req.params.id, 10);
      const index = req.params.index ? parseInt(req.params.index, 10) : 0;
      const filePath = this.onGetRecordingFilePath?.(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Image not found' });
        return;
      }
      try {
        if (fs.statSync(filePath).isDirectory()) {
          const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);
          const images = fs.readdirSync(filePath)
            .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .sort();
          if (index >= images.length) {
            res.status(404).json({ error: 'Image index out of range' });
            return;
          }
          res.sendFile(path.join(filePath, images[index]));
        } else {
          res.sendFile(filePath);
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: stream recording media (video/audio with Range support) ──
    this.app.get('/api/recordings/:id/media', (req, res) => {
      // Accept auth via header OR query param (mobile video players can't set headers)
      const headerToken = (req.headers.authorization || '').replace('Bearer ', '');
      const queryToken = req.query.token as string;
      const providedToken = headerToken || queryToken;
      if (!providedToken || providedToken !== getToken()) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const recordingId = parseInt(req.params.id, 10);
      const filePath = this.onGetRecordingFilePath?.(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Media file not found' });
        return;
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
        '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
        '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });

    // ─── Protected: get image count for a recording ──────
    this.app.get('/api/recordings/:id/images', authMiddleware, (req, res) => {
      const recordingId = parseInt(req.params.id, 10);
      const filePath = this.onGetRecordingFilePath?.(recordingId);
      if (!filePath || !fs.existsSync(filePath)) {
        res.json({ count: 0, images: [] });
        return;
      }
      try {
        if (fs.statSync(filePath).isDirectory()) {
          const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);
          const images = fs.readdirSync(filePath)
            .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .sort();
          res.json({ count: images.length, images });
        } else {
          res.json({ count: 1, images: [path.basename(filePath)] });
        }
      } catch {
        res.json({ count: 0, images: [] });
      }
    });

    // ─── Protected: list recent recordings ────────────────
    this.app.get('/api/recordings', authMiddleware, (_req, res) => {
      const recordings = this.onGetRecordings?.() || [];
      res.json(recordings);
    });

    // ─── Protected: get segments for a recording ──────────
    this.app.get('/api/recordings/:id/segments', authMiddleware, (req, res) => {
      const segments = this.onGetSegments?.(parseInt(req.params.id, 10)) || [];
      res.json(segments);
    });

    // ─── Protected: full-text search ────────────────────
    this.app.get('/api/search', authMiddleware, (req, res) => {
      const q = req.query.q as string;
      if (!q) {
        res.status(400).json({ error: 'q parameter is required' });
        return;
      }
      const results = this.onSearchSegments?.(q) || [];
      res.json(results);
    });

    // ─── Protected: get meeting notes for a recording ─────
    this.app.get('/api/recordings/:id/notes', authMiddleware, (req, res) => {
      const notes =
        this.onGetMeetingNotes?.(parseInt(req.params.id, 10)) || null;
      res.json(notes || { error: 'No notes found' });
    });

    // ─── Protected: RAG query ─────────────────────────────
    this.app.post('/api/query', authMiddleware, async (req, res) => {
      try {
        const { question } = req.body;
        if (!question) {
          res.status(400).json({ error: 'question is required' });
          return;
        }
        const result = await this.onQuery?.(question);
        res.json(result || { error: 'Query engine not available' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: daily summary ─────────────────────────
    this.app.get('/api/daily-summary/:date', authMiddleware, (req, res) => {
      try {
        const summary = this.onGetDailySummary?.(req.params.date);
        res.json(summary || { error: 'No summary found' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: weekly summary ────────────────────────
    this.app.get('/api/weekly-summary/:startDate', authMiddleware, (req, res) => {
      try {
        const summary = this.onGetWeeklySummary?.(req.params.startDate);
        res.json(summary || { error: 'No summary found' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: monthly summary ───────────────────────
    this.app.get('/api/monthly-summary/:startDate', authMiddleware, (req, res) => {
      try {
        const summary = this.onGetMonthlySummary?.(req.params.startDate);
        res.json(summary || { error: 'No summary found' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: extracted items (todos, decisions, etc.) ───
    this.app.get('/api/extracted-items', authMiddleware, (req, res) => {
      try {
        const opts: { type?: string; status?: string; recordingId?: number } = {};
        if (req.query.type) opts.type = req.query.type as string;
        if (req.query.status) opts.status = req.query.status as string;
        if (req.query.recordingId) opts.recordingId = parseInt(req.query.recordingId as string, 10);
        const items = this.onGetExtractedItems?.(opts) || [];
        res.json(items);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: update extracted item status ──────────
    this.app.patch('/api/extracted-items/:id/status', authMiddleware, (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const { status } = req.body;
        if (!status) {
          res.status(400).json({ error: 'status is required' });
          return;
        }
        this.onUpdateExtractedItemStatus?.(id, status);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: chat sessions ─────────────────────────
    this.app.get('/api/chat/sessions', authMiddleware, (_req, res) => {
      try {
        const sessions = this.onGetChatSessions?.() || [];
        res.json(sessions);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.post('/api/chat/sessions', authMiddleware, (req, res) => {
      try {
        const { title } = req.body || {};
        const session = this.onCreateChatSession?.(title);
        res.json(session || { error: 'Failed to create session' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: session messages ──────────────────────
    this.app.get('/api/chat/sessions/:id/messages', authMiddleware, (req, res) => {
      try {
        const sessionId = parseInt(req.params.id, 10);
        const messages = this.onGetSessionMessages?.(sessionId) || [];
        res.json(messages);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: RAG streaming query (SSE) ─────────────
    this.app.post('/api/query-stream', authMiddleware, async (req, res) => {
      try {
        const { question, sessionId } = req.body;
        if (!question) {
          res.status(400).json({ error: 'question is required' });
          return;
        }
        if (!this.onQueryStream) {
          res.status(503).json({ error: 'Query engine not available' });
          return;
        }

        // Save user message if session provided
        if (sessionId && this.onSaveChatMessage) {
          this.onSaveChatMessage(sessionId, 'user', question);
        }

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let fullAnswer = '';

        const result = await this.onQueryStream(
          question,
          (text: string) => {
            fullAnswer += text;
            res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
          },
          (status: string) => {
            res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);
          },
        );

        // Send done event with sources
        res.write(`data: ${JSON.stringify({ type: 'done', sources: result?.sources || [] })}\n\n`);
        res.end();

        // Save assistant response if session provided
        if (sessionId && this.onSaveChatMessage && fullAnswer) {
          this.onSaveChatMessage(
            sessionId,
            'assistant',
            fullAnswer,
            JSON.stringify(result?.sources || []),
          );
        }
      } catch (err) {
        // If headers already sent, write error as SSE event
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
          res.end();
        } else {
          res.status(500).json({ error: String(err) });
        }
      }
    });

    // ─── Protected: create text note (mobile companion) ──────
    this.app.post('/api/notes', authMiddleware, (req, res) => {
      try {
        const { content } = req.body;
        if (!content) {
          res.status(400).json({ error: 'content is required' });
          return;
        }
        const note = this.onCreateTextNote?.(content);
        res.json(note || { success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: aggregated briefing ─────────────────────
    this.app.get('/api/briefing', authMiddleware, (req, res) => {
      try {
        const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
        const briefing = this.onGetBriefing?.(date);
        res.json(briefing || { summary: null, todos: [], items: [] });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Protected: on-demand briefing regeneration ─────────
    // Long-running (LLM call). Mobile shows a spinner. We don't bound the
    // timeout server-side — the LLM call itself has its own.
    this.app.post('/api/briefing/regenerate', authMiddleware, async (req, res) => {
      try {
        const mode = (req.query.mode as string) === 'weekly' ? 'weekly' : 'daily';
        const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          res.status(400).json({ error: 'date must be yyyy-MM-dd' });
          return;
        }
        if (!this.onRegenerateBriefing) {
          res.status(503).json({ error: 'Regeneration handler not wired' });
          return;
        }
        const result = await this.onRegenerateBriefing(mode as 'daily' | 'weekly', date);
        res.json(result || { success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Public: WeChat webhook (POST — XML body, AES encrypted) ──
    this.app.post('/webhook/wechat', express.text({ type: '*/*' }), (req, res) => {
      if (this.onWechatWebhook) this.onWechatWebhook(req, res);
      else res.status(404).send('Not configured');
    });

    // ─── Public: WeChat URL verification (GET — echoes back echostr) ──
    this.app.get('/webhook/wechat', (req, res) => {
      if (this.onWechatVerify) this.onWechatVerify(req, res);
      else res.status(404).send('Not configured');
    });

    // ─── Public: DingTalk webhook (POST — JSON body) ────────────
    this.app.post('/webhook/dingtalk', express.json(), (req, res) => {
      if (this.onDingtalkWebhook) this.onDingtalkWebhook(req, res);
      else res.status(404).send('Not configured');
    });

    // External message sending endpoint (authenticated)
    this.app.post('/api/send-message', authMiddleware, async (req, res) => {
      if (!this.onSendMessage) {
        res.status(503).json({ error: 'Message sending not configured' });
        return;
      }
      try {
        const { channelId = 'openclaw-wechat', chatId = '', text } = req.body;
        if (!text) {
          res.status(400).json({ error: 'text is required' });
          return;
        }
        await this.onSendMessage(channelId, chatId, text);
        res.json({ success: true });
      } catch (err: any) {
        if (err instanceof MessageQueuedError) {
          // Message accepted into queue but not delivered to WeChat yet
          res.status(202).json({ success: true, queued: true, reason: err.reason });
          return;
        }
        console.error('[LanServer] send-message error:', err);
        res.status(500).json({ error: err.message });
      }
    });
  }

  // ─── WebSocket ──────────────────────────────────────────

  private setupWebSocket(server: Server): void {
    this.wss = new WebSocketServer({ server });
    this.attachWsHandlers(this.wss);

    // Heartbeat must run exactly ONCE across all listeners (both the LAN HTTP
    // wss and the public HTTPS wss share `this.authenticatedClients`). Guard
    // against re-arming if setupWebSocket is somehow called twice.
    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => {
        const pingMsg = JSON.stringify({ type: 'ping' });
        for (const client of this.authenticatedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(pingMsg);
          } else {
            this.authenticatedClients.delete(client);
          }
        }
      }, 30_000);
    }

    console.log('[LanServer] WebSocket server ready');
  }

  /**
   * Per-connection WebSocket logic, shared by every WebSocketServer instance
   * (LAN HTTP + public HTTPS). Operates on the SHARED `this.authenticatedClients`
   * set, so broadcasts reach clients regardless of which listener they connected
   * through. Does NOT start the heartbeat — that runs once in setupWebSocket.
   */
  private attachWsHandlers(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket, req) => {
      // Reject if already too many connections (guard against leaked clients)
      const MAX_WS_CLIENTS = 5;
      if (this.authenticatedClients.size >= MAX_WS_CLIENTS) {
        // Evict the oldest connection to make room
        const oldest = this.authenticatedClients.values().next().value;
        if (oldest) {
          console.log('[LanServer] Evicting oldest WS client to make room');
          oldest.close(4009, 'Replaced by new connection');
          this.authenticatedClients.delete(oldest);
        }
      }

      const clientIP = req.socket.remoteAddress || 'unknown';
      console.log(`[LanServer] WS connection opened from ${clientIP}, waiting for auth...`);

      let authenticated = false;

      // 10s auth timeout
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          console.log('[LanServer] WS auth timeout, closing');
          ws.close(4001, 'Auth timeout');
        }
      }, 10_000);

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString());

          if (!authenticated) {
            // Expect auth message first
            if (msg.type === 'auth' && msg.token === getToken()) {
              authenticated = true;
              clearTimeout(authTimeout);
              this.authenticatedClients.add(ws);
              ws.send(JSON.stringify({ type: 'connected', serverVersion: '2.0' }));
              console.log(`[LanServer] WS client authenticated from ${clientIP} (${this.authenticatedClients.size} total)`);
            } else {
              ws.close(4003, 'Invalid token');
            }
            return;
          }

          // Handle pong (heartbeat response)
          if (msg.type === 'pong') {
            // Client is alive — nothing to do
            return;
          }

          // Handle proxy-req — unified WebSocket proxy protocol (same as relay)
          if (msg.type === 'proxy-req' && msg.id && Array.isArray(msg.frames)) {
            const token = getToken();
            if (!token) return;
            const aesKey = deriveLanKey(token);
            const frames = msg.frames.map((f: string) => Buffer.from(f, 'base64'));
            processProxyRequest(this, aesKey, frames)
              .then(({ status, frames: respFrames }) => {
                ws.send(JSON.stringify({
                  type: 'proxy-resp',
                  id: msg.id,
                  status,
                  frames: respFrames.map((f: Buffer) => f.toString('base64')),
                }));
              })
              .catch((err) => {
                console.warn('[LanServer] proxy-req error:', err);
                ws.send(JSON.stringify({ type: 'proxy-resp', id: msg.id, error: 'internal error' }));
              });
            return;
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        this.authenticatedClients.delete(ws);
        console.log(`[LanServer] WS client disconnected (${this.authenticatedClients.size} remaining)`);
      });

      ws.on('error', (err) => {
        console.warn('[LanServer] WS client error:', err.message);
        this.authenticatedClients.delete(ws);
      });
    });
  }

  /** Broadcast an event to all authenticated WebSocket clients. */
  broadcast(event: { type: string; [key: string]: any }): void {
    if (this.authenticatedClients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      } else {
        this.authenticatedClients.delete(client);
      }
    }
  }

  /** Start listening. Returns the generated auth token. */
  async start(): Promise<string> {
    // Guard against double-start
    if (this.server && this.server.listening) {
      console.log('[LanServer] Already running, skipping start');
      return getToken() || generateToken();
    }

    // Clean up previous server if it exists but isn't listening
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }

    const token = generateToken();

    // Wait for the server to actually start listening
    await new Promise<void>((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[LanServer] Listening on port ${this.port}`);
        resolve();
      });
      this.server.on('error', (err: Error) => {
        console.error('[LanServer] Server error:', err.message);
        this.server = null;
        reject(err);
      });
    });

    // Setup WebSocket on the same HTTP server
    this.setupWebSocket(this.server!);

    // ─── HTTPS endpoint for public (relay) access ───────────
    try {
      const { cert, key } = this.certManager.getOrCreate();
      await new Promise<void>((resolve) => {
        this.httpsServer = https.createServer({ cert, key }, this.app);
        this.httpsServer.listen(this.httpsPort, '127.0.0.1', () => {
          console.log(`[LanServer] HTTPS listening on 127.0.0.1:${this.httpsPort}`);
          resolve();
        });
        this.httpsServer.on('error', (err: Error) => {
          // Only treat pre-listen failures (port in use, bad cert) as fatal-for-HTTPS.
          // Post-listen runtime errors must NOT null out a server that stop() still owns.
          if (this.httpsServer && !this.httpsServer.listening) {
            console.warn('[LanServer] HTTPS listen failed (non-critical):', err.message);
            this.httpsServer = null;
            resolve(); // non-fatal: LAN HTTP still works
          } else {
            console.warn('[LanServer] HTTPS runtime error:', err.message);
          }
        });
      });
      if (this.httpsServer) {
        this.httpsWss = new WebSocketServer({ server: this.httpsServer });
        this.attachWsHandlers(this.httpsWss);
      }
    } catch (err) {
      console.warn('[LanServer] HTTPS init skipped:', err);
    }

    // ─── mDNS skipped — phones connect via QR code scan ───

    return token;
  }

  /**
   * Friendly, stable device name for the companion's discovery list.
   * os.hostname() is network-derived and gets poisoned to placeholders like
   * "bogon" behind some VPNs, so prefer the user-set computer name.
   */
  private getDeviceName(): string {
    // macOS: the user-facing Computer Name (what AirDrop/Finder show) — set by
    // the user, unaffected by DHCP/VPN. Fall back to the Bonjour-safe LocalHostName.
    if (process.platform === 'darwin') {
      for (const key of ['ComputerName', 'LocalHostName']) {
        try {
          const name = execSync(`scutil --get ${key}`, { timeout: 1000 }).toString().trim();
          if (name) return name;
        } catch { /* ignore */ }
      }
    }
    // Other platforms (or scutil failed): hostname minus .local, unless it's a
    // useless placeholder or a bare IP.
    const host = os.hostname().replace(/\.local$/, '').trim();
    const bad = new Set(['', 'bogon', 'localhost', 'unknown']);
    const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (host && !bad.has(host.toLowerCase()) && !looksLikeIp) return host;
    return 'Desktop';
  }

  /** Stop the server. */
  stop(): void {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all WebSocket clients
    for (const client of this.authenticatedClients) {
      try { client.close(1001, 'Server shutting down'); } catch {}
    }
    this.authenticatedClients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      console.log('[LanServer] WebSocket server closed');
    }

    // Close HTTPS WebSocket server + HTTPS server (public relay path)
    if (this.httpsWss) { try { this.httpsWss.close(); } catch {} this.httpsWss = null; }
    if (this.httpsServer) { try { this.httpsServer.close(); } catch {} this.httpsServer = null; }

    if (this.server) {
      this.server.close();
      this.server = null;
      console.log('[LanServer] Stopped');
    }
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Get the best non-internal IPv4 address (for QR code / mobile discovery). */
  getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    // Prefer physical adapters (en0/en1 on macOS, eth/wlan on Linux, Ethernet/Wi-Fi on Windows)
    // over virtual interfaces (utun, tun, vEthernet, vmnet, etc.).
    const physicalPrefixes = ['en', 'eth', 'wlan', 'Ethernet', 'Wi-Fi'];
    let fallback: string | null = null;

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        // Skip link-local addresses (169.254.x.x) — useless for device discovery
        if (iface.address.startsWith('169.254.')) continue;
        const isPhysical = physicalPrefixes.some((p) => name.startsWith(p));
        if (isPhysical) return iface.address;
        if (!fallback) fallback = iface.address;
      }
    }
    return fallback || '127.0.0.1';
  }

  /** Connection info for the mobile companion to use. */
  getConnectionInfo(): { host: string; port: number; token: string | null; fingerprint: string } {
    return {
      host: this.getLocalIP(),
      port: this.port,
      token: getToken(),
      fingerprint: this.certManager.getFingerprint(),
    };
  }

  /** Get the number of currently connected WebSocket clients (phones). */
  getClientCount(): number {
    return this.authenticatedClients.size;
  }

  /** HTTPS port (local-only, used by relay tunnel). */
  getHttpsPort(): number { return this.httpsPort; }

  /**
   * Handle a decrypted relay request internally, without going through the real
   * HTTP stack. This lets the relay tunnel (P2P or server-relay) reuse ALL
   * existing LanServer routes (upload, query, segments, notes, etc.) with zero
   * route duplication.
   *
   * Constructs a mock Express request/response pair, dispatches through
   * this.app, and returns the response status + headers + body.
   *
   * NOTE: authMiddleware checks the Bearer token. Relay requests don't carry
   * the LAN token, so we inject it here. The relay tunnel's own encryption
   * (ECDH + AES-GCM) is the real authentication — any request that reaches
   * here has already been decrypted by a paired phone holding the shared key.
   */
  async handleInternal(
    method: string,
    reqPath: string,
    headers: Record<string, string>,
    body: Buffer | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    // Inject the LAN auth token so authMiddleware passes. The relay tunnel
    // has already authenticated the phone via ECDH pairing — this token
    // injection is just to satisfy the existing middleware.
    const injectHeaders: Record<string, string> = {
      ...headers,
      authorization: `Bearer ${getToken()}`,
    };
    // If the body looks like JSON, set content-type so Express's json() middleware
    // parses it correctly. For relay proxy requests, the body is raw decrypted bytes
    // that Express needs to parse as JSON for routes like /api/query.
    const bodyStr = body?.toString('utf-8') || '';
    let isJson = false;
    if (body && body.length > 0) {
      if (!injectHeaders['content-type']) {
        // Try to detect JSON
        try { JSON.parse(bodyStr); isJson = true; injectHeaders['content-type'] = 'application/json'; }
        catch { injectHeaders['content-type'] = 'application/octet-stream'; }
      } else if (injectHeaders['content-type']?.includes('json')) {
        isJson = true;
      }
    }

    return new Promise((resolve) => {
      // Pre-parse JSON body so Express's json() middleware doesn't need to
      // read from the (non-existent) request stream.
      let parsedBody: any = body || Buffer.alloc(0);
      if (isJson && body && body.length > 0) {
        try { parsedBody = JSON.parse(bodyStr); } catch { /* leave as raw buffer */ }
      }

      const mockReq = {
        method,
        url: reqPath,
        path: reqPath,
        headers: injectHeaders,
        body: parsedBody,   // pre-populated: Express body-parser skips if _body is truthy
        _body: true,        // always true — body is already provided, no stream to read
        query: {},
        params: {},
        // Express req.get() helper — body-parser uses this to check Content-Type
        get: (name: string) => injectHeaders[name.toLowerCase()],
        // Express may call these during body parsing
        on: (_event: string, _cb: (...args: any[]) => void) => {},
        pipe: (_dest: any) => {},
      };

      const chunks: Buffer[] = [];
      const mockRes = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        _chunks: chunks,
        set(key: string, val: string) { this.headers[key.toLowerCase()] = val; },
        setHeader(key: string, val: string) { this.headers[key.toLowerCase()] = val; },
        getHeader(key: string) { return this.headers[key.toLowerCase()]; },
        write(chunk: any) {
          if (Buffer.isBuffer(chunk)) this._chunks.push(chunk);
          else this._chunks.push(Buffer.from(chunk));
          return true;
        },
        end(chunk?: any) {
          if (chunk) {
            if (Buffer.isBuffer(chunk)) this._chunks.push(chunk);
            else this._chunks.push(Buffer.from(chunk));
          }
          resolve({
            status: this.statusCode,
            headers: this.headers,
            body: Buffer.concat(this._chunks),
          });
        },
        json(data: any) {
          const body = Buffer.from(JSON.stringify(data), 'utf-8');
          this.setHeader('Content-Type', 'application/json');
          this.end(body);
        },
        status(code: number) { this.statusCode = code; return this; },
        send(body?: any) {
          if (body === undefined) this.end();
          else if (Buffer.isBuffer(body)) this.end(body);
          else if (typeof body === 'string') this.end(Buffer.from(body, 'utf-8'));
          else this.json(body);
        },
        sendFile(filePath: string, _opts?: any, callback?: (err?: any) => void) {
          try {
            const data = fs.readFileSync(filePath);
            this._chunks.push(data);
            this.end();
          } catch (err) {
            this.statusCode = 500;
            this.end(Buffer.from(String(err), 'utf-8'));
          }
          if (callback) callback();
        },
        redirect(code: number, url?: string) {
          if (url === undefined) { url = String(code); code = 302; }
          this.setHeader('Location', url);
          this.statusCode = code;
          this.end();
        },
      };

      // Dispatch through Express. Cast to any because our mock objects
      // are structurally compatible but not type-compatible with Express.
      this.app(mockReq as any, mockRes as any);
    });
  }
}
