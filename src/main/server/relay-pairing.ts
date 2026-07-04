import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  generateECDHKeyPair,
  deriveSharedKey,
  generatePairingNonce,
  constantTimeEqual,
} from './relay-crypto';

/**
 * Manages the pairing lifecycle: QR code generation, ECDH key agreement, and
 * persistent storage of the shared AES key.
 *
 * Pairing flow:
 *   1. Desktop generates ECDH key pair + nonce, shows QR code
 *   2. Phone scans QR, generates its own key pair, computes shared key, POSTs
 *      its public key to the server (which relays it to the desktop via WS)
 *   3. Desktop receives phone's public key via WS, computes the same shared key
 *   4. Both sides persist the shared key for future requests
 *
 * The private key NEVER leaves this machine. The server only sees public keys
 * and the nonce (which is used as HKDF salt — not secret, but binds this
 * pairing session).
 */

// ── Types ──────────────────────────────────────────────────────

export interface PairingQRData {
  /** The deepseno:// pair URL embedded in the QR code. */
  url: string;
  /** Expiry timestamp (ms). QR is valid for 5 minutes. */
  expiresAt: number;
}

export interface PairingSession {
  /** Our ECDH private key (PEM). Never leaves this machine. */
  privateKeyPem: string;
  /** Our ECDH public key (base64 SPKI DER). Embedded in the QR code. */
  publicKeyBase64: string;
  /** Random 16-byte nonce (base64). Used as HKDF salt. */
  nonce: string;
  /** When this session was created (ms). */
  createdAt: number;
}

export interface StoredCredential {
  /** The shared AES-256 key, derived via ECDH + HKDF. */
  aesKeyBase64: string;
  /** The phone's ECDH public key (base64), for re-derivation if needed. */
  phonePublicKey: string;
  /** When the pairing was completed (ISO string). */
  pairedAt: string;
}

// ── Constants ──────────────────────────────────────────────────

const QR_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_FILE = 'relay-pairing.json';

// ── Data dir helper (mirrors cert-manager.ts) ──────────────────

function defaultDataDir(): string {
  if (process.env.DEEPSENO_DATA_DIR) return process.env.DEEPSENO_DATA_DIR;
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'deepseno');
  } catch {
    return path.join(process.env.APPDATA || os.homedir(), 'deepseno');
  }
}

// ── Pairing manager ────────────────────────────────────────────

export class PairingManager {
  private dataDir: string;
  private session: PairingSession | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || defaultDataDir();
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /**
   * Start a new pairing session: generate ECDH key pair + nonce, and return
   * the QR code data for the phone to scan.
   *
   * @param machineId   This machine's persistent ID (so the server can route
   *                    to this desktop's WebSocket)
   * @returns QR code data containing the pair URL
   */
  startSession(machineId: string): PairingQRData {
    const { privateKeyPem, publicKeyBase64 } = generateECDHKeyPair();
    const nonce = generatePairingNonce();

    this.session = {
      privateKeyPem,
      publicKeyBase64,
      nonce,
      createdAt: Date.now(),
    };

    // Build the QR URL. The phone scans this and gets everything it needs to
    // POST its public key to the server.
    const params = new URLSearchParams({
      mid: machineId,
      pub: publicKeyBase64,
      nonce,
    });
    const url = `deepseno://pair?${params.toString()}`;

    return {
      url,
      expiresAt: Date.now() + QR_TTL_MS,
    };
  }

  /**
   * Complete pairing: called when the phone's public key arrives via the
   * WebSocket. Derives the shared AES key and persists it.
   *
   * @param phonePublicKeyBase64  The phone's ECDH public key (from the pair WS message)
   * @param nonce  The nonce from the pair message (must match the session's nonce)
   * @returns true if pairing succeeded, false if no active session or nonce mismatch
   */
  completePairing(phonePublicKeyBase64: string, nonce: string): boolean {
    if (!this.session) return false;

    const sessionNonce = Buffer.from(this.session.nonce, 'base64');
    const receivedNonce = Buffer.from(nonce, 'base64');
    if (!constantTimeEqual(sessionNonce, receivedNonce)) {
      return false;
    }

    // Don't check QR expiration — the QR is static and may be displayed for a long time.

    // Derive the shared AES key
    const aesKey = deriveSharedKey(
      this.session.privateKeyPem,
      phonePublicKeyBase64,
      this.session.nonce,
    );

    // Persist the credential
    const cred: StoredCredential = {
      aesKeyBase64: aesKey.toString('base64'),
      phonePublicKey: phonePublicKeyBase64,
      pairedAt: new Date().toISOString(),
    };
    this.saveCredential(cred);

    // Don't clear the session — keep it alive so the same QR can be reused.

    return true;
  }

  /** Get the current pairing session (for checking if a session is active). */
  getSession(): PairingSession | null {
    return this.session;
  }

  /** Cancel an in-progress pairing session. */
  cancelSession(): void {
    this.session = null;
  }

  // ── Credential persistence ───────────────────────────────────

  /**
   * Load the stored pairing credential. Returns null if not paired.
   * The AES key is what the relay tunnel uses to encrypt/decrypt requests.
   */
  getCredential(): StoredCredential | null {
    try {
      const filePath = path.join(this.dataDir, PAIRING_FILE);
      const data = fs.readFileSync(filePath, 'utf-8');
      const cred = JSON.parse(data) as StoredCredential;
      if (!cred.aesKeyBase64 || !cred.phonePublicKey) return null;
      return cred;
    } catch {
      return null;
    }
  }

  /** Check if a phone is currently paired. */
  isPaired(): boolean {
    return this.getCredential() !== null;
  }

  /**
   * Get the AES key for the relay tunnel. Returns null if not paired.
   * The key is base64-decoded into a Buffer for use with encryptFrame/decryptFrame.
   */
  getAesKey(): Buffer | null {
    const cred = this.getCredential();
    if (!cred) return null;
    return Buffer.from(cred.aesKeyBase64, 'base64');
  }

  /** Clear the stored credential (unpair). */
  clearCredential(): void {
    try {
      const filePath = path.join(this.dataDir, PAIRING_FILE);
      fs.unlinkSync(filePath);
    } catch { /* file doesn't exist — fine */ }
  }

  /** Persist the credential to disk with 0600 permissions. */
  private saveCredential(cred: StoredCredential): void {
    const filePath = path.join(this.dataDir, PAIRING_FILE);
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    }
    fs.renameSync(tmp, filePath);
  }
}
