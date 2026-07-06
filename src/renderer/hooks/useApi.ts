import { createMockApi } from './useApi.mock';

export interface SyncStatus {
  enabled: boolean;
  syncDir: string;
  machineId: string;
  readOnly: boolean;
  lockHolder: { machineId: string; hostname: string; acquiredAt: string } | null;
}

export interface QueueTaskEvent {
  id: string;
  filePath: string;
  status: string;
  progress: number;
  error?: string;
  notes?: string;
  mediaType?: string;
  createdAt: string;
}

export interface AppSettings {
  setupComplete: boolean;
  watchDir: string;
  autoProcessWatchDir: boolean;
  outputDir: string;
  llamaServerPort: number;
  llamaEmbedPort: number;
  whisperModel: string;
  llmModel: string;
  embedModel: string;
  hfToken: string;
  llmProvider: 'local' | 'openai';
  localLlmModel: string;
  localEmbedModel: string;
  cloudApiUrl: string;
  cloudApiKey: string;
  cloudModel: string;
  cloudEmbedModel: string;
  cloudPresetId: string;
  cloudProviderConfigs: Record<string, { url: string; apiKey: string; model: string; embedModel: string }>;
  language: 'en' | 'zh';
  userNickname: string;
  asrLanguage: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  realtimeDailySummary: boolean;
  autoReportDaily: boolean;
  autoReportDailyTime: string;
  autoReportWeekly: boolean;
  autoReportWeeklyDay: number;
  autoReportWeeklyTime: string;
  autoReportMonthly: boolean;
  autoReportMonthlyDay: number;
  autoReportMonthlyTime: string;
  obsidianVaultDir: string;
  obsidianAutoExport: boolean;
  obsidianWikilinks: boolean;
  sceneShortcuts: {
    dictation: string;
    local_meeting: string;
    online_meeting: string;
    media: string;
  };
  autoPasteAfterRecording: boolean;
  clipboardContinuous: boolean;
  llmCleanBeforePaste: boolean;
  llmCleanPrompt: string;
  hotwords: string[];
  feishuAppId: string;
  feishuAppSecret: string;
  feishuEnabled: boolean;
  feishuNotifyOnComplete: boolean;
  feishuNotifyDailyDigest: boolean;
  feishuAdminOpenId: string;
  feishuCliEnabled: boolean;
  feishuCliInstallPath: string;
  feishuCliLastStatus: string;
  feishuCliSyncScopes: string;
  feishuCliLastSyncAt: string;
  wechatCorpId: string;
  wechatAgentId: string;
  wechatSecret: string;
  wechatEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  dingtalkAppKey: string;
  dingtalkAppSecret: string;
  dingtalkRobotCode: string;
  dingtalkEnabled: boolean;
  openclawWechatEnabled: boolean;
  wechatToken: string;
  wechatEncodingAESKey: string;
  notificationSound: boolean;
  showAllFeatures: boolean;
  soulConfig: string;
  agentsRules: string;
  vocabularyContext: string;
  streamingModel: string;
  pasteCleanModel: string;
  workflowTodoPush: boolean;
  workflowDecisionPush: boolean;
  workflowUrgentPush: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFromName: string;
  emailRecipient: string;
  emailEnabled: boolean;
  firstLaunchTime: number;
  licensing: string;
  licenseKey: string;
  diarizationMethod: 'embedding' | 'legacy';
  relayTunnelEnabled: boolean;
  pipelinePrompts: {
    textClean: string;
    imageAnalysis: string;
    videoAnalysis: string;
    infoExtract: string;
    dailySummary: string;
    classify: string;
    memoryExtract: string;
    speakerCorrection: string;
  };
  plugins: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    inject_prompt?: string;
    skill_path?: string;
    instructions?: string;
    mcp?: { command: string; args: string[]; env?: Record<string, string>; autoStart: boolean };
    page?: { icon?: string; menuLabel?: string; welcomeMessage?: string };
    source: string;
    sourceUri?: string;
    version?: string;
  }>;
}

export interface EnvCheckItem {
  status: 'ok' | 'missing' | 'error';
  version?: string;
}

export interface EnvCheckResult {
  ffmpeg: EnvCheckItem;
  local: EnvCheckItem;
  sherpaModels: EnvCheckItem;
}

export interface ModelPullProgress {
  model: string;
  status: string;
  total: number;
  completed: number;
  error?: string;
  updatedAt?: number;
}

export interface SetupProgress {
  step: string;
  output: string;
}

export interface HardwareInfo {
  totalMemoryGB: number;
  freeMemoryGB: number;
  cpuCores: number;
  platform: string;
  arch: string;
  recommendedLlmModel: string;
  recommendedQuality: 'basic' | 'good' | 'excellent';
}

export interface SherpaModelsCheckResult {
  allReady: boolean;
  models: { id: string; name: string; installed: boolean }[];
}

export interface SystemAudioDevice {
  id: number;
  name: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
}

export interface LicenseStatus {
  licensed: boolean;
  trial: { active: boolean; daysRemaining: number; firstLaunchTime: number };
  licenseKey: string | null;
  tier: 'free' | 'trial' | 'personal' | 'professional' | 'lifetime';
  features: string[];
}

// ─── Database Row Types ──────────────────────────────────

export interface RecordingRow {
  id: number;
  file_path: string;
  file_name: string;
  duration_seconds: number | null;
  recorded_at: string | null;
  processed_at: string | null;
  status_updated_at?: string | null;
  status: string;
  speaker_count: number;
  extracted_count: number;
  tags?: string;
  capture_scene?: string;
  media_type?: string;
  page_count?: number;
  word_count?: number;
  custom_title?: string | null;
  custom_category?: string | null;
  /** AI-generated whole-transcript title (5-15 chars). Set after
   * transcription completes; independent of meeting_notes — covers
   * dictation and short voice notes that don't get meeting notes. */
  auto_title?: string | null;
  /** AI-extracted meeting notes JSON (parsed = MeetingNotes). Present on
   * rows that have been through LLM post-processing. */
  meeting_notes_json?: string | null;
  /** First transcript segment text. Falls back to displayable title when
   * neither custom_title nor meeting_notes_json yield a name. */
  first_segment_text?: string | null;
  /** LLM-assigned importance score 0-10. 0 = unscored. */
  importance_score?: number;
  /** FK to capture session if this recording was grouped into one. */
  session_id?: number | null;
}

export interface SessionRow {
  id: number;
  date: string;
  started_at: string;
  ended_at: string;
  topic: string | null;
  summary: string | null;
  importance_score: number;
  member_count: number;
  is_finalized: 0 | 1;
}

export interface CuratedDay {
  sessions: Array<{ session: SessionRow; members: RecordingRow[] }>;
  standalones: RecordingRow[];
  briefs: RecordingRow[];
}

export interface SegmentRow {
  id: number;
  recording_id: number;
  speaker_id: number | null;
  start_time: number;
  end_time: number;
  raw_text: string | null;
  clean_text: string | null;
  sentiment: string | null;
  bookmarked: number;
  created_at: string;
  speaker_name: string | null;
  recording_name?: string | null;
}

export interface SpeakerSampleRow {
  recording_id: number;
  start_time: number;
  end_time: number;
  raw_text: string | null;
  clean_text: string | null;
}

export interface ExtractedItemRow {
  id: number;
  segment_id: number | null;
  type: string;
  content: string;
  due_date: string | null;
  related_person: string | null;
  status: string;
  source: string;
  recording_id?: number | null;
  // New 2.0 fields:
  priority?: string | null;      // 'urgent' | 'normal' | 'low'
  assignee?: string | null;
  reminder_sent?: number | null;  // 0 or 1
  auto_detected_due?: string | null;
}

export interface DailySummaryRow {
  id: number;
  date: string;
  summary_text: string | null;
  timeline_json: string | null;
  key_events_json: string | null;
}

export interface WeeklySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}

export interface MonthlySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}

export interface ChatMessageRow {
  id: number;
  session_id: number | null;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface RecordingChatMessageRow {
  id: number;
  recording_id: number;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface RagSource {
  segment_id: number;
  speaker: string;
  text: string;
  time: string;
}

export interface ActiveRagStream {
  kind: 'global' | 'scoped';
  question: string;
  text: string;
  status: string;
  active: boolean;
  startedAt: number;
  updatedAt: number;
  sessionId?: number;
  recordingId?: number;
}

export interface ChannelSessionRow {
  id: number;
  channel_id: string;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  message_count: number;
}

export interface ChannelMessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PersonRow {
  id: number;
  name: string;
  type: string;           // 'human' | 'organization' | 'alias' | 'unknown'
  notes: string | null;
  created_at: string;
  updated_at: string;
  segment_count: number;
  total_duration: number;
}

export interface PersonIdentifierRow {
  id: number;
  person_id: number;
  type: string;           // 'voice' | 'name' | 'email' | 'phone' | 'mention' | 'face'
  value: string;
  confidence: number;
  source: string | null;
  created_at: string;
}

export interface PersonRelationshipRow {
  id: number;
  person_id: number;
  mentioned_name: string;
  relationship: string | null;
  context: string | null;
  recording_id: number | null;
  created_at: string;
  person_name?: string | null;
}

export interface PersonCoOccurrenceRow {
  person1_id: number;
  person1_name: string | null;
  person2_id: number;
  person2_name: string | null;
  shared_recordings: number;
}

export interface MeetingNotes {
  title: string;
  participants: { name: string; speakingTime: number }[];
  decisions: string[];
  actionItems: { assignee: string; task: string; dueDate?: string }[];
  discussionSummary: string;
  keyTopics: string[];
}

// ─── IPC Event type (replaces `any` in event callbacks) ──

// eslint-disable-next-line @typescript-eslint/no-empty-interface
type IpcEvent = unknown;

export interface MemoryRow {
  id: number;
  fact: string;
  category: string;
  layer: 'core' | 'active' | 'archive';
  confidence: number;
  mention_count: number;
  first_seen: string;
  last_seen: string;
  source_ids: string;
}

export interface MemoryStats {
  core: number;
  active: number;
  archive: number;
}

export interface MemoryDocument {
  id: number;
  date: string;
  content: string;
  auto_generated: number;
  updated_at: string;
}

export interface TextNoteRow {
  id: number;
  channel_id: string;
  user_id: string;
  user_name: string | null;
  content: string;
  agent_reply: string | null;
  created_at: string;
}

export interface MemoryDateEntry {
  date: string;
  has_recordings: boolean;
  recording_count: number;
}

export interface DownloadItem {
  id: string;
  label: string;
  status: 'pending' | 'downloading' | 'done' | 'error' | 'skipped';
  progress: number;
  error?: string;
}

export interface DownloadManagerState {
  items: DownloadItem[];
  active: boolean;
  overallProgress: number;
}

// ─── Scheduler Types ─────────────────────────────────────

export interface ScheduledTaskRow {
  id: number;
  name: string;
  description: string | null;
  task_type: string;
  action: string;
  action_params: string | null;
  schedule_type: string;
  schedule_expr: string | null;
  schedule_display: string | null;
  is_recurring: number;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_result: string | null;
  run_count: number;
  fail_count: number;
  retry_count: number;
  permission_level: string;
  allowed_tools: string | null;
  channels_override: string | null;
  missed_policy: string;
  max_miss_hours: number;
  max_retries: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskExecutionRow {
  id: number;
  task_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  result_summary: string | null;
  error_message: string | null;
  channels_notified: string | null;
}

export interface ParsedSchedule {
  type: 'cron' | 'interval' | 'once';
  expr: string;
  display: string;
  nextRunAt: string | null;
}

export interface PipelineRecoveryResult {
  attempted: boolean;
  repaired: boolean;
  actions: string[];
  errors: string[];
  backupDir?: string;
  rolledBack?: boolean;
}

export type PipelineRetryResult = boolean | {
  ok: boolean;
  error?: string;
  recovery?: PipelineRecoveryResult;
};

export interface PipelineReprocessResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  recovery?: PipelineRecoveryResult;
}

export interface PipelineEnqueueResult {
  id: string;
  status: string;
  error?: string;
  reason?: string;
  recordingId?: number;
}

// ─── API Interface ───────────────────────────────────────

export interface VoiceBrainApi {
  // Dialog
  openFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
  openFiles: (filters?: { name: string; extensions: string[] }[]) => Promise<string[]>;
  selectDirectory: () => Promise<string | null>;

  // Pipeline
  enqueue: (filePath: string) => Promise<PipelineEnqueueResult>;
  getQueue: () => Promise<Array<{
    id: string;
    filePath: string;
    status: string;
    progress: number;
    error?: string;
    notes?: string;
    mediaType?: string;
    createdAt: string;
  }>>;
  cancelTask: (taskId: string) => Promise<boolean>;
  retryTask: (taskId: string) => Promise<PipelineRetryResult>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  isQueuePaused: () => Promise<boolean>;
  resetStuckTasks: () => Promise<{ queueCount: number; dbCount: number }>;
  reprocessRecording: (recordingId: number) => Promise<PipelineReprocessResult>;
  reoptimizeRecording: (recordingId: number) => Promise<{ ok: boolean; error?: string }>;

  // Database - Recordings
  getRecordings: () => Promise<RecordingRow[]>;
  getSegmentsByRecording: (recordingId: number) => Promise<SegmentRow[]>;
  searchSegments: (query: string) => Promise<SegmentRow[]>;

  // Database - Meeting Notes
  getMeetingNotes: (recordingId: number) => Promise<MeetingNotes | null>;
  regenerateMeetingNotes: (recordingId: number) => Promise<MeetingNotes | { error: string }>;
  backfillTitles: (maxBatch?: number) => Promise<{ scanned: number; generated: number; failed: number }>;
  backfillCuration: (maxBatch?: number) => Promise<{ scanned: number; scored: number; sessioned: number; failed: number }>;
  finalizeStaleSessions: () => Promise<{ stale: number; finalized: number }>;
  getTodayCuratedItems: (date: string) => Promise<CuratedDay>;

  // Database - Update Recording
  updateRecordingTitle: (id: number, title: string) => Promise<{ success: boolean; error?: string }>;
  updateRecordingCategory: (id: number, category: string | null) => Promise<{ success: boolean; error?: string }>;
  updateSegmentText: (id: number, text: string) => Promise<{ success: boolean; error?: string }>;

  // Database - Clear / Delete
  deleteRecording: (id: number) => Promise<{ success: boolean; error?: string }>;
  clearAllData: () => Promise<void>;

  // Database - Extracted Items
  getExtractedItems: (typeOrOpts?: string | { recordingId?: number; type?: string }) => Promise<ExtractedItemRow[]>;
  getAllExtractedItems: () => Promise<ExtractedItemRow[]>;
  createExtractedItem: (data: { type: string; content: string; due_date?: string; related_person?: string; source?: string }) => Promise<number | null>;
  updateExtractedItemStatus: (id: number, status: string) => Promise<void>;
  updateExtractedItem: (id: number, data: { content?: string; due_date?: string; related_person?: string; status?: string; type?: string }) => Promise<void>;
  deleteExtractedItem: (id: number) => Promise<void>;

  // Database - Stats
  getDbStats: () => Promise<{ recordingCount: number; segmentCount: number; dbSize: number }>;

  // Database - Segment Bookmarks
  toggleBookmark: (segmentId: number) => Promise<{ success: boolean; bookmarked?: boolean }>;
  getBookmarkedSegments: () => Promise<SegmentRow[]>;

  // Database - Dashboard Charts
  getDashboardCharts: () => Promise<{
    recordingsPerDay: { date: string; count: number }[];
    sentimentDistribution: { sentiment: string; count: number }[];
    topSpeakers: { id: number; name: string; count: number; duration: number }[];
    calendarActivity: { date: string; count: number }[];
  }>;

  // Database - Daily Summary
  getDailySummary: (date: string) => Promise<DailySummaryRow | null>;
  getSegmentsByDate: (date: string) => Promise<SegmentRow[]>;
  getTextNotes: (limit?: number) => Promise<TextNoteRow[]>;
  getTextNoteById: (id: number) => Promise<TextNoteRow | null>;

  // Person CRUD
  getPersons: () => Promise<PersonRow[]>;
  getPerson: (id: number) => Promise<PersonRow | null>;
  createPerson: (data: { name: string; type?: string; notes?: string }) => Promise<PersonRow>;
  updatePerson: (id: number, data: Partial<{ name: string; avatar_path: string; gender: string; company: string; title: string; tags: string[]; profile_markdown: string; source: string; knowledge_page_id: number | null }>) => Promise<PersonRow>;
  deletePerson: (id: number) => Promise<{ success: boolean }>;
  mergePersons: (fromId: number, toId: number) => Promise<{ success: boolean }>;

  // Person Identifiers
  getPersonIdentifiers: (personId: number) => Promise<PersonIdentifierRow[]>;
  addPersonIdentifier: (data: { person_id: number; type: string; value: string; confidence?: number }) => Promise<PersonIdentifierRow>;
  deletePersonIdentifier: (id: number) => Promise<{ success: boolean }>;

  // Content-Person Links
  getContentByPerson: (personId: number, limit?: number) => Promise<SegmentRow[]>;

  // Person Relationships
  getPersonRelationships: (personId: number) => Promise<PersonRelationshipRow[]>;
  getAllPersonRelationships: () => Promise<PersonRelationshipRow[]>;
  getPersonCoOccurrences: () => Promise<PersonCoOccurrenceRow[]>;
  getPersonSample: (personId: number) => Promise<SpeakerSampleRow | null>;

  // Summary Generation
  generateDailySummary: (date: string) => Promise<DailySummaryRow & { error?: string }>;
  generateWeeklySummary: (startDate: string, endDate: string) => Promise<{ summary_json?: string; error?: string }>;
  getAllDailySummaries: () => Promise<DailySummaryRow[]>;
  deleteDailySummary: (date: string) => Promise<{ success: boolean }>;
  updateDailySummaryKeyEvents: (date: string, keyEventsJson: string) => Promise<{ success: boolean }>;
  getAllWeeklySummaries: () => Promise<WeeklySummaryRow[]>;
  deleteWeeklySummary: (startDate: string, endDate: string) => Promise<{ success: boolean }>;
  generateMonthlySummary: (startDate: string, endDate: string) => Promise<{ summary_json?: string; error?: string } & Record<string, unknown>>;
  getAllMonthlySummaries: () => Promise<MonthlySummaryRow[]>;
  deleteMonthlySummary: (startDate: string, endDate: string) => Promise<{ success: boolean }>;

  // Export
  exportDailySummary: (date: string) => Promise<{ filePath?: string; error?: string }>;
  exportTranscript: (recordingId: number) => Promise<{ filePath?: string; error?: string }>;
  exportWeeklySummary: (startDate: string, endDate: string, data: Record<string, unknown>) => Promise<{ filePath?: string; error?: string }>;
  exportMonthlySummary: (startDate: string, endDate: string, data: Record<string, unknown>) => Promise<{ filePath?: string; error?: string }>;
  exportMeetingNotes: (recordingId: number) => Promise<{ filePath?: string; error?: string }>;

  // Obsidian
  obsidianSyncAll: () => Promise<{ success: boolean; count?: number; error?: string }>;
  obsidianSyncFile: (relativePath: string) => Promise<{ success: boolean; dest?: string; error?: string }>;

  // Audio
  getAudioPath: (recordingId: number) => Promise<string | null>;

  // Chat Sessions
  createSession: (title?: string) => Promise<{ success: boolean; id?: number }>;
  getSessions: () => Promise<Array<{ id: number; title: string; created_at: string; updated_at: string }>>;
  renameSession: (id: number, title: string) => Promise<{ success: boolean }>;
  deleteSession: (id: number) => Promise<{ success: boolean }>;
  getSessionMessages: (sessionId: number) => Promise<ChatMessageRow[]>;

  // Channel Sessions (read-only)
  getChannelSessions: () => Promise<ChannelSessionRow[]>;
  getChannelSessionMessages: (sessionId: number) => Promise<ChannelMessageRow[]>;

  // Chat Messages
  saveChatMessage: (sessionId: number, role: string, content: string, sourcesJson?: string) => Promise<{ success: boolean; id?: number }>;
  clearChatMessages: (sessionId: number) => Promise<{ success: boolean }>;
  deleteChatMessage: (messageId: number) => Promise<{ success: boolean; error?: string }>;

  // Per-recording chat history (Library Q&A)
  getRecordingChatMessages: (recordingId: number) => Promise<RecordingChatMessageRow[]>;
  clearRecordingChatMessages: (recordingId: number) => Promise<{ success: boolean }>;
  deleteRecordingChatMessage: (messageId: number) => Promise<{ success: boolean; error?: string }>;

  // RAG
  ragQuery: (question: string) => Promise<{ answer: string; sources: RagSource[] }>;
  ragQueryStream: (question: string, sessionId?: number) => Promise<{ success: boolean; error?: string }>;
  ragCancelStream: () => Promise<void>;
  getActiveRagStream: (sessionId?: number) => Promise<ActiveRagStream | null>;
  onRagStreamChunk: (cb: (event: IpcEvent, chunk: string) => void) => () => void;
  onRagStreamDone: (cb: (event: IpcEvent, sources: RagSource[]) => void) => () => void;
  onRagStreamError: (cb: (event: IpcEvent, error: string) => void) => () => void;
  onRagStreamStatus: (cb: (event: IpcEvent, status: string) => void) => () => void;

  // Scoped RAG (per-recording Q&A)
  ragScopedQueryStream: (
    question: string,
    recordingId: number,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => Promise<{ success: boolean; error?: string }>;
  ragCancelScopedStream: () => Promise<void>;
  getActiveScopedRagStream: (recordingId: number) => Promise<ActiveRagStream | null>;
  onRagScopedChunk: (cb: (event: IpcEvent, chunk: string) => void) => () => void;
  onRagScopedDone: (cb: (event: IpcEvent, sources: RagSource[]) => void) => () => void;
  onRagScopedError: (cb: (event: IpcEvent, error: string) => void) => () => void;
  onRagScopedStatus: (cb: (event: IpcEvent, status: string) => void) => () => void;

  // System
  openDevTools: () => Promise<void>;
  getMainLogs: () => Promise<string[]>;
  onMainLog: (cb: (event: IpcEvent, log: string) => void) => () => void;
  getStatus: () => Promise<{
    local: boolean;
    aiProvider: 'local' | 'openai';
    dbReady: boolean;
    storageUsed: string;
  }>;
  checkCloudApi: (url: string, apiKey: string, model?: string) => Promise<{ ok: boolean; error?: string }>;
  listCloudModels: (url: string, apiKey: string) => Promise<string[]>;
  checkScreenPermission: () => Promise<string>;

  // Settings
  loadSettings: () => Promise<AppSettings>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>;

  // Hardware Detection
  detectHardware: () => Promise<HardwareInfo>;
  getDefaultPrompts: () => Promise<AppSettings['pipelinePrompts']>;

  // Environment & Models
  detectEnvironment: () => Promise<EnvCheckResult>;
  listModels: () => Promise<string[]>;
  pullModel: (modelName: string, force?: boolean) => Promise<{ success: boolean; model: string; error?: string }>;
  testLocal: (modelName?: string) => Promise<{ success: boolean; error?: string }>;
  cancelPull: (modelName?: string) => Promise<void>;
  getPullStatus: () => Promise<ModelPullProgress[]>;
  checkSherpaModels: () => Promise<SherpaModelsCheckResult>;
  downloadSherpaModels: (mirror?: string, force?: boolean) => Promise<{ success: boolean; error?: string }>;
  cancelSherpaDownload: () => Promise<void>;
  getSherpaDownloadStatus: () => Promise<{ model: string; completed: number; total: number; status: string } | null>;
  openExternal: (url: string) => Promise<void>;
  openPath: (dirPath: string) => Promise<void>;
  openLocalModelsDir: () => Promise<void>;
  isLocalInstalled: () => Promise<boolean>;
  installLocal: () => Promise<{ success: boolean; error?: string }>;
  onLocalInstallProgress: (cb: (event: IpcEvent, data: { stage: string; completed: number; total: number }) => void) => () => void;
  getDataDir: () => Promise<string>;
  clipboardWriteText: (text: string) => Promise<void>;

  // File Utilities
  getPathForFile: (file: File) => string;

  // FFmpeg Management
  checkFFmpeg: () => Promise<{ ready: boolean }>;
  downloadFFmpeg: () => Promise<{ success: boolean; error?: string }>;
  cancelFFmpegDownload: () => Promise<void>;
  onFFmpegDownloadProgress: (cb: (event: IpcEvent, data: { completed: number; total: number; stage: string }) => void) => () => void;

  // Local Auto-Install

  // Setup progress events
  onSetupProgress: (cb: (event: IpcEvent, data: SetupProgress) => void) => () => void;

  // Model pull progress events
  onModelPullProgress: (cb: (event: IpcEvent, data: ModelPullProgress) => void) => () => void;

  // Task events
  onTaskAdded: (cb: (event: IpcEvent, task: QueueTaskEvent) => void) => () => void;
  onTaskProgress: (cb: (event: IpcEvent, task: QueueTaskEvent) => void) => () => void;
  onTaskCompleted: (cb: (event: IpcEvent, task: QueueTaskEvent) => void) => () => void;
  onTaskCancelled: (cb: (event: IpcEvent, task: QueueTaskEvent) => void) => () => void;
  onTextNoteNew: (cb: (event: IpcEvent, note: TextNoteRow) => void) => () => void;
  onTaskFailed: (cb: (event: IpcEvent, task: QueueTaskEvent) => void) => () => void;

  // Keyboard shortcut events
  onShortcutSearch: (cb: () => void) => () => void;
  onShortcutSettings: (cb: () => void) => () => void;

  // Recording
  toggleRecording: (scene?: string) => Promise<{ recording: boolean }>;
  updateSceneShortcut: (scene: string, shortcut: string) => Promise<boolean>;

  // Recording events
  onRecordingStateChanged: (cb: (event: IpcEvent, recording: boolean) => void) => () => void;
  onRecordingSaved: (cb: (event: IpcEvent, data: { filePath: string; duration: number }) => void) => () => void;
  onRecordingError: (cb: (event: IpcEvent, error: string) => void) => () => void;
  onPostProcessing: (cb: (event: IpcEvent, data: { active: boolean; recordingId: number }) => void) => () => void;
  onPostProcessComplete: (cb: (event: IpcEvent, data: { recordingId: number }) => void) => () => void;

  // Feishu Bot
  feishuGetStatus: () => Promise<{ status: string }>;
  feishuTestConnection: (appId: string, appSecret: string) => Promise<{ success: boolean; error?: string; adminOpenId?: string }>;
  feishuRestart: () => Promise<{ status: string; error?: string }>;
  feishuSimulate: (params: { type: string; text?: string; wavPath?: string; msgType?: string }) => Promise<any>;
  feishuRunTestSuite: () => Promise<any>;

  // External Source Providers (Feishu CLI is the built-in provider)
  externalSourcesListProviders: () => Promise<Array<{ id: string; displayName: string; domains: string[] }>>;
  externalSourcesGetStatus: (source: string) => Promise<any>;
  externalSourcesSyncNow: (source: string, domains?: string[]) => Promise<{ ok: boolean; documents: number; chunks: number; error?: string }>;
  feishuCliGetStatus: () => Promise<{
    installed: boolean;
    installPath: string | null;
    configured: boolean;
    loggedIn: boolean;
    user: { open_id: string; name: string; avatar_url?: string; scopes: string[] } | null;
    lastSyncAt: string | null;
    error?: string;
  }>;
  feishuCliInstall: () => Promise<{ ok: boolean; error?: string }>;
  feishuCliInitConfig: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  feishuCliLogin: (scopes?: string[]) => Promise<{ ok: boolean; url?: string; deviceCode?: string; error?: string }>;
  feishuCliPollLogin: (deviceCode: string) => Promise<{ ok: boolean; error?: string }>;
  feishuCliLogout: () => Promise<{ ok: boolean; error?: string }>;
  feishuCliSyncNow: () => Promise<{ ok: boolean; documents: number; chunks: number; error?: string }>;

  // WeChat
  wechatTestConnection: (corpId: string, secret: string) => Promise<{ success: boolean; error?: string }>;

  // Telegram
  telegramTestConnection: (botToken: string) => Promise<{ success: boolean; username?: string; error?: string }>;

  // OpenClaw WeChat (Personal)
  openclawWechatGetQRCode: () => Promise<{ qrcodeId: string; qrcodeImage: string }>;
  openclawWechatGetQRCodeStatus: (qrcodeId: string) => Promise<{ status: 'pending' | 'confirmed' | 'expired'; credentials?: any }>;
  openclawWechatTestConnection: () => Promise<{ success: boolean; error?: string }>;
  openclawWechatLogout: () => Promise<{ success: boolean }>;
  openclawWechatGetStatus: () => Promise<{ status: 'connected' | 'authenticated' | 'disconnected' }>;

  // Email
  emailTestConnection: (host: string, port: number, user: string, pass: string) => Promise<{ success: boolean; error?: string }>;

  // Sync
  syncGetStatus: () => Promise<SyncStatus>;
  syncEnable: (syncDir: string) => Promise<{ success: boolean; error?: string }>;
  syncDisable: () => Promise<{ success: boolean; error?: string }>;
  syncTryAcquireLock: () => Promise<{ acquired: boolean }>;

  // Real-time transcription
  realtimeStart: () => Promise<{ success: boolean; recordingId?: number; error?: string }>;
  realtimeStop: () => Promise<{ success: boolean; recordingId?: number; duration?: number; error?: string }>;
  realtimeStatus: () => Promise<{ recording: boolean; recordingId: number | null }>;
  onLiveStarted: (cb: (event: IpcEvent, data: { recordingId: number }) => void) => () => void;
  onLiveSegment: (cb: (event: IpcEvent, data: { index: number; text: string; start: number; end: number }) => void) => () => void;
  onLiveStopped: (cb: (event: IpcEvent) => void) => () => void;
  onLivePostComplete: (cb: (event: IpcEvent, data: { recordingId: number }) => void) => () => void;
  onLiveError: (cb: (event: IpcEvent, error: string) => void) => () => void;

  // System Audio Capture
  systemAudioListDevices: () => Promise<SystemAudioDevice[] | { error: string }>;
  systemAudioStart: (deviceId?: number) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  systemAudioStop: () => Promise<{ success: boolean; error?: string }>;
  systemAudioStatus: () => Promise<{ capturing: boolean }>;
  onSystemAudioProgress: (cb: (event: IpcEvent, data: { duration: number }) => void) => () => void;
  onSystemAudioStopped: (cb: (event: IpcEvent, data: { code: number; totalDuration?: number; outputPath?: string }) => void) => () => void;

  // License Management
  licenseGetStatus: () => Promise<LicenseStatus>;
  licenseIsPro: () => Promise<boolean>;
  licenseActivate: (key: string) => Promise<{ success: boolean; tier?: string; error?: string }>;
  licenseDeactivate: () => Promise<{ success: boolean }>;
  onLicenseChanged: (callback: () => void) => (() => void) | undefined;

  // LAN Server
  lanServerGetStatus: () => Promise<{ running: boolean; clientCount: number; host?: string; port?: number; token?: string | null; fingerprint?: string; relayUrl?: string }>;
  lanServerStart: () => Promise<{ success: boolean; host?: string; port?: number; token?: string | null; fingerprint?: string; error?: string }>;
  lanServerStop: () => Promise<{ success: boolean }>;

  // Public network relay (P2P + server relay fallback)
  relayGetStatus: () => Promise<{
    enabled: boolean;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    paired: boolean;
    transportMode: 'none' | 'p2p' | 'relay';
  }>;
  relayEnable: (enabled: boolean) => Promise<{ success: boolean; status: string }>;
  relayGetPairingQR: () => Promise<{ url?: string; expiresAt?: number; error?: string }>;
  relayUnpair: () => Promise<{ success: boolean }>;

  // Database Export / Backup
  exportDatabase: () => Promise<{ success: boolean; path?: string; error?: string }>;

  // llama-server (bundled local inference)
  llamaStart: () => Promise<{ success: boolean; port?: number; error?: string }>;
  llamaStop: () => Promise<{ success: boolean; error?: string }>;
  llamaStatus: () => Promise<{ running: boolean; port: number | null; pid: number | null; model: string | null }>;

  // Auto Update
  checkForUpdate: () => Promise<{ available: boolean; version?: string }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => Promise<void>;
  onUpdateAvailable: (cb: (event: IpcEvent, data: { version: string }) => void) => () => void;
  onUpdateDownloadProgress: (cb: (event: IpcEvent, data: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (cb: (event: IpcEvent) => void) => () => void;
  onUpdateInstallFailed: (cb: (event: IpcEvent, data: { downloadUrl: string }) => void) => () => void;

  // Background Download Manager
  bgdownloadGetState: () => Promise<DownloadManagerState | null>;
  bgdownloadStart: () => Promise<void>;
  bgdownloadCancel: () => Promise<void>;
  bgdownloadRestart: (ids: string[]) => Promise<void>;
  onBgdownloadState: (cb: (event: IpcEvent, state: DownloadManagerState) => void) => () => void;

  // Plugin APIs (unified MCP + prompt injection; real Skills use skill_path)
  pluginGetAll: () => Promise<Array<{
    id: string; name: string; description: string; enabled: boolean;
    hasInstructions: boolean; hasMCP: boolean; skill_path?: string;
    status: string; toolCount: number; error?: string;
    source: string; sourceUri?: string; version?: string;
    page?: { icon?: string; menuLabel?: string; welcomeMessage?: string };
    serverInfo?: { name: string; version: string };
  }>>;
  pluginInstall: (config: any) => Promise<{ success: boolean; error?: string }>;
  skillInstallFromDirectory: (dirPath: string, page?: { icon?: string; menuLabel?: string; welcomeMessage?: string }) => Promise<{ success: boolean; plugin?: any; error?: string }>;
  skillVerifyGithub: (url: string) => Promise<{ ok: boolean; skillUrl?: string; error?: string }>;
  skillInstallFromGithub: (url: string, page?: { icon?: string; menuLabel?: string; welcomeMessage?: string }) => Promise<{ success: boolean; plugin?: any; error?: string }>;
  pluginInstallFromUrl: (url: string) => Promise<{ success: boolean; pluginId?: string; error?: string }>;
  pluginInstallFromRemoteSkill: (skillPathUrl: string, meta: { id: string; name: string; description: string; version?: string; github_url?: string }) => Promise<{ success: boolean; plugin?: any; error?: string }>;
  pluginUninstall: (id: string) => Promise<{ success: boolean }>;
  pluginUpdate: (id: string, updates: any) => Promise<{ success: boolean; error?: string }>;
  pluginEnable: (id: string) => Promise<{ success: boolean; error?: string }>;
  pluginDisable: (id: string) => Promise<{ success: boolean; error?: string }>;
  pluginGetTools: (pluginId: string) => Promise<Array<{ name: string; description: string; parameters: any }>>;
  pluginGetLogs: (pluginId: string) => Promise<Array<{ timestamp: number; level: string; message: string }>>;
  pluginClearLogs: (pluginId: string) => Promise<any>;
  pluginCheckUpdate: (pluginId: string) => Promise<{ package: string; latest: string; current?: string } | null>;
  pluginUpgrade: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
  pluginGetMarket: () => Promise<Array<{ id: string; name: string; description: string; version: string; source: string; sourceUri: string; tags?: string[]; icon?: string; config_json?: string; inject_prompt?: string; skill_path?: string; github_url?: string; plugin_type?: string }>>;

  // Agent Chat
  agentChat: (question: string) => Promise<{ success: boolean; text?: string; toolCalls?: any[]; error?: string }>;
  agentChatWithPlugin: (pluginId: string, question: string) => Promise<{ success: boolean; text?: string; toolCalls?: any[]; error?: string }>;

  // Scheduler
  schedulerCreate: (params: any) => Promise<ScheduledTaskRow>;
  schedulerUpdate: (id: number, params: any) => Promise<ScheduledTaskRow>;
  schedulerDelete: (id: number) => Promise<{ success: boolean }>;
  schedulerList: (filter?: { status?: string }) => Promise<ScheduledTaskRow[]>;
  schedulerGet: (id: number) => Promise<ScheduledTaskRow>;
  schedulerPause: (id: number) => Promise<ScheduledTaskRow>;
  schedulerResume: (id: number) => Promise<ScheduledTaskRow>;
  schedulerRunNow: (id: number) => Promise<ScheduledTaskRow>;
  schedulerHistory: (taskId: number, limit?: number) => Promise<TaskExecutionRow[]>;
  schedulerParseSchedule: (text: string) => Promise<ParsedSchedule>;
  schedulerListActions: () => Promise<Array<{ name: string; label_zh: string; label_en: string }>>;

  // Agent Memory
  memoryGetAll: () => Promise<MemoryRow[]>;
  memoryGetStats: () => Promise<MemoryStats>;
  memoryPromote: (id: number, layer: string) => Promise<{ success: boolean }>;
  memoryDelete: (id: number) => Promise<{ success: boolean }>;
  memoryUpdate: (id: number, fact: string) => Promise<{ success: boolean }>;

  // Memory Documents
  memoryGetDocumentDates: () => Promise<MemoryDateEntry[]>;
  memoryGetDocument: (date: string) => Promise<MemoryDocument | null>;
  memorySaveDocument: (date: string, content: string) => Promise<{ success: boolean }>;
  memoryGenerateDocument: (date: string) => Promise<{ content: string }>;

  // Knowledge Pages
  knowledgeCreate: (data: { slug: string; type: string; title: string; content?: string }) => Promise<{ id?: number; slug?: string; existed?: boolean; error?: string }>;
  knowledgeGetBySlug: (slug: string) => Promise<any>;
  knowledgeGetAll: (type?: string) => Promise<any[]>;
  knowledgeSearch: (query: string, type?: string) => Promise<any[]>;
  knowledgeGetLinks: (pageId: number) => Promise<any[]>;
  knowledgeGetBacklinks: (pageId: number) => Promise<any[]>;
  knowledgeGetGraph: () => Promise<any>;
  knowledgeGetQueueStatus: () => Promise<any>;
  knowledgeGetQueueEntries: () => Promise<any[]>;
  knowledgeClearStuckQueue: () => Promise<any>;
  knowledgeGetStats: () => Promise<any>;
  knowledgeRecompile: (pageId: number) => Promise<any>;
  knowledgeCompileRecording: (recordingId: number) => Promise<any>;
  knowledgeUpdateContent: (pageId: number, content: string) => Promise<any>;
  knowledgeCompileAll: () => Promise<any>;
  knowledgeMergePages: (sourcePageIds: number[], targetPageId: number) => Promise<any>;
  knowledgeFindDuplicates: () => Promise<any>;
  knowledgeDelete: (pageId: number) => Promise<any>;
  knowledgeBatchDelete: (pageIds: number[]) => Promise<any>;
  knowledgeRenamePage: (pageId: number, newTitle: string, newType: string) => Promise<any>;
  knowledgeEditContent: (pageId: number, content: string) => Promise<any>;
}

declare global {
  interface Window {
    api: VoiceBrainApi;
  }
}

export function useApi(): VoiceBrainApi {
  // In Electron, window.api is exposed via preload script
  // In dev/browser mode, return a mock
  if (window.api) {
    return window.api;
  }

  return createMockApi();
}
