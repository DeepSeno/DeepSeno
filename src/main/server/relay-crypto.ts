import crypto from 'crypto';

/**
 * ECDH key agreement + AES-256-GCM encryption for the relay tunnel.
 *
 * The relay server NEVER sees plaintext: all request/response bodies are
 * encrypted with a key derived from an ECDH exchange that happens at pairing
 * time. The server only relays opaque ciphertext.
 *
 * Encryption format (per chunk):
 *   [4 bytes: length (uint32 BE)] [12 bytes: nonce] [N bytes: ciphertext] [16 bytes: GCM tag]
 *
 * The first chunk of a request/response is always the "header" — a JSON
 * object {method, path, headers}. Subsequent chunks are raw body bytes.
 */

// ── ECDH key agreement ─────────────────────────────────────────

/** Generate an ECDH P-256 key pair for pairing. Returns base64-encoded raw keys. */
export function generateECDHKeyPair(): {
  privateKeyPem: string;
  publicKeyBase64: string;
} {
  // Generate without encoding options so we get KeyObject back (can export in
  // any format), then export manually.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const privateKeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKeyPem,
    publicKeyBase64: spkiDer.toString('base64'),
  };
}

/**
 * Derive the shared AES-256 key from our private key and the peer's public key
 * using ECDH + HKDF. Both sides compute the same key.
 *
 * @param ourPrivateKeyPem  Our ECDH private key (PEM)
 * @param peerPublicKeyBase64  Peer's ECDH public key (base64 SPKI DER)
 * @param nonce  The pairing nonce (base64, 16 bytes) — used as HKDF salt
 * @returns 32-byte AES-256 key
 */
export function deriveSharedKey(
  ourPrivateKeyPem: string,
  peerPublicKeyBase64: string,
  nonceBase64: string,
): Buffer {
  const peerPubKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(ourPrivateKeyPem),
    publicKey: peerPubKey,
  });

  // HKDF-SHA256 to derive the final AES key.
  const nonce = Buffer.from(nonceBase64, 'base64');
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, nonce, 'deepseno-relay-v1', 32);
  return Buffer.from(aesKey);
}

// ── AES-256-GCM encryption ─────────────────────────────────────

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/**
 * Encrypt a single plaintext chunk into a Frame.
 *
 * Frame layout (binary):
 *   [4 bytes: length (uint32 BE)] [12 bytes: nonce] [N bytes: ciphertext] [16 bytes: tag]
 *
 * `length` = len(nonce) + len(ciphertext) + len(tag) = 12 + N + 16
 */
export function encryptFrame(aesKey: Buffer, plaintext: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // length field = nonce + ciphertext + tag
  const length = Buffer.alloc(4);
  length.writeUInt32BE(NONCE_SIZE + ciphertext.length + TAG_SIZE, 0);

  return Buffer.concat([length, nonce, ciphertext, tag]);
}

/**
 * Decrypt a single Frame back into plaintext.
 *
 * @param frame  The raw Frame bytes (starting with the 4-byte length prefix)
 * @returns The decrypted plaintext
 * @throws If the GCM tag verification fails (tampered/corrupted data)
 */
export function decryptFrame(aesKey: Buffer, frame: Buffer): Buffer {
  if (frame.length < 4 + NONCE_SIZE + TAG_SIZE) {
    throw new Error(`Frame too short: ${frame.length} bytes`);
  }
  const length = frame.readUInt32BE(0);
  if (frame.length < 4 + length) {
    throw new Error(`Frame incomplete: expected ${4 + length} bytes, got ${frame.length}`);
  }

  const nonce = frame.subarray(4, 4 + NONCE_SIZE);
  const ciphertext = frame.subarray(4 + NONCE_SIZE, 4 + length - TAG_SIZE);
  const tag = frame.subarray(4 + length - TAG_SIZE, 4 + length);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Request/Response framing ───────────────────────────────────

export interface RequestHeader {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * Encrypt a complete request (header + optional body) into a sequence of
 * Frames. The header is always the first Frame; body chunks follow.
 *
 * @param aesKey  The shared AES key
 * @param header  Request metadata (method, path, headers)
 * @param body    Optional request body (raw bytes)
 * @param chunkSize  Max plaintext size per body Frame (default 1MB for relay, 16KB for P2P)
 * @returns Array of encrypted Frames
 */
export function encryptRequest(
  aesKey: Buffer,
  header: RequestHeader,
  body?: Buffer,
  chunkSize = 1024 * 1024,
): Buffer[] {
  const frames: Buffer[] = [];

  // Frame 0: header JSON
  const headerJson = Buffer.from(JSON.stringify(header), 'utf-8');
  frames.push(encryptFrame(aesKey, headerJson));

  // Frames 1..N: body chunks
  if (body && body.length > 0) {
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const chunk = body.subarray(offset, offset + chunkSize);
      frames.push(encryptFrame(aesKey, chunk));
    }
  }

  return frames;
}

/**
 * Decrypt a sequence of Frames back into a header + body.
 *
 * @param aesKey  The shared AES key
 * @param frames  Array of encrypted Frames
 * @returns { header, body } where body is null if only one frame was present
 */
export function decryptRequest(
  aesKey: Buffer,
  frames: Buffer[],
): { header: RequestHeader; body: Buffer | null } {
  if (frames.length === 0) {
    throw new Error('No frames to decrypt');
  }

  // Frame 0: header
  const headerJson = decryptFrame(aesKey, frames[0]).toString('utf-8');
  const header = JSON.parse(headerJson) as RequestHeader;

  // Frames 1..N: body
  let body: Buffer | null = null;
  if (frames.length > 1) {
    const chunks: Buffer[] = [];
    for (let i = 1; i < frames.length; i++) {
      chunks.push(decryptFrame(aesKey, frames[i]));
    }
    body = Buffer.concat(chunks);
  }

  return { header, body };
}

/**
 * Encrypt a complete response (status + headers + optional body) into Frames.
 * The first Frame is a JSON header: {status, headers}. Body chunks follow.
 */
export function encryptResponse(
  aesKey: Buffer,
  status: number,
  headers: Record<string, string>,
  body?: Buffer,
  chunkSize = 1024 * 1024,
): Buffer[] {
  const frames: Buffer[] = [];

  const headerJson = Buffer.from(
    JSON.stringify({ status, headers }),
    'utf-8',
  );
  frames.push(encryptFrame(aesKey, headerJson));

  if (body && body.length > 0) {
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const chunk = body.subarray(offset, offset + chunkSize);
      frames.push(encryptFrame(aesKey, chunk));
    }
  }

  return frames;
}

export interface DecryptedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

export function decryptResponse(
  aesKey: Buffer,
  frames: Buffer[],
): DecryptedResponse {
  if (frames.length === 0) {
    throw new Error('No frames to decrypt');
  }

  const headerJson = decryptFrame(aesKey, frames[0]).toString('utf-8');
  const { status, headers } = JSON.parse(headerJson) as {
    status: number;
    headers: Record<string, string>;
  };

  let body: Buffer | null = null;
  if (frames.length > 1) {
    const chunks: Buffer[] = [];
    for (let i = 1; i < frames.length; i++) {
      chunks.push(decryptFrame(aesKey, frames[i]));
    }
    body = Buffer.concat(chunks);
  }

  return { status, headers, body };
}

// ── Utilities ──────────────────────────────────────────────────

/** Generate a random 16-byte nonce for pairing, returned as base64. */
export function generatePairingNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Constant-time comparison of two buffers (e.g. nonce verification). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Split concatenated encrypted frames by 4-byte length prefix.
 */
export function splitFrames(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) break;
    const frameLen = data.readUInt32BE(offset);
    if (offset + 4 + frameLen > data.length) break;
    frames.push(data.subarray(offset, offset + 4 + frameLen));
    offset += 4 + frameLen;
  }
  return frames;
}
