/**
 * LLM-based speaker assignment correction.
 * Used when embedding clustering confidence is low.
 */

import type { LLMClient } from '../llm/llm-client';
import type { DiarizeSegment } from './diarizer';

export interface SpeakerCorrectionInput {
  segments: Array<{
    start: number;
    end: number;
    speaker: string;
    text: string;
  }>;
  similarityMatrix: number[][];
  numSpeakers: number;
}

export async function correctSpeakersWithLLM(
  client: LLMClient,
  model: string,
  input: SpeakerCorrectionInput,
): Promise<DiarizeSegment[]> {
  const { segments, similarityMatrix, numSpeakers } = input;
  const n = segments.length;

  const segLines = segments
    .map(
      (s, i) =>
        `  段${i + 1} [${s.start.toFixed(2)}s-${s.end.toFixed(2)}s]: "${s.text}"`,
    )
    .join('\n');

  const simLines: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = similarityMatrix[i][j];
      const label =
        score > 0.5
          ? '很可能同一人'
          : score > 0.2
            ? '可能同一人'
            : score > -0.1
              ? '不确定'
              : '很可能不同人';
      simLines.push(
        `  段${i + 1}↔段${j + 1}: ${score.toFixed(3)} (${label})`,
      );
    }
  }

  const prompt = `这是一段${numSpeakers}人对话的语音分析结果。

检测到的语音段及转写文本：
${segLines}

各段之间的声纹相似度：
${simLines.join('\n')}

请分配说话人（SPEAKER_00到SPEAKER_${String(numSpeakers - 1).padStart(2, '0')}），规则：
1.【最重要】声纹相似度 >0.4 的段必须是同一人，<0.1 的段必须是不同人
2.【次要】对话逻辑辅助：问答交替、称谓、语义连贯性
3. 冲突时以声纹为准

只输出JSON数组：
[{"start": 0.0, "end": 3.5, "speaker": "SPEAKER_00", "text": "..."}]`;

  try {
    const response = await client.generate({
      model,
      prompt,
      temperature: 0.1,
      think: false,
    });

    // Parse JSON from response (handle markdown code blocks)
    let text = response.trim();
    if (text.includes('```')) {
      const parts = text.split('```');
      text = parts.length >= 2 ? parts[1] : text;
      if (text.startsWith('json')) text = text.slice(4);
      text = text.trim();
    }

    const startIdx = text.indexOf('[');
    const endIdx = text.lastIndexOf(']') + 1;
    if (startIdx >= 0 && endIdx > startIdx) {
      const corrected: Array<{ start: number; end: number; speaker: string }> =
        JSON.parse(text.slice(startIdx, endIdx));
      return corrected
        .filter(
          (item) => item.start != null && item.end != null && item.speaker,
        )
        .map((item) => ({
          start: Number(item.start),
          end: Number(item.end),
          speaker: item.speaker,
        }));
    }
  } catch (e: any) {
    console.warn(`[LLM Speaker Correction] Failed: ${e.message}`);
  }

  // Fallback: return original segments unchanged
  return segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }));
}
