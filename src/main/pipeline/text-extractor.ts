import fs from 'node:fs/promises';

interface ExtractedText {
  text: string;
  pageCount?: number;
  wordCount?: number;
}

interface ExtractPdfOptions {
  maxPages?: number;
}

export async function extractText(filePath: string, mediaType: string): Promise<ExtractedText> {
  switch (mediaType) {
    case 'pdf':
      return extractPdfText(filePath);
    case 'docx':
      return extractDocx(filePath);
    case 'text':
      return extractPlainText(filePath);
    default:
      throw new Error(`Unsupported document type: ${mediaType}`);
  }
}

export async function extractPdfText(filePath: string, options: ExtractPdfOptions = {}): Promise<ExtractedText> {
  ensurePdfJsGlobals();
  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default;

  const buffer = await fs.readFile(filePath);

  // pdf-parse v2: class-based API — new PDFParse({ data }) + getText()
  if (typeof PDFParse === 'function' && PDFParse.prototype && PDFParse.prototype.getText) {
    const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const parser = new PDFParse({ data: uint8 });
    try {
      const parseOptions = options.maxPages && options.maxPages > 0
        ? { first: Math.floor(options.maxPages) }
        : undefined;
      const result = await parser.getText(parseOptions);
      const text = (typeof result === 'string' ? result : result?.text || '').trim();
      return {
        text,
        pageCount: typeof result === 'string' ? undefined : result?.total,
        wordCount: countWords(text),
      };
    } finally {
      await parser.destroy?.();
    }
  }

  // pdf-parse v1: function-based API — pdfParse(buffer) returns { text, numpages }
  const pdfParse = PDFParse;
  const data = await pdfParse(buffer, options.maxPages ? { max: Math.floor(options.maxPages) } : undefined);
  const text = data.text.trim();
  return {
    text,
    pageCount: data.numpages,
    wordCount: countWords(text),
  };
}

function ensurePdfJsGlobals(): void {
  const g = globalThis as typeof globalThis & {
    DOMMatrix?: any;
  };

  if (!g.DOMMatrix) {
    g.DOMMatrix = class DOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      is2D = true;
      isIdentity = true;

      constructor(init?: number[] | string) {
        if (Array.isArray(init)) {
          this.a = Number(init[0] ?? 1);
          this.b = Number(init[1] ?? 0);
          this.c = Number(init[2] ?? 0);
          this.d = Number(init[3] ?? 1);
          this.e = Number(init[4] ?? 0);
          this.f = Number(init[5] ?? 0);
          this.isIdentity = this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
        }
      }

      multiplySelf(): this { return this; }
      preMultiplySelf(): this { return this; }
      translate(): this { return this; }
      translateSelf(): this { return this; }
      scale(): this { return this; }
      scaleSelf(): this { return this; }
      invertSelf(): this { return this; }
    };
  }
}

async function extractDocx(filePath: string): Promise<ExtractedText> {
  const mammoth = (await import('mammoth')).default || await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value.trim();
  return {
    text,
    wordCount: countWords(text),
  };
}

async function extractPlainText(filePath: string): Promise<ExtractedText> {
  const text = (await fs.readFile(filePath, 'utf-8')).trim();
  return {
    text,
    wordCount: countWords(text),
  };
}

function countWords(text: string): number {
  // Count CJK characters + whitespace-separated words
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '').split(/\s+/).filter(Boolean).length;
  return cjk + words;
}
