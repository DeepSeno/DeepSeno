import crypto from 'crypto';

/**
 * WeChat Work (Enterprise WeChat) message crypto helper.
 * Handles AES-256-CBC decryption and signature verification for webhook callbacks.
 */

/** Verify the callback signature */
export function verifySignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  const arr = [token, timestamp, nonce, encrypted].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

/** Decrypt the encrypted message body */
export function decryptMessage(encrypted: string, encodingAESKey: string): string {
  const aesKey = Buffer.from(encodingAESKey + '=', 'base64');
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
  // Remove PKCS7 padding
  const padLen = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - padLen);
  // Format: 16 bytes random + 4 bytes content_length + content + corpId
  const contentLen = decrypted.readUInt32BE(16);
  const content = decrypted.subarray(20, 20 + contentLen).toString('utf-8');
  return content;
}

/** Simple XML tag extractor (avoids xml2js dependency) */
export function extractXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`))
    || xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : '';
}
