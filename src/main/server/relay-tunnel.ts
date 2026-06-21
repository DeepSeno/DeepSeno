import { EventEmitter } from 'events';
import { LanServer } from './lan-server';
import { PairingManager } from './relay-pairing';
import { RelayWebRTC } from './relay-webrtc';
import {
  processProxyRequest,
} from './proxy-dispatcher';

/**
 * RelayTunnel connects to the DeepSeno server via WebSocket and serves as the
 * desktop-side endpoint for:
 *
 *   1. Pairing — relays phone ECDH public key to PairingManager
 *   2. Signaling — (Phase 3) passes WebRTC offer/answer/ICE to the WebRTC layer
 *   3. Proxy — receives encrypted request frames, decrypts them, dispatches
 *      to LanServer callbacks, encrypts the response, sends it back
 *   4. Push — forwards LanServer events to the phone via the WS
 *
 * Phase 2 implements relay (fallback) mode only. Phase 3 adds WebRTC P2P.
 */

// ── Types ──────────────────────────────────────────────────────

export type RelayTunnelStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/** The active transport mode — shown in the UI as the "穿透类型". */
export type RelayTransportMode = 'none' | 'p2p' | 'relay';

export interface RelayTunnelOptions {
  /** Server WebSocket URL (e.g. wss://your-server.example.com/api/v1/relay/ws). */
  serverUrl: string;
  /** This machine's persistent ID. */
  machineId: string;
  /** The LanServer whose routes we dispatch to. */
  lanServer: LanServer;
  /** PairingManager for ECDH key agreement. */
  pairingManager: PairingManager;
  /** Reconnect interval (ms). Default 5000. */
  reconnectIntervalMs?: number;
  /** Max reconnect attempts before giving up. Default Infinity. */
  maxReconnectAttempts?: number;
  /** How often to check for relay activity (ms). Default 30000. */
  activityCheckMs?: number;
  /** Inactive timeout before transportMode drops to 'none' (ms). Default 120000. */
  activityTimeoutMs?: number;
}

// ── RelayTunnel ────────────────────────────────────────────────

export class RelayTunnel extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: Required<RelayTunnelOptions>;
  private status: RelayTunnelStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  // Pending proxy requests: id → accumulated frames from server
  private proxyBuffers: Map<string, Buffer[]> = new Map();
  // WebRTC P2P connection (null when not paired or negotiating)
  private webrtc: RelayWebRTC | null = null;
  // Current transport mode (shown in UI)
  private transportMode: RelayTransportMode = 'none';
  // Relay activity tracking — auto-detect phone disconnection
  private lastActivity = 0;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  // Connected phones: wsID → true (received phone-connected/phone-disconnected)
  private connectedPhones: Set<string> = new Set();

  constructor(opts: RelayTunnelOptions) {
    super();
    this.opts = {
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: Infinity,
      activityCheckMs: 30000,
      activityTimeoutMs: 120000,
      ...opts,
    };
  }

  get currentStatus(): RelayTunnelStatus {
    return this.status;
  }

  /** Current transport mode: 'p2p' (direct), 'relay' (server relay), or 'none'. */
  get currentTransportMode(): RelayTransportMode {
    return this.transportMode;
  }

  /** Whether P2P direct connection is active. */
  get isP2P(): boolean {
    return this.transportMode === 'p2p';
  }

  /** Connect to the server WebSocket. */
  connect(): void {
    this.intentionallyClosed = false;
    this.doConnect();
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopActivityCheck();
    this.webrtc?.close();
    this.webrtc = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.transportMode = 'none';
    this.connectedPhones.clear();
    this.setStatus('disconnected');
  }

  /**
   * Push an event to the phone via the server WebSocket.
   * The event is encrypted with the pairing AES key before sending.
   */
  pushEvent(event: { type: string; [key: string]: any }): void {
    const aesKey = this.opts.pairingManager.getAesKey();
    if (!aesKey) return;

    // P2P mode: send via WebRTC DataChannel
    if (this.transportMode === 'p2p' && this.webrtc?.isConnected) {
      this.webrtc.pushEvent(event);
      return;
    }

    // Relay mode: send via server WebSocket
    if (!this.ws || this.status !== 'connected') return;

    const plaintext = Buffer.from(JSON.stringify(event), 'utf-8');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const enc = Buffer.concat([nonce, ciphertext, tag]).toString('base64');

    this.send({ type: 'push', enc });
  }

  // ── Internal ─────────────────────────────────────────────────

  private doConnect(): void {
    if (this.intentionallyClosed) return;
    this.setStatus('connecting');

    // Build WebSocket URL with machine_id as query param.
    // No license key or cert proof-of-possession required — relay is free.
    const url = new URL(this.opts.serverUrl);
    url.searchParams.set('machine_id', this.opts.machineId);

    try {
      // Use global WebSocket (available in Electron 42 / Node 24)
      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.lastActivity = Date.now();
        this.startActivityCheck();
        this.setStatus('connected');
      };

      this.ws.onmessage = (event: MessageEvent) => {
        // Heartbeat from server is NOT phone activity — skip timestamp update
        const raw = event.data as string;
        if (!raw.startsWith('{"type":"heartbeat"')) {
          this.lastActivity = Date.now();
        }
        this.handleMessage(raw).catch((err) => {
          console.error('[RelayTunnel] Message handling error:', err);
        });
      };

      this.ws.onerror = (event: Event) => {
        console.error('[RelayTunnel] WebSocket error:', event);
      };

      this.ws.onclose = () => {
        this.ws = null;
        this.stopActivityCheck();
        if (!this.intentionallyClosed) {
          this.setStatus('disconnected');
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      console.error('[RelayTunnel] Connect failed:', err);
      this.setStatus('error');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectAttempts >= this.opts.maxReconnectAttempts) {
      console.error('[RelayTunnel] Max reconnect attempts reached, giving up');
      this.setStatus('error');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.opts.reconnectIntervalMs * Math.min(this.reconnectAttempts, 10);
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  private setStatus(status: RelayTunnelStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('statusChange', status);
  }

  // ── Activity tracking (auto-detect phone disconnection) ───────

  private startActivityCheck(): void {
    this.stopActivityCheck();
    this.activityTimer = setInterval(() => {
      if (this.intentionallyClosed) return;
      const inactiveMs = Date.now() - this.lastActivity;
      if (inactiveMs > this.opts.activityTimeoutMs && this.connectedPhones.size === 0) {
        if (this.transportMode === 'relay') {
          this.transportMode = 'none';
          this.emit('transportModeChange', this.transportMode);
        }
      }
    }, this.opts.activityCheckMs);
  }

  private stopActivityCheck(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Message handling ─────────────────────────────────────────

  private async handleMessage(rawData: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return; // malformed, ignore
    }

    switch (msg.type) {
      case 'pair':
        await this.handlePair(msg);
        break;
      case 'signal':
        await this.handleSignal(msg);
        break;
      case 'proxy-start':
        this.proxyBuffers.set(msg.id, []);
        break;
      case 'proxy-frame':
        this.handleProxyFrame(msg);
        break;
      case 'proxy-end':
        await this.handleProxyEnd(msg);
        break;
      case 'phone-connected':
        this.handlePhoneConnected(msg);
        break;
      case 'phone-disconnected':
        this.handlePhoneDisconnected(msg);
        break;
      // 'heartbeat' is filtered in onmessage — no case needed
    }
  }

  private handlePhoneConnected(msg: any): void {
    const wsId = msg.wsId as string;
    if (!wsId) return;
    this.connectedPhones.add(wsId);
    if (this.transportMode === 'none') {
      this.transportMode = 'relay';
      this.emit('transportModeChange', this.transportMode);
    }
  }

  private handlePhoneDisconnected(msg: any): void {
    const wsId = msg.wsId as string;
    if (!wsId) return;
    this.connectedPhones.delete(wsId);
    if (this.connectedPhones.size === 0) {
      this.transportMode = 'none';
      this.emit('transportModeChange', this.transportMode);
    }
  }

  private async handlePair(msg: any): Promise<void> {
    const { phonePubKey, nonce, phoneWsId } = msg;

    const ok = this.opts.pairingManager.completePairing(phonePubKey, nonce);

    if (ok) {
      this.send({ type: 'pair-ok', phoneWsId });
      this.transportMode = 'relay';
      this.emit('transportModeChange', this.transportMode);
    } else {
      this.send({ type: 'pair-reject', phoneWsId, reason: 'nonce mismatch or session expired' });
    }
  }

  /** Handle a WebRTC signaling message (offer/answer/ICE candidate). */
  private async handleSignal(msg: any): Promise<void> {
    const aesKey = this.opts.pairingManager.getAesKey();
    if (!aesKey) return; // signal before pairing — ignore

    // Lazily create the WebRTC handler if this is the first signal.
    if (!this.webrtc) {
      const apiBase = this.opts.serverUrl
        .replace(/^ws/, 'http')
        .replace(/\/relay\/ws$/, '');
      this.webrtc = new RelayWebRTC({
        apiBase,
        aesKey,
        sendSignal: (signal) => {
          this.send({ type: 'signal', signal });
        },
        handleInternal: async (method, path, headers, body) => {
          return this.opts.lanServer.handleInternal(method, path, headers, body);
        },
      });
      this.webrtc.on('statusChange', (status) => {
        if (status === 'connected') {
          this.transportMode = 'p2p';
          this.emit('transportModeChange', this.transportMode);
        } else if (status === 'disconnected' || status === 'failed') {
          // Fall back to relay mode
          if (this.transportMode === 'p2p') {
            this.transportMode = 'relay';
            this.emit('transportModeChange', this.transportMode);
          }
        }
      });
    }

    await this.webrtc.handleSignal(msg.signal || msg);
  }

  private handleProxyFrame(msg: any): void {
    const frames = this.proxyBuffers.get(msg.id);
    if (!frames) {
      console.error(`[RelayTunnel] proxy-frame for unknown id: ${msg.id}`);
      return;
    }
    const data = Buffer.from(msg.data, 'base64');
    frames.push(data);
  }

  private async handleProxyEnd(msg: any): Promise<void> {
    const frames = this.proxyBuffers.get(msg.id);
    if (!frames) {
      console.error(`[RelayTunnel] proxy-end for unknown id: ${msg.id}`);
      return;
    }
    this.proxyBuffers.delete(msg.id);
    void this.processProxyRequest(msg.id, frames);
  }

  private async processProxyRequest(reqId: string, encryptedFrames: Buffer[]): Promise<void> {
    const aesKey = this.opts.pairingManager.getAesKey();
    if (!aesKey) {
      this.send({ type: 'resp-start', id: reqId, status: 503 });
      this.send({ type: 'resp-end', id: reqId });
      return;
    }

    try {
      // Phone is active — update transport mode if it was idle
      if (this.transportMode === 'none') {
        this.transportMode = 'relay';
        this.emit('transportModeChange', this.transportMode);
      }

      const { status, frames: responseFrames } = await processProxyRequest(
        this.opts.lanServer, aesKey, encryptedFrames,
      );

      this.send({ type: 'resp-start', id: reqId, status });
      for (const frame of responseFrames) {
        this.send({ type: 'resp-frame', id: reqId, data: frame.toString('base64') });
      }
      this.send({ type: 'resp-end', id: reqId });
    } catch (err) {
      console.error('[RelayTunnel] Proxy processing error:', err);
      this.send({ type: 'resp-start', id: reqId, status: 500 });
      this.send({ type: 'resp-end', id: reqId });
    }
  }
}

export { processProxyRequest } from './proxy-dispatcher';
