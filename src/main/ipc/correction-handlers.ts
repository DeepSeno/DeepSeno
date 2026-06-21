import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { requireId, requireString, ValidationError } from './validate';

export function registerCorrectionHandlers(ctx: IpcContext): void {
  // ─── correction:getAll ─────────────────────────────────────
  ipcMain.handle('correction:getAll', async () => {
    try {
      return ctx.getDb().getAllCorrections();
    } catch {
      return [];
    }
  });

  // ─── correction:add ────────────────────────────────────────
  ipcMain.handle('correction:add', async (_event, wrongText: string, correctText: string, category?: string) => {
    try {
      const validWrong = requireString(wrongText, 'wrongText', 500);
      const validCorrect = requireString(correctText, 'correctText', 500);
      const validCategory = category ? requireString(category, 'category', 100) : 'general';
      const id = ctx.getDb().insertCorrection(validWrong, validCorrect, validCategory);
      return { success: true, id };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── correction:update ─────────────────────────────────────
  ipcMain.handle('correction:update', async (_event, id: number, wrongText: string, correctText: string, category: string) => {
    try {
      const validId = requireId(id, 'id');
      const validWrong = requireString(wrongText, 'wrongText', 500);
      const validCorrect = requireString(correctText, 'correctText', 500);
      const validCategory = requireString(category, 'category', 100);
      ctx.getDb().updateCorrection(validId, validWrong, validCorrect, validCategory);
      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── correction:delete ─────────────────────────────────────
  ipcMain.handle('correction:delete', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deleteCorrection(validId);
      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── correction:apply ──────────────────────────────────────
  ipcMain.handle('correction:apply', async (_event, text: string) => {
    try {
      const validText = requireString(text, 'text', 500_000);
      return ctx.getDb().applyCorrections(validText);
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { corrected: text, appliedIds: [] };
      }
      return { corrected: text, appliedIds: [] };
    }
  });

  // ─── vocabulary:getAll ────────────────────────────────────
  ipcMain.handle('vocabulary:getAll', async () => {
    try {
      return ctx.getDb().getAllVocabulary();
    } catch {
      return [];
    }
  });

  // ─── vocabulary:add ───────────────────────────────────────
  ipcMain.handle('vocabulary:add', async (_event, term: string, category?: string) => {
    try {
      const validTerm = requireString(term, 'term', 500);
      const validCategory = category ? requireString(category, 'category', 100) : 'general';
      const id = ctx.getDb().insertVocabularyTerm(validTerm, validCategory);
      return { success: true, id };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // ─── vocabulary:delete ────────────────────────────────────
  ipcMain.handle('vocabulary:delete', async (_event, id: number) => {
    try {
      const validId = requireId(id, 'id');
      ctx.getDb().deleteVocabularyTerm(validId);
      return { success: true };
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown error' };
    }
  });
}
