import path from 'node:path';

export type MediaType = 'audio' | 'video' | 'pdf' | 'docx' | 'text' | 'image';

const EXT_MAP: Record<string, MediaType> = {
  // Audio
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio',
  '.flac': 'audio', '.ogg': 'audio', '.webm': 'audio',
  // Video
  '.mp4': 'video', '.mkv': 'video', '.avi': 'video',
  '.mov': 'video', '.wmv': 'video',
  // Documents
  '.pdf': 'pdf', '.docx': 'docx',
  '.txt': 'text', '.md': 'text',
  // Images
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image',
  '.heic': 'image', '.webp': 'image',
};

export function detectMediaType(filePath: string): MediaType | null {
  // Directories are image groups (folders containing images)
  try {
    const fs = require('node:fs');
    if (fs.statSync(filePath).isDirectory()) return 'image';
  } catch { /* ignore — file may not exist yet */ }
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? null;
}

export function isDocumentType(type: MediaType): boolean {
  return type === 'pdf' || type === 'docx' || type === 'text';
}

export function isVideoType(type: MediaType): boolean {
  return type === 'video';
}

export function isImageType(type: MediaType): boolean {
  return type === 'image';
}

/** All supported file extensions */
export const SUPPORTED_EXTENSIONS = Object.keys(EXT_MAP);
