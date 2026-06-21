import { createHash } from 'crypto';
import type { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import { getEmbedModel } from '../llm/create-client';
import { loadSettings, saveSettings } from '../settings';
import type { VectorStore } from '../rag/vector-store';
import { getExternalSourceProvider } from './registry';
import type { ExternalDocument, SyncResult } from './types';

export class ExternalSourceSyncService {
  private db: VoiceBrainDB;
  private vectorStore?: VectorStore;
  private embedClient?: LLMClient;

  constructor(db: VoiceBrainDB, vectorStore?: VectorStore, embedClient?: LLMClient) {
    this.db = db;
    this.vectorStore = vectorStore;
    this.embedClient = embedClient;
  }

  async sync(source: string, domains?: string[]): Promise<SyncResult> {
    const provider = getExternalSourceProvider(source);
    const selected = domains && domains.length > 0 ? domains : provider.domains;
    let totalDocs = 0;
    let totalChunks = 0;
    const errors: string[] = [];

    await Promise.all(selected.map(async (domain) => {
      const runId = this.startSyncRun(source, domain);
      try {
        const docs = await provider.syncDomain(domain);
        const chunks = await this.upsertDocuments(docs);
        totalDocs += docs.length;
        totalChunks += chunks;
        this.finishSyncRun(runId, docs.length, chunks);
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`${domain}: ${message}`);
        this.finishSyncRun(runId, 0, 0, message);
      }
    }));

    this.updateLastSync(source);

    return {
      ok: errors.length === 0,
      documents: totalDocs,
      chunks: totalChunks,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  private async upsertDocuments(docs: ExternalDocument[]): Promise<number> {
    let chunks = 0;
    for (const doc of docs) {
      if (!doc.external_id) continue;

      const dbAny = this.db as any;
      if (dbAny.upsertExternalDocument && dbAny.upsertExternalChunk) {
        const documentId = dbAny.upsertExternalDocument(
          doc.source,
          doc.domain,
          doc.external_id,
          doc.title,
          doc.url,
          doc.metadata_json,
          doc.updated_at,
        );
        const contentHash = createHash('sha256').update(doc.content).digest('hex');
        const chunkId = dbAny.upsertExternalChunk(
          documentId,
          doc.external_id,
          doc.title,
          doc.url,
          doc.content,
          doc.metadata_json,
          contentHash,
        );
        chunks += 1;
        try {
          await this.indexChunk(chunkId, doc.content);
        } catch (embedErr: any) {
          // 向量索引失败（Local 未运行等）不影响文档入库
          console.warn('[ExternalSourceSync] indexChunk skipped:', embedErr.message);
        }
      }
    }
    return chunks;
  }

  private async indexChunk(chunkId: number, content: string): Promise<void> {
    if (!this.vectorStore || !this.embedClient || !content.trim()) return;
    const settings = loadSettings();
    const embedding = await this.embedClient.embed(getEmbedModel(settings), content);
    this.vectorStore.insertExternalChunk(chunkId, embedding);
  }

  private startSyncRun(source: string, domain: string): number {
    const dbAny = this.db as any;
    return dbAny.startExternalSyncRun ? dbAny.startExternalSyncRun(source, domain) : 0;
  }

  private finishSyncRun(runId: number, documents: number, chunks: number, error?: string): void {
    const dbAny = this.db as any;
    if (runId && dbAny.finishExternalSyncRun) {
      dbAny.finishExternalSyncRun(runId, documents, chunks, error);
    }
  }

  private updateLastSync(source: string): void {
    const lastSyncAt = new Date().toISOString();
    const dbAny = this.db as any;
    if (dbAny.upsertExternalSource) {
      dbAny.upsertExternalSource(source, getExternalSourceProvider(source).displayName, 'connected', '{}');
      dbAny.updateExternalSourceLastSync(source, lastSyncAt);
    }

    if (source === 'feishu-cli') {
      const settings = loadSettings();
      (settings as any).feishuCliLastSyncAt = lastSyncAt;
      saveSettings(settings);
    }
  }
}
