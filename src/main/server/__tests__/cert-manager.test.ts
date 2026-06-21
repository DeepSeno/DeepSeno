import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { CertManager } from '../cert-manager';

describe('CertManager', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-cert-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generates a self-signed cert + key on first call and persists them', () => {
    const cm = new CertManager(dir);
    const { cert, key } = cm.getOrCreate();
    expect(cert).toContain('BEGIN CERTIFICATE');
    expect(key).toContain('BEGIN'); // RSA/PRIVATE KEY
    expect(fs.existsSync(path.join(dir, 'lan-cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'lan-key.pem'))).toBe(true);
  });

  it('reuses the same cert on subsequent calls (stable fingerprint)', () => {
    const fp1 = new CertManager(dir).getFingerprint();
    const fp2 = new CertManager(dir).getFingerprint();
    expect(fp1).toBe(fp2);
    // SHA-256 hex of DER pubkey, uppercase colon-separated, 32 bytes => 95 chars
    expect(fp1).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('exposes the same SPKI hash in base64 form', () => {
    const cm = new CertManager(dir);
    const b64 = cm.getFingerprintBase64();
    expect(b64).toMatch(/^[A-Za-z0-9+/]{43}=$/); // 32-byte SHA-256 base64 = 44 chars w/ padding
  });

  it('self-heals a corrupt/truncated key by regenerating a working pair', () => {
    // First produce a good pair so lan-cert.pem is valid...
    new CertManager(dir).getOrCreate();
    // ...then corrupt the key as if the process died mid-write.
    fs.writeFileSync(path.join(dir, 'lan-key.pem'), '-----BEGIN RSA PRIVATE KEY-----\ntruncated', 'utf-8');

    const cm = new CertManager(dir);
    // Must NOT throw ERR_OSSL_PEM_BAD_END_LINE — it should regenerate instead.
    const fp = cm.getFingerprint();
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // The on-disk key is now a real, parseable private key again.
    const key = fs.readFileSync(path.join(dir, 'lan-key.pem'), 'utf-8');
    expect(() => crypto.createPrivateKey(key)).not.toThrow();
  });

  it('writes the private key with 0600 perms (POSIX)', () => {
    new CertManager(dir).getOrCreate();
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(dir, 'lan-key.pem')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
