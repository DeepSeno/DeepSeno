export interface TextChunk {
  text: string;
  index: number;
}

/**
 * Split text into chunks of approximately `maxChars` characters.
 * Respects paragraph boundaries — never splits mid-paragraph unless
 * a single paragraph exceeds maxChars.
 */
export function chunkText(text: string, maxChars = 512): TextChunk[] {
  if (!text.trim()) return [];

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let current = '';
  let index = 0;

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 1) > maxChars) {
      chunks.push({ text: current.trim(), index: index++ });
      current = '';
    }

    if (para.length > maxChars) {
      if (current) {
        chunks.push({ text: current.trim(), index: index++ });
        current = '';
      }
      const sentences = splitSentences(para);
      let sentBuf = '';
      for (const sent of sentences) {
        if (sentBuf && (sentBuf.length + sent.length + 1) > maxChars) {
          chunks.push({ text: sentBuf.trim(), index: index++ });
          sentBuf = '';
        }
        sentBuf += (sentBuf ? ' ' : '') + sent;
      }
      if (sentBuf) {
        chunks.push({ text: sentBuf.trim(), index: index++ });
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    chunks.push({ text: current.trim(), index: index++ });
  }

  return chunks;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
