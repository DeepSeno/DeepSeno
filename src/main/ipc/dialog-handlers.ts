import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { IpcContext } from './context';

export function registerDialogHandlers(ctx: IpcContext): void {
  ipcMain.handle('dialog:openFile', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getFocusedWindow() || ctx.getWindow() || null;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: filters || [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a', 'flac'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() || ctx.getWindow() || null;
    const opts = { properties: ['openDirectory'] as ('openDirectory')[] };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
