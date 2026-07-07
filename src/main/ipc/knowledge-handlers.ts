import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { getKnowledgeCompiler } from './context';
import { requireId, requireString, requireEnum, ValidationError } from './validate';
import { pinyinSimilarity } from '../utils/pinyin';

function parseRecordingIds(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  } catch {
    return [];
  }
}

export function registerKnowledgeHandlers(ctx: IpcContext): void {
  // ─── knowledge:getAll ──────────────────────────────────────
  ipcMain.handle('knowledge:getAll', async (_event, type?: string) => {
    try {
      return ctx.getDb().getAllKnowledgePages(type);
    } catch {
      return [];
    }
  });

  // ─── knowledge:getBySlug ───────────────────────────────────
  ipcMain.handle('knowledge:getBySlug', async (_event, slug: string) => {
    try {
      const validSlug = requireString(slug, 'slug', 500);
      return ctx.getDb().getKnowledgePageBySlug(validSlug) ?? null;
    } catch (err: any) {
      return null;
    }
  });

  // ─── knowledge:search ─────────────────────────────────────
  ipcMain.handle('knowledge:search', async (_event, query: string, type?: string) => {
    try {
      const validQuery = requireString(query, 'query', 1000);
      const db = ctx.getDb();
      const pages = db.getAllKnowledgePages(type);

      // Direct title match (always reliable, covers short Chinese names)
      const q = validQuery.toLowerCase();
      const titleMatches = pages.filter((p: any) =>
        p.title?.toLowerCase().includes(q) || p.slug?.toLowerCase().includes(q)
      );

      // FTS full-text search (covers content & summary)
      const ftsResults = db.searchKnowledgePagesFts(validQuery, 20);
      const ftsIdSet = new Set(ftsResults.map((r) => r.id));
      const ftsMatches = pages.filter((p: any) => ftsIdSet.has(p.id));

      // Merge: title matches first, then FTS matches (deduplicated)
      const seenIds = new Set<number>();
      const merged: any[] = [];
      for (const p of titleMatches) {
        if (!seenIds.has(p.id)) { seenIds.add(p.id); merged.push(p); }
      }
      for (const p of ftsMatches) {
        if (!seenIds.has(p.id)) { seenIds.add(p.id); merged.push(p); }
      }
      return merged;
    } catch {
      return [];
    }
  });

  // ─── knowledge:getLinks ────────────────────────────────────
  ipcMain.handle('knowledge:getLinks', async (_event, pageId: number) => {
    try {
      const validId = requireId(pageId, 'pageId');
      return ctx.getDb().getKnowledgeLinks(validId);
    } catch {
      return [];
    }
  });

  // ─── knowledge:getBacklinks ────────────────────────────────
  ipcMain.handle('knowledge:getBacklinks', async (_event, pageId: number) => {
    try {
      const validId = requireId(pageId, 'pageId');
      return ctx.getDb().getKnowledgeBacklinks(validId);
    } catch {
      return [];
    }
  });

  // ─── knowledge:create ──────────────────────────────────────
  ipcMain.handle('knowledge:create', async (_event, data: { slug: string; type: string; title: string; content?: string }) => {
    try {
      const slug = requireString(data.slug, 'slug', 500);
      const type = requireString(data.type, 'type', 50);
      const title = requireString(data.title, 'title', 500);
      const content = data.content || '';
      const db = ctx.getDb();

      // Check if slug already exists
      const existing = db.getKnowledgePageBySlug(slug);
      if (existing) {
        return { id: existing.id, slug: existing.slug, existed: true };
      }

      const id = db.insertKnowledgePage(slug, type, title, content);
      return { id, slug, existed: false };
    } catch (err: any) {
      return { error: err.message || 'Failed to create knowledge page' };
    }
  });

  // ─── knowledge:getGraph ────────────────────────────────────
  ipcMain.handle('knowledge:getGraph', async () => {
    try {
      return ctx.getDb().getKnowledgeGraph();
    } catch {
      return { nodes: [], edges: [] };
    }
  });

  // ─── knowledge:getQueueStatus ──────────────────────────────
  ipcMain.handle('knowledge:getQueueStatus', async () => {
    try {
      return ctx.getDb().getCompilationQueueStatus();
    } catch {
      return { pending: 0, processing: 0 };
    }
  });

  // ─── knowledge:getQueueEntries ─────────────────────────────
  // Detailed list (recording name + status + timing + error) for the queue panel.
  ipcMain.handle('knowledge:getQueueEntries', async () => {
    try {
      return ctx.getDb().getCompilationQueueEntries(50);
    } catch {
      return [];
    }
  });

  // ─── knowledge:clearStuckQueue ─────────────────────────────
  // Manual recovery: remove stuck ('processing') and failed entries.
  ipcMain.handle('knowledge:clearStuckQueue', async () => {
    try {
      const removed = ctx.getDb().clearStuckCompilationEntries();
      return { success: true, removed };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  });

  // ─── knowledge:getStats ────────────────────────────────────
  ipcMain.handle('knowledge:getStats', async () => {
    try {
      return ctx.getDb().getKnowledgeStats();
    } catch {
      return { total: 0, person: 0, topic: 0, project: 0, concept: 0 };
    }
  });

  // ─── knowledge:recompile ───────────────────────────────────
  // Re-enqueue ONLY the recordings that contributed to this specific page
  // (sourced from page.source_recording_ids). Previously this enqueued every
  // completed recording, which was equivalent to compileAll — a major scope bug.
  ipcMain.handle('knowledge:recompile', async (_event, pageId: number) => {
    try {
      const validId = requireId(pageId, 'pageId');
      const compiler = getKnowledgeCompiler();
      if (!compiler) {
        return { success: false, error: 'KnowledgeCompiler not initialized' };
      }
      const db = ctx.getDb();
      const page = db.getKnowledgePage(validId);
      if (!page) {
        return { success: false, error: `Knowledge page ${validId} not found` };
      }

      let sourceIds: number[] = [];
      try {
        const parsed = JSON.parse(page.source_recording_ids || '[]');
        if (Array.isArray(parsed)) {
          sourceIds = parsed.filter((n) => typeof n === 'number' && Number.isFinite(n));
        }
      } catch { /* fall through with empty */ }

      let enqueued = 0;
      for (const recId of sourceIds) {
        compiler.enqueue(recId, 1); // priority 1 (above default 0)
        enqueued++;
      }
      return { success: true, enqueued };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:compileRecording ────────────────────────────
  ipcMain.handle('knowledge:compileRecording', async (_event, recordingId: number) => {
    try {
      const validId = requireId(recordingId, 'recordingId');
      const compiler = getKnowledgeCompiler();
      if (!compiler) {
        return { success: false, error: 'KnowledgeCompiler not initialized' };
      }
      compiler.enqueue(validId, 1);
      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:updateContent ──────────────────────────────
  ipcMain.handle('knowledge:updateContent', async (_event, pageId: number, content: string) => {
    try {
      const validId = requireId(pageId, 'pageId');
      const validContent = requireString(content, 'content', 500_000);
      // Fetch current page to preserve existing summary and source ids
      const page = ctx.getDb().getKnowledgePage(validId);
      ctx.getDb().updateKnowledgePageContent(
        validId,
        validContent,
        page?.summary ?? '',
        page?.source_segment_ids ? JSON.parse(page.source_segment_ids) : [],
        page?.source_recording_ids ? JSON.parse(page.source_recording_ids) : [],
      );
      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:delete ───────────────────────────────────
  ipcMain.handle('knowledge:delete', async (_event, pageId: number) => {
    try {
      const validId = requireId(pageId, 'pageId');
      const db = ctx.getDb();
      const page = db.getKnowledgePage(validId);
      if (!page) return { success: false, error: 'Page not found' };

      // Delete links (both directions)
      db.deleteKnowledgeLinksFrom(validId);
      db.deleteKnowledgeLinksTo(validId);

      // Delete vector
      try { ctx.getVectorStore().deletePageVector(validId); } catch { /* ignore */ }

      // Delete page (FTS triggers handle knowledge_pages_fts cleanup)
      db.deleteKnowledgePage(validId);

      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) return { success: false, error: err.message };
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:batchDelete ──────────────────────────────
  ipcMain.handle('knowledge:batchDelete', async (_event, pageIds: number[]) => {
    try {
      if (!Array.isArray(pageIds) || pageIds.length === 0) {
        return { success: false, error: 'pageIds must be a non-empty array' };
      }
      const db = ctx.getDb();
      const vs = ctx.getVectorStore();
      let deleted = 0;
      for (const rawId of pageIds) {
        const id = requireId(rawId, 'pageId');
        db.deleteKnowledgeLinksFrom(id);
        db.deleteKnowledgeLinksTo(id);
        try { vs.deletePageVector(id); } catch { /* ignore */ }
        db.deleteKnowledgePage(id);
        deleted++;
      }
      return { success: true, deleted };
    } catch (err: any) {
      if (err instanceof ValidationError) return { success: false, error: err.message };
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:renamePage ───────────────────────────────
  ipcMain.handle('knowledge:renamePage', async (_event, pageId: number, newTitle: string, newType: string) => {
    try {
      const validId = requireId(pageId, 'pageId');
      const validTitle = requireString(newTitle, 'newTitle', 500);
      const validType = requireEnum(newType, ['person', 'topic', 'project', 'concept'], 'newType');
      const db = ctx.getDb();
      const page = db.getKnowledgePage(validId);
      if (!page) return { success: false, error: 'Page not found' };

      const oldSlug = page.slug;
      const oldTitle = page.title;
      const newSlug = `${validType}/${validTitle}`;

      // Check for slug conflict
      if (oldSlug !== newSlug) {
        const existing = db.getKnowledgePageBySlug(newSlug);
        if (existing) return { success: false, error: 'A page with this title and type already exists' };
      }

      // Rename the page
      db.renameKnowledgePage(validId, validTitle, validType);

      // Cascade: update [[oldSlug]] → [[newSlug]] in all other pages' content
      if (oldSlug !== newSlug) {
        // Bulk SQL UPDATE instead of loading all pages into memory
        db.bulkUpdateKnowledgeSlugReferences(oldSlug, newSlug, validId);

        // Add correction dictionary entry (old title → new title)
        if (oldTitle !== validTitle) {
          db.insertCorrection(oldTitle, validTitle, 'person_name', 'auto_learned');
        }
      }

      return { success: true, newSlug };
    } catch (err: any) {
      if (err instanceof ValidationError) return { success: false, error: err.message };
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:editContent ──────────────────────────────
  ipcMain.handle('knowledge:editContent', async (_event, pageId: number, content: string) => {
    try {
      const validId = requireId(pageId, 'pageId');
      const validContent = requireString(content, 'content', 500_000);
      ctx.getDb().updateKnowledgePageContentOnly(validId, validContent);

      // Re-process cross-references
      const compiler = getKnowledgeCompiler();
      if (compiler) compiler.updateCrossReferences(validId);

      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) return { success: false, error: err.message };
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:compileAll ─────────────────────────────────
  // Find all completed recordings that haven't been knowledge-compiled yet and enqueue them.
  // Re-enqueuing already compiled recordings with unchanged source data makes page counts drift
  // because entity extraction is LLM-based; this handler is intentionally idempotent.
  ipcMain.handle('knowledge:compileAll', async () => {
    try {
      const compiler = getKnowledgeCompiler();
      if (!compiler) {
        return { success: false, error: 'KnowledgeCompiler not initialized' };
      }
      const db = ctx.getDb();
      const recordings = db.getRecordingsByStatus('completed');
      const compiledRecordingIds = new Set<number>();
      for (const page of db.getAllKnowledgePages()) {
        for (const id of parseRecordingIds(page.source_recording_ids)) {
          compiledRecordingIds.add(id);
        }
      }
      const activeRecordingIds = new Set<number>();
      for (const entry of db.getCompilationQueueEntries(10_000)) {
        if (entry.status === 'pending' || entry.status === 'processing') {
          activeRecordingIds.add(entry.recording_id);
        }
      }
      let enqueued = 0;
      let skipped = 0;
      for (const rec of recordings) {
        if (compiledRecordingIds.has(rec.id) || activeRecordingIds.has(rec.id)) {
          skipped++;
          continue;
        }
        compiler.enqueue(rec.id, 0);
        enqueued++;
      }
      return { success: true, enqueued, skipped, total: recordings.length };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:mergePages ─────────────────────────────────
  ipcMain.handle('knowledge:mergePages', async (_e, sourcePageIds: number[], targetPageId: number) => {
    try {
      if (!Array.isArray(sourcePageIds) || sourcePageIds.length === 0) {
        return { success: false, error: 'sourcePageIds must be a non-empty array' };
      }
      const validTargetId = requireId(targetPageId, 'targetPageId');
      const validSourceIds = [...new Set(sourcePageIds.map((id) => requireId(id, 'sourcePageId')))]
        .filter((id) => id !== validTargetId);
      if (validSourceIds.length === 0) {
        return { success: false, error: 'Select at least one source page to merge' };
      }
      const compiler = getKnowledgeCompiler();
      if (!compiler) {
        return { success: false, error: 'KnowledgeCompiler not initialized' };
      }
      const result = await compiler.mergePages(validSourceIds, validTargetId);
      return { success: true, ...result };
    } catch (err: any) {
      if (err instanceof ValidationError) return { success: false, error: err.message };
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── knowledge:findDuplicates ─────────────────────────────
  ipcMain.handle('knowledge:findDuplicates', async () => {
    const db = ctx.getDb();
    const pages = db.getAllKnowledgePages();

    const duplicates: Array<{ pageA: any; pageB: any; similarity: number; reason: string }> = [];

    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const a = pages[i];
        const b = pages[j];
        if (a.type !== b.type) continue;

        const sim = pinyinSimilarity(a.title, b.title);
        if (sim >= 0.7) {
          duplicates.push({
            pageA: { id: a.id, slug: a.slug, title: a.title, type: a.type },
            pageB: { id: b.id, slug: b.slug, title: b.title, type: b.type },
            similarity: sim,
            reason: sim >= 0.85 ? 'pinyin_match' : 'pinyin_similar',
          });
        }
      }
    }

    return duplicates.sort((a, b) => b.similarity - a.similarity);
  });
}
