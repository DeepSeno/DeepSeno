/**
 * Shared style constants for document generation (PPTX, DOCX, PDF).
 * Two presets: business (formal) and casual (internal notes).
 */

export interface DocStyle {
  primaryColor: string;
  accentColor: string;
  textColor: string;
  subtextColor: string;
  lightBg: string;
  headerBg: string;
  fontTitle: string;
  fontBody: string;
  pptxTitleSize: number;
  pptxSlideTitle: number;
  pptxBody: number;
  pptxSubtitle: number;
  docxTitle: number;
  docxH1: number;
  docxH2: number;
  docxH3: number;
  docxBody: number;
  docxLineSpacing: number;
}

export const BUSINESS: DocStyle = {
  primaryColor: '1a365d',
  accentColor: 'd4a843',
  textColor: '1a1a2e',
  subtextColor: '6b7280',
  lightBg: 'f8f9fa',
  headerBg: '1a365d',
  fontTitle: 'Microsoft YaHei',
  fontBody: 'Microsoft YaHei',
  pptxTitleSize: 36,
  pptxSlideTitle: 22,
  pptxBody: 14,
  pptxSubtitle: 16,
  docxTitle: 52,
  docxH1: 36,
  docxH2: 30,
  docxH3: 26,
  docxBody: 21,
  docxLineSpacing: 360,
};

export const CASUAL: DocStyle = {
  primaryColor: '3f3f46',
  accentColor: '64748b',
  textColor: '27272a',
  subtextColor: '71717a',
  lightBg: 'fafafa',
  headerBg: '3f3f46',
  fontTitle: 'Microsoft YaHei',
  fontBody: 'Microsoft YaHei',
  pptxTitleSize: 36,
  pptxSlideTitle: 22,
  pptxBody: 14,
  pptxSubtitle: 16,
  docxTitle: 52,
  docxH1: 36,
  docxH2: 30,
  docxH3: 26,
  docxBody: 21,
  docxLineSpacing: 360,
};

export function getStyle(style?: string): DocStyle {
  return style === 'casual' ? CASUAL : BUSINESS;
}
