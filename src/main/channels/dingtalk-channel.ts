import { MessageChannel, IncomingMessage, MessageCard } from './types';

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
}

interface DingTalkApiResponse {
  errcode: number;
  errmsg: string;
  [key: string]: unknown;
}

const API_BASE = 'https://oapi.dingtalk.com';
const TOKEN_EXPIRE_BUFFER = 300; // Refresh 5 min before actual expiry

export class DingTalkChannel implements MessageChannel {
  readonly id = 'dingtalk';
  readonly name = '钉钉';

  private running = false;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor(private config: DingTalkConfig) {}

  async start(): Promise<void> {
    if (!this.config.appKey || !this.config.appSecret) {
      throw new Error('[DingTalkChannel] Missing appKey or appSecret');
    }
    await this.refreshAccessToken();
    this.running = true;
    console.log('[DingTalkChannel] Channel started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    console.log('[DingTalkChannel] Channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Handle incoming webhook from LanServer */
  async handleWebhook(body: any): Promise<string> {
    if (!this.messageHandler) return 'No handler';

    try {
      const msgType = body.msgtype || 'text';
      const senderId = body.senderStaffId || body.senderId || 'unknown';
      const senderNick = body.senderNick || body.senderCorpId || senderId;
      const conversationId = body.conversationId || '';

      const msg: IncomingMessage = {
        channelId: 'dingtalk',
        userId: senderId,
        userName: senderNick,
        chatId: conversationId,
        type: msgType === 'audio' ? 'voice' : 'text',
        content: body.text?.content?.trim() || '',
        timestamp: Date.now(),
        raw: body,
      };

      if (msgType === 'audio' && body.content?.downloadCode) {
        msg.audioUrl = body.content.downloadCode;
      }

      await this.messageHandler(msg);
      return 'ok';
    } catch (err: any) {
      console.error('[DingTalkChannel] Webhook handler error:', err.message);
      return 'error';
    }
  }

  async sendText(_chatId: string, text: string): Promise<void> {
    const token = await this.getValidToken();
    await this.callApi(
      `${API_BASE}/robot/send?access_token=${token}`,
      {
        msgtype: 'markdown',
        markdown: { title: 'DeepSeno', text },
      },
    );
  }

  async sendCard(_chatId: string, card: MessageCard): Promise<void> {
    const token = await this.getValidToken();
    const text = card.sections
      .map((s) => (s.header ? `### ${s.header}\n${s.content}` : s.content))
      .join('\n\n');

    await this.callApi(
      `${API_BASE}/robot/send?access_token=${token}`,
      {
        msgtype: 'actionCard',
        actionCard: {
          title: card.title,
          text: `# ${card.title}\n\n${text}`,
          singleTitle: '查看详情',
          singleURL: '',
        },
      },
    );
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    // DingTalk file sending requires uploading media first.
    // For now, send the file path as text notification (same pattern as other channels).
    await this.sendText(chatId, `File: ${filePath}`);
  }

  // ─── Static helpers ──────────────────────────────────────

  static async testConnection(
    appKey: string,
    appSecret: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${API_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`,
      );
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      if (data.errcode !== 0) return { success: false, error: data.errmsg || `Error: ${data.errcode}` };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // ─── Internal helpers ─────────────────────────────────────

  private async getValidToken(): Promise<string> {
    if (!this.accessToken || Date.now() / 1000 >= this.tokenExpiresAt - TOKEN_EXPIRE_BUFFER) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshAccessToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
    }
    if (!this.accessToken) throw new Error('[DingTalkChannel] Failed to get token');
    return this.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const url = `${API_BASE}/gettoken?appkey=${encodeURIComponent(this.config.appKey)}&appsecret=${encodeURIComponent(this.config.appSecret)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[DingTalkChannel] Token request failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`[DingTalkChannel] Token error: ${data.errcode} ${data.errmsg}`);
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() / 1000 + (data.expires_in || 7200);
  }

  private async callApi(url: string, body: Record<string, unknown>): Promise<DingTalkApiResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`[DingTalkChannel] API call failed: HTTP ${res.status}`);
    const data: DingTalkApiResponse = await res.json();

    // Handle expired/invalid token — retry once
    if (data.errcode === 40014 || data.errcode === 42001) {
      console.warn('[DingTalkChannel] Token expired, refreshing...');
      await this.refreshAccessToken();
      const retryUrl = url.replace(/access_token=[^&]+/, `access_token=${this.accessToken}`);
      const retryRes = await fetch(retryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!retryRes.ok) throw new Error(`[DingTalkChannel] API retry failed: HTTP ${retryRes.status}`);
      const retryData: DingTalkApiResponse = await retryRes.json();
      if (retryData.errcode !== 0) {
        throw new Error(`[DingTalkChannel] API error after retry: ${retryData.errcode} ${retryData.errmsg}`);
      }
      return retryData;
    }

    if (data.errcode !== 0 && data.errcode !== undefined) {
      throw new Error(`[DingTalkChannel] API error: ${data.errcode} ${data.errmsg}`);
    }
    return data;
  }
}
