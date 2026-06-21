import { loadSettings } from '../settings';
import type { PipelinePrompts } from '../settings';

// ─── Default Prompts (Chinese) ───────────────────────────────

const ZH_PROMPTS: Omit<PipelinePrompts, 'textClean' | 'dailySummary'> & { textClean: string; dailySummary: string } = {
  textClean: '', // textClean uses its own DEFAULT_CLEAN_PROMPT in text-optimizer.ts

  imageAnalysis: `仔细分析这张图片，输出一个 JSON 对象，包含以下字段：
1. "description": 详细描述你看到的内容（2-4句话）
2. "ocr_text": 图中所有可见文字和数字，原样转录。没有文字则为空字符串。

仅输出合法 JSON，不要用 markdown 代码块包裹。`,

  videoAnalysis: `分析这些视频关键帧，输出一个 JSON 对象，包含以下字段：
1. "scene_description": 视频内容的整体描述（2-4句话）
2. "ocr_text": 帧中可见的**关键文字**（标题、按钮、标签等），最多200字。如果是代码/终端截图，只描述语言和大致内容，不要逐行转录代码。没有文字则为空字符串。

仅输出合法 JSON，不要用 markdown 代码块包裹。总输出不超过500字。`,

  infoExtract: `你是一个信息提取助手。请从以下文本中提取结构化信息。所有输出必须使用简体中文。

需要提取的信息类型：
- 待办事项（todo）
- 会议安排（meeting）
- 决策记录（decision）
- 联系人信息（contact）
同时，请提取文本中提到的人物关系（如上下级、同事、客户、朋友、家人等）。

文本内容：
{{text}}

请以 JSON 格式输出，格式如下：
{
  "items": [{"type": "...", "content": "...", "due_date": "...", "related_person": "..."}],
  "relationships": [{"person1": "...", "person2": "...", "relationship": "...", "context": "..."}]
}

如果没有提取到信息，返回 {"items": [], "relationships": []}。`,

  dailySummary: '', // Complex prompt stays in text-optimizer.ts

  classify: `将以下录音转写文本分类到 1-3 个类别中：
meeting, brainstorm, planning, personal, interview, lecture, review, report, casual

文本（前500字）：
{{text}}

仅返回 JSON 数组，例如 ["meeting","planning"]。不要解释。`,

  memoryExtract: `从以下会议/对话文本中提取值得长期记住的事实信息。

提取类型：
- person: 人物信息（姓名、职位、联系方式、特征）
- business: 业务信息（目标、数字、日期、项目状态）
- preference: 用户偏好（习惯、喜好、工作方式）
- relationship: 人物关系（谁和谁的关系、合作关系）
- general: 其他重要事实

要求：
- 只提取明确陈述的事实，不推测
- 每条事实独立完整，不依赖上下文
- 忽略闲聊、寒暄、重复内容
- confidence: 1.0=明确陈述, 0.7=较确定推断, 0.5=可能

输出 JSON:
{"facts": [{"fact": "...", "category": "...", "confidence": 0.9}]}

文本：
{{text}}`,

  speakerCorrection: `你是一个对话分析专家。以下是一段语音转写文本，已标注说话人。部分说话人标注可能有误。

请根据对话语义逻辑（问答关系、称谓、话题连贯性），判断并修正说话人标注。

规则：
1. 只修正明显的说话人错误，不改变文本内容
2. 保持说话人编号不变（如"说话人 1"、"说话人 2"）
3. 输出格式与输入完全相同，每行一个 "说话人 N: 文本"
4. 如果不确定，保持原标注不变

对话内容：
{{text}}

修正后的对话（仅修改说话人标注，不改文本）：`,
};

// ─── Default Prompts (English) ───────────────────────────────

const EN_PROMPTS: typeof ZH_PROMPTS = {
  textClean: '',

  imageAnalysis: `Analyze this image thoroughly. Output a JSON object with these fields:
1. "description": A detailed description of what you see (2-4 sentences)
2. "ocr_text": ALL text and numbers visible, transcribed exactly. Empty string if none.

Return ONLY valid JSON, no markdown fences.`,

  videoAnalysis: `Analyze these video keyframes. Output a JSON object with these fields:
1. "scene_description": Overall description of what's happening in the video (2-4 sentences)
2. "ocr_text": **Key text** visible in frames (titles, buttons, labels), max 200 words. For code/terminal screenshots, only describe language and general content — do NOT transcribe code line by line. Empty string if none.

Return ONLY valid JSON, no markdown fences. Total output under 500 words.`,

  infoExtract: `You are an information extraction assistant. Extract structured information from the text below.

Types to extract:
- todo: action items
- meeting: meeting arrangements
- decision: key decisions
- contact: contact information
Also extract person relationships mentioned in the text.

Text:
{{text}}

Output JSON:
{
  "items": [{"type": "...", "content": "...", "due_date": "...", "related_person": "..."}],
  "relationships": [{"person1": "...", "person2": "...", "relationship": "...", "context": "..."}]
}

If nothing found, return {"items": [], "relationships": []}.`,

  dailySummary: '',

  classify: `Classify this recording transcript into 1-3 categories from this list:
meeting, brainstorm, planning, personal, interview, lecture, review, report, casual

Transcript (first 500 chars):
{{text}}

Return ONLY a JSON array of category strings, e.g. ["meeting","planning"]. No explanation.`,

  memoryExtract: `Extract long-term memorable facts from the following meeting/conversation text.

Types:
- person: people info (name, role, contact, traits)
- business: business info (goals, numbers, dates, project status)
- preference: user preferences (habits, likes, work style)
- relationship: people relationships
- general: other important facts

Rules:
- Only extract explicitly stated facts, no speculation
- Each fact should be self-contained
- Skip small talk and repetition
- confidence: 1.0=explicit, 0.7=fairly certain, 0.5=possible

Output JSON:
{"facts": [{"fact": "...", "category": "...", "confidence": 0.9}]}

Text:
{{text}}`,

  speakerCorrection: `You are a conversation analysis expert. Below is a voice transcription with speaker labels. Some labels may be incorrect.

Based on dialog semantics (Q&A patterns, forms of address, topic continuity), correct speaker attribution errors.

Rules:
1. Only fix obvious speaker errors, do not change the text content
2. Keep speaker numbering unchanged (e.g., "Speaker 1", "Speaker 2")
3. Output format must match input exactly, one line per segment: "Speaker N: text"
4. If uncertain, keep original attribution

Conversation:
{{text}}

Corrected conversation (only change speaker labels, not text):`,
};

// ─── Public API ──────────────────────────────────────────────

export function getDefaultPrompts(lang: 'zh' | 'en'): typeof ZH_PROMPTS {
  return lang === 'zh' ? ZH_PROMPTS : EN_PROMPTS;
}

/**
 * Get the effective pipeline prompt for a given key.
 * Returns user-customized prompt if set, otherwise the built-in default for current language.
 */
export function getPipelinePrompt(key: keyof PipelinePrompts, lang?: 'zh' | 'en'): string {
  const settings = loadSettings();
  const userPrompt = settings.pipelinePrompts?.[key];
  if (userPrompt) return userPrompt;
  const effectiveLang = lang || settings.language || 'zh';
  return getDefaultPrompts(effectiveLang)[key];
}
