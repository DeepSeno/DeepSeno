import fs from 'fs';
import { GGUF_CATALOG } from './gguf-model-catalog';

export const GGUF_COMPLETE_RATIO = 1;
const GGUF_MAGIC = 'GGUF';

export interface GGUFFileInfo {
  size: number;
  header?: Uint8Array | null;
}

export interface GGUFFileValidation {
  ok: boolean;
  size: number;
  error?: string;
}

export function isCompleteGGUFFile(actualBytes: number, expectedBytes: number): boolean {
  return actualBytes === expectedBytes;
}

export function hasGGUFMagic(header?: Uint8Array | null): boolean {
  if (!header || header.length < GGUF_MAGIC.length) return false;
  return String.fromCharCode(...Array.from(header.slice(0, GGUF_MAGIC.length))) === GGUF_MAGIC;
}

export function isValidGGUFFileInfo(info: GGUFFileInfo, expectedBytes: number): boolean {
  if (!isCompleteGGUFFile(info.size, expectedBytes)) return false;
  return info.header === undefined || hasGGUFMagic(info.header);
}

export function readGGUFFileInfo(filePath: string): GGUFFileInfo | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(GGUF_MAGIC.length);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return {
      size: stat.size,
      header: bytesRead === header.length ? header : header.subarray(0, bytesRead),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function validateGGUFFilePath(filePath: string, expectedBytes: number): GGUFFileValidation {
  const info = readGGUFFileInfo(filePath);
  if (!info) {
    return { ok: false, size: 0, error: 'Model file not found' };
  }
  if (!hasGGUFMagic(info.header)) {
    return {
      ok: false,
      size: info.size,
      error: 'Downloaded file is not a valid GGUF model file',
    };
  }
  if (!isCompleteGGUFFile(info.size, expectedBytes)) {
    return {
      ok: false,
      size: info.size,
      error: `Downloaded file size mismatch (${info.size} bytes, expected ${expectedBytes} bytes)`,
    };
  }
  return { ok: true, size: info.size };
}

export function getDownloadedGGUFModelIds(
  getFileInfo: (fileName: string) => number | GGUFFileInfo | null,
): string[] {
  return GGUF_CATALOG
    .filter((model) => {
      const info = getFileInfo(model.fileName);
      if (info === null) return false;
      const fileInfo = typeof info === 'number' ? { size: info } : info;
      return isValidGGUFFileInfo(fileInfo, model.fileSizeBytes);
    })
    .map((model) => model.id);
}
