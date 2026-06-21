/**
 * PPTX generator with two modes:
 * 1. Cloud-powered: LLM generates custom pptxgenjs code per request (Anthropic Skill guidelines)
 * 2. Local fallback: Fixed professional template when no cloud model is configured
 */

import path from 'path';
import fs from 'fs';
import type { LLMClient } from '../llm/llm-client';

export interface PptxSlide {
  title: string;
  bullets: string[];
}

export interface PptxOptions {
  title: string;
  slides: PptxSlide[];
  style?: 'business' | 'casual';
  filename?: string;
  subtitle?: string;
}

/** Normalize LLM slides input: may be strings or {title, bullets} objects */
export function normalizeSlides(rawSlides: any[]): PptxSlide[] {
  const result: PptxSlide[] = [];
  for (const raw of rawSlides) {
    if (typeof raw === 'string') {
      const lines = raw.split(/\n|(?<=[。！？])\s*/);
      const first = lines[0] || raw;
      const titleMatch = first.match(/^\[([^\]]+)\]\s*(.*)/) || first.match(/^(.+?)[：:]\s*(.+)/);
      if (titleMatch) {
        const slideTitle = titleMatch[1].trim();
        const rest = titleMatch[2] ? [titleMatch[2].trim()] : [];
        const bullets = [...rest, ...lines.slice(1)]
          .map(l => l.replace(/^[-•*]\s*/, '').trim())
          .filter(Boolean);
        result.push({ title: slideTitle, bullets });
      } else {
        result.push({ title: first, bullets: lines.slice(1).filter(Boolean) });
      }
    } else {
      result.push({ title: raw.title || '', bullets: raw.bullets || [] });
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// Cloud-powered generation: LLM writes pptxgenjs code
// ────────────────────────────────────────────────────────────────

const PPTX_SYSTEM_PROMPT = `You are an expert presentation designer. Generate pptxgenjs JavaScript code to create a professional PowerPoint presentation.

## Design Guidelines (from Anthropic PPTX Skill)

### Color Palettes — pick ONE that fits the content:
| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| Midnight Executive | 1E2761 | CADCFC | FFFFFF |
| Forest & Moss | 2C5F2D | 97BC62 | F5F5F5 |
| Coral Energy | F96167 | F9E795 | 2F3C7E |
| Warm Terracotta | B85042 | E7E8D1 | A7BEAE |
| Ocean Gradient | 065A82 | 1C7293 | 21295C |
| Charcoal Minimal | 36454F | F2F2F2 | 212121 |
| Teal Trust | 028090 | 00A896 | 02C39A |
| Berry & Cream | 6D2E46 | A26769 | ECE2D0 |

### Typography — pick a pair:
| Header | Body |
|--------|------|
| Georgia | Calibri |
| Arial Black | Arial |
| Trebuchet MS | Calibri |
| Cambria | Calibri |

### Layout Rules:
- Dark backgrounds for title + conclusion slides, light for content (sandwich structure)
- Left-align body text, center only titles on dark slides
- Every slide needs a visual element (shape, color block, accent bar) — not just text
- Vary layouts across slides (don't repeat same layout)
- 0.5" minimum margins, 0.3-0.5" between content blocks
- Titles 36-44pt bold, body 14-16pt, captions 10-12pt
- NEVER use accent lines under titles (AI hallmark)
- Use bullets correctly: { text: "item", options: { bullet: true, breakLine: true } }

### Structure:
1. Title slide (dark background, big title, subtitle/date)
2. Content slides (light background, varied layouts)
3. Closing slide (dark background, "谢谢" or "Thank You")

## Output Format

Output ONLY a JavaScript function body. The function receives \`pres\` (a PptxGenJS instance already created with layout LAYOUT_16x9).
Do NOT include require/import statements, do NOT call pres.writeFile(), do NOT wrap in a function declaration.
Just output the code that adds slides to \`pres\`.

Example:
\`\`\`
// Title slide
const s1 = pres.addSlide();
s1.background = { color: '1E2761' };
s1.addText("Title Here", { x: 0.8, y: 1.5, w: 8.4, h: 1.5, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Georgia', margin: 0 });
// ... more slides
\`\`\``;

/**
 * Generate PPTX using a cloud LLM to write custom pptxgenjs code.
 * Returns the file path, or null if generation fails (caller should fallback).
 */
async function generateWithCloudLLM(
  options: PptxOptions,
  outputDir: string,
  llmClient: LLMClient,
  model: string,
): Promise<string | null> {
  try {
    // Build the content description for the LLM
    const slidesDesc = options.slides.map((s, i) =>
      `Slide ${i + 1}: "${s.title}"\n  - ${s.bullets.join('\n  - ')}`,
    ).join('\n\n');

    const userPrompt = `Create a professional presentation:

Title: "${options.title}"
Subtitle: "${options.subtitle || new Date().toLocaleDateString('zh-CN')}"
Style: ${options.style === 'casual' ? 'casual/internal (use Charcoal Minimal palette)' : 'business/formal (pick a palette that fits the content)'}

Content:
${slidesDesc}

Generate the pptxgenjs code now. Remember: output ONLY the code body, no function wrapper, no imports, no writeFile.`;

    console.log(`[PptxGenerator] Generating custom code via cloud LLM (${model})...`);
    const code = await llmClient.generate({
      model,
      prompt: userPrompt,
      system: PPTX_SYSTEM_PROMPT,
      temperature: 0.4,
      num_ctx: 16384,
    });

    // Extract code from markdown fences if present
    let cleanCode = code.trim();
    const fenceMatch = cleanCode.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    if (fenceMatch) {
      cleanCode = fenceMatch[1].trim();
    }

    if (!cleanCode || cleanCode.length < 50) {
      console.warn('[PptxGenerator] Cloud LLM returned insufficient code, falling back');
      return null;
    }

    // Execute the generated code
    const PptxGenJS = require('pptxgenjs');
    const pres = new PptxGenJS();
    pres.title = options.title;
    pres.author = 'DeepSeno';
    pres.layout = 'LAYOUT_16x9';

    // Run the LLM-generated code with pres in scope
    const fn = new Function('pres', cleanCode);
    fn(pres);

    // Write file
    fs.mkdirSync(outputDir, { recursive: true });
    const fname = (options.filename || options.title.replace(/[^\w\u4e00-\u9fff]/g, '_')).replace(/\.pptx$/i, '') + '.pptx';
    const filePath = path.join(outputDir, fname);
    await pres.writeFile({ fileName: filePath });

    console.log(`[PptxGenerator] Cloud-generated: ${filePath}`);
    return filePath;
  } catch (err: any) {
    console.warn(`[PptxGenerator] Cloud generation failed: ${err.message}, falling back to template`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Local fallback: fixed professional template
// ────────────────────────────────────────────────────────────────

function generateWithTemplate(options: PptxOptions, outputDir: string): Promise<string> {
  const PptxGenJS = require('pptxgenjs');

  // Palette
  const isBusiness = options.style !== 'casual';
  const P = isBusiness
    ? { primary: '1E2761', secondary: 'CADCFC', accent: 'FFFFFF', text: '1E2761', muted: '6B7B8D', hFont: 'Georgia', bFont: 'Calibri' }
    : { primary: '36454F', secondary: 'F2F2F2', accent: '212121', text: '36454F', muted: '808080', hFont: 'Arial Black', bFont: 'Calibri' };

  const pptx = new PptxGenJS();
  pptx.title = options.title;
  pptx.author = 'DeepSeno';
  pptx.layout = 'LAYOUT_16x9';
  const W = 10, H = 5.625, M = 0.6;

  // Title slide (dark)
  const ts = pptx.addSlide();
  ts.background = { color: P.primary };
  ts.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.15, h: H, fill: { color: P.secondary } });
  ts.addText(options.title, {
    x: M + 0.3, y: 1.5, w: W - M * 2, h: 1.5,
    fontSize: 40, bold: true, color: P.accent, fontFace: P.hFont, margin: 0,
  });
  ts.addText(options.subtitle || new Date().toLocaleDateString('zh-CN'), {
    x: M + 0.3, y: 3.2, w: W - M * 2, h: 0.6,
    fontSize: 16, color: P.secondary, fontFace: P.bFont, margin: 0,
  });
  ts.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.08, w: W, h: 0.08, fill: { color: P.secondary } });

  // Content slides (light)
  for (let i = 0; i < options.slides.length; i++) {
    const slide = options.slides[i];
    const cs = pptx.addSlide();
    cs.background = { color: 'FAFAFA' };
    cs.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.08, h: H, fill: { color: P.primary } });
    cs.addText(`${i + 2}`, {
      x: W - 1, y: H - 0.5, w: 0.5, h: 0.3,
      fontSize: 10, color: P.muted, align: 'right', fontFace: P.bFont, margin: 0,
    });
    cs.addText(slide.title, {
      x: M, y: 0.35, w: W - M * 2, h: 0.6,
      fontSize: 22, bold: true, color: P.primary, fontFace: P.hFont, margin: 0,
    });
    cs.addShape(pptx.ShapeType.rect, { x: M, y: 1.05, w: 1.5, h: 0.04, fill: { color: P.secondary } });
    if (slide.bullets.length > 0) {
      cs.addText(
        slide.bullets.map((b: string) => ({
          text: b,
          options: { bullet: true, breakLine: true, color: P.text, fontFace: P.bFont },
        })),
        { x: M, y: 1.3, w: W - M * 2, h: H - 2.0, fontSize: 14, lineSpacingMultiple: 1.5, valign: 'top', margin: 0 },
      );
    }
  }

  // Closing slide (dark)
  const es = pptx.addSlide();
  es.background = { color: P.primary };
  es.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.15, h: H, fill: { color: P.secondary } });
  es.addText('谢谢', {
    x: M, y: 1.8, w: W - M * 2, h: 1.2,
    fontSize: 44, bold: true, color: P.accent, fontFace: P.hFont, align: 'center', margin: 0,
  });
  es.addText(options.title, {
    x: M, y: 3.3, w: W - M * 2, h: 0.5,
    fontSize: 14, color: P.secondary, fontFace: P.bFont, align: 'center', margin: 0,
  });
  es.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.08, w: W, h: 0.08, fill: { color: P.secondary } });

  // Write
  fs.mkdirSync(outputDir, { recursive: true });
  const fname = (options.filename || options.title.replace(/[^\w\u4e00-\u9fff]/g, '_')).replace(/\.pptx$/i, '') + '.pptx';
  const filePath = path.join(outputDir, fname);
  return pptx.writeFile({ fileName: filePath }).then(() => {
    console.log(`[PptxGenerator] Template-generated: ${filePath}`);
    return filePath;
  });
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export interface GenerateContext {
  llmClient?: LLMClient;
  model?: string;
}

/**
 * Generate a PPTX file.
 * If a cloud LLM client + model are provided, uses cloud-powered custom generation.
 * Otherwise falls back to the fixed professional template.
 */
export async function generatePptx(
  options: PptxOptions,
  outputDir: string,
  ctx?: GenerateContext,
): Promise<string> {
  // Try cloud-powered generation if available
  if (ctx?.llmClient && ctx?.model) {
    const result = await generateWithCloudLLM(options, outputDir, ctx.llmClient, ctx.model);
    if (result) return result;
  }

  // Fallback to template
  return generateWithTemplate(options, outputDir);
}
