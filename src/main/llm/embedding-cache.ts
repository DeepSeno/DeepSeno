import { createHash } from 'crypto';

interface CacheEntry {
  embedding: number[];
  expiresAt: number;
}

/**
 * LRU cache for embedding vectors.
 * Uses Map insertion-order semantics: on hit, delete + re-insert moves the entry to the end.
 * Eviction removes the oldest (first) entry when capacity is reached.
 */
export class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 500, ttlMs = 30 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  private key(model: string, text: string): string {
    return createHash('md5').update(`${model}:${text}`).digest('hex');
  }

  get(model: string, text: string): number[] | undefined {
    const k = this.key(model, text);
    const entry = this.cache.get(k);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return undefined;
    }
    // Move to end for LRU ordering
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.embedding;
  }

  set(model: string, text: string, embedding: number[]): void {
    const k = this.key(model, text);
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(k, { embedding, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
