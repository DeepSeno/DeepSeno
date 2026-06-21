import type { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import { formatLocalDate } from '../utils/date';

export interface CompactionResult {
  decayed: number;
  merged: number;
  purged: number;
}

export class MemoryCompactor {
  constructor(
    private db: VoiceBrainDB,
    private llmClient: LLMClient,
    private llmModel: string,
    private embedModel: string,
    private embedClient?: LLMClient,
  ) {}

  /**
   * Run all compaction steps. Returns a summary of actions taken.
   */
  async compact(): Promise<CompactionResult> {
    const result: CompactionResult = {
      decayed: 0,
      merged: 0,
      purged: 0,
    };

    // 1. Decay stale memories (30 days inactive -> archive)
    result.decayed = this.decayStaleMemories();

    // 2. Merge duplicate/overlapping memories in active layer
    result.merged = await this.mergeDuplicates();

    // 3. Purge excess: if active layer > 500, archive lowest confidence
    result.purged = this.purgeExcess(500);

    console.log(
      `[MemoryCompactor] Compaction done: decayed=${result.decayed}, merged=${result.merged}, purged=${result.purged}`,
    );
    return result;
  }

  /**
   * Decay active memories not seen in 30 days -> archive.
   */
  private decayStaleMemories(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = formatLocalDate(cutoff);

    const active = this.db.getMemoriesByLayer('active');
    const stale = active.filter((m) => m.last_seen < cutoffStr);

    for (const mem of stale) {
      this.db.promoteMemory(mem.id, 'archive');
    }
    return stale.length;
  }

  /**
   * Find memories with very similar embeddings in the active layer,
   * then use LLM to merge them into one consolidated fact.
   */
  private async mergeDuplicates(): Promise<number> {
    const memories = this.db.getActiveMemories(300);
    const merged = new Set<number>();
    let mergeCount = 0;

    // Pre-compute embeddings to avoid repeated buffer conversions in O(n²) loop
    const embeddings = new Map<number, number[]>();
    for (const mem of memories) {
      if (mem.embedding) {
        embeddings.set(mem.id, this.bufferToArray(mem.embedding));
      }
    }

    for (let i = 0; i < memories.length; i++) {
      if (merged.has(memories[i].id)) continue;
      const embI = embeddings.get(memories[i].id);
      if (!embI) continue;

      const cluster: typeof memories = [memories[i]];

      for (let j = i + 1; j < memories.length; j++) {
        if (merged.has(memories[j].id)) continue;
        const embJ = embeddings.get(memories[j].id);
        if (!embJ) continue;

        const sim = this.cosineSimilarity(embI, embJ);

        if (sim > 0.8) {
          // Lower threshold than conflict detection (0.85) for finding related facts
          cluster.push(memories[j]);
        }
      }

      if (cluster.length >= 2) {
        // Use LLM to merge cluster into one consolidated fact
        try {
          const consolidatedFact = await this.consolidateCluster(cluster);
          const bestConfidence = Math.max(...cluster.map((m) => m.confidence));
          const allSourceIds = [
            ...new Set(
              cluster.flatMap((m) => {
                try {
                  return JSON.parse(m.source_ids || '[]');
                } catch {
                  return [];
                }
              }),
            ),
          ];

          const newId = this.db.insertMemory({
            fact: consolidatedFact,
            category: cluster[0].category,
            layer: 'active',
            confidence: bestConfidence,
            sourceIds: allSourceIds,
          });

          // Embed the consolidated fact (always use local Local for embeddings)
          const client = this.embedClient || this.llmClient;
          const embedding = await client.embed(this.embedModel, consolidatedFact);
          this.db.updateMemoryEmbedding(newId, Buffer.from(new Float32Array(embedding).buffer));

          // Supersede all old memories
          for (const mem of cluster) {
            this.db.supersedeMemory(mem.id, newId);
            merged.add(mem.id);
          }
          mergeCount += cluster.length;
        } catch (err) {
          console.warn('[MemoryCompactor] Failed to merge cluster:', err);
        }
      }
    }
    return mergeCount;
  }

  /**
   * Use LLM to consolidate a cluster of related facts into one.
   */
  private async consolidateCluster(cluster: any[]): Promise<string> {
    const facts = cluster.map((m) => `- ${m.fact}`).join('\n');
    const prompt = `以下是几条相关的事实记忆，请将它们合并为一条简洁完整的事实：\n\n${facts}\n\n合并后的事实（只输出一句话）：`;
    const result = await this.llmClient.generate({
      model: this.llmModel,
      prompt,
      temperature: 0.1,
      think: false,
    });
    return result.trim();
  }

  /**
   * If active layer exceeds maxCount, archive lowest confidence memories.
   */
  private purgeExcess(maxCount: number): number {
    const active = this.db.getMemoriesByLayer('active');
    if (active.length <= maxCount) return 0;

    // Sort by confidence ascending (lowest first)
    const sorted = [...active].sort((a, b) => a.confidence - b.confidence);
    const excess = sorted.slice(0, active.length - maxCount);

    for (const mem of excess) {
      this.db.promoteMemory(mem.id, 'archive'); // Archive instead of delete — preservable
    }
    return excess.length;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private bufferToArray(buf: any): number[] {
    try {
      return Array.from(
        new Float32Array(buf.buffer || buf, buf.byteOffset || 0, (buf.byteLength || buf.length) / 4),
      );
    } catch {
      return [];
    }
  }
}
