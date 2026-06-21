import fs from 'fs';
import path from 'path';
import { MessageChannel, IncomingMessage, MessageCard } from './types';
import { ILinkClient, ILinkApiError, ILinkMessage, ILinkMessageItem } from './ilink-client';
import { getLocalDataDir } from '../paths';

interface PendingMessage {
  userId: string;
  text: string;
  createdAt: number;
  type: 'text' | 'file';
  filePath?: string;
}

/**
 * Thrown when a message is queued instead of delivered (e.g. context_token expired).
 * Callers should treat this as "accepted but not yet delivered."
 */
export class MessageQueuedError extends Error {
  constructor(public readonly reason: string) {
    super(`Message queued: ${reason}`);
    this.name = 'MessageQueuedError';
  }
}

/**
 * Personal WeChat channel via OpenClaw ClawBot ilink API.
 *
 * Distinct from WeChatChannel (Enterprise WeChat / 企业微信).
 * This uses ilink long-polling (no webhook / public IP needed).
 */
export class OpenClawWeChatChannel implements MessageChannel {
  readonly id = 'openclaw-wechat';
  readonly name = '个人微信 (ClawBot)';

  private static readonly MAX_QUEUE_SIZE = 100;
  private static readonly QUEUE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private client: ILinkClient;
  // Map userId → latest contextToken with timestamp (needed for replies)
  private contextTokens: Map<string, { token: string; updatedAt: number }> = new Map();
  // Last active user (for proactive push when no chatId is specified)
  private lastActiveUserId = '';
  // Callback to enqueue files into pipeline (set by integration-handlers)
  private pipelineEnqueue: ((filePath: string) => void) | null = null;
  // Track files enqueued from WeChat → userId, so we can push results back
  private pendingMediaFiles: Map<string, { userId: string }> = new Map();
  // Queue for messages that failed due to stale context_token (ret=-2)
  private pendingQueue: PendingMessage[] = [];
  // Periodic timer to keep context_tokens alive via sendTyping
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

  private tokenStorePath: string;

  constructor() {
    this.client = new ILinkClient();
    this.tokenStorePath = path.join(getLocalDataDir(), 'openclaw-context-tokens.json');
    this.loadPersistedTokens();
  }

  private loadPersistedTokens(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenStorePath, 'utf-8'));
      for (const [userId, entry] of Object.entries(data as Record<string, { token: string; updatedAt: number }>)) {
        this.contextTokens.set(userId, entry);
      }
      console.log(`[OpenClawWeChatChannel] Loaded ${this.contextTokens.size} persisted context token(s)`);
    } catch { /* file may not exist */ }
  }

  private persistTokens(): void {
    try {
      const data: Record<string, { token: string; updatedAt: number }> = {};
      for (const [userId, entry] of this.contextTokens) {
        data[userId] = entry;
      }
      fs.writeFileSync(this.tokenStorePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* not critical */ }
  }

  // ─── MessageChannel interface ────────────────────────────

  async start(): Promise<void> {
    if (!this.client.isAuthenticated()) {
      // Try loading saved credentials
      if (!this.client.loadCredentials()) {
        throw new Error('[OpenClawWeChatChannel] Not authenticated — scan QR code first');
      }
    }

    this.client.onMessage((msg) => this.handleILinkMessage(msg));
    this.client.onDisconnect((reason) => {
      console.warn(`[OpenClawWeChatChannel] Disconnected: ${reason}`);
    });

    this.client.startPolling();
    await this.verifyLoadedTokens();
    this.startTokenKeepalive();
    console.log('[OpenClawWeChatChannel] Channel started');
  }

  /** Verify persisted tokens at startup: ping each with sendTyping and drop
   *  any that come back as expired (ret=-2). Leaves network/transient
   *  failures intact so they can be retried by keepalive later. */
  private async verifyLoadedTokens(): Promise<void> {
    const entries = [...this.contextTokens];
    if (!entries.length) return;
    for (const [userId, entry] of entries) {
      try {
        await this.client.sendTyping(userId, entry.token);
        entry.updatedAt = Date.now();
      } catch (err: any) {
        if (err instanceof ILinkApiError && err.ret === -2) {
          this.contextTokens.delete(userId);
        }
      }
    }
    this.persistTokens();
    console.log(
      `[OpenClawWeChatChannel] Verified ${entries.length} token(s), ${this.contextTokens.size} still alive`,
    );
  }

  async stop(): Promise<void> {
    this.stopTokenKeepalive();
    this.client.stopPolling();
    // Persist tokens before clearing so they survive restarts
    this.persistTokens();
    this.contextTokens.clear();
    this.pendingQueue = [];
    console.log('[OpenClawWeChatChannel] Channel stopped');
  }

  isRunning(): boolean {
    return this.client.isPolling;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    // For proactive push (scheduled tasks), use last active user if no chatId specified
    const targetId = chatId || this.lastActiveUserId;
    const entry = this.contextTokens.get(targetId);
    if (!entry) {
      console.warn(`[OpenClawWeChatChannel] No context_token for ${targetId}, queuing message`);
      this.enqueueMessage({ userId: targetId, text, createdAt: Date.now(), type: 'text' });
      throw new MessageQueuedError('no_context_token');
    }
    const ageMin = ((Date.now() - entry.updatedAt) / 60000).toFixed(1);
    console.log(`[OpenClawWeChatChannel] sendText targetId="${targetId}" tokenAge=${ageMin}min`);
    try {
      // Split long messages (WeChat has a soft ~4096 char limit per message)
      const chunks = this.splitText(text, 4000);
      for (const chunk of chunks) {
        await this.client.sendText(targetId, entry.token, chunk);
      }
    } catch (err: any) {
      if (err instanceof ILinkApiError && err.ret === -2) {
        console.warn(`[OpenClawWeChatChannel] context_token expired for ${targetId} (age=${ageMin}min), clearing and queuing`);
        this.contextTokens.delete(targetId);
        this.persistTokens();
        this.enqueueMessage({ userId: targetId, text, createdAt: Date.now(), type: 'text' });
        throw new MessageQueuedError('context_token_expired');
      }
      throw err;
    }
  }

  async sendCard(chatId: string, card: MessageCard): Promise<void> {
    // ilink API has no native card — format as structured text
    const parts = [`【${card.title}】`];
    for (const section of card.sections) {
      if (section.header) parts.push(`\n▎${section.header}`);
      parts.push(section.content);
    }
    await this.sendText(chatId, parts.join('\n'));
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    const targetId = chatId || this.lastActiveUserId;
    const entry = this.contextTokens.get(targetId);
    if (!entry) {
      console.warn(`[OpenClawWeChatChannel] sendFile: no context_token for ${targetId}, queuing`);
      this.enqueueMessage({ userId: targetId, text: '', createdAt: Date.now(), type: 'file', filePath });
      return;
    }
    if (!fs.existsSync(filePath)) {
      console.warn(`[OpenClawWeChatChannel] sendFile: file not found: ${filePath}`);
      await this.sendText(chatId, `文件不存在：${filePath}`);
      return;
    }
    try {
      await this.client.sendFile(targetId, entry.token, filePath);
      console.log(`[OpenClawWeChatChannel] File sent: ${filePath}`);
    } catch (err: any) {
      if (err instanceof ILinkApiError && err.ret === -2) {
        console.warn(`[OpenClawWeChatChannel] context_token expired for sendFile ${targetId}, clearing and queuing`);
        this.contextTokens.delete(targetId);
        this.persistTokens();
        this.enqueueMessage({ userId: targetId, text: '', createdAt: Date.now(), type: 'file', filePath });
        return;
      }
      console.error(`[OpenClawWeChatChannel] sendFile failed:`, err.message);
      await this.sendText(chatId, `📎 文件发送失败，文件路径: ${filePath}\n错误: ${err.message}`);
    }
  }

  async sendImage(chatId: string, imageData: Buffer, _mimeType: string): Promise<void> {
    const targetId = chatId || this.lastActiveUserId;
    const entry = this.contextTokens.get(targetId);
    if (!entry) {
      // Image messages are NOT queued (avoid memory pressure from large Buffers)
      console.warn(`[OpenClawWeChatChannel] sendImage: no context_token for ${targetId}, dropping image`);
      return;
    }
    try {
      await this.client.sendImage(targetId, entry.token, imageData);
      console.log(`[OpenClawWeChatChannel] Image sent to ${targetId} (${imageData.length} bytes)`);
    } catch (err: any) {
      if (err instanceof ILinkApiError && err.ret === -2) {
        console.warn(`[OpenClawWeChatChannel] context_token expired for sendImage ${targetId}, dropping image`);
        this.contextTokens.delete(targetId);
        this.persistTokens();
        return;
      }
      console.error(`[OpenClawWeChatChannel] sendImage failed:`, err.message);
    }
  }

  // ─── Auth helpers (used by IPC) ──────────────────────────

  getClient(): ILinkClient {
    return this.client;
  }

  /** Set pipeline enqueue callback for auto-processing */
  setPipelineEnqueue(fn: (filePath: string) => void): void {
    this.pipelineEnqueue = fn;
  }

  /** Called when a pipeline task completes — push result back to WeChat user */
  async onPipelineComplete(filePath: string, summary: string): Promise<void> {
    const pending = this.pendingMediaFiles.get(filePath);
    if (!pending) return; // Not from WeChat
    this.pendingMediaFiles.delete(filePath);
    const text = summary || '处理完成';
    console.log(`[OpenClawWeChatChannel] Pipeline done for ${filePath}, notifying user`);
    // Use standard sendText which handles stale tokens and queuing
    await this.sendText(pending.userId, text);
  }

  // ─── Internal ────────────────────────────────────────────

  private async handleILinkMessage(msg: ILinkMessage): Promise<void> {
    if (!this.messageHandler) return;

    // Save context_token for reply routing + remember last active user for proactive push
    this.contextTokens.set(msg.fromUserId, { token: msg.contextToken, updatedAt: Date.now() });
    this.lastActiveUserId = msg.fromUserId;
    this.persistTokens();

    // Flush any queued messages now that we have a fresh token
    this.flushPendingQueue(msg.fromUserId, msg.contextToken).catch((err) => {
      console.error('[OpenClawWeChatChannel] Queue flush error:', err.message);
    });

    // Send typing indicator
    this.client.sendTyping(msg.fromUserId, msg.contextToken).catch(() => {});

    // Determine message type from first item
    const firstItem = msg.items[0];
    if (!firstItem) return;

    // Handle media types (image/file/video) — download, save, respond directly
    if (firstItem.type === 'image' || firstItem.type === 'file' || firstItem.type === 'video') {
      await this.handleMediaItem(firstItem, msg);
      return;
    }

    let incomingType: 'text' | 'voice' | 'file' = 'text';
    let content = '';
    let audioUrl: string | undefined;

    switch (firstItem.type) {
      case 'text':
        incomingType = 'text';
        content = firstItem.text || '';
        break;

      case 'voice':
        incomingType = 'voice';
        // Use voice ASR transcription if available, otherwise empty
        content = firstItem.voiceText || '';
        audioUrl = firstItem.mediaUrl;
        break;
    }

    const incoming: IncomingMessage = {
      channelId: this.id,
      userId: msg.fromUserId,
      userName: msg.fromUserId.split('@')[0] || msg.fromUserId,
      chatId: msg.fromUserId,
      type: incomingType,
      content,
      audioUrl,
      timestamp: Date.now(),
      raw: msg.raw,
    };

    console.log(`[OpenClawWeChatChannel] Incoming ${incomingType} from ${incoming.userName}: ${content.slice(0, 50)}`);

    try {
      await this.messageHandler(incoming);
    } catch (err: any) {
      console.error('[OpenClawWeChatChannel] Handler error:', err.message);
    }
  }

  /** Download, decrypt, and save media; enqueue video to pipeline */
  private async handleMediaItem(item: ILinkMessageItem, msg: ILinkMessage): Promise<void> {
    const userId = msg.fromUserId;
    const userName = userId.split('@')[0] || userId;
    const contextToken = msg.contextToken;

    console.log(`[OpenClawWeChatChannel] handleMediaItem type=${item.type} encryptQueryParam=${item.encryptQueryParam ? `${item.encryptQueryParam.length}chars` : 'EMPTY'} aesKey=${item.aesKey ? `${item.aesKey.length}chars` : 'EMPTY'}`);

    const typeLabel = item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : '文件';

    if (!item.encryptQueryParam) {
      console.warn(`[OpenClawWeChatChannel] ${item.type} missing encryptQueryParam`);
      await this.replyText(userId, contextToken, `收到${typeLabel}，但无法下载（缺少媒体信息）`);
      return;
    }

    console.log(`[OpenClawWeChatChannel] Incoming ${item.type} from ${userName}, downloading...`);

    try {
      // Download from CDN (decrypt if aesKey present)
      const data = await this.client.downloadMedia(item.encryptQueryParam!, item.aesKey || '');

      // Determine file name
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let fileName: string;
      if (item.fileName) {
        // Use original file name with timestamp prefix to avoid collisions
        fileName = `wechat-${timestamp}-${item.fileName}`;
      } else {
        const extMap: Record<string, string> = { image: '.jpg', video: '.mp4', file: '.bin' };
        fileName = `wechat-${timestamp}${extMap[item.type] || '.bin'}`;
      }

      // Save to imports directory
      const importsDir = path.join(getLocalDataDir(), 'imports');
      fs.mkdirSync(importsDir, { recursive: true });
      const filePath = path.join(importsDir, fileName);
      fs.writeFileSync(filePath, data);

      const sizeMB = (data.length / 1024 / 1024).toFixed(1);
      console.log(`[OpenClawWeChatChannel] Saved ${item.type}: ${filePath} (${sizeMB}MB)`);

      // Auto-enqueue all media to pipeline for processing
      if (this.pipelineEnqueue) {
        this.pendingMediaFiles.set(filePath, { userId });
        this.pipelineEnqueue(filePath);
        await this.replyText(userId, contextToken, `${typeLabel}已接收（${sizeMB}MB），正在处理...`);
      } else {
        await this.replyText(userId, contextToken, `${typeLabel}已保存：${fileName}`);
      }
    } catch (err: any) {
      console.error(`[OpenClawWeChatChannel] ${item.type} download failed:`, err.message);
      await this.replyText(userId, contextToken, `${typeLabel}下载失败：${err.message}`);
    }
  }

  /** Helper to reply text directly (bypasses MessageHandler) */
  private async replyText(userId: string, contextToken: string, text: string): Promise<void> {
    try {
      await this.client.sendText(userId, contextToken, text);
    } catch (err: any) {
      console.error('[OpenClawWeChatChannel] replyText failed:', err.message);
    }
  }

  private enqueueMessage(msg: PendingMessage): void {
    const now = Date.now();
    // Prune expired entries
    this.pendingQueue = this.pendingQueue.filter(
      (m) => now - m.createdAt < OpenClawWeChatChannel.QUEUE_TTL_MS,
    );
    // Evict oldest if full
    if (this.pendingQueue.length >= OpenClawWeChatChannel.MAX_QUEUE_SIZE) {
      this.pendingQueue.shift();
    }
    this.pendingQueue.push(msg);
    console.log(
      `[OpenClawWeChatChannel] Message queued for ${msg.userId}, queue size=${this.pendingQueue.length}`,
    );
  }

  private async flushPendingQueue(userId: string, token: string): Promise<void> {
    const now = Date.now();
    const toSend = this.pendingQueue.filter(
      (m) => m.userId === userId && now - m.createdAt < OpenClawWeChatChannel.QUEUE_TTL_MS,
    );
    this.pendingQueue = this.pendingQueue.filter((m) => m.userId !== userId);
    if (!toSend.length) return;
    console.log(
      `[OpenClawWeChatChannel] Flushing ${toSend.length} queued message(s) for ${userId}`,
    );
    for (const msg of toSend) {
      try {
        if (msg.type === 'file' && msg.filePath) {
          await this.client.sendFile(userId, token, msg.filePath);
        } else {
          const chunks = this.splitText(msg.text, 4000);
          for (const chunk of chunks) {
            await this.client.sendText(userId, token, chunk);
          }
        }
      } catch (err: any) {
        console.error(`[OpenClawWeChatChannel] Flush send failed:`, err.message);
        // Don't re-queue — avoid infinite loops
      }
    }
  }

  /**
   * Periodically send typing indicators to keep context_tokens alive on ilink's server.
   * Refreshes every token unconditionally; ret=-2 triggers cleanup, transient
   * errors (network, 5xx) are retried next cycle. On success, updates
   * entry.updatedAt so the persisted state reflects real freshness.
   */
  private startTokenKeepalive(): void {
    this.stopTokenKeepalive();
    this.keepaliveTimer = setInterval(() => this.runTokenKeepalive(), OpenClawWeChatChannel.KEEPALIVE_INTERVAL_MS);
  }

  private stopTokenKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private async runTokenKeepalive(): Promise<void> {
    let dirty = false;
    for (const [userId, entry] of [...this.contextTokens]) {
      try {
        await this.client.sendTyping(userId, entry.token);
        entry.updatedAt = Date.now();
        dirty = true;
        console.log(`[OpenClawWeChatChannel] Keepalive OK for ${userId}`);
      } catch (err: any) {
        if (err instanceof ILinkApiError && err.ret === -2) {
          console.warn(`[OpenClawWeChatChannel] Keepalive: token expired for ${userId}, clearing`);
          this.contextTokens.delete(userId);
          dirty = true;
        }
        // Other errors (network, etc.) — ignore, will retry next cycle
      }
    }
    if (dirty) this.persistTokens();
  }

  private splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen; // No good newline — hard split
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  // ─── Static helpers ──────────────────────────────────────

  static testConnection(): { success: boolean; error?: string } {
    const client = new ILinkClient();
    if (client.loadCredentials()) {
      return { success: true };
    }
    return { success: false, error: 'Not authenticated — scan QR code to connect' };
  }
}
