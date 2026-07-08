declare global {
  interface Window {
    recorderApi: {
      onStartCommand: (cb: (scene?: string) => void) => () => void;
      onStopCommand: (cb: () => void) => () => void;
      notifyStarted: (details?: { scene?: string; activeSources?: AudioSource[]; warnings?: string[] }) => void;
      notifyStopped: () => void;
      reportError: (message: string) => void;
      reportWarning: (message: string) => void;
      sendRealtimeChunk: (buffer: ArrayBuffer, source?: string) => void;
      onLiveSegment: (cb: (segment: { text: string; start?: number; source?: string; id?: number }) => void) => () => void;
      onSegmentOptimized: (cb: (data: { segId: number; cleanText: string }) => void) => () => void;
      onSegmentSpeaker: (cb: (data: { segId: number; label: string; color: string; confidence: number }) => void) => () => void;
      onProcessingState: (cb: (state: string) => void) => () => void;
      onError: (cb: (message: string) => void) => () => void;
      expandWindow: () => void;
      collapseWindow: () => void;
      getDesktopSources: () => Promise<Array<{ id: string; name: string }>>;
    };
  }
}

type AudioSource = 'mic' | 'system';

// --- DOM references ---
const timerEl = document.getElementById('timer')!;
const stopBtn = document.getElementById('stopBtn')!;
const toggleExpandBtn = document.getElementById('toggleExpand')!;
const transcriptEl = document.getElementById('transcript')!;
const processingTextEl = document.getElementById('processingText')!;
const doneTextEl = document.getElementById('doneText')!;
const sceneLabelEl = document.getElementById('sceneLabel');

// --- State ---
let startTime = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let mediaStream: MediaStream | null = null;
let expanded = true;
let recording = false;
let starting = false;
let liveSegments: { text: string; start: number; optimized: boolean; segId: number; speaker?: string; speakerColor?: string }[] = [];
let systemAudioContext: AudioContext | null = null;
let systemWorkletNode: AudioWorkletNode | null = null;
let systemMediaStream: MediaStream | null = null;
let currentScene: string = 'dictation';
let micDeviceChangeHandler: (() => void) | null = null;

// --- Timer ---
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateTimer() {
  timerEl.textContent = formatTime(Date.now() - startTime);
}

// --- Live transcript display ---
function isNearBottom(): boolean {
  // Consider "near bottom" if within 50px of the end
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 50;
}

function renderTranscript() {
  const wasAtBottom = isNearBottom();
  transcriptEl.innerHTML = liveSegments
    .map((seg) => {
      const m = Math.floor(seg.start / 60);
      const s = Math.floor(seg.start % 60);
      const ts = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      const cls = seg.optimized ? 'seg-line optimized' : 'seg-line';
      const speakerTag = seg.speaker
        ? `<span class="seg-speaker" style="color:${seg.speakerColor || '#71717a'}">${escapeHtml(seg.speaker)}</span>`
        : '';
      return `<div class="${cls}"><span class="seg-time">${ts}</span>${speakerTag}${escapeHtml(seg.text)}</div>`;
    })
    .join('');
  if (wasAtBottom) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Expand / Collapse ---
function setExpanded(value: boolean) {
  if (expanded === value) return;
  expanded = value;
  document.body.classList.toggle('expanded', expanded);
  document.body.classList.toggle('collapsed', !expanded);
  if (expanded) {
    window.recorderApi.expandWindow();
  } else {
    window.recorderApi.collapseWindow();
  }
}

// --- Mic capture ---
const MIC_CAPTURE_ERRORS = new Set([
  'microphone_denied',
  'microphone_not_found',
  'microphone_unavailable',
  'microphone_not_supported',
]);

const SYSTEM_AUDIO_CAPTURE_ERRORS = new Set([
  'system_audio_denied',
  'system_audio_no_track',
  'system_audio_unavailable',
  'system_audio_not_supported',
  'system_audio_fallback_mic_only',
]);

function mapMicCaptureError(err: unknown): string {
  if (err instanceof Error && MIC_CAPTURE_ERRORS.has(err.message)) {
    return err.message;
  }
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'microphone_denied';
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') return 'microphone_not_found';
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') return 'microphone_unavailable';
  }
  return String(err || 'microphone_unavailable');
}

function mapSystemAudioCaptureError(err: unknown): string {
  if (err instanceof Error && SYSTEM_AUDIO_CAPTURE_ERRORS.has(err.message)) {
    return err.message;
  }
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'system_audio_denied';
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') return 'system_audio_no_track';
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError' || err.name === 'AbortError') return 'system_audio_unavailable';
    if (err.name === 'NotSupportedError' || err.name === 'TypeError') return 'system_audio_not_supported';
  }
  const message = err instanceof Error ? err.message : String(err || '');
  if (/no audio track|audio track available/i.test(message)) return 'system_audio_no_track';
  return 'system_audio_unavailable';
}

function mapRecordingCaptureError(err: unknown): string {
  if (err instanceof Error && SYSTEM_AUDIO_CAPTURE_ERRORS.has(err.message)) {
    return err.message;
  }
  return mapMicCaptureError(err);
}

async function startMicCapture(): Promise<void> {
  // Try with ideal constraints first; fall back to plain audio:true for
  // devices/drivers that can't satisfy the full constraint set (common on Windows).
  let stream: MediaStream;
  console.log('[mic-diag] Requesting getUserMedia...');
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('microphone_not_supported');
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    console.log(`[mic-diag] Audio input devices: ${audioInputs.length}`, audioInputs.map(d => `${d.label}|${d.deviceId}`));
    if (audioInputs.length === 0) {
      throw new Error('microphone_not_found');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      console.log(`[mic-diag] getUserMedia ideal constraints failed: ${err instanceof DOMException ? `${err.name}: ${err.message}` : err}`);
      if (err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw new Error(mapMicCaptureError(err));
      }
    }
  } catch (err) {
    console.log(`[mic-diag] getUserMedia error: ${err instanceof DOMException ? `${err.name}: ${err.message}` : err}`);
    throw new Error(mapMicCaptureError(err));
  }
  mediaStream = stream;

  // Diagnose audio track
  const tracks = stream.getAudioTracks();
  console.log(`[mic-diag] Audio tracks: ${tracks.length}`);
  if (tracks.length === 0) {
    throw new Error('microphone_not_found');
  }
  if (tracks.length > 0) {
    const t = tracks[0];
    const s = t.getSettings();
    console.log(`[mic-diag] Track label: "${t.label}", enabled=${t.enabled}, muted=${t.muted}`);
    console.log(`[mic-diag] Settings: deviceId=${s.deviceId}, sampleRate=${s.sampleRate}, channelCount=${s.channelCount}`);
  }

  // Detect mic disconnect: track 'ended' fires when device is physically removed
  const micTrack = tracks.length > 0 ? tracks[0] : null;
  if (micTrack) {
    micTrack.addEventListener('ended', () => {
      console.warn('[mic-diag] Mic track ended — device disconnected');
      window.recorderApi.reportError('mic_disconnected');
    });
  }
  // Supplementary: detect device list changes (covers Bluetooth/USB reconnect scenarios)
  const onDeviceChange = async () => {
    if (!mediaStream) return;
    const currentDevices = await navigator.mediaDevices.enumerateDevices();
    const hasAudioInput = currentDevices.some(d => d.kind === 'audioinput' && d.deviceId !== '');
    if (!hasAudioInput) {
      console.warn('[mic-diag] No audio input devices available');
      window.recorderApi.reportError('mic_disconnected');
    }
  };
  micDeviceChangeHandler = onDeviceChange;
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  console.log(`[mic-diag] AudioContext state=${audioContext.state}, sampleRate=${audioContext.sampleRate}`);

  const processorUrl = new URL('./pcm-processor.js', import.meta.url);
  console.log(`[mic-diag] Loading AudioWorklet from: ${processorUrl.href}`);
  await audioContext.audioWorklet.addModule(processorUrl.href);
  console.log(`[mic-diag] AudioWorklet loaded OK`);

  const source = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor', {
    processorOptions: { targetSampleRate: 16000, nativeSampleRate: audioContext.sampleRate },
  });

  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    window.recorderApi.sendRealtimeChunk(event.data, 'mic');
  };

  source.connect(workletNode);

  // Connect worklet to a silent gain → destination so Chromium's audio engine
  // actually pulls from the MediaStream. Without this, MediaStreamAudioSourceNode
  // returns all-zero samples even when the mic is working and permission is granted.
  const silentOut = audioContext.createGain();
  silentOut.gain.value = 0;
  workletNode.connect(silentOut);
  silentOut.connect(audioContext.destination);
}

function stopMicCapture(): void {
  if (micDeviceChangeHandler) {
    navigator.mediaDevices?.removeEventListener?.('devicechange', micDeviceChangeHandler);
    micDeviceChangeHandler = null;
  }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// --- System audio capture ---
async function startSystemAudio(): Promise<void> {
  // Use getDisplayMedia for system audio — setDisplayMediaRequestHandler
  // in main process auto-selects screen source with audio: 'loopback'
  console.log('[sys-diag] Requesting getDisplayMedia for system audio...');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('system_audio_not_supported');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,  // required by spec, discarded immediately
    });
  } catch (err) {
    console.log(`[sys-diag] getDisplayMedia error: ${err instanceof DOMException ? `${err.name}: ${err.message}` : err}`);
    throw new Error(mapSystemAudioCaptureError(err));
  }

  // Discard video tracks — we only need audio
  stream.getVideoTracks().forEach(track => track.stop());

  if (stream.getAudioTracks().length === 0) {
    throw new Error('system_audio_no_track');
  }

  // Diagnose audio track
  const sysTracks = stream.getAudioTracks();
  console.log(`[sys-diag] Audio tracks: ${sysTracks.length}`);
  if (sysTracks.length > 0) {
    const t = sysTracks[0];
    const s = t.getSettings();
    console.log(`[sys-diag] Track label: "${t.label}", enabled=${t.enabled}, muted=${t.muted}`);
    console.log(`[sys-diag] Settings: sampleRate=${s.sampleRate}, channelCount=${s.channelCount}`);
  }

  systemMediaStream = stream;
  systemAudioContext = new AudioContext();
  if (systemAudioContext.state === 'suspended') {
    await systemAudioContext.resume();
  }
  console.log(`[sys-diag] AudioContext state=${systemAudioContext.state}, sampleRate=${systemAudioContext.sampleRate}`);

  const processorUrl = new URL('./pcm-processor.js', import.meta.url);
  await systemAudioContext.audioWorklet.addModule(processorUrl.href);

  const source = systemAudioContext.createMediaStreamSource(stream);
  systemWorkletNode = new AudioWorkletNode(systemAudioContext, 'pcm-processor', {
    processorOptions: {
      targetSampleRate: 16000,
      nativeSampleRate: systemAudioContext.sampleRate,
    },
  });

  systemWorkletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (event.data && event.data.byteLength > 0) {
      window.recorderApi.sendRealtimeChunk(event.data, 'system');
    }
  };

  source.connect(systemWorkletNode);

  // Connect worklet to silent gain → destination so Chromium pulls from MediaStream
  const silentOut = systemAudioContext.createGain();
  silentOut.gain.value = 0;
  systemWorkletNode.connect(silentOut);
  silentOut.connect(systemAudioContext.destination);
}

function stopSystemAudio(): void {
  if (systemWorkletNode) { systemWorkletNode.disconnect(); systemWorkletNode = null; }
  if (systemAudioContext) { systemAudioContext.close().catch(() => {}); systemAudioContext = null; }
  if (systemMediaStream) { systemMediaStream.getTracks().forEach(t => t.stop()); systemMediaStream = null; }
}

// --- Recording (scene-aware) ---
async function startRecording(scene: string = 'dictation') {
  if (recording || starting) return;
  starting = true;
  currentScene = scene;

  const needsMic = ['dictation', 'local_meeting', 'online_meeting'].includes(scene);
  const needsSystem = ['online_meeting', 'media'].includes(scene);

  try {
    const activeSources: AudioSource[] = [];
    const warnings: string[] = [];

    if (needsMic) {
      await startMicCapture();
      activeSources.push('mic');
    }
    if (needsSystem) {
      try {
        await startSystemAudio();
        activeSources.push('system');
      } catch (err) {
        const code = mapSystemAudioCaptureError(err);
        console.warn(`[sys-diag] System audio capture failed: ${code}`);
        if (scene === 'online_meeting' && activeSources.includes('mic')) {
          warnings.push('system_audio_fallback_mic_only');
          window.recorderApi.reportWarning('system_audio_fallback_mic_only');
        } else {
          throw new Error(code);
        }
      }
    }

    if (activeSources.length === 0) {
      throw new Error(needsSystem ? 'system_audio_unavailable' : 'microphone_unavailable');
    }

    recording = true;
    starting = false;
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 200);
    liveSegments = [];
    renderTranscript();

    document.body.classList.remove('processing', 'done');

    // Show scene badge in toolbar
    if (sceneLabelEl) {
      const sceneInfo: Record<string, { label: string; icon: string }> = {
        dictation: {
          label: '口述',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
        },
        local_meeting: {
          label: '会议',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        },
        online_meeting: {
          label: '线上',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
        },
        media: {
          label: '媒体',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
        },
      };
      const info = sceneInfo[scene] || sceneInfo.dictation;
      // Remove any previous scene-* class
      sceneLabelEl.className = 'scene-label';
      sceneLabelEl.innerHTML = info.icon + info.label;
      sceneLabelEl.classList.add('visible', `scene-${scene}`);
    }

    setExpanded(true);
    window.recorderApi.notifyStarted({ scene, activeSources, warnings });
  } catch (err) {
    starting = false;
    // Cleanup any partially initialized streams
    stopMicCapture();
    stopSystemAudio();

    window.recorderApi.reportError(mapRecordingCaptureError(err));
    window.recorderApi.notifyStopped();
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;

  const needsMic = ['dictation', 'local_meeting', 'online_meeting'].includes(currentScene);
  const needsSystem = ['online_meeting', 'media'].includes(currentScene);

  if (needsMic) stopMicCapture();
  if (needsSystem) stopSystemAudio();

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  // DO NOT clear transcript or collapse — let processing/done state handle it
  window.recorderApi.notifyStopped();
}

/** Reset UI state for next recording (called when window hides or before new recording). */
function resetUI() {
  timerEl.textContent = '00:00';
  liveSegments = [];
  renderTranscript();
  document.body.classList.remove('processing', 'done');
}

// --- Wire up IPC commands from main process ---
const cleanupStart = window.recorderApi.onStartCommand((scene?: string) => {
  resetUI();
  startRecording(scene || 'dictation');
});

const cleanupStop = window.recorderApi.onStopCommand(() => {
  stopRecording();
});

// --- Wire up live segment updates ---
const cleanupLiveSegment = window.recorderApi.onLiveSegment((segment) => {
  const sourceTag = currentScene === 'online_meeting' && segment.source === 'system' ? '[对方] ' : '';
  liveSegments.push({
    text: sourceTag + segment.text,
    start: segment.start || 0,
    optimized: false,
    segId: segment.id || 0,
  });
  renderTranscript();
});

// --- Wire up segment optimization results ---
const cleanupSegOptimized = window.recorderApi.onSegmentOptimized((data) => {
  const seg = liveSegments.find(s => s.segId === data.segId);
  if (seg) {
    const sourcePrefix = seg.text.startsWith('[对方] ') ? '[对方] ' : '';
    seg.text = sourcePrefix + data.cleanText;
    seg.optimized = true;
    renderTranscript();
  }
});

// --- Wire up speaker identification results ---
const cleanupSegSpeaker = window.recorderApi.onSegmentSpeaker((data) => {
  const seg = liveSegments.find(s => s.segId === data.segId);
  if (seg) {
    seg.speaker = data.label;
    seg.speakerColor = data.color;
    renderTranscript();
  }
});

// --- Wire up error display ---
const cleanupError = window.recorderApi.onError((msg: string) => {
  const transcript = document.getElementById('transcript');
  if (transcript) {
    transcript.innerHTML = `<div class="error-msg" style="color: #dc2626; font-size: 12px; padding: 8px; font-family: monospace;">&#9888; ${escapeHtml(msg)}</div>`;
  }
});

// --- Wire up processing state ---
const cleanupProcessing = window.recorderApi.onProcessingState((state) => {
  if (state === 'optimizing' || state === 'processing') {
    document.body.classList.remove('done');
    document.body.classList.add('processing');
    processingTextEl.innerHTML = '优化文本中<span class="processing-dots"></span>';
  } else if (state === 'done') {
    document.body.classList.remove('processing');
    document.body.classList.add('done');
    doneTextEl.textContent = '已复制到剪贴板';
  } else if (state === 'skipped') {
    document.body.classList.remove('processing', 'done');
  }
});

// --- Wire up buttons ---
stopBtn.addEventListener('click', () => {
  stopRecording();
});

toggleExpandBtn.addEventListener('click', () => {
  setExpanded(!expanded);
});

// --- Cleanup on unload ---
window.addEventListener('beforeunload', () => {
  cleanupStart();
  cleanupStop();
  cleanupLiveSegment();
  cleanupSegOptimized();
  cleanupSegSpeaker();
  cleanupError();
  cleanupProcessing();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
});

export {};
