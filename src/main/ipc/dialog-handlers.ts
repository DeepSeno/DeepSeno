import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { IpcContext } from './context';

const DEFAULT_IMPORT_FILTERS = [
  {
    name: 'All Supported',
    extensions: [
      'wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm',
      'mp4', 'mkv', 'avi', 'mov', 'wmv',
      'pdf', 'docx', 'txt', 'md',
      'jpg', 'jpeg', 'png', 'heic', 'webp',
    ],
  },
  { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'] },
  { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv'] },
  { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
  { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp'] },
];

export function registerDialogHandlers(ctx: IpcContext): void {
  ipcMain.handle('dialog:openFile', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getFocusedWindow() || ctx.getWindow() || null;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: filters || DEFAULT_IMPORT_FILTERS,
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:openFiles', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getFocusedWindow() || ctx.getWindow() || null;
    const opts = {
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: filters || DEFAULT_IMPORT_FILTERS,
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths;
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
