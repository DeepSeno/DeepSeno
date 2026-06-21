import { describe, it, expect } from 'vitest';
import { detectMediaType, isDocumentType, isVideoType, SUPPORTED_EXTENSIONS } from '../media-type';

describe('detectMediaType', () => {
  it('detects audio files', () => {
    expect(detectMediaType('/path/to/file.wav')).toBe('audio');
    expect(detectMediaType('/path/to/file.mp3')).toBe('audio');
    expect(detectMediaType('/path/to/file.m4a')).toBe('audio');
    expect(detectMediaType('/path/to/file.flac')).toBe('audio');
    expect(detectMediaType('/path/to/file.ogg')).toBe('audio');
    expect(detectMediaType('/path/to/file.webm')).toBe('audio');
  });

  it('detects video files', () => {
    expect(detectMediaType('/path/to/file.mp4')).toBe('video');
    expect(detectMediaType('/path/to/file.mkv')).toBe('video');
    expect(detectMediaType('/path/to/file.avi')).toBe('video');
    expect(detectMediaType('/path/to/file.mov')).toBe('video');
  });

  it('detects document files', () => {
    expect(detectMediaType('/path/to/file.pdf')).toBe('pdf');
    expect(detectMediaType('/path/to/file.docx')).toBe('docx');
    expect(detectMediaType('/path/to/file.txt')).toBe('text');
    expect(detectMediaType('/path/to/file.md')).toBe('text');
  });

  it('returns null for unsupported extensions', () => {
    expect(detectMediaType('/path/to/file.xyz')).toBeNull();
  });

  it('detects image files', () => {
    expect(detectMediaType('/path/to/file.jpg')).toBe('image');
    expect(detectMediaType('/path/to/file.png')).toBe('image');
    expect(detectMediaType('/path/to/file.heic')).toBe('image');
    expect(detectMediaType('/path/to/file.webp')).toBe('image');
  });

  it('handles case-insensitive extensions', () => {
    expect(detectMediaType('/path/to/FILE.PDF')).toBe('pdf');
    expect(detectMediaType('/path/to/FILE.MP4')).toBe('video');
  });
});

describe('isDocumentType', () => {
  it('returns true for document types', () => {
    expect(isDocumentType('pdf')).toBe(true);
    expect(isDocumentType('docx')).toBe(true);
    expect(isDocumentType('text')).toBe(true);
  });

  it('returns false for non-document types', () => {
    expect(isDocumentType('audio')).toBe(false);
    expect(isDocumentType('video')).toBe(false);
  });
});

describe('isVideoType', () => {
  it('returns true for video', () => {
    expect(isVideoType('video')).toBe(true);
  });

  it('returns false for non-video', () => {
    expect(isVideoType('audio')).toBe(false);
    expect(isVideoType('pdf')).toBe(false);
  });
});

describe('SUPPORTED_EXTENSIONS', () => {
  it('includes all expected extensions', () => {
    expect(SUPPORTED_EXTENSIONS).toContain('.wav');
    expect(SUPPORTED_EXTENSIONS).toContain('.mp4');
    expect(SUPPORTED_EXTENSIONS).toContain('.pdf');
    expect(SUPPORTED_EXTENSIONS).toContain('.docx');
    expect(SUPPORTED_EXTENSIONS).toContain('.txt');
    expect(SUPPORTED_EXTENSIONS).toContain('.md');
  });
});
