import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IpcContext } from './context';
import { TextOptimizer } from '../llm/text-optimizer';
import { MarkdownGenerator } from '../output/markdown-generator';
import { loadSettings } from '../settings';
import { getLLMModel } from '../llm/create-client';
import { getDbPath, getOutputDir } from '../paths';
import type { PersonData } from '../db/database';
import { requireId, requireString, requireEnum, requireDate } from './validate';
import { formatLocalDate } from '../utils/date';

export function registerDbHandlers(ctx: IpcContext): void {
  // ─── Database - Recordings ─────────────────────────────────
  ipcMain.handle('db:getRecordings', async () => {
    try {
      return ctx.getDb().getAllRecordings();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getSegmentsByRecording', async (_event, recordingId: number) => {
    try {
      const validId = requireId(recordingId, 'recordingId');
      return ctx.getDb().getSegmentsByRecording(validId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:searchSegments', async (_event, query: string) => {
    try {
      const validQuery = requireString(query, 'query', 500);
      // Wrap in double-quotes for safe FTS5 MATCH (handles CJK, special chars)
      const safeQuery = `"${validQuery.replace(/"/g, '""')}"`;
      return ctx.getDb().searchSegments(safeQuery);
    } catch {
      return [];
    }
  });

  // ─── Database - Meeting Notes ───────────────────────────────
  ipcMain.handle('db:getMeetingNotes', async (_event, recordingId: number) => {
    const validId = requireId(recordingId, 'recordingId');
    const database = ctx.getDb();
    return database.getMeetingNotes(validId);
  });

  ipcMain.handle('db:regenerateMeetingNotes', async (_event, recordingId: number) => {
    try {
      const database = ctx.getDb();
      const segments = database.getSegmentsByRecording(recordingId);
      const recording = database.getRecording(recordingId);
      if (!segments.length || !recording) return { error: 'Recording or segments not found' };

      const settings = loadSettings();
      const client = ctx.getLLM();
      const optimizer = new TextOptimizer(client, getLLMModel(settings));
      optimizer.setVocabularyBlock(database.buildVocabularyPromptBlock(settings.vocabularyContext));

      // Document recordings don't have speaker/time data — skip meeting notes
      const isDocument = ['pdf', 'docx', 'text'].includes(recording.media_type || '');
      if (isDocument) return { error: 'Meeting notes are not available for document recordings' };

      const meetingSegments = segments.map(s => ({
        speaker: s.speaker_name || `Speaker ${s.speaker_id}`,
        startTime: s.start_time ?? 0,
        endTime: s.end_time ?? 0,
        cleanText: s.clean_text || s.raw_text || '',
      }));

      const notes = await optimizer.generateMeetingNotes(meetingSegments, {
        date: formatLocalDate(recording.recorded_at ? new Date(recording.recorded_at) : new Date()),
        duration: recording.duration_seconds || 0,
      });

      database.saveMeetingNotes(recordingId, notes);
      return notes;
    } catch (err: any) {
      console.error('[IPC] regenerateMeetingNotes failed:', err);
      return { error: err.message };
    }
  });

  // ─── Database - Auto title backfill ─────────────────────────
  // Runs sequentially in background. Returns counts; emits no progress
  // events (Dashboard fires it as fire-and-forget and re-fetches when
  // task-completed events arrive for OTHER reasons).
  ipcMain.handle('db:backfillTitles', async (_event, maxBatch?: number) => {
    const database = ctx.getDb();
    const settings = loadSettings();
    const client = ctx.getLLM();
    const optimizer = new TextOptimizer(client, getLLMModel(settings));
    optimizer.setVocabularyBlock(database.buildVocabularyPromptBlock(settings.vocabularyContext));

    const limit = Math.max(1, Math.min(maxBatch ?? 200, 500));
    const rows = database.getRecordingsNeedingTitle(limit);
    let generated = 0;
    let failed = 0;

    for (const { id } of rows) {
      try {
        const text = database.getRecordingTranscriptText(id);
        if (!text || text.length < 8) continue;
        const title = await optimizer.generateTitle(text);
        if (title) {
          database.updateRecordingAutoTitle(id, title);
          generated++;
          console.log(`[backfillTitles] #${id} → "${title}"`);
        }
        // Yield briefly so other IPC / pipeline work isn't starved.
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        failed++;
        console.warn(`[backfillTitles] #${id} failed:`, err);
      }
    }

    return { scanned: rows.length, generated, failed };
  });

  // ─── Database - TODAY curation (sessions + importance) ──────

  ipcMain.handle('db:backfillCuration', async (_event, maxBatch?: number) => {
    const database = ctx.getDb();
    const settings = loadSettings();
    const client = ctx.getLLM();
    const optimizer = new TextOptimizer(client, getLLMModel(settings));
    optimizer.setVocabularyBlock(database.buildVocabularyPromptBlock(settings.vocabularyContext));

    const limit = Math.max(1, Math.min(maxBatch ?? 200, 500));
    const rows = database.getRecordingsNeedingCuration(limit);
    let scored = 0, sessioned = 0, failed = 0;

    const { assembleSession } = await import('../rag/session-assembly');

    for (const row of rows) {
      try {
        const text = database.getRecordingTranscriptText(row.id);
        if (!text || text.length < 8) continue;
        const rec = database.getRecording(row.id);
        if (!rec) continue;

        const { score, reason } = await optimizer.scoreImportance(text, {
          durationSec: rec.duration_seconds || 0,
          speakerCount: 0,
          mediaType: rec.media_type || 'audio',
        });
        database.updateRecordingImportance(row.id, score);
        scored++;
        console.log(`[backfillCuration] #${row.id} score=${score} (${reason})`);

        if (!rec.session_id) {
          const recDate = rec.recorded_at || rec.processed_at;
          if (recDate) {
            await assembleSession(database, optimizer, {
              recordingId: row.id,
              transcript: text,
              durationSec: rec.duration_seconds || 0,
              captureScene: rec.capture_scene || 'dictation',
              date: recDate.slice(0, 10),
              recordedAt: recDate,
              mediaType: rec.media_type || 'audio',
            });
            sessioned++;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        failed++;
        console.warn(`[backfillCuration] #${row.id} failed:`, err);
      }
    }
    return { scanned: rows.length, scored, sessioned, failed };
  });

  ipcMain.handle('db:finalizeStaleSessions', async () => {
    const database = ctx.getDb();
    const settings = loadSettings();
    const optimizer = new TextOptimizer(ctx.getLLM(), getLLMModel(settings));
    const stale = database.getStaleCaptureSessions(10);
    let finalized = 0;
    for (const s of stale) {
      try {
        const members = database.getCaptureSessionMembers(s.id);
        if (members.length === 0) {
          database.updateCaptureSession(s.id, { is_finalized: 1 });
          continue;
        }
        const texts = members.map((m) => ({
          transcript: database.getRecordingTranscriptText(m.id),
          durationSec: m.duration_seconds || 0,
        }));
        const { topic, summary } = await optimizer.detectSessionTopic(texts);
        database.updateCaptureSession(s.id, { topic, summary, is_finalized: 1 });
        finalized++;
      } catch (err) {
        console.warn(`[finalizeStaleSessions] #${s.id} failed:`, err);
      }
    }
    return { stale: stale.length, finalized };
  });

  ipcMain.handle('db:getTodayCuratedItems', async (_event, date: string) => {
    return ctx.getDb().getTodayCuratedItems(date);
  });

  // ─── Database - Persons ──────────────────────────────────
  ipcMain.handle('db:getPersons', async () => {
    try {
      return ctx.getDb().getAllPersons();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getPerson', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      return ctx.getDb().getPerson(validId) || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('db:createPerson', async (_event, data: { name: string; profile_markdown?: string; avatar_path?: string; source?: string }) => {
    try {
      requireString(data.name, 'name', 200);
      const id = ctx.getDb().insertPerson({
        name: data.name,
        profile_markdown: data.profile_markdown,
        avatar_path: data.avatar_path,
        source: (data.source as 'manual' | 'auto' | 'import') ?? 'manual',
      });
      return { id };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('db:updatePerson', async (_event, id: number, data: PersonData) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().updatePerson(validId, data);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:deletePerson', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deletePerson(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:mergePersons', async (_event, fromId: number, toId: number) => {
    try {
      const validFromId = requireId(fromId, 'fromId');
      const validToId = requireId(toId, 'toId');
      ctx.getDb().mergePersons(validFromId, validToId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Database - Person Identifiers ───────────────────────
  ipcMain.handle('db:getPersonIdentifiers', async (_event, personId: number) => {
    try {
      const validId = requireId(personId, 'personId');
      return ctx.getDb().getPersonIdentifiers(validId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:addPersonIdentifier', async (_event, data: { person_id: number; type: string; value?: string; confidence?: number }) => {
    try {
      requireId(data.person_id, 'person_id');
      requireString(data.type, 'type', 50);
      if (data.value && data.value.length > 500) throw new Error('value exceeds max length 500');
      return ctx.getDb().insertPersonIdentifier({
        person_id: data.person_id,
        type: data.type,
        value: data.value || '',
        confidence: data.confidence,
      });
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('db:deletePersonIdentifier', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deletePersonIdentifier(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Database - Content-Person Links ─────────────────────
  ipcMain.handle('db:getContentByPerson', async (_event, personId: number, limit?: number) => {
    try {
      const validId = requireId(personId, 'personId');
      return ctx.getDb().getContentByPerson(validId, limit);
    } catch {
      return [];
    }
  });

  // ─── Database - Person Relationships ─────────────────────
  ipcMain.handle('db:getPersonRelationships', async (_event, personId: number) => {
    try {
      const validId = requireId(personId, 'personId');
      return ctx.getDb().getPersonRelationships(validId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getAllPersonRelationships', async () => {
    try {
      return ctx.getDb().getAllPersonRelationships();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getPersonCoOccurrences', async () => {
    try {
      return ctx.getDb().getPersonCoOccurrences();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getPersonSample', async (_event, personId: number) => {
    try {
      const validId = requireId(personId, 'personId');
      return ctx.getDb().getPersonSampleSegment(validId) || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('db:updateRecordingTitle', async (_event, id: number, title: string) => {
    try {
      const validId = requireId(id, 'recordingId');
      const validTitle = requireString(title, 'title', 200);
      ctx.getDb().updateRecordingTitle(validId, validTitle);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:updateRecordingCategory', async (_event, id: number, category: string | null) => {
    try {
      const validId = requireId(id, 'recordingId');
      ctx.getDb().updateRecordingCategory(validId, category);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:deleteRecording', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'recordingId');
      const segIds = ctx.getDb().getSegmentIdsByRecording(validId);
      if (segIds.length > 0) {
        try {
          ctx.getQueryEngine().deleteSegments(segIds);
        } catch (err) {
          console.warn('[db:deleteRecording] vector cleanup failed:', err);
        }
      }
      ctx.getDb().deleteRecording(validId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:clearAll', async () => {
    try {
      ctx.getDb().clearAllData();
    } catch {
      // Ignore errors
    }
  });

  // ─── Database - Extracted Items ────────────────────────────
  ipcMain.handle('db:getExtractedItems', async (_event, typeOrOpts?: string | { recordingId?: number; type?: string }) => {
    try {
      const database = ctx.getDb();
      if (typeof typeOrOpts === 'object' && typeOrOpts?.recordingId) {
        return database.getExtractedItemsByRecording(typeOrOpts.recordingId);
      }
      const type = typeof typeOrOpts === 'string' ? typeOrOpts : typeOrOpts?.type;
      if (type) {
        return database.getExtractedItemsByType(type);
      }
      return database.getActiveExtractedItems();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:updateExtractedItemStatus', async (_event, id: number, status: string) => {
    try {
      const validId = requireId(id, 'id');
      const validStatus = requireEnum(status, ['active', 'completed', 'cancelled', 'archived'], 'status');
      ctx.getDb().updateExtractedItemStatus(validId, validStatus);
    } catch {
      // Ignore errors
    }
  });

  ipcMain.handle('db:getAllExtractedItems', async () => {
    try {
      return ctx.getDb().getAllExtractedItems();
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:createExtractedItem', async (_event, data: { type: string; content: string; due_date?: string; related_person?: string; source?: string }) => {
    try {
      requireEnum(data.type, ['todo', 'meeting', 'decision', 'contact', 'memo', 'idea'], 'type');
      requireString(data.content, 'content', 5000);
      return ctx.getDb().insertExtractedItem({ ...data, source: data.source || 'manual' });
    } catch {
      return null;
    }
  });

  ipcMain.handle('db:updateExtractedItem', async (_event, id: number, data: { content?: string; due_date?: string; related_person?: string; status?: string; type?: string }) => {
    try {
      ctx.getDb().updateExtractedItem(id, data);
    } catch {
      // Ignore errors
    }
  });

  ipcMain.handle('db:deleteExtractedItem', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deleteExtractedItem(validId);
    } catch {
      // Ignore errors
    }
  });

  // ─── Database - Daily Summary ──────────────────────────────
  ipcMain.handle('db:getDailySummary', async (_event, date: string) => {
    try {
      const validDate = requireDate(date, 'date');
      return ctx.getDb().getDailySummary(validDate);
    } catch {
      return null;
    }
  });

  ipcMain.handle('db:getSegmentsByDate', async (_event, date: string) => {
    try {
      const validDate = requireDate(date, 'date');
      return ctx.getDb().getSegmentsByDate(validDate);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getTextNotes', async (_event, limit?: number) => {
    try {
      return ctx.getDb().getTextNotes(limit ?? 100);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getTextNoteById', async (_event, id: number) => {
    try {
      return ctx.getDb().getTextNoteById(id);
    } catch {
      return null;
    }
  });

  // ─── Summary Generation ──────────────────────────────────
  ipcMain.handle('summary:generateDaily', async (_event, date: string) => {
    const segments = ctx.getDb().getSegmentsByDate(date);
    const textNotes = ctx.getDb().getTextNotesByDate(date);

    if (segments.length === 0 && textNotes.length === 0) return { error: 'no_data' };

    const segData = segments.map((s: any) => ({
      start: s.start_time ?? 0,
      end: s.end_time ?? 0,
      speaker: s.speaker_name || 'Unknown',
      text: s.clean_text || s.raw_text || '',
    }));

    // Merge text notes: convert created_at timestamp to seconds from midnight
    for (const note of textNotes) {
      const d = new Date(note.created_at);
      const secondsFromMidnight = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      segData.push({
        start: secondsFromMidnight,
        end: secondsFromMidnight + 1,
        speaker: note.user_name || '[飞书]',
        text: note.content,
      });
    }

    // Sort by start time so timeline is chronological
    segData.sort((a, b) => a.start - b.start);

    const settings = loadSettings();
    const optimizer = new TextOptimizer(ctx.getLLM(), getLLMModel(settings));
    optimizer.setVocabularyBlock(ctx.getDb().buildVocabularyPromptBlock(settings.vocabularyContext));
    const result = await optimizer.generateDailySummary(date, segData);

    ctx.getDb().upsertDailySummary({
      date,
      summary_text: result.summary,
      timeline_json: JSON.stringify(result.timeline),
      key_events_json: JSON.stringify({ todos: result.todos, decisions: result.decisions }),
    });

    return result;
  });

  ipcMain.handle('summary:generateWeekly', async (_event, startDate: string, endDate: string) => {
    const dailySummaries = ctx.getDb().getDailySummariesInRange(startDate, endDate);
    if (dailySummaries.length === 0) return { error: 'no_data' };

    const parsed = dailySummaries.map((ds: any) => ({
      date: ds.date,
      summary: ds.summary_text || '',
      todos: ds.key_events_json ? JSON.parse(ds.key_events_json).todos || [] : [],
      decisions: ds.key_events_json ? JSON.parse(ds.key_events_json).decisions || [] : [],
    }));

    const settings = loadSettings();
    const optimizer = new TextOptimizer(ctx.getLLM(), getLLMModel(settings));
    optimizer.setVocabularyBlock(ctx.getDb().buildVocabularyPromptBlock(settings.vocabularyContext));
    const result = await optimizer.generateWeeklySummary(startDate, endDate, parsed);

    // Persist weekly summary to DB
    ctx.getDb().upsertWeeklySummary(startDate, endDate, JSON.stringify(result));

    return result;
  });

  ipcMain.handle('summary:generateMonthly', async (_event, startDate: string, endDate: string) => {
    // Monthly aggregates the month's daily summaries directly (not weekly),
    // so it works even when the weekly report is disabled.
    const dailySummaries = ctx.getDb().getDailySummariesInRange(startDate, endDate);
    if (dailySummaries.length === 0) return { error: 'no_data' };

    const parsed = dailySummaries.map((ds: any) => ({
      date: ds.date,
      summary: ds.summary_text || '',
      todos: ds.key_events_json ? JSON.parse(ds.key_events_json).todos || [] : [],
      decisions: ds.key_events_json ? JSON.parse(ds.key_events_json).decisions || [] : [],
    }));

    const settings = loadSettings();
    const optimizer = new TextOptimizer(ctx.getLLM(), getLLMModel(settings));
    optimizer.setVocabularyBlock(ctx.getDb().buildVocabularyPromptBlock(settings.vocabularyContext));
    const result = await optimizer.generateMonthlySummary(startDate, endDate, parsed);

    // Persist monthly summary to DB
    ctx.getDb().upsertMonthlySummary(startDate, endDate, JSON.stringify(result));

    return result;
  });

  ipcMain.handle('summary:getAllDaily', async () => {
    return ctx.getDb().getAllDailySummaries();
  });

  ipcMain.handle('summary:getAllWeekly', async () => {
    return ctx.getDb().getAllWeeklySummaries();
  });

  ipcMain.handle('summary:deleteWeekly', async (_event, startDate: string, endDate: string) => {
    ctx.getDb().deleteWeeklySummary(startDate, endDate);
    return { success: true };
  });

  ipcMain.handle('summary:getAllMonthly', async () => {
    return ctx.getDb().getAllMonthlySummaries();
  });

  ipcMain.handle('summary:deleteMonthly', async (_event, startDate: string, endDate: string) => {
    ctx.getDb().deleteMonthlySummary(startDate, endDate);
    return { success: true };
  });

  ipcMain.handle('summary:delete', async (_event, date: string) => {
    ctx.getDb().deleteDailySummary(date);
    return { success: true };
  });

  ipcMain.handle('summary:updateKeyEvents', async (_event, date: string, keyEventsJson: string) => {
    ctx.getDb().updateDailySummaryKeyEvents(date, keyEventsJson);
    return { success: true };
  });

  // ─── Export ──────────────────────────────────────────────
  ipcMain.handle('export:dailySummary', async (_event, date: string) => {
    const settings = loadSettings();
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir, settings.obsidianWikilinks);

    const summary = ctx.getDb().getDailySummary(date);
    if (!summary) return { error: 'no_summary' };

    const weekday = new Date(date + 'T00:00:00').toLocaleDateString('zh-CN', { weekday: 'long' });
    const timeline = summary.timeline_json ? JSON.parse(summary.timeline_json) : [];
    const keyEvents = summary.key_events_json ? JSON.parse(summary.key_events_json) : {};

    const content = mdGen.buildDailySummary({
      date,
      weekday,
      summary: summary.summary_text || '',
      timeline,
      todos: keyEvents.todos || [],
      decisions: keyEvents.decisions || [],
    });

    const filePath = mdGen.writeDailySummary(date, content);

    // Auto-sync to Obsidian vault
    if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
      try {
        MarkdownGenerator.syncToVault(outputDir, settings.obsidianVaultDir, path.join('daily', `${date}.md`));
      } catch (err) {
        console.error('[Obsidian] Failed to sync daily summary:', err);
      }
    }

    return { filePath };
  });

  ipcMain.handle('export:transcript', async (_event, recordingId: number) => {
    const settings = loadSettings();
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir, settings.obsidianWikilinks);

    const recording = ctx.getDb().getRecording(recordingId);
    if (!recording) return { error: 'no_recording' };

    const segments = ctx.getDb().getSegmentsByRecording(recordingId);
    const dateStr = formatLocalDate(recording.recorded_at ? new Date(recording.recorded_at) : new Date());

    const content = mdGen.buildTranscript({
      date: dateStr,
      title: recording.file_name.replace(/\.[^.]+$/, ''),
      captureScene: recording.capture_scene || recording.media_type || undefined,
      recordedAt: recording.recorded_at || undefined,
      segments: segments.map((s: any) => ({
        start: s.start_time ?? 0,
        end: s.end_time ?? 0,
        speaker: s.speaker_name || 'Unknown',
        text: s.raw_text || '',
        clean_text: s.clean_text || '',
      })),
    });

    const fileName = recording.file_name.replace(/\.[^.]+$/, '');
    const filePath = mdGen.writeTranscript(dateStr, fileName, content);

    // Auto-sync to Obsidian vault
    if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
      try {
        MarkdownGenerator.syncToVault(outputDir, settings.obsidianVaultDir, path.join('transcripts', dateStr, `${fileName}.md`));
      } catch (err) {
        console.error('[Obsidian] Failed to sync transcript:', err);
      }
    }

    return { filePath };
  });

  ipcMain.handle('export:meetingNotes', async (_event, recordingId: number) => {
    try {
      const database = ctx.getDb();
      const notes = database.getMeetingNotes(recordingId);
      if (!notes) return { error: 'No meeting notes found for this recording' };

      const recording = database.getRecording(recordingId);
      if (!recording) return { error: 'Recording not found' };

      const settings = loadSettings();
      const mdGen = new MarkdownGenerator(settings.outputDir || getOutputDir(), settings.obsidianWikilinks);

      const date = formatLocalDate(recording.recorded_at ? new Date(recording.recorded_at) : new Date());
      const baseName = recording.file_name.replace(/\.[^.]+$/, '');

      const content = mdGen.buildMeetingNotes({
        date,
        title: notes.title,
        duration: recording.duration_seconds || 0,
        participants: notes.participants,
        decisions: notes.decisions,
        actionItems: notes.actionItems,
        discussionSummary: notes.discussionSummary,
        keyTopics: notes.keyTopics,
      });

      const filePath = mdGen.writeMeetingNotes(date, baseName, content);

      // Also sync to Obsidian vault if configured
      if (settings.obsidianAutoExport && settings.obsidianVaultDir) {
        try {
          MarkdownGenerator.syncToVault(
            settings.outputDir || getOutputDir(),
            settings.obsidianVaultDir,
            path.join('meeting-notes', date, `${baseName}.md`)
          );
        } catch (syncErr) {
          console.warn('[IPC] Obsidian sync failed:', syncErr);
        }
      }

      return { filePath };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('export:weeklySummary', async (_event, startDate: string, endDate: string, data: any) => {
    const settings = loadSettings();
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir);

    const content = mdGen.buildWeeklySummary({
      startDate,
      endDate,
      ...data,
    });
    const filePath = mdGen.writeWeeklySummary(startDate, content);
    return { filePath };
  });

  ipcMain.handle('export:monthlySummary', async (_event, startDate: string, endDate: string, data: any) => {
    const settings = loadSettings();
    const outputDir = settings.outputDir || getOutputDir();
    const mdGen = new MarkdownGenerator(outputDir);

    const content = mdGen.buildMonthlySummary({
      startDate,
      endDate,
      ...data,
    });
    const filePath = mdGen.writeMonthlySummary(startDate, content);
    return { filePath };
  });

  // ─── Database - Segment Text Edit ─────────────────────────
  ipcMain.handle('db:updateSegmentText', async (_event, segmentId: number, newText: string) => {
    try {
      const validId = requireId(segmentId, 'segmentId');
      ctx.getDb().updateSegmentCleanText(validId, newText);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Database - Segment Bookmarks ─────────────────────────
  ipcMain.handle('db:toggleBookmark', async (_event, segmentId: number) => {
    try {
      const validId = requireId(segmentId, 'segmentId');
      const bookmarked = ctx.getDb().toggleSegmentBookmark(validId);
      return { success: true, bookmarked };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:getBookmarkedSegments', async () => {
    try {
      return ctx.getDb().getBookmarkedSegments();
    } catch {
      return [];
    }
  });

  // ─── Database - Dashboard Charts ──────────────────────────
  ipcMain.handle('db:getDashboardCharts', async () => {
    try {
      const database = ctx.getDb();
      return {
        recordingsPerDay: database.getRecordingsPerDay(7),
        sentimentDistribution: database.getSentimentDistribution(),
        topSpeakers: database.getTopPersons(5),
        calendarActivity: database.getRecordingsPerDay(90),
      };
    } catch {
      return { recordingsPerDay: [], sentimentDistribution: [], topSpeakers: [], calendarActivity: [] };
    }
  });

  // ─── Database - Stats ─────────────────────────────────────
  ipcMain.handle('db:getStats', async () => {
    try {
      const database = ctx.getDb();
      const recordings = database.getAllRecordings();
      const segmentCount = (database as any).db
        .prepare('SELECT COUNT(*) as count FROM segments')
        .get() as { count: number };
      const dbPath = getDbPath();
      let dbSize = 0;
      try { dbSize = fs.statSync(dbPath).size; } catch { /* ignore */ }
      return {
        recordingCount: recordings.length,
        segmentCount: segmentCount.count,
        dbSize,
      };
    } catch {
      return { recordingCount: 0, segmentCount: 0, dbSize: 0 };
    }
  });
}
