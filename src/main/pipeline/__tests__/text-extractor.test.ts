import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractText } from '../text-extractor';

const originalDomMatrix = (globalThis as any).DOMMatrix;
const originalImageData = (globalThis as any).ImageData;
const originalPath2D = (globalThis as any).Path2D;

afterEach(() => {
  restoreGlobal('DOMMatrix', originalDomMatrix);
  restoreGlobal('ImageData', originalImageData);
  restoreGlobal('Path2D', originalPath2D);
});

describe('extractText', () => {
  it('extracts PDF text when DOMMatrix is missing', async () => {
    delete (globalThis as any).DOMMatrix;
    delete (globalThis as any).ImageData;
    delete (globalThis as any).Path2D;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseno-pdf-'));
    const filePath = path.join(dir, 'sample.pdf');
    await fs.writeFile(filePath, createMinimalPdf('DeepSeno PDF smoke test'), 'binary');

    const result = await extractText(filePath, 'pdf');

    expect(result.text).toContain('DeepSeno PDF smoke test');
    expect(result.pageCount).toBe(1);
    expect(result.wordCount).toBeGreaterThan(0);
  });
});

function restoreGlobal(name: 'DOMMatrix' | 'ImageData' | 'Path2D', value: unknown): void {
  if (value) (globalThis as any)[name] = value;
  else delete (globalThis as any)[name];
}

function createMinimalPdf(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
