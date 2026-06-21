import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { Processor } from '../pipeline/processor';
import { QueryEngine } from '../rag/query-engine';
import { VoiceBrainDB } from '../db/database';
import type { SherpaEngineProxy } from '../audio/sherpa-engine-proxy';
import { loadSettings } from '../settings';
import { createLLMClient, getLLMModel } from '../llm/create-client';
import { FeishuEventHandler } from './event-handler';
import { type TranscriptionResult } from './card-builder';
import { MessageQueue } from './message-queue';
import { ReconnectManager } from './reconnect-manager';
import type { QueueTask } from '../pipeline/task-queue';

// Workaround: SDK's bundled axios sends HTTP to HTTPS ports on Node.js v25+.
// Provide a fetch-based httpInstance that matches the axios-like interface the SDK expects.
const fetchHttpInstance: any = {
  request: async (config: any) => {
    const { method, url, data, headers, timeout, responseType, params, paramsSerializer } = config;
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      // Build URL with query params
      let fullUrl = url;
      if (params && Object.keys(params).length > 0) {
        const qs = paramsSerializer
          ? paramsSerializer(params)
          : new URLSearchParams(params).toString();
        fullUrl += (url.includes('?') ? '&' : '?') + qs;
      }

      // Build request body and headers
      const reqHeaders: Record<string, string> = { ...headers };
      let body: any = undefined;
      if (data !== undefined && data !== null) {
        if (typeof data === 'string') {
          body = data;
          if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
        } else if (typeof data === 'object') {
          body = JSON.stringify(data);
          if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
        }
      }

      const upperMethod = method?.toUpperCase() || 'GET';
      // GET/HEAD requests cannot have a body per HTTP spec
      const fetchBody = (upperMethod === 'GET' || upperMethod === 'HEAD') ? undefined : body;

      const resp = await fetch(fullUrl, {
        method: upperMethod,
        headers: reqHeaders,
        body: fetchBody,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err: any = new Error(`Request failed with status code ${resp.status}`);
        err.response = { status: resp.status, data: await resp.text() };
        throw err;
      }

      // Handle different response types
      if (responseType === 'stream' || config['$return_headers']) {
        const respHeaders = Object.fromEntries(resp.headers.entries());
        if (responseType === 'stream') {
          // Return a Node-compatible readable stream
          const { Readable } = await import('stream');
          const reader = resp.body?.getReader();
          const stream = new Readable({
            async read() {
              if (!reader) { this.push(null); return; }
              const { done, value } = await reader.read();
              if (done) this.push(null);
              else this.push(Buffer.from(value));
            },
          });
          return { data: stream, headers: respHeaders };
        }
        return { data: await resp.json(), headers: respHeaders };
      }

      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
// Add axios-compatible method shortcuts
fetchHttpInstance.get = (url: string, config?: any) => fetchHttpInstance.request({ ...config, method: 'GET', url });
fetchHttpInstance.post = (url: string, data?: any, config?: any) => fetchHttpInstance.request({ ...config, method: 'POST', url, data });
fetchHttpInstance.put = (url: string, data?: any, config?: any) => fetchHttpInstance.request({ ...config, method: 'PUT', url, data });
fetchHttpInstance.delete = (url: string, config?: any) => fetchHttpInstance.request({ ...config, method: 'DELETE', url });
fetchHttpInstance.patch = (url: string, data?: any, config?: any) => fetchHttpInstance.request({ ...config, method: 'PATCH', url, data });
// Interceptors stub (SDK checks for these)
fetchHttpInstance.interceptors = { request: { use: () => {} }, response: { use: () => {} } };

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  adminOpenId?: string;
}

export type FeishuBotStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export class FeishuBot extends EventEmitter {
  private client: lark.Client | null = null;
  private wsClient: any | null = null;
  private handler: FeishuEventHandler | null = null;
  private getProcessor: () => Processor;
  private getQueryEngine: () => QueryEngine;
  private getDb: () => VoiceBrainDB;
  private getSherpaEngine: () => SherpaEngineProxy;
  private getMemoryManager: () => import('../agent/memory-manager').MemoryManager | null;
  private config: FeishuBotConfig | null = null;
  private _status: FeishuBotStatus = 'disconnected';
  private messageQueue: MessageQueue | null = null;
  private reconnectManager: ReconnectManager | null = null;

  constructor(getProcessor: () => Processor, getQueryEngine: () => QueryEngine, getDb: () => VoiceBrainDB, getSherpaEngine: () => SherpaEngineProxy, getMemoryManager: () => import('../agent/memory-manager').MemoryManager | null = () => null) {
    super();
    this.getProcessor = getProcessor;
    this.getQueryEngine = getQueryEngine;
    this.getDb = getDb;
    this.getSherpaEngine = getSherpaEngine;
    this.getMemoryManager = getMemoryManager;
  }

  get status(): FeishuBotStatus {
    return this._status;
  }

  getHandler(): FeishuEventHandler | null {
    return this.handler;
  }

  getMessageQueue(): MessageQueue | null {
    return this.messageQueue;
  }

  private setStatus(status: FeishuBotStatus): void {
    this._status = status;
    this.emit('statusChanged', status);
  }

  async start(config: FeishuBotConfig): Promise<void> {
    if (!config.appId || !config.appSecret) {
      console.log('[Feishu] Missing appId or appSecret, not starting');
      return;
    }

    // Stop any existing connection first to prevent duplicates
    if (this._status !== 'disconnected') {
      await this.stop();
    }

    this.config = config;

    const settings = loadSettings();
    const local = createLLMClient(settings);

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      httpInstance: fetchHttpInstance as any,
    });

    this.handler = new FeishuEventHandler(
      this.client,
      this.getProcessor,
      this.getQueryEngine,
      this.getDb,
      local,
      config.adminOpenId || '',
      this.getSherpaEngine(),
      this.getMemoryManager,
    );

    // Set up sequential message queue
    this.messageQueue = new MessageQueue();
    this.messageQueue.setHandler(async (data: any) => {
      await this.handler!.handleMessage(data);
    });

    this.wirePipelineEvents();

    // Create event dispatcher — messages go through queue
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        console.log('[Feishu] Message received, type:', data?.message?.message_type);
        try {
          if (!this.messageQueue) {
            console.warn('[Feishu] Message ignored: bot is stopping');
            return;
          }
          await this.messageQueue.enqueue(data);
        } catch (err) {
          console.warn('[Feishu] Message queue rejected:', err);
        }
      },
    });

    // Use ReconnectManager for WebSocket connection
    this.reconnectManager = new ReconnectManager({
      connect: async () => {
        // Tear down previous WS client if any
        if (this.wsClient) {
          try { this.wsClient.close({ force: true }); } catch { /* best-effort */ }
          this.wsClient = null;
        }

        this.wsClient = new lark.WSClient({
          appId: config.appId,
          appSecret: config.appSecret,
          loggerLevel: lark.LoggerLevel.WARN,
          httpInstance: fetchHttpInstance as any,
        });
        await this.wsClient.start({ eventDispatcher });
      },
      onStatusChange: (status) => {
        if (status === 'connected') {
          this.setStatus('connected');
        } else if (status === 'connecting') {
          this.setStatus('connecting');
        } else if (status === 'reconnecting') {
          this.setStatus('reconnecting');
        } else if (status === 'error') {
          this.setStatus('error');
        }
      },
      onMaxRetriesReached: () => {
        console.error('[Feishu] WebSocket reconnection failed after maximum retries. Manual restart required.');
        this.emit('maxRetriesReached');
      },
    });

    await this.reconnectManager.start();
    console.log('[Feishu] Bot started');
  }

  async stop(): Promise<void> {
    // Stop reconnection attempts first
    if (this.reconnectManager) {
      this.reconnectManager.stop();
      this.reconnectManager = null;
    }

    // Drain pending messages
    if (this.messageQueue) {
      this.messageQueue.drain();
      this.messageQueue = null;
    }

    this.unwirePipelineEvents();

    // Disconnect WebSocket properly — calling close() terminates the underlying WS connection
    // Without this, the old WS stays alive and delivers messages to a dead event dispatcher
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* best-effort */ }
      this.wsClient = null;
    }
    this.client = null;
    this.handler = null;
    this.config = null;
    this.setStatus('disconnected');
    console.log('[Feishu] Bot stopped');
  }

  async restart(config: FeishuBotConfig): Promise<void> {
    await this.stop();
    await this.start(config);
  }

  async simulate(params: { type: string; text?: string; wavPath?: string; msgType?: string }): Promise<{ success: boolean; error?: string; intent?: string; transcription?: string }> {
    if (!this.handler) {
      return { success: false, error: 'Bot not started' };
    }
    try {
      switch (params.type) {
        case 'text': {
          const result = await this.handler.simulateTextMessage(params.text || '');
          return { success: true, intent: result.intent };
        }
        case 'voice': {
          if (!params.wavPath) return { success: false, error: 'wavPath required' };
          const result = await this.handler.simulateVoiceMessage(params.wavPath);
          return { success: true, intent: result.intent, transcription: result.transcription };
        }
        case 'unsupported':
          await this.handler.simulateUnsupportedMessage(params.msgType || 'image');
          return { success: true };
        default:
          return { success: false, error: `Unknown type: ${params.type}` };
      }
    } catch (err: any) {
      console.error('[Feishu:Sim] Error:', err);
      return { success: false, error: err.message || String(err) };
    }
  }

  static async testConnection(appId: string, appSecret: string): Promise<{ success: boolean; error?: string; adminOpenId?: string }> {
    try {
      // Directly call tenant_access_token API to verify credentials
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = await resp.json();
      if (data.code !== 0) {
        return { success: false, error: data.msg || `Error code: ${data.code}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // ─── Pipeline event wiring ───────────────────────────────

  private onTaskCompleted = async (task: QueueTask) => {
    if (!this.handler) return;
    try {
      const db = this.getDb();
      const recording = db.getRecordingByPath(task.filePath);
      if (!recording) return;

      const segments = db.getSegmentsByRecording(recording.id);
      const speakerIds = new Set(segments.map((s) => s.speaker_id).filter(Boolean));

      const summaryText = segments.slice(0, 3)
        .map((s) => s.clean_text || s.raw_text || '')
        .join(' ')
        .slice(0, 200);

      // Query actual extracted item counts from DB
      const extractedItems = db.getExtractedItemsByRecording(recording.id);
      const todoCount = extractedItems.filter((i) => i.type === 'todo').length;
      const decisionCount = extractedItems.filter((i) => i.type === 'decision').length;

      const result: TranscriptionResult = {
        fileName: recording.file_name,
        durationSeconds: recording.duration_seconds || 0,
        speakerCount: speakerIds.size,
        summary: summaryText || undefined,
        todoCount,
        decisionCount,
        mediaType: recording.media_type || 'audio',
      };

      await this.handler.onPipelineComplete(task.id, result);
    } catch (err) {
      console.error('[Feishu] Error on pipeline complete notification:', err);
    }
  };

  private onTaskFailed = async (task: QueueTask) => {
    if (!this.handler) return;
    await this.handler.onPipelineFailed(task.id, task.error || 'Unknown error');
  };

  private wirePipelineEvents(): void {
    const tq = this.getProcessor().getTaskQueue();
    tq.on('task:completed', this.onTaskCompleted);
    tq.on('task:failed', this.onTaskFailed);
  }

  private unwirePipelineEvents(): void {
    try {
      const tq = this.getProcessor().getTaskQueue();
      tq.removeListener('task:completed', this.onTaskCompleted);
      tq.removeListener('task:failed', this.onTaskFailed);
    } catch { /* processor might be disposed */ }
  }
}
