import { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import { loadSettings } from '../settings';
import { getEmbedModel } from '../llm/create-client';
import { formatLocalDate } from '../utils/date';
import { transaction } from '../db/sqlite-util';

interface ScoredMemory {
  id: number;
  fact: string;
  layer: string;
  confidence: number;
  last_seen: string;
  score: number;
}

export class MemoryManager {
  constructor(
    private db: VoiceBrainDB,
    private llmClient: LLMClient,
    private embedClient?: LLMClient,
  ) {}

  // ─── Existing: addFact (unchanged) ───────────────────────

  /**
   * Add a new fact, automatically detecting conflicts via embedding similarity.
   * If a highly similar memory exists (>0.85), the old one is superseded.
   */
  async addFact(fact: string, category: string, confidence: number, sourceIds: number[]): Promise<number> {
    const settings = loadSettings();
    const embedModel = getEmbedModel(settings);

    // 1. Embed the new fact outside the transaction (async I/O)
    const client = this.embedClient || this.llmClient;
    const embedding = await client.embed(embedModel, fact);
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // 2. Synchronous transaction for atomicity — uses IMMEDIATE lock,
    //    serializing concurrent addFact() calls so two calls cannot both
    //    pass the conflict check and insert duplicates.
    const doInsert = transaction(this.db.getRawDb(), () => {
      // Search existing active memories for conflicts (inside transaction)
      const existing = this.db.getActiveMemories(500);
      let bestMatch: { id: number; similarity: number } | null = null;

      for (const mem of existing) {
        if (mem.embedding) {
          const memEmbedding = this.bufferToArray(mem.embedding);
          const sim = this.cosineSimilarity(embedding, memEmbedding);
          if (sim > 0.85 && (!bestMatch || sim > bestMatch.similarity)) {
            bestMatch = { id: mem.id, similarity: sim };
          }
        }
      }

      // If high-similarity match found, supersede the old memory
      if (bestMatch) {
        const newId = this.db.insertMemory({ fact, category, layer: 'active', confidence, sourceIds });
        this.db.updateMemoryEmbedding(newId, embeddingBuffer);
        this.db.supersedeMemory(bestMatch.id, newId);
        console.log(`[MemoryManager] Superseded memory #${bestMatch.id} (sim=${bestMatch.similarity.toFixed(3)}) with #${newId}`);
        return newId;
      }

      // New fact — insert directly
      const id = this.db.insertMemory({ fact, category, layer: 'active', confidence, sourceIds });
      this.db.updateMemoryEmbedding(id, embeddingBuffer);
      console.log(`[MemoryManager] Added new memory #${id}: ${fact.substring(0, 50)}`);
      return id;
    });

    return doInsert();
  }

  // ─── NEW: Query-aware hybrid retrieval ───────────────────

  /**
   * Search memories relevant to a query using hybrid retrieval:
   * 1. Vector cosine similarity (semantic)
   * 2. FTS5 keyword search (lexical)
   * 3. Reciprocal Rank Fusion (RRF) to merge results
   * 4. Time decay (exponential, half-life 14 days)
   * 5. Layer boost (core=1.5, active=1.0, archive=0.5)
   * 6. Core memories always included
   * 7. Formatted within token budget
   */
  async searchMemories(query: string, maxTokens: number = 800, precomputedEmbedding?: number[]): Promise<string> {
    // 1. Embed the query (reuse precomputed if available to avoid duplicate LLM call)
    let queryEmbedding: number[];
    if (precomputedEmbedding) {
      queryEmbedding = precomputedEmbedding;
    } else {
      const settings = loadSettings();
      const embedModel = getEmbedModel(settings);
      const client = this.embedClient || this.llmClient;
      queryEmbedding = await client.embed(embedModel, query);
    }

    // 2. Vector search: brute-force cosine on all active memories
    const allMemories = this.db.getActiveMemories(300);
    const vectorScored: ScoredMemory[] = [];

    for (const mem of allMemories) {
      if (mem.embedding) {
        const memEmbedding = this.bufferToArray(mem.embedding);
        const sim = this.cosineSimilarity(queryEmbedding, memEmbedding);
        vectorScored.push({
          id: mem.id, fact: mem.fact, layer: mem.layer,
          confidence: mem.confidence, last_seen: mem.last_seen, score: sim,
        });
      }
    }

    // 3. FTS5 keyword search
    const ftsResults = this.db.searchMemoriesFts(query, 20);

    // 4. Reciprocal Rank Fusion (RRF)
    vectorScored.sort((a, b) => b.score - a.score);
    const VECTOR_WEIGHT = 0.7;
    const BM25_WEIGHT = 0.3;
    const K = 60;

    const rrfScores = new Map<number, ScoredMemory & { rrfScore: number }>();

    for (let i = 0; i < vectorScored.length; i++) {
      const mem = vectorScored[i];
      const vectorRRF = VECTOR_WEIGHT / (K + i + 1);
      rrfScores.set(mem.id, { ...mem, rrfScore: vectorRRF });
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const fts = ftsResults[i];
      const bm25RRF = BM25_WEIGHT / (K + i + 1);
      const existing = rrfScores.get(fts.id);
      if (existing) {
        existing.rrfScore += bm25RRF;
      } else {
        const mem = allMemories.find((m) => m.id === fts.id);
        if (mem) {
          rrfScores.set(fts.id, {
            id: fts.id, fact: fts.fact, layer: mem.layer,
            confidence: mem.confidence, last_seen: mem.last_seen,
            score: 0, rrfScore: bm25RRF,
          });
        }
      }
    }

    // 5. Apply time decay and layer boost
    const finalScored = Array.from(rrfScores.values()).map((mem) => {
      const decay = mem.layer === 'core' ? 1.0 : this.timeDecay(mem.last_seen, 14);
      const layerBoost = mem.layer === 'core' ? 1.5 : mem.layer === 'active' ? 1.0 : 0.5;
      return { ...mem, finalScore: mem.rrfScore * decay * layerBoost };
    });

    finalScored.sort((a, b) => b.finalScore - a.finalScore);

    // 6. Ensure all core memories are included
    const includedIds = new Set(finalScored.map((m) => m.id));
    const coreMemories = allMemories
      .filter((m) => m.layer === 'core' && !includedIds.has(m.id))
      .map((m) => ({ id: m.id, fact: m.fact, layer: m.layer, finalScore: Infinity }));

    // 7. Format output within token budget
    const lines: string[] = [];
    let tokenEstimate = 0;

    // Core memories first (those not already in scored results)
    for (const mem of coreMemories) {
      const line = `- [core] ${mem.fact}`;
      const lineTokens = Math.ceil(line.length / 2);
      if (tokenEstimate + lineTokens > maxTokens) break;
      lines.push(line);
      tokenEstimate += lineTokens;
    }

    // Then scored results (which may include core memories ranked by relevance)
    for (const mem of finalScored) {
      const line = `- [${mem.layer}] ${mem.fact}`;
      const lineTokens = Math.ceil(line.length / 2);
      if (tokenEstimate + lineTokens > maxTokens) break;
      lines.push(line);
      tokenEstimate += lineTokens;
    }

    return lines.length > 0 ? `## 已知信息\n${lines.join('\n')}` : '';
  }

  // ─── Existing: static retrieval (backward compat) ────────

  /**
   * Get relevant memories formatted as text, within a token budget.
   * Core memories first, then active by confidence.
   */
  getRelevantMemories(maxTokens: number = 800): string {
    const memories = this.db.getActiveMemories(100);
    if (memories.length === 0) return '';

    const lines: string[] = [];
    let tokenEstimate = 0;

    for (const mem of memories) {
      const line = `- [${mem.layer}] ${mem.fact}`;
      const lineTokens = Math.ceil(line.length / 2); // rough estimate: 1 token ~ 2 chars for Chinese
      if (tokenEstimate + lineTokens > maxTokens) break;
      lines.push(line);
      tokenEstimate += lineTokens;
    }

    return lines.length > 0 ? `## 已知信息\n${lines.join('\n')}` : '';
  }

  // ─── Existing: decayStaleMemories (unchanged) ────────────

  /**
   * Decay stale memories: archive active memories not seen in 30 days.
   * Returns the number of memories archived.
   */
  decayStaleMemories(): number {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = formatLocalDate(thirtyDaysAgo);

    const active = this.db.getActiveMemories(1000).filter(
      (m) => m.layer === 'active' && m.last_seen < cutoff
    );

    for (const mem of active) {
      this.db.promoteMemory(mem.id, 'archive');
    }

    if (active.length > 0) {
      console.log(`[MemoryManager] Decayed ${active.length} stale memories to archive`);
    }
    return active.length;
  }

  // ─── Private helpers ─────────────────────────────────────

  /**
   * Exponential time decay with configurable half-life.
   * Returns 1.0 for today, ~0.5 at halfLifeDays, ~0.25 at 2*halfLifeDays.
   */
  private timeDecay(lastSeen: string, halfLifeDays: number = 14): number {
    const lastSeenDate = new Date(lastSeen + 'T00:00:00');
    const daysSince = (Date.now() - lastSeenDate.getTime()) / (1000 * 86400);
    if (daysSince <= 0) return 1.0;
    return Math.exp(-0.693 * daysSince / halfLifeDays);
  }

  /**
   * Convert a Buffer containing Float32 data to a number array.
   */
  private bufferToArray(embedding: Buffer): number[] {
    return Array.from(new Float32Array(
      embedding.buffer || embedding,
      embedding.byteOffset || 0,
      (embedding.byteLength || embedding.length) / 4
    ));
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
