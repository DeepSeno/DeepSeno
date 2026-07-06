import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileResponse, getContentType, parseRangeHeader } from '../electron/media-protocol';

const tempFiles: string[] = [];

function writeTempFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `deepseno-media-protocol-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  fs.writeFileSync(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const filePath of tempFiles.splice(0)) {
    try { fs.unlinkSync(filePath); } catch { /* already removed */ }
  }
});

describe('media protocol file responses', () => {
  it('parses byte ranges used by media element seeking', () => {
    expect(parseRangeHeader('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRangeHeader('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRangeHeader('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRangeHeader('bytes=20-', 10)).toBeNull();
  });

  it('returns 206 partial content for ranged media requests', async () => {
    const filePath = writeTempFile('0123456789');
    const request = new Request('media://audio/1', {
      headers: { Range: 'bytes=2-5' },
    });

    const response = createFileResponse(filePath, request);

    expect(response.status).toBe(206);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(await response.text()).toBe('2345');
  });

  it('returns 416 for unsatisfiable media ranges', () => {
    const filePath = writeTempFile('0123456789');
    const request = new Request('media://audio/1', {
      headers: { Range: 'bytes=10-20' },
    });

    const response = createFileResponse(filePath, request);

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('detects common media content types', () => {
    expect(getContentType('/tmp/demo.mp4')).toBe('video/mp4');
    expect(getContentType('/tmp/demo.mov')).toBe('video/quicktime');
    expect(getContentType('/tmp/demo.wav')).toBe('audio/wav');
    expect(getContentType('/tmp/demo.unknown')).toBe('application/octet-stream');
  });
});
