import fs from 'node:fs/promises';

interface ExtractedText {
  text: string;
  pageCount?: number;
  wordCount?: number;
}

export async function extractText(filePath: string, mediaType: string): Promise<ExtractedText> {
  switch (mediaType) {
    case 'pdf':
      return extractPdf(filePath);
    case 'docx':
      return extractDocx(filePath);
    case 'text':
      return extractPlainText(filePath);
    default:
      throw new Error(`Unsupported document type: ${mediaType}`);
  }
}

async function extractPdf(filePath: string): Promise<ExtractedText> {
  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default;

  const buffer = await fs.readFile(filePath);

  // pdf-parse v2: class-based API — new PDFParse(Uint8Array) + load() + getText()
  if (typeof PDFParse === 'function' && PDFParse.prototype && PDFParse.prototype.load) {
    const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const parser = new PDFParse(uint8);
    await parser.load();
    const info = await parser.getInfo();
    const result = await parser.getText();
    const text = (typeof result === 'string' ? result : result?.text || '').trim();
    parser.destroy();
    return {
      text,
      pageCount: info?.total || info?.numPages || undefined,
      wordCount: countWords(text),
    };
  }

  // pdf-parse v1: function-based API — pdfParse(buffer) returns { text, numpages }
  const pdfParse = PDFParse;
  const data = await pdfParse(buffer);
  const text = data.text.trim();
  return {
    text,
    pageCount: data.numpages,
    wordCount: countWords(text),
  };
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
