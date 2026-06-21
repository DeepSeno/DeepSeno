/**
 * Shared hybrid search utilities: RRF merge, time decay.
 * Extracted from MemoryManager for reuse across QueryEngine and other search paths.
 */

export interface RankedItem {
  id: number;
  score: number;
}

export interface RRFSource {
  items: Array<{ id: number; rank?: number; distance?: number }>;
  weight: number;
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into one.
 * @param sources Array of ranked result lists with weights
 * @param k RRF parameter (default 60)
 * @returns Merged and sorted results by fused score (descending)
 */
export function rrfMerge(sources: RRFSource[], k: number = 60): RankedItem[] {
  const scores = new Map<number, number>();

  for (const source of sources) {
    for (let i = 0; i < source.items.length; i++) {
      const item = source.items[i];
      const prev = scores.get(item.id) || 0;
      scores.set(item.id, prev + source.weight / (k + i + 1));
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Exponential time decay factor.
 * @param lastSeenDate ISO date string (YYYY-MM-DD or full ISO)
 * @param halfLifeDays Half-life in days (default 14)
 * @returns Decay factor 0-1 (1.0 = today, 0.5 = halfLife days ago)
 */
export function timeDecay(lastSeenDate: string, halfLifeDays: number = 14): number {
  const daysSince = (Date.now() - new Date(lastSeenDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // future date = no decay
  return Math.exp(-0.693 * daysSince / halfLifeDays);
}
