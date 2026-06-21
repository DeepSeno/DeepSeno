import { createHash } from 'crypto';
import type { QueryAnalysis } from '../rag/query-analyzer';

interface CacheEntry {
  analysis: QueryAnalysis;
  expiresAt: number;
}

/**
 * LRU cache for QueryAnalyzer results.
 *
 * Keyed on (model, question, historyHash) — same question with different
 * conversation history may resolve pronouns differently, so history is
 * part of the key. Mirrors EmbeddingCache's insertion-order LRU behavior.
 */
export class QueryAnalysisCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 200, ttlMs = 30 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Stable hash of recent history turns. Empty string when no history. */
  static hashHistory(history?: Array<{ role: string; content: string }>): string {
    if (!history || history.length === 0) return '';
    const tail = history.slice(-6);
    const joined = tail.map((h) => `${h.role}:${h.content}`).join('\n');
    return createHash('md5').update(joined).digest('hex');
  }

  private key(model: string, question: string, historyHash: string): string {
    return createHash('md5').update(`${model}|${question}|${historyHash}`).digest('hex');
  }

  get(model: string, question: string, historyHash: string): QueryAnalysis | undefined {
    const k = this.key(model, question, historyHash);
    const entry = this.cache.get(k);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return undefined;
    }
    // Touch for LRU.
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.analysis;
  }

  set(model: string, question: string, historyHash: string, analysis: QueryAnalysis): void {
    const k = this.key(model, question, historyHash);
    if (this.cache.size >= this.maxSize && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(k, { analysis, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
