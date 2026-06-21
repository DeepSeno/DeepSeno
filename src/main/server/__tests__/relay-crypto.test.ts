import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  generateECDHKeyPair,
  deriveSharedKey,
  encryptFrame,
  decryptFrame,
  encryptRequest,
  decryptRequest,
  encryptResponse,
  decryptResponse,
  generatePairingNonce,
  constantTimeEqual,
  type RequestHeader,
} from '../relay-crypto';

describe('RelayCrypto', () => {
  // ── ECDH key agreement ───────────────────────────────────────

  it('generates a valid ECDH P-256 key pair', () => {
    const { privateKeyPem, publicKeyBase64 } = generateECDHKeyPair();
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');
    // SPKI DER for P-256 public key is 91 bytes → base64 = 124 chars
    const der = Buffer.from(publicKeyBase64, 'base64');
    expect(der.length).toBe(91);
  });

  it('both sides derive the same shared key from ECDH', () => {
    const nonce = generatePairingNonce();

    // Desktop side
    const desktop = generateECDHKeyPair();
    // Phone side
    const phone = generateECDHKeyPair();

    // Each side derives the shared key using its own private key + peer's public key
    const desktopKey = deriveSharedKey(desktop.privateKeyPem, phone.publicKeyBase64, nonce);
    const phoneKey = deriveSharedKey(phone.privateKeyPem, desktop.publicKeyBase64, nonce);

    expect(desktopKey.equals(phoneKey)).toBe(true);
    expect(desktopKey.length).toBe(32); // AES-256
  });

  it('different nonce produces different key (nonce binding)', () => {
    const desktop = generateECDHKeyPair();
    const phone = generateECDHKeyPair();

    const key1 = deriveSharedKey(desktop.privateKeyPem, phone.publicKeyBase64, generatePairingNonce());
    const key2 = deriveSharedKey(desktop.privateKeyPem, phone.publicKeyBase64, generatePairingNonce());

    expect(key1.equals(key2)).toBe(false);
  });

  // ── Frame encryption ─────────────────────────────────────────

  it('encrypt + decrypt roundtrip preserves plaintext', () => {
    const key = crypto.randomBytes(32);
    const plaintext = Buffer.from('Hello, relay world!', 'utf-8');

    const frame = encryptFrame(key, plaintext);
    const decrypted = decryptFrame(key, frame);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('produces different ciphertexts for the same plaintext (random nonce)', () => {
    const key = crypto.randomBytes(32);
    const plaintext = Buffer.from('same input', 'utf-8');

    const frame1 = encryptFrame(key, plaintext);
    const frame2 = encryptFrame(key, plaintext);

    // Ciphertext differs because nonce is random
    expect(frame1.equals(frame2)).toBe(false);
    // But both decrypt to the same plaintext
    expect(decryptFrame(key, frame1).equals(plaintext)).toBe(true);
    expect(decryptFrame(key, frame2).equals(plaintext)).toBe(true);
  });

  it('decryption with wrong key fails (GCM auth tag mismatch)', () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const plaintext = Buffer.from('secret data', 'utf-8');

    const frame = encryptFrame(key1, plaintext);
    expect(() => decryptFrame(key2, frame)).toThrow();
  });

  it('handles empty plaintext', () => {
    const key = crypto.randomBytes(32);
    const plaintext = Buffer.alloc(0);

    const frame = encryptFrame(key, plaintext);
    const decrypted = decryptFrame(key, frame);
    expect(decrypted.length).toBe(0);
  });

  it('handles large plaintext (1MB)', () => {
    const key = crypto.randomBytes(32);
    const plaintext = crypto.randomBytes(1024 * 1024);

    const frame = encryptFrame(key, plaintext);
    const decrypted = decryptFrame(key, frame);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  // ── Request/Response framing ─────────────────────────────────

  it('encryptRequest + decryptRequest roundtrip (no body)', () => {
    const key = crypto.randomBytes(32);
    const header: RequestHeader = {
      method: 'GET',
      path: '/api/recordings',
      headers: { Authorization: 'Bearer test-token' },
    };

    const frames = encryptRequest(key, header);
    expect(frames.length).toBe(1); // header only, no body

    const { header: decHeader, body } = decryptRequest(key, frames);
    expect(decHeader.method).toBe('GET');
    expect(decHeader.path).toBe('/api/recordings');
    expect(decHeader.headers.Authorization).toBe('Bearer test-token');
    expect(body).toBeNull();
  });

  it('encryptRequest + decryptRequest roundtrip (with body)', () => {
    const key = crypto.randomBytes(32);
    const header: RequestHeader = {
      method: 'POST',
      path: '/api/query',
      headers: { 'Content-Type': 'application/json' },
    };
    const body = Buffer.from('{"question":"hello"}', 'utf-8');

    const frames = encryptRequest(key, header, body);
    const { header: decHeader, body: decBody } = decryptRequest(key, frames);

    expect(decHeader.method).toBe('POST');
    expect(decHeader.path).toBe('/api/query');
    expect(decBody?.toString('utf-8')).toBe('{"question":"hello"}');
  });

  it('encryptRequest chunks large body into multiple frames', () => {
    const key = crypto.randomBytes(32);
    const header: RequestHeader = { method: 'POST', path: '/upload', headers: {} };
    const body = crypto.randomBytes(1024 * 100); // 100KB
    const chunkSize = 16 * 1024; // 16KB chunks

    const frames = encryptRequest(key, header, body, chunkSize);
    // 1 header frame + ceil(100KB / 16KB) = 1 + 7 = 8 frames
    expect(frames.length).toBe(1 + Math.ceil(body.length / chunkSize));

    const { body: decBody } = decryptRequest(key, frames);
    expect(decBody?.equals(body)).toBe(true);
  });

  it('encryptResponse + decryptResponse roundtrip', () => {
    const key = crypto.randomBytes(32);
    const body = Buffer.from('{"result":"answer"}', 'utf-8');

    const frames = encryptResponse(key, 200, { 'Content-Type': 'application/json' }, body);
    const { status, headers, body: decBody } = decryptResponse(key, frames);

    expect(status).toBe(200);
    expect(headers['Content-Type']).toBe('application/json');
    expect(decBody?.toString('utf-8')).toBe('{"result":"answer"}');
  });

  // ── Utilities ────────────────────────────────────────────────

  it('generatePairingNonce produces 16 bytes of base64', () => {
    const nonce = generatePairingNonce();
    const decoded = Buffer.from(nonce, 'base64');
    expect(decoded.length).toBe(16);
  });

  it('constantTimeEqual returns true for identical buffers', () => {
    const a = Buffer.from('abcdef', 'utf-8');
    const b = Buffer.from('abcdef', 'utf-8');
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it('constantTimeEqual returns false for different buffers', () => {
    const a = Buffer.from('abcdef', 'utf-8');
    const b = Buffer.from('abcdeg', 'utf-8');
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('constantTimeEqual returns false for different lengths', () => {
    const a = Buffer.from('abc', 'utf-8');
    const b = Buffer.from('abcd', 'utf-8');
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});
