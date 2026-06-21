import { EventEmitter } from 'events';
import {
  decryptRequest,
  encryptFrame,
  encryptResponse,
  splitFrames,
} from './relay-crypto';

/**
 * RelayWebRTC wraps a WebRTC RTCPeerConnection + DataChannel for P2P direct
 * connection between the phone and desktop.
 *
 * Electron's main process has access to the Chromium WebRTC stack via the
 * `electron` module's RTCPeerConnection (available in Electron 42+).
 *
 * The signaling (SDP offer/answer + ICE candidates) is exchanged through the
 * relay server WebSocket — the server is a dumb relay for signaling and never
 * participates in the P2P data path.
 *
 * Once the DataChannel is open, all requests flow P2P (encrypted with the
 * ECDH-derived AES key), bypassing the server entirely. If the DataChannel
 * drops, the relay tunnel automatically falls back to server relay mode.
 */

// Electron exposes WebRTC APIs in the main process via the `electron` global.
// We declare minimal types to avoid pulling in @types/electron (which may not
// match the installed version).
interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
}
interface RTCDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: any) => void) | null;
}
interface RTCPeerConnection {
  createDataChannel(label: string, options?: any): RTCDataChannel;
  setLocalDescription(desc: { type: string; sdp: string }): Promise<void>;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  addIceCandidate(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: any }) => void) | null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  connectionState: string;
  iceConnectionState: string;
}
declare const RTCPeerConnection: {
  new (config: RTCConfiguration): RTCPeerConnection;
};

/** STUN server config — self-hosted only, no external services. */
function getStunServers(apiBase: string): RTCIceServer[] {
  // Extract the host from the API base URL for the STUN server.
  // The STUN server runs on UDP 3478 on the same host as the API.
  try {
    const url = new URL(apiBase);
    return [{ urls: `stun:${url.hostname}:3478` }];
  } catch {
    return [];
  }
}

export type WebRTCStatus = 'idle' | 'negotiating' | 'connected' | 'failed' | 'disconnected';

export interface RelayWebRTCOptions {
  /** API base URL (for deriving the STUN server address). */
  apiBase: string;
  /** The shared AES key for encrypting/decrypting P2P traffic. */
  aesKey: Buffer;
  /** Callback to send signaling messages via the server WebSocket. */
  sendSignal: (signal: any) => void;
  /** The LanServer's handleInternal function for dispatching decrypted requests. */
  handleInternal: (method: string, path: string, headers: Record<string, string>, body: Buffer | null) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
}

/** ICE negotiation timeout — if no P2P connection within this, give up. */
const ICE_TIMEOUT_MS = 15_000;

export class RelayWebRTC extends EventEmitter {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private opts: RelayWebRTCOptions;
  private status: WebRTCStatus = 'idle';
  private iceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayWebRTCOptions) {
    super();
    this.opts = opts;
  }

  get currentStatus(): WebRTCStatus {
    return this.status;
  }

  get isConnected(): boolean {
    return this.dc?.readyState === 'open';
  }

  private setStatus(s: WebRTCStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('statusChange', s);
  }

  /**
   * Handle a signaling message from the phone (received via the server WS).
   * The phone is the offerer; the desktop is the answerer.
   */
  async handleSignal(signal: any): Promise<void> {
    if (signal.type === 'offer') {
      await this.handleOffer(signal.sdp);
    } else if (signal.type === 'ice-candidate' && signal.candidate) {
      try {
        await this.pc?.addIceCandidate(signal.candidate);
      } catch (err) {
        /* ICE candidate not usable — ignore */
      }
    }
  }

  /** Process an incoming SDP offer from the phone. */
  private async handleOffer(sdp: string): Promise<void> {
    if (this.pc) {
      // Already negotiating — close the old connection first.
      this.close();
    }

    this.setStatus('negotiating');
    const stunServers = getStunServers(this.opts.apiBase);
    this.pc = new RTCPeerConnection({
      iceServers: stunServers,
      iceTransportPolicy: 'all',
    });

    // Listen for the phone's DataChannel (the phone creates it).
    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.attachDataChannelHandlers();
    };

    // ICE candidate handler — relay candidates to the phone via the server WS.
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.opts.sendSignal({
          type: 'ice-candidate',
          candidate: event.candidate,
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null; }
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.setStatus('disconnected');
        if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null; }
      }
    };

    // Set remote description (the offer) and create an answer.
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // Send the answer back via the server WS.
    this.opts.sendSignal({
      type: 'answer',
      sdp: answer.sdp,
    });

    // Start the ICE timeout — if no P2P connection within 15s, give up.
    this.iceTimer = setTimeout(() => {
      if (this.status !== 'connected') {
        this.setStatus('failed');
        this.close();
      }
    }, ICE_TIMEOUT_MS);
  }

  private attachDataChannelHandlers(): void {
    if (!this.dc) return;

    this.dc.onopen = () => {
      if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null; }
      this.setStatus('connected');
    };

    this.dc.onmessage = (event) => {
      this.handleDataChannelMessage(event.data).catch((err) => {
        console.error('[RelayWebRTC] message handling error:', err);
      });
    };

    this.dc.onclose = () => {
      this.setStatus('disconnected');
    };

    this.dc.onerror = (event) => {
      console.error('[RelayWebRTC] DataChannel error:', event);
    };
  }

  /**
   * Handle a message from the phone via DataChannel.
   * Messages are encrypted frames — decrypt, dispatch to LanServer, encrypt response.
   *
   * Message format: first byte is the message type:
   *   0x01 = request header frame
   *   0x02 = request body chunk
   *   0x03 = request end
   *   0x81 = response header frame (desktop → phone, not used here)
   *   0x10 = push event (desktop → phone, not used here)
   */
  private async handleDataChannelMessage(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === 'string') return; // ignore text messages

    const buf = Buffer.from(data);
    if (buf.length === 0) return;

    const msgType = buf[0];
    const payload = buf.subarray(1);

    // For simplicity in Phase 3, we handle the simplest protocol:
    // The phone sends the entire request as a single message:
    //   [0x01] [encrypted header frame] [encrypted body frame] ...
    // But we also support a multi-message protocol where frames arrive separately.
    //
    // Phase 3 implementation: the phone sends a single message containing
    // all encrypted frames concatenated. The desktop splits by frame length
    // prefix, decrypts, and processes.

    if (msgType === 0x01) {
      // Request: payload is concatenated encrypted frames
      const frames = splitFrames(payload);
      const { header, body } = decryptRequest(this.opts.aesKey, frames);

      // Dispatch to LanServer
      const response = await this.opts.handleInternal(
        header.method,
        header.path,
        header.headers,
        body,
      );

      // Encrypt response
      const responseFrames = encryptResponse(
        this.opts.aesKey,
        response.status,
        response.headers,
        response.body,
      );

      // Send response back via DataChannel
      // Format: [0x81] [response header frame] [response body frames...]
      const responseMsg = Buffer.concat([
        Buffer.from([0x81]),
        ...responseFrames,
      ]);
      this.dc?.send(responseMsg);
    }
  }

  /** Push an event to the phone via the DataChannel. */
  pushEvent(event: { type: string; [key: string]: any }): void {
    if (!this.isConnected || !this.dc) return;
    const enc = encryptFrame(this.opts.aesKey, Buffer.from(JSON.stringify(event), 'utf-8'));
    const msg = Buffer.concat([Buffer.from([0x10]), enc]);
    this.dc.send(msg);
  }

  /** Close the P2P connection. */
  close(): void {
    if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null; }
    if (this.dc) { try { this.dc.close(); } catch {} this.dc = null; }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    this.setStatus('disconnected');
  }
}
