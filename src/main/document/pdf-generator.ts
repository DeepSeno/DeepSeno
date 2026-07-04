import path from 'path';
import fs from 'fs';
import { getStyle } from './styles';

export interface PdfOptions {
  title: string;
  content: string;
  style?: 'business' | 'casual';
  filename?: string;
}

/** Find the bundled Chinese font path */
function findFontPath(): string | null {
  const candidates = [
    path.join(__dirname, '../../resources/fonts/NotoSansSC-Regular.otf'),
    path.join(process.resourcesPath || '', 'fonts/NotoSansSC-Regular.otf'),
    path.join(__dirname, '../../../resources/fonts/NotoSansSC-Regular.otf'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function generatePdf(options: PdfOptions, outputDir: string): Promise<string> {
  const PDFDocument = require('pdfkit');
  const s = getStyle(options.style);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 72, bottom: 72, left: 90, right: 72 },
    info: { Title: options.title, Author: 'DeepSeno' },
    autoFirstPage: false,
    bufferPages: true,
  });

  // Register Chinese font
  const fontPath = findFontPath();
  if (fontPath) {
    doc.registerFont('CJK', fontPath);
  }
  const fontName = fontPath ? 'CJK' : 'Helvetica';

  // Output stream
  fs.mkdirSync(outputDir, { recursive: true });
  const fname = (options.filename || options.title.replace(/[^\w\u4e00-\u9fff]/g, '_')).replace(/\.pdf$/i, '') + '.pdf';
  const filePath = path.join(outputDir, fname);
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Helper: add page with header
  function addPage() {
    doc.addPage();
    // Header line
    doc.save()
      .moveTo(90, 50).lineTo(doc.page.width - 72, 50)
      .strokeColor('#' + s.subtextColor).lineWidth(0.5).stroke()
      .restore();
    // Header text
    doc.font(fontName).fontSize(8).fillColor('#' + s.subtextColor)
      .text(options.title, 90, 38, { width: doc.page.width - 162, align: 'right' });
  }

  // ── Title Page ──
  addPage();
  const titleY = 260;
  doc.save()
    .rect(0, titleY - 30, doc.page.width, 80)
    .fill('#' + s.primaryColor)
    .restore();
  doc.font(fontName).fontSize(26).fillColor('#FFFFFF')
    .text(options.title, 90, titleY, { width: doc.page.width - 162, align: 'center' });
  const dateStr = new Date().toLocaleDateString('zh-CN');
  doc.font(fontName).fontSize(12).fillColor('#' + s.subtextColor)
    .text(dateStr, 90, titleY + 60, { width: doc.page.width - 162, align: 'center' });
  doc.save()
    .moveTo(doc.page.width / 2 - 60, titleY + 90)
    .lineTo(doc.page.width / 2 + 60, titleY + 90)
    .strokeColor('#' + s.accentColor).lineWidth(2).stroke()
    .restore();

  // ── Content Pages ──
  addPage();

  const lines = options.content.split('\n');
  const bodySize = 10.5;
  const h1Size = 18;
  const h2Size = 15;
  const h3Size = 13;
  let numberCounter = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      doc.moveDown(0.5);
      numberCounter = 0;
      continue;
    }

    // Check if near bottom of page
    if (doc.y > doc.page.height - 100) {
      addPage();
    }

    if (trimmed.startsWith('### ')) {
      doc.moveDown(0.5);
      doc.font(fontName).fontSize(h3Size).fillColor('#' + s.primaryColor)
        .text(trimmed.slice(4), { lineGap: 4 });
      doc.moveDown(0.3);
      numberCounter = 0;
    } else if (trimmed.startsWith('## ')) {
      doc.moveDown(0.8);
      doc.font(fontName).fontSize(h2Size).fillColor('#' + s.primaryColor)
        .text(trimmed.slice(3), { lineGap: 4 });
      doc.moveDown(0.4);
      numberCounter = 0;
    } else if (trimmed.startsWith('# ')) {
      doc.moveDown(1);
      doc.font(fontName).fontSize(h1Size).fillColor('#' + s.primaryColor)
        .text(trimmed.slice(2), { lineGap: 6 });
      doc.moveDown(0.5);
      numberCounter = 0;
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const indent = line.startsWith('  ') ? 30 : 15;
      const bulletChar = line.startsWith('  ') ? '○' : '●';
      doc.font(fontName).fontSize(bodySize).fillColor('#' + s.textColor)
        .text(bulletChar + '  ' + trimmed.slice(2), 90 + indent, doc.y, {
          width: doc.page.width - 162 - indent, lineGap: 4,
        });
      numberCounter = 0;
    } else if (/^\d+\.\s/.test(trimmed)) {
      numberCounter++;
      const text = trimmed.replace(/^\d+\.\s*/, '');
      doc.font(fontName).fontSize(bodySize).fillColor('#' + s.textColor)
        .text(numberCounter + '.  ' + text, 105, doc.y, {
          width: doc.page.width - 177, lineGap: 4,
        });
    } else if (trimmed.startsWith('> ')) {
      const quoteX = 105;
      const startY = doc.y;
      doc.font(fontName).fontSize(bodySize).fillColor('#' + s.subtextColor)
        .text(trimmed.slice(2), quoteX, doc.y, {
          width: doc.page.width - quoteX - 72, lineGap: 4,
        });
      doc.save()
        .moveTo(98, startY).lineTo(98, doc.y)
        .strokeColor('#' + s.accentColor).lineWidth(2).stroke()
        .restore();
      numberCounter = 0;
    } else if (trimmed === '---' || trimmed === '***') {
      doc.moveDown(0.5);
      doc.save()
        .moveTo(90, doc.y).lineTo(doc.page.width - 72, doc.y)
        .strokeColor('#' + s.subtextColor).lineWidth(0.5).stroke()
        .restore();
      doc.moveDown(0.5);
      numberCounter = 0;
    } else {
      const plain = trimmed.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
      doc.font(fontName).fontSize(bodySize).fillColor('#' + s.textColor)
        .text(plain, { lineGap: 4 });
      numberCounter = 0;
    }
  }

  // ── Footer on all pages ──
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.font(fontName).fontSize(8).fillColor('#' + s.subtextColor)
      .text((i + 1) + ' / ' + totalPages, 90, doc.page.height - 50, {
        width: doc.page.width - 162, align: 'center',
      });
  }

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  console.log('[PdfGenerator] Generated: ' + filePath);
  return filePath;
}
