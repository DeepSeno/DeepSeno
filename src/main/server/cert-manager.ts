import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
// pinned to selfsigned@2.4.1: 5.x made generate() async; we need the sync API
import selfsigned from 'selfsigned';

/**
 * Manages a persistent self-signed TLS cert/key for the public HTTPS endpoint.
 * The private key never leaves this machine. Mobile clients pin the cert's
 * public-key SHA-256 fingerprint (hostname verification is disabled because
 * clients connect via a VPS IP, not the cert CN).
 */
export class CertManager {
  private dir: string;
  // Memoized SPKI SHA-256 of the active cert. Immutable for the process
  // lifetime UNLESS getOrCreate() regenerates a corrupt pair — that path
  // invalidates this back to null so the next read recomputes it.
  private cachedSpki: Buffer | null = null;
  constructor(dataDir?: string) {
    this.dir = dataDir || defaultDataDir();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private certPath() { return path.join(this.dir, 'lan-cert.pem'); }
  private keyPath() { return path.join(this.dir, 'lan-key.pem'); }

  /** Return existing cert/key, generating + persisting on first use. */
  getOrCreate(): { cert: string; key: string } {
    try {
      const cert = fs.readFileSync(this.certPath(), 'utf-8');
      const key = fs.readFileSync(this.keyPath(), 'utf-8');
      // Validate by ACTUALLY parsing the pair — a truncated/half-written PEM
      // passes a naive string check but throws ERR_OSSL_PEM_BAD_END_LINE later.
      // If either side is corrupt (e.g. process died mid-write), regenerate.
      new crypto.X509Certificate(cert);
      crypto.createPrivateKey(key);
      return { cert, key };
    } catch { /* missing or corrupt — regenerate below */ }

    // Regenerating a new pair changes the public key, so any memoized
    // fingerprint is now stale — drop it to force a recompute on next read.
    this.cachedSpki = null;
    const attrs = [{ name: 'commonName', value: 'deepseno-desktop' }];
    const pems = selfsigned.generate(attrs, {
      keySize: 2048,
      days: 3650, // 10y; rotation handled by re-pairing if user reinstalls
      algorithm: 'sha256',
      extensions: [{ name: 'basicConstraints', cA: false }],
    });
    this.writeAtomic(this.keyPath(), pems.private, 0o600);
    this.writeAtomic(this.certPath(), pems.cert);
    return { cert: pems.cert, key: pems.private };
  }

  /**
   * Write via temp-file + rename so a crash never leaves a half-written PEM
   * (rename is atomic per-file on POSIX/NTFS). `mode` is enforced with an
   * explicit chmod because the writeFileSync mode is masked by umask on create
   * and ignored entirely if a stale temp file already exists.
   */
  private writeAtomic(target: string, data: string, mode?: number) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, mode === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', mode });
    if (mode !== undefined && process.platform !== 'win32') {
      try { fs.chmodSync(tmp, mode); } catch { /* best-effort on POSIX */ }
    }
    fs.renameSync(tmp, target);
  }

  /** Raw SHA-256 of the cert's public key (SPKI DER). Memoized — see cachedSpki. */
  private spkiSha256(): Buffer {
    if (this.cachedSpki) return this.cachedSpki;
    const { cert } = this.getOrCreate();
    const x509 = new crypto.X509Certificate(cert);
    const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    this.cachedSpki = crypto.createHash('sha256').update(spkiDer).digest();
    return this.cachedSpki;
  }

  /** SPKI SHA-256, upper-case colon-separated hex (for iOS custom pinning). */
  getFingerprint(): string {
    const hex = this.spkiSha256().toString('hex').toUpperCase();
    return (hex.match(/.{2}/g) || []).join(':');
  }

  /** SPKI SHA-256, base64 (matches OkHttp CertificatePinner `sha256/<base64>`). */
  getFingerprintBase64(): string {
    return this.spkiSha256().toString('base64');
  }
}

function defaultDataDir(): string {
  if (process.env.DEEPSENO_DATA_DIR) return process.env.DEEPSENO_DATA_DIR;
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'deepseno');
  } catch {
    return path.join(process.env.APPDATA || os.homedir(), 'deepseno');
  }
}
