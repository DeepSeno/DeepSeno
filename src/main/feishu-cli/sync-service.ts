import type { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import type { VectorStore } from '../rag/vector-store';
import { loadSettings } from '../settings';
import { ExternalSourceSyncService } from '../external-sources/sync-service';
import type { SyncResult } from '../external-sources/types';

export class FeishuSyncService {
  private externalSync: ExternalSourceSyncService;

  constructor(db: VoiceBrainDB, vectorStore?: VectorStore, embedClient?: LLMClient) {
    this.externalSync = new ExternalSourceSyncService(db, vectorStore, embedClient);
  }

  async syncAll(domains?: string[]): Promise<SyncResult> {
    const selected = domains && domains.length > 0 ? domains : this.getConfiguredDomains();
    return this.externalSync.sync('feishu-cli', selected);
  }

  async syncCalendar(): Promise<SyncResult> {
    return this.externalSync.sync('feishu-cli', ['calendar']);
  }

  async syncTasks(): Promise<SyncResult> {
    return this.externalSync.sync('feishu-cli', ['task']);
  }

  async syncDocs(): Promise<SyncResult> {
    return this.externalSync.sync('feishu-cli', ['doc']);
  }

  private getConfiguredDomains(): string[] {
    const settings = loadSettings();
    const raw = (settings as any).feishuCliSyncScopes || 'calendar,task,doc';
    return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
}
