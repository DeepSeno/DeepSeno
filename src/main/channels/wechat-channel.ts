import { MessageChannel, IncomingMessage, MessageCard } from './types';
import { verifySignature, decryptMessage, extractXmlTag } from './wechat-crypto';

export interface WeChatConfig {
  corpId: string;
  agentId: string;
  secret: string;
}

interface WeChatApiResponse {
  errcode: number;
  errmsg: string;
  [key: string]: unknown;
}

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_EXPIRE_BUFFER = 300; // Refresh 5 min before actual expiry

export class WeChatChannel implements MessageChannel {
  readonly id = 'wechat';
  readonly name = '企业微信';

  private running = false;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor(private config: WeChatConfig) {}

  async start(): Promise<void> {
    if (!this.config.corpId || !this.config.secret || !this.config.agentId) {
      throw new Error('[WeChatChannel] Missing corpId, agentId, or secret');
    }
    await this.refreshAccessToken();
    this.running = true;
    console.log('[WeChatChannel] Channel started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    console.log('[WeChatChannel] Channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Handle WeChat URL verification (GET request) */
  handleVerify(query: { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string }, token: string, encodingAESKey: string): string | null {
    const { msg_signature, timestamp, nonce, echostr } = query;
    if (!msg_signature || !timestamp || !nonce || !echostr) return null;

    const signature = verifySignature(token, timestamp, nonce, echostr);
    if (signature !== msg_signature) return null;

    try {
      return decryptMessage(echostr, encodingAESKey);
    } catch {
      return null;
    }
  }

  /** Handle incoming webhook message (POST request) */
  async handleWebhook(body: string, query: { msg_signature?: string; timestamp?: string; nonce?: string }, token: string, encodingAESKey: string): Promise<string> {
    if (!this.messageHandler) return 'success';

    const { msg_signature, timestamp, nonce } = query;
    if (!msg_signature || !timestamp || !nonce) return 'success';

    try {
      // Extract encrypted content from XML
      const encryptedMsg = extractXmlTag(body, 'Encrypt');
      if (!encryptedMsg) return 'success';

      // Verify signature
      const sig = verifySignature(token, timestamp, nonce, encryptedMsg);
      if (sig !== msg_signature) {
        console.warn('[WeChatChannel] Signature verification failed');
        return 'success';
      }

      // Decrypt
      const xml = decryptMessage(encryptedMsg, encodingAESKey);
      const msgType = extractXmlTag(xml, 'MsgType');
      const fromUser = extractXmlTag(xml, 'FromUserName');
      const content = extractXmlTag(xml, 'Content');

      const msg: IncomingMessage = {
        channelId: 'wechat',
        userId: fromUser,
        userName: fromUser,
        chatId: fromUser, // Reply to the same user
        type: msgType === 'voice' ? 'voice' : 'text',
        content: content || '',
        timestamp: Date.now(),
        raw: { xml, msgType },
      };

      // For voice messages, extract media_id for downloading
      if (msgType === 'voice') {
        const mediaId = extractXmlTag(xml, 'MediaId');
        if (mediaId) {
          msg.audioUrl = mediaId; // Will need to download via WeChat API
        }
      }

      await this.messageHandler(msg);
    } catch (err: any) {
      console.error('[WeChatChannel] Webhook handler error:', err.message);
    }

    return 'success';
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const token = await this.getValidToken();
    const body = {
      touser: chatId,
      msgtype: 'text',
      agentid: Number(this.config.agentId),
      text: { content: text },
    };
    await this.callApi(`${API_BASE}/message/send?access_token=${token}`, body);
  }

  async sendCard(chatId: string, card: MessageCard): Promise<void> {
    const token = await this.getValidToken();
    // Build description from sections
    const description = card.sections
      .map((s) => (s.header ? `<b>${s.header}</b>\n${s.content}` : s.content))
      .join('\n\n');

    const body = {
      touser: chatId,
      msgtype: 'textcard',
      agentid: Number(this.config.agentId),
      textcard: {
        title: card.title,
        description,
        url: '', // Required by WeChat API; empty string — no clickable link
      },
    };
    await this.callApi(`${API_BASE}/message/send?access_token=${token}`, body);
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    // WeChat file sending requires uploading media first.
    // For now, send the file path as text notification (same pattern as FeishuChannel).
    await this.sendText(chatId, `File: ${filePath}`);
  }

  // ─── Static helpers ──────────────────────────────────────

  static async testConnection(
    corpId: string,
    secret: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      if (data.errcode !== 0) {
        return { success: false, error: data.errmsg || `Error code: ${data.errcode}` };
      }
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
    if (!this.accessToken) throw new Error('[WeChatChannel] Failed to obtain access token');
    return this.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.secret)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[WeChatChannel] Token request failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.errcode !== 0) {
      throw new Error(`[WeChatChannel] Token error: ${data.errcode} ${data.errmsg}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() / 1000 + (data.expires_in || 7200);
  }

  private async callApi(url: string, body: Record<string, unknown>): Promise<WeChatApiResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`[WeChatChannel] API call failed: HTTP ${res.status}`);
    }
    const data: WeChatApiResponse = await res.json();

    // Handle expired/invalid token — retry once
    if (data.errcode === 42001 || data.errcode === 40014) {
      console.warn('[WeChatChannel] Token expired, refreshing...');
      await this.refreshAccessToken();
      const retryUrl = url.replace(/access_token=[^&]+/, `access_token=${this.accessToken}`);
      const retryRes = await fetch(retryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!retryRes.ok) {
        throw new Error(`[WeChatChannel] API retry failed: HTTP ${retryRes.status}`);
      }
      const retryData: WeChatApiResponse = await retryRes.json();
      if (retryData.errcode !== 0) {
        throw new Error(`[WeChatChannel] API error after retry: ${retryData.errcode} ${retryData.errmsg}`);
      }
      return retryData;
    }

    if (data.errcode !== 0) {
      throw new Error(`[WeChatChannel] API error: ${data.errcode} ${data.errmsg}`);
    }
    return data;
  }
}
