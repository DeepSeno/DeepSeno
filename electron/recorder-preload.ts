import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('recorderApi', {
  // Notify main process recording started
  onStartCommand: (cb: (scene?: string) => void) => {
    const handler = (_: any, scene?: string) => cb(scene);
    ipcRenderer.on('recording:start', handler);
    return () => { ipcRenderer.removeListener('recording:start', handler); };
  },
  onStopCommand: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('recording:stop', handler);
    return () => { ipcRenderer.removeListener('recording:stop', handler); };
  },

  // Send recorded audio data to main process
  saveRecording: (buffer: ArrayBuffer, duration: number) =>
    ipcRenderer.invoke('recording:save', buffer, duration),

  // Notify main that recording has started/stopped
  notifyStarted: () => ipcRenderer.send('recording:started'),
  notifyStopped: () => ipcRenderer.send('recording:stopped'),

  // Report error
  reportError: (message: string) => ipcRenderer.send('recording:error', message),

  // Listen for errors from main process
  onError: (cb: (message: string) => void) => {
    const handler = (_: any, msg: string) => cb(msg);
    ipcRenderer.on('recording:error', handler);
    return () => { ipcRenderer.removeListener('recording:error', handler); };
  },

  // Real-time streaming
  sendRealtimeChunk: (buffer: ArrayBuffer, source?: string) =>
    ipcRenderer.send('realtime:chunk', buffer, source || 'mic'),

  onLiveSegment: (cb: (segment: any) => void) => {
    const handler = (_: any, seg: any) => cb(seg);
    ipcRenderer.on('live:segment', handler);
    return () => { ipcRenderer.removeListener('live:segment', handler); };
  },

  onSegmentOptimized: (cb: (data: { segId: number; cleanText: string }) => void) => {
    const handler = (_: any, data: any) => cb(data);
    ipcRenderer.on('live:segmentOptimized', handler);
    return () => { ipcRenderer.removeListener('live:segmentOptimized', handler); };
  },

  onSegmentSpeaker: (cb: (data: { segId: number; label: string; color: string; confidence: number }) => void) => {
    const handler = (_: any, data: any) => cb(data);
    ipcRenderer.on('live:segmentSpeaker', handler);
    return () => { ipcRenderer.removeListener('live:segmentSpeaker', handler); };
  },

  // Processing state (processing / done / skipped)
  onProcessingState: (cb: (state: string) => void) => {
    const handler = (_: any, state: string) => cb(state);
    ipcRenderer.on('recorder:processingState', handler);
    return () => { ipcRenderer.removeListener('recorder:processingState', handler); };
  },

  // Desktop sources for system audio capture
  getDesktopSources: () =>
    ipcRenderer.invoke('desktop:getSources'),

  // Window expand/collapse
  expandWindow: () => ipcRenderer.send('recorder:expand'),
  collapseWindow: () => ipcRenderer.send('recorder:collapse'),
});
