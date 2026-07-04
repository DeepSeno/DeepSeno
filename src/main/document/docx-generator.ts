import path from 'path';
import fs from 'fs';
import { getStyle } from './styles';

export interface DocxOptions {
  title: string;
  content: string;
  style?: 'business' | 'casual';
  filename?: string;
}

/** Parse inline markdown: **bold**, *italic* → TextRun[] */
function parseInline(text: string, defaultOpts: Record<string, any> = {}): any[] {
  const { TextRun } = require('docx');
  const parts: any[] = [];
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|([^*]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      parts.push(new TextRun({ text: match[2], bold: true, ...defaultOpts }));
    } else if (match[4]) {
      parts.push(new TextRun({ text: match[4], italics: true, ...defaultOpts }));
    } else if (match[5]) {
      parts.push(new TextRun({ text: match[5], ...defaultOpts }));
    }
  }
  return parts.length > 0 ? parts : [new TextRun({ text, ...defaultOpts })];
}

export async function generateDocx(options: DocxOptions, outputDir: string): Promise<string> {
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType,
    Header, Footer, PageNumber, BorderStyle, convertInchesToTwip,
  } = require('docx');

  const s = getStyle(options.style);
  const lines = options.content.split('\n');
  const children: any[] = [];
  const baseTextOpts = { font: s.fontBody, size: s.docxBody, color: s.textColor };

  // Title
  children.push(new Paragraph({
    children: [new TextRun({
      text: options.title,
      bold: true, font: s.fontTitle, size: s.docxTitle, color: s.primaryColor,
    })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
  }));

  // Decoration line under title
  children.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: s.accentColor } },
    spacing: { after: 300 },
  }));

  // Parse content
  let numberCounter = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
      numberCounter = 0;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(4), bold: true,
          font: s.fontTitle, size: s.docxH3, color: s.primaryColor,
        })],
        spacing: { before: 240, after: 120 },
      }));
      numberCounter = 0;
    } else if (trimmed.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(3), bold: true,
          font: s.fontTitle, size: s.docxH2, color: s.primaryColor,
        })],
        spacing: { before: 360, after: 160 },
      }));
      numberCounter = 0;
    } else if (trimmed.startsWith('# ')) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: trimmed.slice(2), bold: true,
          font: s.fontTitle, size: s.docxH1, color: s.primaryColor,
        })],
        spacing: { before: 400, after: 200 },
      }));
      numberCounter = 0;
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const level = line.startsWith('  ') ? 1 : 0;
      const text = trimmed.slice(2);
      children.push(new Paragraph({
        children: parseInline(text, baseTextOpts),
        bullet: { level },
        spacing: { after: 80, line: s.docxLineSpacing },
      }));
      numberCounter = 0;
    } else if (/^\d+\.\s/.test(trimmed)) {
      numberCounter++;
      const text = trimmed.replace(/^\d+\.\s*/, '');
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${numberCounter}. `, bold: true, ...baseTextOpts }),
          ...parseInline(text, baseTextOpts),
        ],
        spacing: { after: 80, line: s.docxLineSpacing },
        indent: { left: convertInchesToTwip(0.3) },
      }));
    } else if (trimmed.startsWith('> ')) {
      children.push(new Paragraph({
        children: parseInline(trimmed.slice(2), { ...baseTextOpts, italics: true, color: s.subtextColor }),
        indent: { left: convertInchesToTwip(0.5) },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: s.accentColor, space: 8 } },
        spacing: { after: 120, line: s.docxLineSpacing },
      }));
      numberCounter = 0;
    } else if (trimmed === '---' || trimmed === '***') {
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: s.subtextColor } },
        spacing: { before: 200, after: 200 },
      }));
      numberCounter = 0;
    } else {
      children.push(new Paragraph({
        children: parseInline(trimmed, baseTextOpts),
        spacing: { after: 160, line: s.docxLineSpacing },
      }));
      numberCounter = 0;
    }
  }

  const doc = new Document({
    creator: 'DeepSeno',
    title: options.title,
    styles: {
      default: {
        document: {
          run: { font: s.fontBody, size: s.docxBody, color: s.textColor },
          paragraph: { spacing: { line: s.docxLineSpacing } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({
              text: options.title,
              font: s.fontBody, size: 16, color: s.subtextColor, italics: true,
            })],
            alignment: AlignmentType.RIGHT,
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ children: [PageNumber.CURRENT], font: s.fontBody, size: 16, color: s.subtextColor }),
              new TextRun({ text: ' / ', font: s.fontBody, size: 16, color: s.subtextColor }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: s.fontBody, size: 16, color: s.subtextColor }),
            ],
            alignment: AlignmentType.CENTER,
          })],
        }),
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(outputDir, { recursive: true });
  const fname = (options.filename || options.title.replace(/[^\w\u4e00-\u9fff]/g, '_')).replace(/\.docx$/i, '') + '.docx';
  const filePath = path.join(outputDir, fname);
  fs.writeFileSync(filePath, buffer);
  console.log(`[DocxGenerator] Generated: ${filePath}`);
  return filePath;
}
