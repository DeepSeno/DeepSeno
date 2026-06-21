import crypto from 'crypto';
import { LanServer } from './lan-server';
import { decryptRequest, encryptResponse, splitFrames } from './relay-crypto';

/**
 * Shared proxy request dispatcher used by both relay tunnel (server-relayed)
 * and LAN WebSocket (direct). Routes decrypted proxy requests to LanServer
 * callbacks and returns encrypted response frames.
 */

/** Derive an AES-256 key from the LAN bearer token (same on both sides). */
export function deriveLanKey(token: string): Buffer {
  const buf = crypto.hkdfSync(
    'sha256',
    Buffer.from(token, 'utf-8'),
    Buffer.from('deepseno-lan-v1'), // salt
    'deepseno-lan-proxy',          // info
    32,                            // 256 bits
  );
  return Buffer.from(buf);
}

/**
 * Process a single proxy-req from a WebSocket (relay or LAN).
 * Decrypts, dispatches to LanServer via handleInternal, encrypts response.
 */
export async function processProxyRequest(
  lanServer: LanServer,
  aesKey: Buffer,
  encryptedFrames: Buffer[],
): Promise<{ status: number; frames: Buffer[] }> {
  try {
    const allData = Buffer.concat(encryptedFrames);
    const frames = splitFrames(allData);
    const { header, body } = decryptRequest(aesKey, frames);

    const response = await lanServer.handleInternal(header.method, header.path, header.headers, body);

    const responseFrames = encryptResponse(aesKey, response.status, response.headers, response.body);
    return { status: response.status, frames: responseFrames };
  } catch (err) {
    console.error('[ProxyDispatcher] Processing error:', err);
    return { status: 500, frames: [] };
  }
}
