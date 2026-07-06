import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Optional startup theme override, passed by the main process as
// --kz-theme=<dark|light> (from the KZ_THEME env var). Exposed synchronously so
// the renderer can apply it on first paint, before React mounts.
const __kzForcedTheme = (() => {
  const arg = process.argv.find((a) => a.startsWith('--kz-theme='));
  const v = arg ? arg.slice('--kz-theme='.length) : '';
  return v === 'dark' || v === 'light' ? v : null;
})();
contextBridge.exposeInMainWorld('__kzForcedTheme', __kzForcedTheme);

contextBridge.exposeInMainWorld('api', {
  // #region Dialog APIs
  openFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:openFile', filters),
  openFiles: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:openFiles', filters),
  selectDirectory: () =>
    ipcRenderer.invoke('dialog:selectDirectory'),
  // #endregion

  // #region Pipeline APIs
  enqueue: (filePath: string) =>
    ipcRenderer.invoke('pipeline:enqueue', filePath),
  getQueue: () =>
    ipcRenderer.invoke('pipeline:getQueue'),
  cancelTask: (taskId: string) =>
    ipcRenderer.invoke('pipeline:cancel', taskId),
  retryTask: (taskId: string) =>
    ipcRenderer.invoke('pipeline:retry', taskId),
  pauseQueue: () =>
    ipcRenderer.invoke('pipeline:pause'),
  resumeQueue: () =>
    ipcRenderer.invoke('pipeline:resume'),
  isQueuePaused: () =>
    ipcRenderer.invoke('pipeline:isPaused'),
  resetStuckTasks: () =>
    ipcRenderer.invoke('pipeline:resetStuck') as Promise<{ queueCount: number; dbCount: number }>,
  reprocessRecording: (recordingId: number) =>
    ipcRenderer.invoke('pipeline:reprocess', recordingId) as Promise<{ ok: boolean; taskId?: string; error?: string; recovery?: any }>,
  reoptimizeRecording: (recordingId: number) =>
    ipcRenderer.invoke('pipeline:reoptimize', recordingId) as Promise<{ ok: boolean; error?: string }>,
  // #endregion

  // #region Database APIs
  // Recordings
  getRecordings: () =>
    ipcRenderer.invoke('db:getRecordings'),
  getSegmentsByRecording: (recordingId: number) =>
    ipcRenderer.invoke('db:getSegmentsByRecording', recordingId),
  searchSegments: (query: string) =>
    ipcRenderer.invoke('db:searchSegments', query),

  // Meeting Notes
  getMeetingNotes: (recordingId: number) =>
    ipcRenderer.invoke('db:getMeetingNotes', recordingId),
  regenerateMeetingNotes: (recordingId: number) =>
    ipcRenderer.invoke('db:regenerateMeetingNotes', recordingId),
  backfillTitles: (maxBatch?: number) =>
    ipcRenderer.invoke('db:backfillTitles', maxBatch),
  backfillCuration: (maxBatch?: number) =>
    ipcRenderer.invoke('db:backfillCuration', maxBatch),
  finalizeStaleSessions: () => ipcRenderer.invoke('db:finalizeStaleSessions'),
  getTodayCuratedItems: (date: string) =>
    ipcRenderer.invoke('db:getTodayCuratedItems', date),

  // Update Recording
  updateRecordingTitle: (id: number, title: string) =>
    ipcRenderer.invoke('db:updateRecordingTitle', id, title),
  updateRecordingCategory: (id: number, category: string | null) =>
    ipcRenderer.invoke('db:updateRecordingCategory', id, category),

  // Update Segment Text
  updateSegmentText: (id: number, text: string) =>
    ipcRenderer.invoke('db:updateSegmentText', id, text),

  // Clear / Delete
  deleteRecording: (id: number) =>
    ipcRenderer.invoke('db:deleteRecording', id),
  clearAllData: () =>
    ipcRenderer.invoke('db:clearAll'),

  // Extracted Items
  getExtractedItems: (typeOrOpts?: string | { recordingId?: number; type?: string }) =>
    ipcRenderer.invoke('db:getExtractedItems', typeOrOpts),
  getAllExtractedItems: () =>
    ipcRenderer.invoke('db:getAllExtractedItems'),
  createExtractedItem: (data: { type: string; content: string; due_date?: string; related_person?: string; source?: string }) =>
    ipcRenderer.invoke('db:createExtractedItem', data),
  updateExtractedItemStatus: (id: number, status: string) =>
    ipcRenderer.invoke('db:updateExtractedItemStatus', id, status),
  updateExtractedItem: (id: number, data: { content?: string; due_date?: string; related_person?: string; status?: string; type?: string }) =>
    ipcRenderer.invoke('db:updateExtractedItem', id, data),
  deleteExtractedItem: (id: number) =>
    ipcRenderer.invoke('db:deleteExtractedItem', id),

  // Stats
  getDbStats: () =>
    ipcRenderer.invoke('db:getStats'),

  // Segment Bookmarks
  toggleBookmark: (segmentId: number) =>
    ipcRenderer.invoke('db:toggleBookmark', segmentId),
  getBookmarkedSegments: () =>
    ipcRenderer.invoke('db:getBookmarkedSegments'),

  // Dashboard Charts
  getDashboardCharts: () =>
    ipcRenderer.invoke('db:getDashboardCharts'),

  // Daily Summary
  getDailySummary: (date: string) =>
    ipcRenderer.invoke('db:getDailySummary', date),
  getSegmentsByDate: (date: string) =>
    ipcRenderer.invoke('db:getSegmentsByDate', date),
  getTextNotes: (limit?: number) =>
    ipcRenderer.invoke('db:getTextNotes', limit),
  getTextNoteById: (id: number) =>
    ipcRenderer.invoke('db:getTextNoteById', id),

  // Database Export / Backup
  exportDatabase: () => ipcRenderer.invoke('system:exportDatabase'),
  // #endregion

  // #region Person APIs
  // Person CRUD
  getPersons: () =>
    ipcRenderer.invoke('db:getPersons'),
  getPerson: (id: number) =>
    ipcRenderer.invoke('db:getPerson', id),
  createPerson: (data: any) =>
    ipcRenderer.invoke('db:createPerson', data),
  updatePerson: (id: number, data: any) =>
    ipcRenderer.invoke('db:updatePerson', id, data),
  deletePerson: (id: number) =>
    ipcRenderer.invoke('db:deletePerson', id),
  mergePersons: (fromId: number, toId: number) =>
    ipcRenderer.invoke('db:mergePersons', fromId, toId),

  // Person identifiers
  getPersonIdentifiers: (personId: number) =>
    ipcRenderer.invoke('db:getPersonIdentifiers', personId),
  addPersonIdentifier: (data: any) =>
    ipcRenderer.invoke('db:addPersonIdentifier', data),
  deletePersonIdentifier: (id: number) =>
    ipcRenderer.invoke('db:deletePersonIdentifier', id),

  // Content-person links
  getContentByPerson: (personId: number, limit?: number) =>
    ipcRenderer.invoke('db:getContentByPerson', personId, limit),

  // Person relationships
  getPersonRelationships: (personId: number) =>
    ipcRenderer.invoke('db:getPersonRelationships', personId),
  getAllPersonRelationships: () =>
    ipcRenderer.invoke('db:getAllPersonRelationships'),
  getPersonCoOccurrences: () =>
    ipcRenderer.invoke('db:getPersonCoOccurrences'),
  getPersonSample: (personId: number) =>
    ipcRenderer.invoke('db:getPersonSample', personId),

  // #endregion

  // #region RAG & Chat APIs
  // Summary Generation
  generateDailySummary: (date: string) =>
    ipcRenderer.invoke('summary:generateDaily', date),
  generateWeeklySummary: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('summary:generateWeekly', startDate, endDate),
  getAllDailySummaries: () =>
    ipcRenderer.invoke('summary:getAllDaily'),
  deleteDailySummary: (date: string) =>
    ipcRenderer.invoke('summary:delete', date),
  updateDailySummaryKeyEvents: (date: string, keyEventsJson: string) =>
    ipcRenderer.invoke('summary:updateKeyEvents', date, keyEventsJson),
  getAllWeeklySummaries: () =>
    ipcRenderer.invoke('summary:getAllWeekly'),
  deleteWeeklySummary: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('summary:deleteWeekly', startDate, endDate),
  generateMonthlySummary: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('summary:generateMonthly', startDate, endDate),
  getAllMonthlySummaries: () =>
    ipcRenderer.invoke('summary:getAllMonthly'),
  deleteMonthlySummary: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('summary:deleteMonthly', startDate, endDate),

  // Export
  exportDailySummary: (date: string) =>
    ipcRenderer.invoke('export:dailySummary', date),
  exportTranscript: (recordingId: number) =>
    ipcRenderer.invoke('export:transcript', recordingId),
  exportWeeklySummary: (startDate: string, endDate: string, data: any) =>
    ipcRenderer.invoke('export:weeklySummary', startDate, endDate, data),
  exportMonthlySummary: (startDate: string, endDate: string, data: any) =>
    ipcRenderer.invoke('export:monthlySummary', startDate, endDate, data),
  exportMeetingNotes: (recordingId: number) =>
    ipcRenderer.invoke('export:meetingNotes', recordingId),

  // Obsidian
  obsidianSyncAll: () =>
    ipcRenderer.invoke('obsidian:syncAll'),
  obsidianSyncFile: (relativePath: string) =>
    ipcRenderer.invoke('obsidian:syncFile', relativePath),

  // Audio
  getAudioPath: (recordingId: number) =>
    ipcRenderer.invoke('audio:getPath', recordingId),

  // Chat Sessions
  createSession: (title?: string) =>
    ipcRenderer.invoke('chat:createSession', title),
  getSessions: () =>
    ipcRenderer.invoke('chat:getSessions'),
  renameSession: (id: number, title: string) =>
    ipcRenderer.invoke('chat:renameSession', id, title),
  deleteSession: (id: number) =>
    ipcRenderer.invoke('chat:deleteSession', id),
  getSessionMessages: (sessionId: number) =>
    ipcRenderer.invoke('chat:getSessionMessages', sessionId),

  // Channel Sessions (read-only)
  getChannelSessions: () =>
    ipcRenderer.invoke('chat:getChannelSessions'),
  getChannelSessionMessages: (sessionId: number) =>
    ipcRenderer.invoke('chat:getChannelSessionMessages', sessionId),

  // Chat Messages
  saveChatMessage: (sessionId: number, role: string, content: string, sourcesJson?: string) =>
    ipcRenderer.invoke('chat:save', sessionId, role, content, sourcesJson),
  clearChatMessages: (sessionId: number) =>
    ipcRenderer.invoke('chat:clear', sessionId),
  deleteChatMessage: (messageId: number) =>
    ipcRenderer.invoke('chat:deleteMessage', messageId),

  // Per-recording chat history (Library Q&A)
  getRecordingChatMessages: (recordingId: number) =>
    ipcRenderer.invoke('chat:getRecordingMessages', recordingId),
  clearRecordingChatMessages: (recordingId: number) =>
    ipcRenderer.invoke('chat:clearRecordingMessages', recordingId),
  deleteRecordingChatMessage: (messageId: number) =>
    ipcRenderer.invoke('chat:deleteRecordingMessage', messageId),

  // RAG
  ragQuery: (question: string) =>
    ipcRenderer.invoke('rag:query', question),
  ragQueryStream: (question: string, sessionId?: number) =>
    ipcRenderer.invoke('rag:queryStream', question, sessionId),
  ragCancelStream: () =>
    ipcRenderer.invoke('rag:cancelStream'),
  getActiveRagStream: (sessionId?: number) =>
    ipcRenderer.invoke('rag:getActiveStream', sessionId),
  onRagStreamChunk: (cb: (_event: any, chunk: string) => void) => {
    ipcRenderer.on('rag:stream:chunk', cb);
    return () => { ipcRenderer.removeListener('rag:stream:chunk', cb); };
  },
  onRagStreamDone: (cb: (_event: any, sources: any[]) => void) => {
    ipcRenderer.on('rag:stream:done', cb);
    return () => { ipcRenderer.removeListener('rag:stream:done', cb); };
  },
  onRagStreamError: (cb: (_event: any, error: string) => void) => {
    ipcRenderer.on('rag:stream:error', cb);
    return () => { ipcRenderer.removeListener('rag:stream:error', cb); };
  },
  onRagStreamStatus: (cb: (_event: any, status: string) => void) => {
    ipcRenderer.on('rag:stream:status', cb);
    return () => { ipcRenderer.removeListener('rag:stream:status', cb); };
  },

  // Scoped RAG (single recording)
  ragScopedQueryStream: (
    question: string,
    recordingId: number,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) =>
    ipcRenderer.invoke('rag:scopedQueryStream', question, recordingId, history),
  ragCancelScopedStream: () =>
    ipcRenderer.invoke('rag:cancelScopedStream'),
  getActiveScopedRagStream: (recordingId: number) =>
    ipcRenderer.invoke('rag:getActiveScopedStream', recordingId),
  onRagScopedChunk: (cb: (_event: any, chunk: string) => void) => {
    ipcRenderer.on('rag:scoped:chunk', cb);
    return () => { ipcRenderer.removeListener('rag:scoped:chunk', cb); };
  },
  onRagScopedDone: (cb: (_event: any, sources: any[]) => void) => {
    ipcRenderer.on('rag:scoped:done', cb);
    return () => { ipcRenderer.removeListener('rag:scoped:done', cb); };
  },
  onRagScopedError: (cb: (_event: any, error: string) => void) => {
    ipcRenderer.on('rag:scoped:error', cb);
    return () => { ipcRenderer.removeListener('rag:scoped:error', cb); };
  },
  onRagScopedStatus: (cb: (_event: any, status: string) => void) => {
    ipcRenderer.on('rag:scoped:status', cb);
    return () => { ipcRenderer.removeListener('rag:scoped:status', cb); };
  },
  // #endregion

  // #region System APIs
  openDevTools: () =>
    ipcRenderer.invoke('system:openDevTools'),
  getMainLogs: () =>
    ipcRenderer.invoke('system:getMainLogs'),
  onMainLog: (cb: (_e: any, log: string) => void) => {
    const handler = (_e: any, log: string) => cb(_e, log);
    ipcRenderer.on('main:log', handler);
    return () => ipcRenderer.removeListener('main:log', handler);
  },
  openLogWindow: () =>
    ipcRenderer.invoke('logs:openWindow'),
  getAppLogs: () =>
    ipcRenderer.invoke('logs:getEntries'),
  appendRendererLog: (entry: { level?: string; scope?: string; message?: string; details?: unknown }) =>
    ipcRenderer.invoke('logs:appendRenderer', entry),
  clearAppLogs: () =>
    ipcRenderer.invoke('logs:clear'),
  exportAppLogs: () =>
    ipcRenderer.invoke('logs:export'),
  onAppLogEntry: (cb: (_e: any, entry: any) => void) => {
    const handler = (_e: any, entry: any) => cb(_e, entry);
    ipcRenderer.on('logs:entry', handler);
    return () => ipcRenderer.removeListener('logs:entry', handler);
  },
  getStatus: () =>
    ipcRenderer.invoke('system:getStatus'),
  checkCloudApi: (url: string, apiKey: string, model?: string) =>
    ipcRenderer.invoke('cloud:check', url, apiKey, model),
  listCloudModels: (url: string, apiKey: string) =>
    ipcRenderer.invoke('cloud:listModels', url, apiKey),
  checkScreenPermission: () =>
    ipcRenderer.invoke('system:checkScreenPermission'),

  // Settings
  loadSettings: () =>
    ipcRenderer.invoke('settings:load'),
  updateSettings: (partial: any) =>
    ipcRenderer.invoke('settings:update', partial),

  // Hardware Detection
  detectHardware: () =>
    ipcRenderer.invoke('system:detectHardware'),
  getDefaultPrompts: () =>
    ipcRenderer.invoke('system:getDefaultPrompts'),

  // Environment & Models
  detectEnvironment: () =>
    ipcRenderer.invoke('system:detectEnvironment'),
  listModels: () =>
    ipcRenderer.invoke('system:listModels'),
  pullModel: (modelName: string, force?: boolean) =>
    ipcRenderer.invoke('system:pullModel', modelName, force),
  testLocal: (modelName?: string) =>
    ipcRenderer.invoke('system:testLocal', modelName),
  cancelPull: (modelName?: string) =>
    ipcRenderer.invoke('system:cancelPull', modelName),
  getPullStatus: () =>
    ipcRenderer.invoke('system:getPullStatus'),
  checkSherpaModels: () =>
    ipcRenderer.invoke('sherpa:checkModels'),
  downloadSherpaModels: (mirror?: string, force?: boolean) =>
    ipcRenderer.invoke('sherpa:downloadModels', { mirror, force }),
  cancelSherpaDownload: () =>
    ipcRenderer.invoke('sherpa:cancelDownload'),
  getSherpaDownloadStatus: () =>
    ipcRenderer.invoke('sherpa:getDownloadStatus'),
  openExternal: (url: string) =>
    ipcRenderer.invoke('system:openExternal', url),
  openPath: (dirPath: string) =>
    ipcRenderer.invoke('system:openPath', dirPath),
  openLocalModelsDir: () =>
    ipcRenderer.invoke('system:openLocalModelsDir'),
  isLocalInstalled: () =>
    ipcRenderer.invoke('system:isLocalInstalled') as Promise<boolean>,
  installLocal: () =>
    ipcRenderer.invoke('system:installLocal') as Promise<{ success: boolean; error?: string }>,
  onLocalInstallProgress: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('local:installProgress', cb);
    return () => { ipcRenderer.removeListener('local:installProgress', cb); };
  },
  getDataDir: () =>
    ipcRenderer.invoke('system:getDataDir') as Promise<string>,
  clipboardWriteText: (text: string) =>
    ipcRenderer.invoke('clipboard:writeText', text),

  // FFmpeg Management
  checkFFmpeg: () =>
    ipcRenderer.invoke('ffmpeg:check'),
  downloadFFmpeg: () =>
    ipcRenderer.invoke('ffmpeg:download'),
  cancelFFmpegDownload: () =>
    ipcRenderer.invoke('ffmpeg:cancelDownload'),
  onFFmpegDownloadProgress: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('ffmpeg:downloadProgress', cb);
    return () => { ipcRenderer.removeListener('ffmpeg:downloadProgress', cb); };
  },

  // llama-server (bundled local inference)
  llamaStart: () =>
    ipcRenderer.invoke('llama:start'),
  llamaStop: () =>
    ipcRenderer.invoke('llama:stop'),
  llamaStatus: () =>
    ipcRenderer.invoke('llama:status'),

  // Setup progress events (push from main -> renderer)
  onSetupProgress: (cb: (_event: any, data: any) => void) => {
    ipcRenderer.on('setup:progress', cb);
    return () => { ipcRenderer.removeListener('setup:progress', cb); };
  },

  // Model pull progress events (push from main -> renderer)
  onModelPullProgress: (cb: (_event: any, data: any) => void) => {
    ipcRenderer.on('model:pullProgress', cb);
    return () => { ipcRenderer.removeListener('model:pullProgress', cb); };
  },

  // Task events (push from main -> renderer)
  onTaskAdded: (cb: (_event: any, task: any) => void) => {
    ipcRenderer.on('pipeline:task:added', cb);
    return () => { ipcRenderer.removeListener('pipeline:task:added', cb); };
  },
  onTaskProgress: (cb: (_event: any, task: any) => void) => {
    ipcRenderer.on('pipeline:task:progress', cb);
    return () => { ipcRenderer.removeListener('pipeline:task:progress', cb); };
  },
  onTaskCompleted: (cb: (_event: any, task: any) => void) => {
    ipcRenderer.on('pipeline:task:completed', cb);
    return () => { ipcRenderer.removeListener('pipeline:task:completed', cb); };
  },
  onTaskCancelled: (cb: (_event: any, task: any) => void) => {
    ipcRenderer.on('pipeline:task:cancelled', cb);
    return () => { ipcRenderer.removeListener('pipeline:task:cancelled', cb); };
  },
  onTextNoteNew: (cb: (_event: any, note: any) => void) => {
    ipcRenderer.on('text-note:new', cb);
    return () => { ipcRenderer.removeListener('text-note:new', cb); };
  },
  onTaskFailed: (cb: (_event: any, task: any) => void) => {
    ipcRenderer.on('pipeline:task:failed', cb);
    return () => { ipcRenderer.removeListener('pipeline:task:failed', cb); };
  },

  // Keyboard shortcut events
  onShortcutSearch: (cb: () => void) => {
    ipcRenderer.on('shortcut:search', cb);
    return () => { ipcRenderer.removeListener('shortcut:search', cb); };
  },
  onShortcutSettings: (cb: () => void) => {
    ipcRenderer.on('shortcut:settings', cb);
    return () => { ipcRenderer.removeListener('shortcut:settings', cb); };
  },

  // Auto Update
  checkForUpdate: () =>
    ipcRenderer.invoke('system:checkForUpdate'),
  downloadUpdate: () =>
    ipcRenderer.invoke('system:downloadUpdate'),
  installUpdate: () =>
    ipcRenderer.invoke('system:installUpdate'),
  onUpdateAvailable: (cb: (_event: any, data: { version: string }) => void) => {
    ipcRenderer.on('update-available', cb);
    return () => { ipcRenderer.removeListener('update-available', cb); };
  },
  onUpdateDownloadProgress: (cb: (_event: any, data: { percent: number }) => void) => {
    ipcRenderer.on('update-download-progress', cb);
    return () => { ipcRenderer.removeListener('update-download-progress', cb); };
  },
  onUpdateDownloaded: (cb: (_event: any) => void) => {
    ipcRenderer.on('update-downloaded', cb);
    return () => { ipcRenderer.removeListener('update-downloaded', cb); };
  },
  onUpdateInstallFailed: (cb: (_event: any, data: { downloadUrl: string }) => void) => {
    ipcRenderer.on('update-install-failed', cb);
    return () => { ipcRenderer.removeListener('update-install-failed', cb); };
  },

  // Background Download Manager
  bgdownloadGetState: () => ipcRenderer.invoke('bgdownload:getState'),
  bgdownloadStart: () => ipcRenderer.invoke('bgdownload:start'),
  bgdownloadCancel: () => ipcRenderer.invoke('bgdownload:cancel'),
  bgdownloadRestart: (ids: string[]) => ipcRenderer.invoke('bgdownload:restart', ids),
  onBgdownloadState: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('bgdownload:state', cb);
    return () => { ipcRenderer.removeListener('bgdownload:state', cb); };
  },
  // #endregion

  // #region Recording & Realtime APIs
  toggleRecording: (scene?: string) =>
    ipcRenderer.invoke('recording:toggle', scene),
  updateSceneShortcut: (scene: string, shortcut: string) =>
    ipcRenderer.invoke('recording:updateSceneShortcut', scene, shortcut),

  // Recording events (push from main -> renderer)
  onRecordingStateChanged: (cb: (_event: any, recording: boolean) => void) => {
    ipcRenderer.on('recording:stateChanged', cb);
    return () => { ipcRenderer.removeListener('recording:stateChanged', cb); };
  },
  onRecordingSaved: (cb: (_event: any, data: { filePath: string; duration: number }) => void) => {
    ipcRenderer.on('recording:saved', cb);
    return () => { ipcRenderer.removeListener('recording:saved', cb); };
  },
  onRecordingError: (cb: (_event: any, error: string) => void) => {
    ipcRenderer.on('recording:error', cb);
    return () => { ipcRenderer.removeListener('recording:error', cb); };
  },
  onPostProcessing: (cb: (_event: any, data: { active: boolean; recordingId: number }) => void) => {
    ipcRenderer.on('recording:postProcessing', cb);
    return () => { ipcRenderer.removeListener('recording:postProcessing', cb); };
  },
  onPostProcessComplete: (cb: (_event: any, data: { recordingId: number }) => void) => {
    ipcRenderer.on('live:post_complete', cb);
    return () => { ipcRenderer.removeListener('live:post_complete', cb); };
  },

  // Real-time transcription
  realtimeStart: (scene?: string) => ipcRenderer.invoke('realtime:start', scene),
  realtimeStop: () => ipcRenderer.invoke('realtime:stop'),
  realtimeStatus: () => ipcRenderer.invoke('realtime:status'),

  onLiveStarted: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('live:started', cb);
    return () => { ipcRenderer.removeListener('live:started', cb); };
  },
  onLiveSegment: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('live:segment', cb);
    return () => { ipcRenderer.removeListener('live:segment', cb); };
  },
  onLiveStopped: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('live:stopped', cb);
    return () => { ipcRenderer.removeListener('live:stopped', cb); };
  },
  onLivePostComplete: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('live:post_complete', cb);
    return () => { ipcRenderer.removeListener('live:post_complete', cb); };
  },
  onLiveError: (cb: (...args: any[]) => void) => {
    ipcRenderer.on('live:error', cb);
    return () => { ipcRenderer.removeListener('live:error', cb); };
  },

  // System Audio Capture
  systemAudioListDevices: () =>
    ipcRenderer.invoke('systemAudio:listDevices'),
  systemAudioStart: (deviceId?: number) =>
    ipcRenderer.invoke('systemAudio:start', deviceId),
  systemAudioStop: () =>
    ipcRenderer.invoke('systemAudio:stop'),
  systemAudioStatus: () =>
    ipcRenderer.invoke('systemAudio:status'),
  onSystemAudioProgress: (cb: (_event: any, data: any) => void) => {
    ipcRenderer.on('systemAudio:progress', cb);
    return () => { ipcRenderer.removeListener('systemAudio:progress', cb); };
  },
  onSystemAudioStopped: (cb: (_event: any, data: any) => void) => {
    ipcRenderer.on('systemAudio:stopped', cb);
    return () => { ipcRenderer.removeListener('systemAudio:stopped', cb); };
  },
  // #endregion

  // #region Integration APIs
  // Feishu Bot
  feishuGetStatus: () =>
    ipcRenderer.invoke('feishu:getStatus'),
  feishuTestConnection: (appId: string, appSecret: string) =>
    ipcRenderer.invoke('feishu:testConnection', appId, appSecret),
  feishuRestart: () =>
    ipcRenderer.invoke('feishu:restart'),
  feishuSimulate: (params: { type: string; text?: string; wavPath?: string; msgType?: string }) =>
    ipcRenderer.invoke('feishu:simulate', params),
  feishuRunTestSuite: () =>
    ipcRenderer.invoke('feishu:runTestSuite'),

  externalSourcesListProviders: () =>
    ipcRenderer.invoke('externalSources:listProviders'),
  externalSourcesGetStatus: (source: string) =>
    ipcRenderer.invoke('externalSources:getStatus', source),
  externalSourcesSyncNow: (source: string, domains?: string[]) =>
    ipcRenderer.invoke('externalSources:syncNow', source, domains),

  // External Source Providers (Feishu CLI is the built-in provider)
  feishuCliGetStatus: () =>
    ipcRenderer.invoke('externalSources:getStatus', 'feishu-cli'),
  feishuCliInstall: () =>
    ipcRenderer.invoke('feishuCli:install'),
  feishuCliInitConfig: () =>
    ipcRenderer.invoke('feishuCli:initConfig'),
  feishuCliLogin: (scopes?: string[]) =>
    ipcRenderer.invoke('feishuCli:login', scopes),
  feishuCliPollLogin: (deviceCode: string) =>
    ipcRenderer.invoke('feishuCli:pollLogin', deviceCode),
  feishuCliLogout: () =>
    ipcRenderer.invoke('feishuCli:logout'),
  feishuCliSyncNow: () =>
    ipcRenderer.invoke('externalSources:syncNow', 'feishu-cli'),

  // WeChat
  wechatTestConnection: (corpId: string, secret: string) =>
    ipcRenderer.invoke('wechat:testConnection', corpId, secret),

  // Telegram
  telegramTestConnection: (botToken: string) =>
    ipcRenderer.invoke('telegram:testConnection', botToken),

  // OpenClaw WeChat (Personal)
  openclawWechatGetQRCode: () =>
    ipcRenderer.invoke('openclawWechat:getQRCode'),
  openclawWechatGetQRCodeStatus: (qrcodeId: string) =>
    ipcRenderer.invoke('openclawWechat:getQRCodeStatus', qrcodeId),
  openclawWechatTestConnection: () =>
    ipcRenderer.invoke('openclawWechat:testConnection'),
  openclawWechatLogout: () =>
    ipcRenderer.invoke('openclawWechat:logout'),
  openclawWechatGetStatus: () =>
    ipcRenderer.invoke('openclawWechat:getStatus'),

  // Email
  emailTestConnection: (host: string, port: number, user: string, pass: string) =>
    ipcRenderer.invoke('email:testConnection', host, port, user, pass),

  // Sync
  syncGetStatus: () =>
    ipcRenderer.invoke('sync:getStatus'),
  syncEnable: (syncDir: string) =>
    ipcRenderer.invoke('sync:enable', syncDir),
  syncDisable: () =>
    ipcRenderer.invoke('sync:disable'),
  syncTryAcquireLock: () =>
    ipcRenderer.invoke('sync:tryAcquireLock'),

  // LAN Server
  lanServerGetStatus: () => ipcRenderer.invoke('lanServer:getStatus'),
  lanServerStart: () => ipcRenderer.invoke('lanServer:start'),
  lanServerStop: () => ipcRenderer.invoke('lanServer:stop'),

  // Public network relay (P2P + server relay fallback)
  relayGetStatus: () => ipcRenderer.invoke('relay:getStatus'),
  relayEnable: (enabled: boolean) => ipcRenderer.invoke('relay:enable', enabled),
  relayGetPairingQR: () => ipcRenderer.invoke('relay:getPairingQR'),
  relayUnpair: () => ipcRenderer.invoke('relay:unpair'),
  // #endregion

  // #region License APIs
  licenseGetStatus: () => ipcRenderer.invoke('license:getStatus'),
  licenseIsPro: () => ipcRenderer.invoke('license:isPro'),
  licenseActivate: (key: string) => ipcRenderer.invoke('license:activate', key),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),
  onLicenseChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('license:changed', handler);
    return () => { ipcRenderer.removeListener('license:changed', handler); };
  },
  // #endregion

  // #region Knowledge Pages APIs
  knowledgeCreate: (data: { slug: string; type: string; title: string; content?: string }) => ipcRenderer.invoke('knowledge:create', data),
  knowledgeGetAll: (type?: string) => ipcRenderer.invoke('knowledge:getAll', type),
  knowledgeGetBySlug: (slug: string) => ipcRenderer.invoke('knowledge:getBySlug', slug),
  knowledgeSearch: (query: string, type?: string) => ipcRenderer.invoke('knowledge:search', query, type),
  knowledgeGetLinks: (pageId: number) => ipcRenderer.invoke('knowledge:getLinks', pageId),
  knowledgeGetBacklinks: (pageId: number) => ipcRenderer.invoke('knowledge:getBacklinks', pageId),
  knowledgeGetGraph: () => ipcRenderer.invoke('knowledge:getGraph'),
  knowledgeGetQueueStatus: () => ipcRenderer.invoke('knowledge:getQueueStatus'),
  knowledgeGetQueueEntries: () => ipcRenderer.invoke('knowledge:getQueueEntries'),
  knowledgeClearStuckQueue: () => ipcRenderer.invoke('knowledge:clearStuckQueue'),
  knowledgeGetStats: () => ipcRenderer.invoke('knowledge:getStats'),
  knowledgeRecompile: (pageId: number) => ipcRenderer.invoke('knowledge:recompile', pageId),
  knowledgeCompileRecording: (recordingId: number) => ipcRenderer.invoke('knowledge:compileRecording', recordingId),
  knowledgeUpdateContent: (pageId: number, content: string) => ipcRenderer.invoke('knowledge:updateContent', pageId, content),
  knowledgeCompileAll: () => ipcRenderer.invoke('knowledge:compileAll'),
  knowledgeMergePages: (sourcePageIds: number[], targetPageId: number) => ipcRenderer.invoke('knowledge:mergePages', sourcePageIds, targetPageId),
  knowledgeFindDuplicates: () => ipcRenderer.invoke('knowledge:findDuplicates'),
  knowledgeDelete: (pageId: number) => ipcRenderer.invoke('knowledge:delete', pageId),
  knowledgeBatchDelete: (pageIds: number[]) => ipcRenderer.invoke('knowledge:batchDelete', pageIds),
  knowledgeRenamePage: (pageId: number, newTitle: string, newType: string) => ipcRenderer.invoke('knowledge:renamePage', pageId, newTitle, newType),
  knowledgeEditContent: (pageId: number, content: string) => ipcRenderer.invoke('knowledge:editContent', pageId, content),
  // #endregion

  // #region Correction Dictionary APIs
  correctionGetAll: () => ipcRenderer.invoke('correction:getAll'),
  correctionAdd: (wrongText: string, correctText: string, category?: string) => ipcRenderer.invoke('correction:add', wrongText, correctText, category),
  correctionUpdate: (id: number, wrongText: string, correctText: string, category: string) => ipcRenderer.invoke('correction:update', id, wrongText, correctText, category),
  correctionDelete: (id: number) => ipcRenderer.invoke('correction:delete', id),
  correctionApply: (text: string) => ipcRenderer.invoke('correction:apply', text),
  // #endregion

  // #region Custom Vocabulary APIs
  vocabularyGetAll: () => ipcRenderer.invoke('vocabulary:getAll'),
  vocabularyAdd: (term: string, category?: string) => ipcRenderer.invoke('vocabulary:add', term, category),
  vocabularyDelete: (id: number) => ipcRenderer.invoke('vocabulary:delete', id),
  // #endregion

  // #region Memory APIs
  memoryGetAll: () => ipcRenderer.invoke('memory:getAll'),
  memoryGetStats: () => ipcRenderer.invoke('memory:getStats'),
  memoryPromote: (id: number, layer: string) => ipcRenderer.invoke('memory:promote', id, layer),
  memoryDelete: (id: number) => ipcRenderer.invoke('memory:delete', id),
  memoryUpdate: (id: number, fact: string) => ipcRenderer.invoke('memory:update', id, fact),

  // Memory Documents
  memoryGetDocumentDates: () => ipcRenderer.invoke('memory:getDocumentDates'),
  memoryGetDocument: (date: string) => ipcRenderer.invoke('memory:getDocument', date),
  memorySaveDocument: (date: string, content: string) => ipcRenderer.invoke('memory:saveDocument', date, content),
  memoryGenerateDocument: (date: string) => ipcRenderer.invoke('memory:generateDocument', date),
  // #endregion

  // #region Scheduler APIs
  schedulerCreate: (params: any) => ipcRenderer.invoke('scheduler:create', params),
  schedulerUpdate: (id: number, params: any) => ipcRenderer.invoke('scheduler:update', id, params),
  schedulerDelete: (id: number) => ipcRenderer.invoke('scheduler:delete', id),
  schedulerList: (filter?: any) => ipcRenderer.invoke('scheduler:list', filter),
  schedulerGet: (id: number) => ipcRenderer.invoke('scheduler:get', id),
  schedulerPause: (id: number) => ipcRenderer.invoke('scheduler:pause', id),
  schedulerResume: (id: number) => ipcRenderer.invoke('scheduler:resume', id),
  schedulerRunNow: (id: number) => ipcRenderer.invoke('scheduler:runNow', id),
  schedulerHistory: (taskId: number, limit?: number) => ipcRenderer.invoke('scheduler:history', taskId, limit),
  schedulerParseSchedule: (text: string) => ipcRenderer.invoke('scheduler:parseSchedule', text),
  schedulerListActions: () => ipcRenderer.invoke('scheduler:listActions'),
  // #endregion

  // #region File Utilities
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return (file as any).path || ''; }
  },
  // #endregion

  // #region Plugin APIs (unified MCP + Skill)
  pluginGetAll: () => ipcRenderer.invoke('plugin:getAll'),
  pluginInstall: (config: any) => ipcRenderer.invoke('plugin:install', config),
  skillInstallFromDirectory: (dirPath: string, page?: any) => ipcRenderer.invoke('skill:installFromDirectory', dirPath, page),
  skillVerifyGithub: (url: string) => ipcRenderer.invoke('skill:verifyGithub', url),
  skillInstallFromGithub: (url: string, page?: any) => ipcRenderer.invoke('skill:installFromGithub', url, page),
  pluginInstallFromUrl: (url: string) => ipcRenderer.invoke('plugin:installFromUrl', url),
  pluginInstallFromRemoteSkill: (skillPathUrl: string, meta: { id: string; name: string; description: string; version?: string; github_url?: string }) => ipcRenderer.invoke('plugin:installFromRemoteSkill', skillPathUrl, meta),
  pluginUninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', id),
  pluginUpdate: (id: string, updates: any) => ipcRenderer.invoke('plugin:update', id, updates),
  pluginEnable: (id: string) => ipcRenderer.invoke('plugin:enable', id),
  pluginDisable: (id: string) => ipcRenderer.invoke('plugin:disable', id),
  pluginGetTools: (pluginId: string) => ipcRenderer.invoke('plugin:getTools', pluginId),
  pluginGetLogs: (pluginId: string) => ipcRenderer.invoke('plugin:getLogs', pluginId),
  pluginClearLogs: (pluginId: string) => ipcRenderer.invoke('plugin:clearLogs', pluginId),
  pluginCheckUpdate: (pluginId: string) => ipcRenderer.invoke('plugin:checkUpdate', pluginId),
  pluginUpgrade: (pluginId: string) => ipcRenderer.invoke('plugin:upgrade', pluginId),
  pluginGetMarket: () => ipcRenderer.invoke('plugin:getMarket'),

  // Agent Chat
  agentChat: (question: string) => ipcRenderer.invoke('agent:chat', question),
  agentChatWithPlugin: (pluginId: string, question: string) => ipcRenderer.invoke('agent:chatWithPlugin', pluginId, question),
  // #endregion

  // Theme — notify main process so window chrome (titleBarOverlay, bg) tracks the renderer theme.
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.send('theme:changed', theme),
});
