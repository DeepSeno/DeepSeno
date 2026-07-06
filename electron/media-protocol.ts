import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
};

export interface ByteRange {
  start: number;
  end: number;
}

export function getContentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function parseRangeHeader(rangeHeader: string | null, fileSize: number): ByteRange | null {
  if (!rangeHeader || fileSize < 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startPart, endPart] = match;
  if (!startPart && !endPart) return null;

  let start: number;
  let end: number;

  if (!startPart) {
    const suffixLength = Number.parseInt(endPart, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(fileSize - suffixLength, 0);
    end = Math.max(fileSize - 1, 0);
  } else {
    start = Number.parseInt(startPart, 10);
    end = endPart ? Number.parseInt(endPart, 10) : fileSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return null;
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

function streamFile(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const nodeStream = range
    ? fs.createReadStream(filePath, { start: range.start, end: range.end })
    : fs.createReadStream(filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export function createFileResponse(filePath: string, request: Request): Response {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return new Response('Media path is not a file', { status: 404 });
  }

  const fileSize = stat.size;
  const contentType = getContentType(filePath);
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  };

  const range = parseRangeHeader(request.headers.get('range'), fileSize);
  const wantsRange = !!request.headers.get('range');
  if (wantsRange && !range) {
    return new Response(null, {
      status: 416,
      headers: {
        ...commonHeaders,
        'Content-Range': `bytes */${fileSize}`,
      },
    });
  }

  if (range) {
    const contentLength = range.end - range.start + 1;
    return new Response(request.method === 'HEAD' ? null : streamFile(filePath, range), {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
        'Content-Length': String(contentLength),
      },
    });
  }

  return new Response(request.method === 'HEAD' ? null : streamFile(filePath), {
    status: 200,
    headers: {
      ...commonHeaders,
      'Content-Length': String(fileSize),
    },
  });
}
