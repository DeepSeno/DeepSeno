import { loadSettings } from '../settings';
import { zh } from './zh';
import { en } from './en';

export type Lang = 'zh' | 'en';

const tables: Record<Lang, Record<string, string | ((...args: any[]) => string)>> = { zh, en };

/**
 * Get a localized string by key. If no lang is provided, reads from settings.
 * For function-type strings, returns the function — caller must invoke with args.
 */
export function getStr(key: string, lang?: Lang): any {
  const l = lang ?? (loadSettings().language as Lang) ?? 'zh';
  return tables[l]?.[key] ?? tables.zh[key] ?? key;
}

/** Get current language from settings. */
export function getLang(): Lang {
  return (loadSettings().language as Lang) || 'zh';
}
