import { loadSettings } from '../settings';

export interface SoulContext {
  soul: string;
  rules: string;
}

export function loadSoulContext(): SoulContext {
  const settings = loadSettings();
  return {
    soul: settings.soulConfig || '',
    rules: settings.agentsRules || '',
  };
}

export function buildSoulSystemPrompt(soul: SoulContext): string {
  const parts: string[] = [];
  if (soul.soul.trim()) {
    parts.push(`## 用户画像\n${soul.soul.trim()}`);
  }
  if (soul.rules.trim()) {
    parts.push(`## 处理规则\n${soul.rules.trim()}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}
