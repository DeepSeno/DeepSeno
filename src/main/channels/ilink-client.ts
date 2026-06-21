import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { net } from 'electron';
import { app } from 'electron';
import QRCode from 'qrcode';

/**
 * ilink Bot API client for WeChat ClawBot integration.
 * Protocol: https://ilinkai.weixin.qq.com
 *
 * Flow: QR scan → bot_token → long-poll getupdates → sendmessage
 */

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

// Use Electron's net.fetch for system proxy support
const efetch: typeof fetch = (...args) =>
  net.fetch(...(args as Parameters<typeof net.fetch>)) as Promise<Response>;

// ─── Types ───────────────────────────────────────────────────

export interface ILinkCredentials {
  botToken: string;
  baseUrl?: string; // Optional custom base URL from auth response
}

export interface ILinkMessage {
  fromUserId: string;
  toUserId: string;
  messageType: number; // 1 = user, 2 = bot
  contextToken: string;
  items: ILinkMessageItem[];
  raw: any;
}

export interface ILinkMessageItem {
  type: 'text' | 'image' | 'voice' | 'file' | 'video';
  text?: string;
  mediaUrl?: string; // Legacy: hex media ID (not a direct URL)
  aesKey?: string; // AES-128 key for CDN media decryption
  encryptQueryParam?: string; // CDN download parameter (construct URL with this)
  fileName?: string; // Original file name (for file type)
  voiceText?: string; // ASR transcription for voice messages
}

export interface QRCodeResult {
  qrcodeId: string;
  qrcodeImage: string; // Base64 PNG
}

export interface QRCodeStatus {
  status: 'pending' | 'confirmed' | 'expired';
  credentials?: ILinkCredentials;
}

export class ILinkApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly ret: number,
    public readonly errmsg: string,
  ) {
    super(`[ILinkClient] API ${endpoint} error: ret=${ret} ${errmsg}`);
    this.name = 'ILinkApiError';
  }
}

// ─── Client ──────────────────────────────────────────────────

export class ILinkClient {
  private credentials: ILinkCredentials | null = null;
  private updatesBuf = '';
  private running = false;
  private pollAbortController: AbortController | null = null;
  private onMessageCallback: ((msg: ILinkMessage) => void) | null = null;
  private onDisconnectCallback: ((reason: string) => void) | null = null;
  private credentialsPath: string;
  private botUserId = ''; // Learned from incoming messages (to_user_id = bot)
  private typingTicket = ''; // From getupdates response

  constructor() {
    const dataDir = app.getPath('userData');
    this.credentialsPath = path.join(dataDir, 'wechat-openclaw-credentials.json');
  }

  // ─── Authentication ──────────────────────────────────────

  /** Get QR code for user to scan in WeChat */
  async getQRCode(): Promise<QRCodeResult> {
    console.log('[ILinkClient] Requesting QR code from', `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`);
    const res = await efetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`);
    console.log('[ILinkClient] QR code response status:', res.status);
    if (!res.ok) throw new Error(`[ILinkClient] QR code request failed: HTTP ${res.status}`);
    const data = await res.json();
    console.log('[ILinkClient] QR code response keys:', Object.keys(data));
    console.log('[ILinkClient] QR code ret:', data.ret, 'qrcode:', data.qrcode ? 'present' : 'missing',
      'img_content:', data.qrcode_img_content ? `${String(data.qrcode_img_content).length} chars` : 'missing');
    if (data.ret !== 0) throw new Error(`[ILinkClient] QR code error: ${data.errmsg || data.ret}`);

    const qrImage = data.qrcode_img_content || data.qrcodeImgContent || data.img || data.image || '';
    const qrId = data.qrcode || data.qrcodeId || '';

    if (!qrImage) {
      console.error('[ILinkClient] No QR image in response. Full response:', JSON.stringify(data).slice(0, 500));
      throw new Error('[ILinkClient] QR code response missing image data');
    }

    console.log('[ILinkClient] QR image value:', qrImage);

    // qrcode_img_content is a URL — generate QR code image locally as data URI
    const qrDataUri = await QRCode.toDataURL(qrImage, { width: 280, margin: 2 });
    console.log('[ILinkClient] Generated QR data URI:', qrDataUri.length, 'chars');

    return {
      qrcodeId: qrId,
      qrcodeImage: qrDataUri,
    };
  }

  /** Poll QR code scan status */
  async getQRCodeStatus(qrcodeId: string): Promise<QRCodeStatus> {
    const res = await efetch(`${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`);
    if (!res.ok) throw new Error(`[ILinkClient] QR status request failed: HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === 'confirmed' && data.bot_token) {
      const creds: ILinkCredentials = {
        botToken: data.bot_token,
        baseUrl: data.baseurl || undefined,
      };
      this.credentials = creds;
      this.saveCredentials(creds);
      return { status: 'confirmed', credentials: creds };
    }

    if (data.status === 'expired') {
      return { status: 'expired' };
    }

    return { status: 'pending' };
  }

  /** Load saved credentials */
  loadCredentials(): boolean {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        const raw = fs.readFileSync(this.credentialsPath, 'utf-8');
        const creds: ILinkCredentials = JSON.parse(raw);
        if (creds.botToken) {
          this.credentials = creds;
          return true;
        }
      }
    } catch {
      // Corrupted file — ignore
    }
    return false;
  }

  /** Check if authenticated */
  isAuthenticated(): boolean {
    return !!this.credentials?.botToken;
  }

  /** Clear credentials (logout) */
  logout(): void {
    this.credentials = null;
    this.updatesBuf = '';
    try {
      if (fs.existsSync(this.credentialsPath)) {
        fs.unlinkSync(this.credentialsPath);
      }
    } catch {}
  }

  // ─── Long Polling ────────────────────────────────────────

  onMessage(cb: (msg: ILinkMessage) => void): void {
    this.onMessageCallback = cb;
  }

  onDisconnect(cb: (reason: string) => void): void {
    this.onDisconnectCallback = cb;
  }

  /** Start the long-polling loop */
  startPolling(): void {
    if (this.running) return;
    if (!this.credentials?.botToken) {
      throw new Error('[ILinkClient] Cannot poll: not authenticated');
    }
    this.running = true;
    this.pollLoop().catch((err) => {
      console.error('[ILinkClient] Poll loop crashed:', err.message);
      this.running = false;
      this.onDisconnectCallback?.(err.message);
    });
  }

  /** Stop polling */
  stopPolling(): void {
    this.running = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
  }

  get isPolling(): boolean {
    return this.running;
  }

  // ─── Send Messages ───────────────────────────────────────

  /** Send a text message */
  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = `wcb-${crypto.randomUUID()}`;
    const body: Record<string, unknown> = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };
    console.log(`[ILinkClient] sendText to=${toUserId} clientId=${clientId} contextToken=${contextToken.length}chars text=${text.length}chars`);
    await this.callApi('/ilink/bot/sendmessage', body);
  }

  /**
   * Download media from ilink CDN, optionally decrypting with AES.
   * @param encryptQueryParam — media.encrypt_query_param from message
   * @param aesKeyField — aeskey field (empty = no encryption, download plain)
   */
  async downloadMedia(encryptQueryParam: string, aesKeyField: string): Promise<Buffer> {
    const cdnBase = 'https://novac2c.cdn.weixin.qq.com/c2c';
    const url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    console.log(`[ILinkClient] downloadMedia CDN url length=${url.length}`);

    const res = await efetch(url);
    if (!res.ok) throw new Error(`[ILinkClient] Media download failed: HTTP ${res.status}`);
    const downloaded = Buffer.from(await res.arrayBuffer());
    console.log(`[ILinkClient] Downloaded ${downloaded.length} bytes`);

    // No AES key → file is not encrypted (e.g. file attachments)
    if (!aesKeyField) {
      console.log(`[ILinkClient] No aesKey, returning plain data`);
      return downloaded;
    }

    // Check if data is already plaintext (known file signatures)
    const header = downloaded.subarray(0, 8);
    if (this.isKnownFileSignature(header)) {
      console.log(`[ILinkClient] Data is plaintext (detected file signature), skipping decrypt`);
      return downloaded;
    }

    // AES-128-ECB decrypt (key is always base64-encoded at this point)
    const key = this.parseAesKey(aesKeyField);
    console.log(`[ILinkClient] Decrypting: key=${key.toString('hex')} first16=${downloaded.subarray(0, 16).toString('hex')}`);
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      const decrypted = Buffer.concat([decipher.update(downloaded), decipher.final()]);
      // Verify decrypted data looks valid
      if (this.isKnownFileSignature(decrypted.subarray(0, 8))) {
        console.log(`[ILinkClient] Decrypted OK: ${decrypted.length} bytes, valid file signature`);
        return decrypted;
      }
      console.log(`[ILinkClient] Decrypted ${decrypted.length} bytes (no recognized signature, using anyway)`);
      return decrypted;
    } catch (err: any) {
      // CDN deduplication issue: same encrypted blob cached with old key,
      // new key doesn't match. Log diagnostic and return raw data.
      console.warn(`[ILinkClient] Decrypt failed: ${err.message}`);
      console.warn(`[ILinkClient] This may be caused by CDN deduplication — try sending a never-before-sent file`);
      return downloaded;
    }
  }

  /** Check if buffer starts with a known file magic number */
  private isKnownFileSignature(header: Buffer): boolean {
    if (header.length < 4) return false;
    const hex4 = header.subarray(0, 4).toString('hex');
    const ascii4 = header.subarray(0, 4).toString('ascii');
    // PDF: %PDF
    if (ascii4 === '%PDF') return true;
    // ZIP/DOCX/XLSX/PPTX: PK\x03\x04
    if (hex4 === '504b0304') return true;
    // PNG: \x89PNG
    if (hex4 === '89504e47') return true;
    // JPEG: \xFF\xD8\xFF
    if (hex4.startsWith('ffd8ff')) return true;
    // MP4/MOV: ftyp at offset 4
    if (header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    // GIF: GIF8
    if (ascii4 === 'GIF8') return true;
    // RIFF (WAV/AVI): RIFF
    if (ascii4 === 'RIFF') return true;
    return false;
  }

  /**
   * Parse AES key from base64 string. Two encodings exist in the wild:
   *   - base64(raw 16 bytes) → images (from hex→base64 conversion)
   *   - base64(hex string 32 chars) → file/voice/video (media.aes_key)
   * Matches official SDK: @tencent-weixin/openclaw-weixin/src/cdn/pic-decrypt.ts
   */
  private parseAesKey(aesKeyBase64: string): Buffer {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`[ILinkClient] aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
  }

  /**
   * Upload a file to ilink CDN and send it as a file message.
   * Flow: gen AES key → compute sizes/MD5 → getuploadurl → encrypt → POST to CDN → sendmessage
   * Protocol ref: @tencent-weixin/openclaw-weixin v2.1.2 (official SDK)
   * media_type: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE
   */
  async sendFile(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // 1. Client generates AES key + computes file metadata
    const aesKey = crypto.randomBytes(16); // 16 bytes raw
    const aesKeyHex = aesKey.toString('hex'); // 32-char hex for API
    const filekey = crypto.randomBytes(16).toString('hex'); // unique file ID
    const rawsize = fileData.length;
    const rawfilemd5 = crypto.createHash('md5').update(fileData).digest('hex');
    const filesize = Math.ceil((rawsize + 1) / 16) * 16; // AES-128-ECB PKCS7 padded size

    console.log(`[ILinkClient] sendFile: ${fileName} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5}`);

    // 2. Get upload URL from server
    const uploadResp = await this.callApi('/ilink/bot/getuploadurl', {
      filekey,
      media_type: 3, // FILE
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: '1.0.2' },
    });

    const uploadFullUrl = uploadResp.upload_full_url?.trim();
    const uploadParam = uploadResp.upload_param;
    if (!uploadFullUrl && !uploadParam) {
      throw new Error(`[ILinkClient] getUploadUrl returned no upload URL: ${JSON.stringify(uploadResp)}`);
    }

    // 3. Encrypt file with AES-128-ECB
    const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
    const encrypted = Buffer.concat([cipher.update(fileData), cipher.final()]);

    // 4. POST encrypted data to CDN
    const cdnUrl = uploadFullUrl
      || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    console.log(`[ILinkClient] CDN POST ${fileName} (${encrypted.length} bytes)`);

    const putRes = await efetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted,
    });
    if (!putRes.ok) {
      throw new Error(`[ILinkClient] CDN upload failed: HTTP ${putRes.status}`);
    }

    // 5. Get download param from CDN response header
    const downloadParam = putRes.headers.get('x-encrypted-param') || '';
    if (!downloadParam) {
      throw new Error('[ILinkClient] CDN response missing x-encrypted-param header');
    }
    console.log(`[ILinkClient] CDN upload OK: ${fileName}, downloadParam=${downloadParam.length}chars`);

    // 6. Send file message
    // aes_key in CDNMedia = base64(hex_string_as_ascii), matching official SDK:
    //   Buffer.from(uploaded.aeskey).toString("base64") where aeskey is hex string
    const aesKeyForMedia = Buffer.from(aesKeyHex).toString('base64');
    const clientId = `wcb-${crypto.randomUUID()}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{
          type: 4, // MessageItemType.FILE
          file_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: aesKeyForMedia,
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(rawsize),
          },
        }],
      },
    };
    console.log(`[ILinkClient] sendFile to=${toUserId} file=${fileName} size=${rawsize}`);
    await this.callApi('/ilink/bot/sendmessage', body);
  }

  /**
   * Upload image data to ilink CDN and send as an image message.
   * Same CDN flow as sendFile, but media_type=1 (IMAGE) and item type=2.
   */
  async sendImage(toUserId: string, contextToken: string, imageData: Buffer): Promise<void> {
    const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

    // 1. Generate AES key + compute metadata
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString('hex');
    const filekey = crypto.randomBytes(16).toString('hex');
    const rawsize = imageData.length;
    const rawfilemd5 = crypto.createHash('md5').update(imageData).digest('hex');
    const filesize = Math.ceil((rawsize + 1) / 16) * 16; // AES-128-ECB PKCS7 padded size

    console.log(`[ILinkClient] sendImage: rawsize=${rawsize} filesize=${filesize}`);

    // 2. Get upload URL
    const uploadResp = await this.callApi('/ilink/bot/getuploadurl', {
      filekey,
      media_type: 1, // IMAGE (not FILE=3)
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: '1.0.2' },
    });

    const uploadFullUrl = uploadResp.upload_full_url?.trim();
    const uploadParam = uploadResp.upload_param;
    if (!uploadFullUrl && !uploadParam) {
      throw new Error(`[ILinkClient] getUploadUrl for image returned no upload URL: ${JSON.stringify(uploadResp)}`);
    }

    // 3. Encrypt with AES-128-ECB
    const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
    const encrypted = Buffer.concat([cipher.update(imageData), cipher.final()]);

    // 4. POST to CDN
    const cdnUrl = uploadFullUrl
      || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    console.log(`[ILinkClient] CDN POST image (${encrypted.length} bytes)`);

    const putRes = await efetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted,
    });
    if (!putRes.ok) {
      throw new Error(`[ILinkClient] CDN image upload failed: HTTP ${putRes.status}`);
    }

    // 5. Get download param
    const downloadParam = putRes.headers.get('x-encrypted-param') || '';
    if (!downloadParam) {
      throw new Error('[ILinkClient] CDN image response missing x-encrypted-param header');
    }
    console.log(`[ILinkClient] CDN image upload OK, downloadParam=${downloadParam.length}chars`);

    // 6. Send image message
    // aes_key encoding must match sendFile: base64(hex_string_as_ascii)
    const aesKeyForMedia = Buffer.from(aesKeyHex).toString('base64');
    const clientId = `wcb-${crypto.randomUUID()}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{
          type: 2, // MessageItemType.IMAGE
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: aesKeyForMedia,
              encrypt_type: 1,
            },
            file_size: rawsize,
          },
        }],
      },
    };
    console.log(`[ILinkClient] sendImage to=${toUserId} size=${rawsize}`);
    await this.callApi('/ilink/bot/sendmessage', body);
  }

  /** Send typing indicator. Propagates ret=-2 (context_token expired) so
   *  callers (keepalive, startup verification) can detect dead tokens. */
  async sendTyping(toUserId: string, contextToken: string): Promise<void> {
    if (!this.typingTicket) return; // No ticket yet — skip silently
    try {
      await this.callApi('/ilink/bot/sendtyping', {
        ilink_user_id: this.botUserId,
        to_user_id: toUserId,
        context_token: contextToken,
        typing_ticket: this.typingTicket,
      });
    } catch (err) {
      if (err instanceof ILinkApiError && err.ret === -2) throw err;
      // Other errors (network, 5xx, etc.) stay non-critical
    }
  }

  // ─── Internal ────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    console.log('[ILinkClient] Long polling started');
    let consecutiveErrors = 0;

    while (this.running) {
      try {
        this.pollAbortController = new AbortController();
        const res = await efetch(this.getUrl('/ilink/bot/getupdates'), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({
            get_updates_buf: this.updatesBuf,
            base_info: { channel_version: '1.0.2' },
          }),
          signal: this.pollAbortController.signal,
        });

        if (!res.ok) {
          if (res.status === 401) {
            console.warn('[ILinkClient] Token expired (401), stopping');
            this.running = false;
            this.onDisconnectCallback?.('token_expired');
            break;
          }
          console.warn(`[ILinkClient] Poll HTTP ${res.status}`);
          consecutiveErrors++;
          await this.delay(Math.min(consecutiveErrors * 2000, 30000));
          continue;
        }

        const data = await res.json();

        // Check for error responses (errcode or ret)
        const errCode = data.errcode ?? data.ret;
        if (errCode !== undefined && errCode !== 0) {
          consecutiveErrors++;
          if (consecutiveErrors <= 3) {
            console.warn(`[ILinkClient] Poll error: code=${errCode} ${data.errmsg || ''}`);
          } else if (consecutiveErrors === 4) {
            console.warn(`[ILinkClient] Poll error repeating (code=${errCode}), suppressing further logs`);
          }
          await this.delay(Math.min(consecutiveErrors * 2000, 30000));
          continue;
        }

        // Update cursor — field may be get_updates_buf or getUpdatesBuf
        const newBuf = data.get_updates_buf || data.getUpdatesBuf || data.buf || '';
        if (newBuf) {
          this.updatesBuf = newBuf;
        }

        // Capture typing_ticket for sendTyping
        const ticket = data.typing_ticket || data.typingTicket || '';
        if (ticket) {
          this.typingTicket = ticket;
        }

        consecutiveErrors = 0;

        // Process messages — field may be msgs or messages
        const msgs = data.msgs || data.messages || [];
        if (msgs.length) {
          console.log(`[ILinkClient] Received ${msgs.length} message(s)`);
          for (const raw of msgs) {
            try {
              const msg = this.parseMessage(raw);
              if (!msg) continue;
              // Learn bot's own user ID from incoming messages
              if (msg.toUserId && msg.toUserId.endsWith('@im.bot')) {
                this.botUserId = msg.toUserId;
              }
              if (msg.messageType === 1) {
                // Only handle user messages (type 1), skip bot echoes (type 2)
                this.onMessageCallback?.(msg);
              }
            } catch (err: any) {
              console.error('[ILinkClient] Message parse error:', err.message);
            }
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') break;
        console.warn('[ILinkClient] Poll error:', err.message);
        consecutiveErrors++;
        await this.delay(Math.min(consecutiveErrors * 2000, 30000));
      }
    }
    console.log('[ILinkClient] Long polling stopped');
  }

  private parseMessage(raw: any): ILinkMessage | null {
    if (!raw.from_user_id || !raw.item_list?.length) return null;

    const items: ILinkMessageItem[] = [];
    for (const item of raw.item_list) {
      // Log raw item structure for non-text types to discover field names
      if (item.type !== 1) {
        console.log(`[ILinkClient] raw item type=${item.type} keys:`, Object.keys(item));
        console.log(`[ILinkClient] raw item sample:`, JSON.stringify(item).slice(0, 1200));
      }
      // Official SDK key handling (from @tencent-weixin/openclaw-weixin):
      //   - image: aeskey is raw hex → convert to base64 for decryption; fallback to media.aes_key
      //   - file/voice/video: use media.aes_key directly (already base64)
      switch (item.type) {
        case 1: // Text
          items.push({ type: 'text', text: item.text_item?.text || '' });
          break;
        case 2: { // Image
          const img = item.image_item || {};
          const imgMedia = img.media || {};
          // img.aeskey is hex string → convert to base64; fallback to media.aes_key (already base64)
          const imgAesKey = img.aeskey
            ? Buffer.from(img.aeskey, 'hex').toString('base64')
            : (imgMedia.aes_key || '');
          items.push({
            type: 'image',
            aesKey: imgAesKey,
            encryptQueryParam: imgMedia.encrypt_query_param || '',
          });
          break;
        }
        case 3: { // Voice
          const voice = item.voice_item || {};
          const voiceMedia = voice.media || {};
          items.push({
            type: 'voice',
            aesKey: voiceMedia.aes_key || '',
            encryptQueryParam: voiceMedia.encrypt_query_param || '',
            voiceText: voice.text || '',
          });
          break;
        }
        case 4: { // File
          const file = item.file_item || {};
          const fileMedia = file.media || {};
          items.push({
            type: 'file',
            aesKey: fileMedia.aes_key || '',
            encryptQueryParam: fileMedia.encrypt_query_param || '',
            fileName: file.file_name || '',
          });
          break;
        }
        case 5: { // Video
          const video = item.video_item || {};
          const videoMedia = video.media || {};
          items.push({
            type: 'video',
            aesKey: videoMedia.aes_key || '',
            encryptQueryParam: videoMedia.encrypt_query_param || '',
          });
          break;
        }
      }
    }

    if (!items.length) return null;

    const contextToken = raw.context_token || raw.contextToken || '';
    console.log(`[ILinkClient] parseMessage: from=${raw.from_user_id} to=${raw.to_user_id} context_token=${contextToken ? `${contextToken.length} chars` : 'MISSING'} items=${items.length}`);
    // Log all top-level keys to discover required fields
    console.log(`[ILinkClient] raw message keys:`, Object.keys(raw));

    return {
      fromUserId: raw.from_user_id,
      toUserId: raw.to_user_id || '',
      messageType: raw.message_type || 1,
      contextToken,
      items,
      raw,
    };
  }

  private async callApi(endpoint: string, body: Record<string, unknown>): Promise<any> {
    if (!this.credentials?.botToken) {
      throw new Error('[ILinkClient] Not authenticated');
    }
    console.log(`[ILinkClient] callApi ${endpoint}`, JSON.stringify(body).slice(0, 300));
    const res = await efetch(this.getUrl(endpoint), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`[ILinkClient] API ${endpoint} failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    console.log(`[ILinkClient] callApi ${endpoint} response:`, JSON.stringify(data).slice(0, 300));
    // ret is 0 on success; absent means success (e.g. timeout with no data)
    if (data.ret !== undefined && data.ret !== 0) {
      throw new ILinkApiError(endpoint, data.ret, data.errmsg || '');
    }
    return data;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.generateWechatUin(),
      'Authorization': `Bearer ${this.credentials!.botToken}`,
    };
  }

  /** Generate random X-WECHAT-UIN header (anti-replay) */
  private generateWechatUin(): string {
    const rand = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(rand)).toString('base64');
  }

  private getUrl(endpoint: string): string {
    const base = this.credentials?.baseUrl || ILINK_BASE;
    return `${base}${endpoint}`;
  }

  private saveCredentials(creds: ILinkCredentials): void {
    try {
      const dir = path.dirname(this.credentialsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2));
      console.log('[ILinkClient] Credentials saved');
    } catch (err: any) {
      console.error('[ILinkClient] Failed to save credentials:', err.message);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
