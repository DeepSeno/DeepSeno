import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IpcContext } from './context';
import { FileWatcher, isSupportedWatchFile } from '../watcher';
import { loadSettings } from '../settings';
import { getLocalDataDir, getTempDir } from '../paths';
import { requireString, requireId, ValidationError } from './validate';
import { isSqliteCorruptionError, makeRepairFailureMessage } from '../db/sqlite-recovery';
import { toPipelineEnqueueResponse } from './pipeline-enqueue-result';

let fileWatcher: FileWatcher | null = null;

/**
 * Copy an imported file to the app's imports/ directory so it stays
 * accessible even if the user moves or deletes the original.
 * Files already inside the watch directory or data directory are not copied.
 */
function copyToImportsIfNeeded(filePath: string): string {
  const dataDir = getLocalDataDir();
  const resolvedDataDir = path.resolve(dataDir);

  // Already inside data dir (e.g. imports/) — no copy needed
  // NOTE: watchDir files ARE copied so the DB path survives if the user
  // moves or deletes the original from their watch folder.
  const normalized = path.resolve(filePath);
  const relativeToDataDir = path.relative(resolvedDataDir, normalized);
  if (relativeToDataDir === '' || (!relativeToDataDir.startsWith('..') && !path.isAbsolute(relativeToDataDir))) {
    return filePath;
  }

  const importsDir = path.join(dataDir, 'imports');
  fs.mkdirSync(importsDir, { recursive: true });

  // Use original filename. If the same file was imported before, reuse the
  // existing imported copy so downstream de-duplication sees the same path.
  let dest = path.join(importsDir, path.basename(filePath));
  if (fs.existsSync(dest)) {
    try {
      const srcStat = fs.statSync(filePath);
      const destStat = fs.statSync(dest);
      if (srcStat.size === destStat.size) {
        console.log(`[Pipeline] Reusing existing import: ${path.basename(filePath)}`);
        return dest;
      }
    } catch {
      // Fall through to suffixing when either side cannot be inspected.
    }

    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    dest = path.join(importsDir, `${base}_${Date.now()}${ext}`);
  }

  fs.copyFileSync(filePath, dest);
  console.log(`[Pipeline] Copied import: ${path.basename(filePath)} → imports/`);
  return dest;
}

export function registerPipelineHandlers(ctx: IpcContext): void {
  ipcMain.handle('pipeline:enqueue', async (_event, filePath: string) => {
    try {
      const validPath = requireString(filePath, 'filePath', 1000);
      const safePath = copyToImportsIfNeeded(validPath);
      const task = ctx.getProcessor().enqueue(safePath);
      return toPipelineEnqueueResponse(task);
    } catch (err: any) {
      if (err instanceof ValidationError) return { id: '', status: 'failed', error: err.message, code: err.code };
      return { id: '', status: 'failed', error: err.message || 'Failed to enqueue file' };
    }
  });

  ipcMain.handle('pipeline:getQueue', async () => {
    try {
      const tasks = ctx.getProcessor().getTaskQueue().getAll();
      return tasks.map((t) => ({
        id: t.id,
        filePath: t.filePath,
        status: t.status,
        progress: t.progress,
        error: t.error,
        notes: t.notes,
        mediaType: t.mediaType,
        createdAt: t.createdAt.toISOString(),
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('pipeline:cancel', (_event, taskId: string) => {
    try {
      const validId = requireString(taskId, 'taskId', 100);
      const queue = ctx.getProcessor().getTaskQueue();
      const task = queue.getById(validId);
      const cancelled = queue.cancel(validId);
      if (cancelled && task) {
        const recordingId = task.recordingId ?? ctx.getDb().getRecordingByPath(task.filePath)?.id;
        if (recordingId) {
          ctx.getDb().updateRecordingStatus(recordingId, 'cancelled');
        }
      }
      return cancelled;
    } catch {
      return false;
    }
  });

  ipcMain.handle('pipeline:retry', async (_event, taskId: string) => {
    try {
      const validId = requireString(taskId, 'taskId', 100);
      const queue = ctx.getProcessor().getTaskQueue();
      const task = queue.getById(validId);

      if (task?.error && isSqliteCorruptionError(task.error)) {
        const repair = await ctx.repairStorageAfterSqliteCorruption(task.error);
        if (!repair.repaired) {
          return {
            ok: false,
            error: makeRepairFailureMessage(repair, false),
            recovery: repair,
          };
        }
      }

      return { ok: queue.retry(validId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('pipeline:pause', () => {
    try {
      ctx.getProcessor().getTaskQueue().pause();
    } catch {
      // Ignore
    }
  });

  ipcMain.handle('pipeline:resume', () => {
    try {
      ctx.getProcessor().getTaskQueue().resume();
    } catch {
      // Ignore
    }
  });

  ipcMain.handle('pipeline:isPaused', () => {
    try {
      return ctx.getProcessor().getTaskQueue().isPaused();
    } catch {
      return false;
    }
  });

  ipcMain.handle('pipeline:resetStuck', () => {
    try {
      const queueCount = ctx.getProcessor().getTaskQueue().resetStuck();
      const dbCount = ctx.getDb().recoverStuckRecordings();
      console.log(`[pipeline:resetStuck] Reset ${queueCount} queue tasks, ${dbCount} DB recordings`);
      return { queueCount, dbCount };
    } catch (err: any) {
      console.error('[pipeline:resetStuck] Error:', err);
      return { queueCount: 0, dbCount: 0 };
    }
  });

  ipcMain.handle('pipeline:reprocess', async (_event, recordingId: number) => {
    let originalStatus: string | null = null;
    try {
      const validId = requireId(recordingId, 'recordingId');
      const rec = ctx.getDb().getRecording(validId);
      if (!rec) return { ok: false, error: 'Recording not found' };
      originalStatus = rec.status;
      const inputPath = rec.source_file_path || rec.file_path;
      const task = ctx.getProcessor().enqueueReprocess(inputPath, validId);
      return { ok: true, taskId: task.id };
    } catch (err: any) {
      if (isSqliteCorruptionError(err)) {
        const validId = Number(recordingId);
        const repair = await ctx.repairStorageAfterSqliteCorruption(err);
        if (repair.repaired) {
          try {
            const rec = ctx.getDb().getRecording(validId);
            if (!rec) return { ok: false, error: 'Recording not found after repair', recovery: repair };
            const inputPath = rec.source_file_path || rec.file_path;
            const task = ctx.getProcessor().enqueueReprocess(inputPath, validId);
            return { ok: true, taskId: task.id, recovery: repair };
          } catch (retryErr: any) {
            console.error('[pipeline:reprocess] Retry after repair failed:', retryErr);
            if (!isSqliteCorruptionError(retryErr)) {
              return { ok: false, error: retryErr?.message || String(retryErr), recovery: repair };
            }
            repair.repaired = false;
            repair.errors.push(`repair retry still failed: ${retryErr?.message || String(retryErr)}`);
          }
        }

        let rolledBack = false;
        if (Number.isFinite(validId) && originalStatus) {
          try {
            ctx.getDb().updateRecording(validId, { status: originalStatus });
            rolledBack = true;
          } catch (rollbackErr) {
            console.warn('[pipeline:reprocess] Failed to rollback recording status:', rollbackErr);
          }
        }
        return {
          ok: false,
          error: makeRepairFailureMessage(repair, rolledBack),
          recovery: { ...repair, rolledBack },
        };
      }
      console.error('[pipeline:reprocess] Error:', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pipeline:reoptimize', async (_event, recordingId: number) => {
    try {
      const validId = requireId(recordingId, 'recordingId');
      await ctx.getProcessor().reoptimizeRecording(validId);
      return { ok: true };
    } catch (err: any) {
      console.error('[pipeline:reoptimize] Error:', err);
      return { ok: false, error: err.message };
    }
  });
}

/** Enqueue a file for pipeline processing (used by recording:save in main.ts) */
export function enqueueForProcessing(ctx: IpcContext, filePath: string): { id: string; status: string } | null {
  try {
    const task = ctx.getProcessor().enqueue(filePath);
    return { id: task.id, status: task.status };
  } catch (err) {
    console.error('[ipc] enqueueForProcessing failed:', err);
    return null;
  }
}

export async function startFileWatching(ctx: IpcContext): Promise<void> {
  const settings = loadSettings();

  if (!settings.setupComplete || !settings.watchDir) return;

  if (!fs.existsSync(settings.watchDir)) return;

  // Stop existing watcher if any
  if (fileWatcher) {
    await fileWatcher.stop();
    fileWatcher = null;
  }

  // If auto-processing is disabled, don't start watcher or scan directory
  if (settings.autoProcessWatchDir === false) {
    console.log('[FileWatcher] Auto-processing disabled, skipping file watch');
    return;
  }

  const proc = ctx.getProcessor();

  // Start watching for new files (ignore imports/ and temp/ to prevent re-processing)
  const importsDir = path.join(getLocalDataDir(), 'imports');
  const tempDir = getTempDir();
  fileWatcher = new FileWatcher(settings.watchDir, (filePath) => {
    const basename = path.basename(filePath);
    // Skip FEISHU-* files — already enqueued by the Feishu bot handler
    if (basename.startsWith('FEISHU-')) {
      console.log(`[FileWatcher] Skipping Feishu-originated file: ${basename}`);
      return;
    }
    // Skip LIVE-* files — already handled by real-time transcription pipeline
    if (basename.startsWith('LIVE-')) {
      console.log(`[FileWatcher] Skipping live-recording file: ${basename}`);
      return;
    }
    // Skip REC-* files — already enqueued by recording:save handler
    if (basename.startsWith('REC-')) {
      console.log(`[FileWatcher] Skipping internal recording: ${basename}`);
      return;
    }
    // Skip SYSAUDIO-* files — already enqueued by systemAudio:stopped handler
    if (basename.startsWith('SYSAUDIO-')) {
      console.log(`[FileWatcher] Skipping system audio file: ${basename}`);
      return;
    }
    console.log(`[FileWatcher] New supported file detected: ${filePath}`);
    proc.enqueue(filePath);
  }, [importsDir, tempDir]);
  await fileWatcher.start();
  console.log(`[FileWatcher] Watching: ${settings.watchDir}`);

  const database = ctx.getDb();

  // Crash recovery: never auto-reprocess stuck recordings on startup.
  // Reprocessing clears and rebuilds derived data, so doing it automatically can
  // duplicate large imports or wipe usable previous results after a restart.
  // Keep the recording visible as interrupted and let the user retry explicitly.
  const recoverableStatuses = ['processing', 'pending', 'recording', 'post_processing'] as const;
  let skippedMissing = 0;
  let markedInterrupted = 0;
  for (const status of recoverableStatuses) {
    const recs = database.getRecordingsByStatus(status);
    for (const rec of recs) {
      if (!fs.existsSync(rec.file_path)) {
        database.updateRecordingStatus(rec.id, 'interrupted');
        skippedMissing++;
        continue;
      }
      try {
        database.updateRecordingStatus(rec.id, 'interrupted');
        markedInterrupted++;
      } catch (err) {
        console.error(`[FileWatcher] Failed to mark interrupted recording ${rec.file_name}:`, err);
      }
    }
  }
  if (skippedMissing > 0 || markedInterrupted > 0) {
    console.log(`[FileWatcher] Crash recovery: interrupted ${markedInterrupted}, missing ${skippedMissing}`);
  }

  // Scan watch directory for truly new files (no recording in DB at all)
  // Delay scan to let files that are still being copied stabilize
  const STABLE_AGE_MS = 3000; // file must not have been modified in last 3 seconds

  const files = fs.readdirSync(settings.watchDir);
  const now = Date.now();

  for (const file of files) {
    if (!isSupportedWatchFile(file)) continue;
    // Skip files already handled by their own pipelines
    if (file.startsWith('LIVE-') || file.startsWith('FEISHU-') || file.startsWith('REC-') || file.startsWith('SYSAUDIO-')) continue;

    const fullPath = path.join(settings.watchDir, file);

    // Skip files still being written (modified within last 3 seconds)
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs < STABLE_AGE_MS) {
        console.log(`[FileWatcher] Skipping unstable file (still being written?): ${file}`);
        continue;
      }
    } catch {
      continue; // File disappeared between readdir and stat
    }

    const existing = database.getRecordingByPath(fullPath);
    if (!existing) {
      console.log(`[FileWatcher] Enqueuing new file: ${file}`);
      proc.enqueue(fullPath);
    }
  }
}

export async function cleanupFileWatcher(): Promise<void> {
  if (fileWatcher) {
    await fileWatcher.stop();
    fileWatcher = null;
  }
}
