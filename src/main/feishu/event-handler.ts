import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { Processor } from '../pipeline/processor';
import { QueryEngine } from '../rag/query-engine';
import { VoiceBrainDB } from '../db/database';
import { Transcriber } from '../audio/transcriber';
import type { SherpaEngineProxy } from '../audio/sherpa-engine-proxy';
import type { LLMClient } from '../llm/llm-client';
import { loadSettings, saveSettings } from '../settings';
import { getLLMModel } from '../llm/create-client';
import { TextOptimizer } from '../llm/text-optimizer';
import { withTimeout } from '../utils/with-timeout';
import { IntentClassifier, type IntentResult } from './intent-classifier';
import { getAgentExecutor } from '../ipc/integration-handlers';
import {
  buildTranscriptionCard,
  buildQueryCard,
  buildProcessingCard,
  buildTextCard,
  buildErrorCard,
  buildTodoCard,
  buildMemoCard,
  buildDailySummaryCard,
  buildHelpCard,
  buildItemListCard,
  type TranscriptionResult,
} from './card-builder';

// Timeout constants
const DOWNLOAD_TIMEOUT = 30_000;    // 30 seconds
const FFMPEG_TIMEOUT = 120_000;     // 2 minutes
const REPORT_TIMEOUT = 180_000;     // 3 minutes
const PENDING_TTL = 30 * 60 * 1000; // 30 minutes

/** Sanitize internal error messages for user-facing display. */
function sanitizeError(err: unknown): string {
  const msg = String(err);
  if (msg.includes('ECONNREFUSED')) return '无法连接 AI 服务，请检查 Local 是否运行';
  if (msg.includes('Timeout')) return '处理超时，请稍后重试';
  if (msg.includes('ENOENT')) return '文件未找到';
  if (msg.includes('ENOMEM')) return '内存不足';
  // Strip stack traces and internal paths
  const firstLine = msg.split('\n')[0];
  if (firstLine.length > 100) return '处理失败，请重试';
  return firstLine;
}

/** Generate a unique file prefix to avoid collisions. */
function uniqueFilePrefix(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

interface PendingNotification {
  chatId: string;
  messageId?: string;
  createdAt: number;
}

export class FeishuEventHandler {
  private client: lark.Client;
  private getProcessor: () => Processor;
  private getQueryEngine: () => QueryEngine;
  private getDb: () => VoiceBrainDB;
  private intentClassifier: IntentClassifier;
  private transcriber: Transcriber;
  private optimizer: TextOptimizer;
  private adminOpenId: string;

  getAdminOpenId(): string {
    return this.adminOpenId;
  }
  private pendingNotifications = new Map<string, PendingNotification>();
  /** Dedup: recently processed message IDs (SDK may deliver events twice) */
  private processedMessageIds = new Set<string>();
  constructor(
    client: lark.Client,
    getProcessor: () => Processor,
    getQueryEngine: () => QueryEngine,
    getDb: () => VoiceBrainDB,
    local: LLMClient,
    adminOpenId: string,
    sherpaEngine: SherpaEngineProxy,
    _getMemoryManager?: () => unknown,
  ) {
    this.client = client;
    this.getProcessor = getProcessor;
    this.getQueryEngine = getQueryEngine;
    this.getDb = getDb;
    this.intentClassifier = new IntentClassifier(local);
    this.transcriber = new Transcriber(sherpaEngine);
    this.adminOpenId = adminOpenId;

    // Reuse a single TextOptimizer instance (I8)
    const settings = loadSettings();
    this.optimizer = new TextOptimizer(local, getLLMModel(settings));
  }

  async handleMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) {
      console.warn('[Feishu] Received event with no message payload, skipping');
      return;
    }

    const msgType = message.message_type;
    const senderId = data?.sender?.sender_id?.open_id;
    console.log(`[Feishu] handleMessage: type=${msgType}, sender=${senderId}, id=${message.message_id}`);

    // Dedup: skip if already processed (SDK may deliver the same event multiple times)
    const messageId = message.message_id;
    if (messageId && this.processedMessageIds.has(messageId)) {
      console.log(`[Feishu] Skipping duplicate message: ${messageId}`);
      return;
    }
    if (messageId) {
      this.processedMessageIds.add(messageId);
      // Evict old entries to prevent memory leak (keep last 200)
      if (this.processedMessageIds.size > 200) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }
    }

    // Auto-save admin open_id on first message so scheduled tasks can push back
    if (senderId && !this.adminOpenId) {
      this.adminOpenId = senderId;
      const s = loadSettings();
      if (!s.feishuAdminOpenId) {
        s.feishuAdminOpenId = senderId;
        saveSettings(s);
        console.log(`[Feishu] Auto-saved adminOpenId: ${senderId}`);
      }
    }

    if (this.adminOpenId && senderId !== this.adminOpenId) {
      console.warn(`[Feishu] Blocked non-admin sender: ${senderId} (admin=${this.adminOpenId})`);
      return;
    }

    const chatId = message.chat_id;

    // Clean expired pending notifications periodically (I3)
    this.cleanPendingNotifications();

    try {
      if (msgType === 'audio') {
        await this.handleVoiceMessage(message, chatId);
      } else if (msgType === 'text') {
        await this.handleTextMessage(message, chatId);
      } else {
        console.log(`[Feishu] Ignoring message type: ${msgType}`);
        await this.sendCard(chatId, buildTextCard(
          '💡 提示',
          `暂时只支持文字和语音消息哦，${msgType === 'image' ? '图片' : msgType}消息暂不支持。`,
          'grey',
        ));
      }
    } catch (err) {
      console.error('[Feishu] Error handling message:', err);
      await this.sendCard(chatId, buildErrorCard(sanitizeError(err)));
    }
  }

  private async handleVoiceMessage(message: any, chatId: string): Promise<void> {
    const content = JSON.parse(message.content || '{}');
    const fileKey = content.file_key;
    if (!fileKey) {
      console.error('[Feishu] Voice message missing file_key');
      return;
    }

    const messageId = message.message_id;
    const prefix = uniqueFilePrefix();
    const processingMsgId = await this.sendCard(chatId, buildProcessingCard(`FEISHU-${prefix}`, 'downloading'));

    const settings = loadSettings();
    const saveDir = settings.watchDir || require('electron').app.getPath('documents');
    const opusPath = path.join(saveDir, `FEISHU-${prefix}.opus`);
    const wavPath = path.join(saveDir, `FEISHU-${prefix}.wav`);

    // Download voice file from Feishu (with timeout)
    try {
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (resp.writeFile) {
        await withTimeout(resp.writeFile(opusPath), DOWNLOAD_TIMEOUT, 'voice download');
        console.log(`[Feishu] Downloaded voice: ${opusPath}`);
      } else if (resp.getReadableStream) {
        const buffer = await withTimeout(
          streamToBuffer(resp.getReadableStream()),
          DOWNLOAD_TIMEOUT,
          'voice download',
        );
        fs.writeFileSync(opusPath, buffer);
        console.log(`[Feishu] Downloaded voice: ${opusPath}`);
      } else {
        throw new Error('Unexpected response format from Feishu file download');
      }
    } catch (err) {
      console.error('[Feishu] Failed to download voice:', err);
      const errorCard = buildErrorCard(sanitizeError(err));
      if (processingMsgId) await this.updateCard(processingMsgId, errorCard);
      else await this.sendCard(chatId, errorCard);
      return;
    }

    // Update progress: transcribing
    if (processingMsgId) {
      await this.updateCard(processingMsgId, buildProcessingCard(`FEISHU-${prefix}`, 'transcribing'));
    }

    // Convert opus to 16kHz mono WAV (with timeout)
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          ffmpeg(opusPath)
            .audioFrequency(16000)
            .audioChannels(1)
            .audioCodec('pcm_s16le')
            .output(wavPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        }),
        FFMPEG_TIMEOUT,
        'ffmpeg conversion',
      );
      try { fs.unlinkSync(opusPath); } catch { /* ignore */ }
      console.log(`[Feishu] Converted to WAV: ${wavPath}`);
    } catch (err) {
      console.error('[Feishu] FFmpeg conversion failed:', err);
      try { fs.unlinkSync(opusPath); } catch { /* ignore */ }
      const errorCard = buildErrorCard(sanitizeError(err));
      if (processingMsgId) await this.updateCard(processingMsgId, errorCard);
      else await this.sendCard(chatId, errorCard);
      return;
    }

    // Step 1: Quick transcription (uses Python/Whisper — independent of LLM)
    let rawText = '';
    try {
      const result = await this.transcriber.transcribe(wavPath, settings.whisperModel || 'sensevoice');
      rawText = result.full_text?.trim() || '';
      if (rawText) {
        console.log(`[Feishu] Voice transcribed: "${rawText.slice(0, 100)}"`);
      }
    } catch (err) {
      console.error('[Feishu] Transcription failed, enqueuing for full pipeline:', err);
    }

    // If transcription is empty or failed, go straight to pipeline (recording still has value)
    if (!rawText) {
      const task = this.getProcessor().enqueue(wavPath);
      this.pendingNotifications.set(task.id, { chatId, messageId: processingMsgId, createdAt: Date.now() });
      return;
    }

    // Step 2: Route transcribed text through AgentExecutor (same as text messages)
    // AgentExecutor decides what to do — pipeline enqueue only for storage-related actions
    try {
      if (processingMsgId) {
        await this.updateCard(processingMsgId, buildProcessingCard(`FEISHU-${prefix}`, 'executing'));
      }

      const executor = getAgentExecutor();
      let card: string;
      let shouldEnqueuePipeline = false;

      if (executor) {
        console.log(`[Feishu] Using AgentExecutor for voice message`);
        const senderId = this.adminOpenId || 'feishu-user';
        const result = await executor.execute('feishu', senderId, '用户', rawText);
        console.log(`[Feishu] Agent result: ${result.text.slice(0, 100)}, toolCalls=${result.toolCalls.length}`);
        card = buildTextCard('🎙️ 语音回复', result.text, 'blue');

        // Only enqueue to pipeline if agent stored content (memo/todo) — the recording has archival value
        // Commands like delete/query/list don't need pipeline processing
        const storageTools = ['create_memo', 'create_todo', 'set_reminder'];
        shouldEnqueuePipeline = result.toolCalls.some(tc => storageTools.includes(tc.tool))
          || result.toolCalls.length === 0; // No tool called = LLM responded directly, likely a recording
      } else {
        // Fallback to IntentClassifier when AgentExecutor not initialized
        const intent = await this.intentClassifier.classify(rawText, 'voice');
        console.log(`[Feishu] Voice intent (fallback): ${intent.intent}`, intent.params);
        card = await this.executeIntent(intent, rawText);
        shouldEnqueuePipeline = intent.intent === 'transcribe' || intent.intent === 'memo';
      }

      if (shouldEnqueuePipeline) {
        const task = this.getProcessor().enqueue(wavPath);
        this.pendingNotifications.set(task.id, { chatId, messageId: processingMsgId, createdAt: Date.now() });
        // Send agent response as a separate card (processing card will be updated by pipeline)
        await this.sendCard(chatId, card);
      } else {
        // No pipeline needed — update the processing card directly with the response
        if (processingMsgId) {
          await this.updateCard(processingMsgId, card);
        } else {
          await this.sendCard(chatId, card);
        }
        // Clean up the temporary WAV file since it won't be processed
        try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error('[Feishu] Voice message processing failed:', err);
      // Fallback: enqueue to pipeline so audio is not lost
      const task = this.getProcessor().enqueue(wavPath);
      this.pendingNotifications.set(task.id, { chatId, messageId: processingMsgId, createdAt: Date.now() });
    }
  }

  private async handleTextMessage(message: any, chatId: string): Promise<void> {
    const t0 = Date.now();
    const content = JSON.parse(message.content || '{}');
    const text = content.text?.trim();
    if (!text) return;

    console.log(`[Feishu] Text message: "${text}"`);

    // Quick keyword commands (no LLM needed)
    const quickCard = this.tryQuickCommand(text);
    if (quickCard) {
      const msgId = await this.sendCard(chatId, buildProcessingCard('thinking'));
      if (msgId) {
        await this.updateCard(msgId, quickCard);
      } else {
        await this.sendCard(chatId, quickCard);
      }
      console.log(`[Feishu] quick command total=${Date.now() - t0}ms`);
      return;
    }

    // Send "thinking" card immediately
    const msgId = await this.sendCard(chatId, buildProcessingCard('thinking'));
    console.log(`[Feishu] thinking card sent +${Date.now() - t0}ms`);

    try {
      // Prefer AgentExecutor (has tools, MCP, skills) over IntentClassifier
      const executor = getAgentExecutor();
      let card: string;

      if (executor) {
        console.log(`[Feishu] agent start +${Date.now() - t0}ms`);
        const senderId = this.adminOpenId || 'feishu-user';
        const result = await executor.execute('feishu', senderId, '用户', text);
        console.log(`[Feishu] agent done +${Date.now() - t0}ms | toolCalls=${result.toolCalls.length} | "${result.text.slice(0, 60)}"`);
        card = buildTextCard('💬 回复', result.text, 'blue');
        this.persistTextNote('feishu', senderId, '用户', text, result.text);
      } else {
        console.log(`[Feishu] intent classify start +${Date.now() - t0}ms`);
        const intent = await this.intentClassifier.classify(text);
        console.log(`[Feishu] intent=${intent.intent} +${Date.now() - t0}ms`);
        card = await this.executeIntent(intent, text);
        const fallbackSenderId = this.adminOpenId || 'feishu-user';
        this.persistTextNote('feishu', fallbackSenderId, '用户', text, card ? '(见飞书卡片)' : '');
      }

      const tUpdate = Date.now();
      if (msgId) {
        await this.updateCard(msgId, card);
      } else {
        await this.sendCard(chatId, card);
      }
      console.log(`[Feishu] card update +${Date.now() - t0}ms (card api took ${Date.now() - tUpdate}ms)`);
      console.log(`[Feishu] TOTAL ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[Feishu] Text message processing failed:', err);
      const errorCard = buildErrorCard(sanitizeError(err));
      if (msgId) {
        await this.updateCard(msgId, errorCard);
      } else {
        await this.sendCard(chatId, errorCard);
      }
      console.log(`[Feishu] error path total=${Date.now() - t0}ms`);
    }
  }

  /** Handle quick commands like "完成1", "删除2" without LLM */
  private tryQuickCommand(text: string): string | null {
    // "完成X" / "完成第X个"
    const completeMatch = text.match(/^完成\s*第?\s*(\d+)\s*个?$/);
    if (completeMatch) {
      const idx = parseInt(completeMatch[1], 10) - 1;
      const items = this.getDb().getAllExtractedItems().filter((i) => i.status === 'active');
      if (idx < 0 || idx >= items.length) {
        return buildTextCard('⚠️', `编号 ${idx + 1} 不存在，当前有 ${items.length} 个活跃事项`, 'orange');
      }
      const item = items[idx];
      this.getDb().updateExtractedItemStatus(item.id, 'completed');
      console.log(`[Feishu] Quick command: completed item #${item.id} "${item.content}"`);
      return buildTextCard('✅ 已完成', `~~${item.content}~~`, 'green');
    }

    // "删除X" / "删除第X个"
    const deleteMatch = text.match(/^删除\s*第?\s*(\d+)\s*个?$/);
    if (deleteMatch) {
      const idx = parseInt(deleteMatch[1], 10) - 1;
      const items = this.getDb().getAllExtractedItems();
      if (idx < 0 || idx >= items.length) {
        return buildTextCard('⚠️', `编号 ${idx + 1} 不存在，当前有 ${items.length} 个事项`, 'orange');
      }
      const item = items[idx];
      this.getDb().deleteExtractedItem(item.id);
      console.log(`[Feishu] Quick command: deleted item #${item.id} "${item.content}"`);
      return buildTextCard('🗑️ 已删除', item.content, 'grey');
    }

    return null;
  }

  /** Persist a text note and fire-and-forget memory + info extraction. */
  private persistTextNote(channelId: string, userId: string, userName: string, content: string, agentReply: string): void {
    let noteId: number;
    try {
      noteId = this.getDb().insertTextNote({
        channel_id: channelId,
        user_id: userId,
        user_name: userName,
        content,
        agent_reply: agentReply,
      });
      console.log(`[Feishu] Text note persisted: id=${noteId}`);
    } catch (err) {
      console.error('[Feishu] Failed to persist text note:', err);
    }
  }

  private async executeIntent(intent: IntentResult, originalText: string): Promise<string> {
    switch (intent.intent) {
      case 'help':
        return buildHelpCard();

      case 'query': {
        const question = intent.params.question || originalText;
        const result = await this.getQueryEngine().query(question);
        return buildQueryCard({ question, answer: result.answer, sources: result.sources });
      }

      case 'todo': {
        const content = intent.params.content || originalText;
        this.getDb().insertExtractedItem({
          type: 'todo',
          content,
          due_date: intent.params.dueDate || undefined,
          related_person: intent.params.relatedPerson || undefined,
          source: 'feishu',
        });
        return buildTodoCard({
          content,
          dueDate: intent.params.dueDate,
          relatedPerson: intent.params.relatedPerson,
        });
      }

      case 'memo': {
        const content = intent.params.content || originalText;
        this.getDb().insertExtractedItem({
          type: 'memo',
          content,
          related_person: intent.params.relatedPerson || undefined,
          source: 'feishu',
        });
        return buildMemoCard({
          content,
          relatedPerson: intent.params.relatedPerson,
        });
      }

      case 'list_items': {
        const listType = intent.params.type as string || 'all';
        let items;
        if (listType === 'todo') {
          items = this.getDb().getExtractedItemsByType('todo');
        } else if (listType === 'memo') {
          items = this.getDb().getExtractedItemsByType('memo');
        } else {
          items = this.getDb().getAllExtractedItems();
        }
        // Show only active items first, then completed, limit to 15
        const sorted = [...items].sort((a, b) => {
          if (a.status === 'active' && b.status !== 'active') return -1;
          if (a.status !== 'active' && b.status === 'active') return 1;
          return b.id - a.id;
        }).slice(0, 15);
        return buildItemListCard(sorted, listType);
      }

      case 'report': {
        const today = new Date().toISOString().split('T')[0];
        if (intent.params.type === 'weekly') {
          const endDate = intent.params.endDate || today;
          const startDate = intent.params.date || (() => {
            const d = new Date();
            d.setDate(d.getDate() - 6);
            return d.toISOString().split('T')[0];
          })();
          const summaries = this.getDb().getDailySummariesInRange(startDate, endDate);
          const parsed = summaries.map((s) => ({
            date: s.date,
            summary: s.summary_text || '',
            todos: s.key_events_json ? (JSON.parse(s.key_events_json).todos || []) : [],
            decisions: s.key_events_json ? (JSON.parse(s.key_events_json).decisions || []) : [],
          }));
          const result = await withTimeout(
            this.optimizer.generateWeeklySummary(startDate, endDate, parsed),
            REPORT_TIMEOUT,
            'weekly report',
          );
          return buildDailySummaryCard({
            date: `${startDate} ~ ${endDate}`,
            summaryText: typeof result === 'string' ? result : JSON.stringify(result),
          });
        } else {
          const date = intent.params.date || today;
          const segments = this.getDb().getSegmentsByDate(date);
          const textNotes = this.getDb().getTextNotesByDate(date);

          const segData = segments.map((s: any) => ({
            start: s.start_time ?? 0,
            end: s.end_time ?? s.start_time ?? 0,
            speaker: s.speaker_name || 'Unknown',
            text: s.clean_text || s.raw_text || '',
            time: `${Math.floor((s.start_time || 0) / 60)}:${String(Math.floor((s.start_time || 0) % 60)).padStart(2, '0')}`,
          }));

          for (const note of textNotes) {
            const d = new Date(note.created_at);
            segData.push({
              start: 0,
              end: 0,
              speaker: note.user_name || '[飞书]',
              text: note.content,
              time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
            });
          }

          if (segData.length === 0) {
            return buildTextCard('📋 日报', `${date} 暂无录音或文字记录`, 'grey');
          }

          const result = await withTimeout(
            this.optimizer.generateDailySummary(date, segData),
            REPORT_TIMEOUT,
            'daily report',
          );

          this.getDb().upsertDailySummary({
            date,
            summary_text: result.summary,
            timeline_json: JSON.stringify(result.timeline),
            key_events_json: JSON.stringify({ todos: result.todos, decisions: result.decisions }),
          });

          return buildDailySummaryCard({
            date,
            summaryText: result.summary,
            keyEvents: { todos: result.todos, decisions: result.decisions },
          });
        }
      }

      case 'transcribe':
        // This case should not reach here (voice messages handle it directly)
        return buildTextCard('💡', '请发送语音消息进行转录', 'grey');

      default:
        return buildQueryCard({
          question: originalText,
          answer: '无法识别意图，已作为查询处理',
          sources: [],
        });
    }
  }

  async sendCard(chatId: string, cardJson: string): Promise<string | undefined> {
    try {
      const cardData = JSON.parse(cardJson);
      // Auto-detect receive_id_type: ou_ = open_id, oc_ = chat_id
      const receiveIdType = chatId.startsWith('ou_') ? 'open_id' : 'chat_id';
      const resp = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardData.card),
        },
      });
      const msgId = (resp as any)?.data?.message_id;
      console.log(`[Feishu] Card sent, message_id: ${msgId || 'none'}`);
      return msgId;
    } catch (err) {
      console.error('[Feishu] Failed to send card:', err);
      return undefined;
    }
  }

  async updateCard(messageId: string, cardJson: string): Promise<void> {
    try {
      const cardData = JSON.parse(cardJson);
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(cardData.card),
        },
      });
      console.log(`[Feishu] Card updated: ${messageId}`);
    } catch (err) {
      console.error('[Feishu] Failed to update card:', err);
    }
  }

  async sendNotificationToAdmin(cardJson: string): Promise<void> {
    if (!this.adminOpenId) return;
    try {
      const cardData = JSON.parse(cardJson);
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.adminOpenId,
          msg_type: 'interactive',
          content: JSON.stringify(cardData.card),
        },
      });
    } catch (err) {
      console.error('[Feishu] Failed to send notification:', err);
    }
  }

  async onPipelineComplete(taskId: string, result: TranscriptionResult): Promise<void> {
    const pending = this.pendingNotifications.get(taskId);
    if (pending) {
      this.pendingNotifications.delete(taskId);
      const card = buildTranscriptionCard(result);
      if (pending.messageId) {
        await this.updateCard(pending.messageId, card);
      } else {
        await this.sendCard(pending.chatId, card);
      }
    }

    const settings = loadSettings();
    if (settings.feishuNotifyOnComplete && !pending) {
      await this.sendNotificationToAdmin(buildTranscriptionCard(result));
    }
  }

  async onPipelineFailed(taskId: string, error: string): Promise<void> {
    const pending = this.pendingNotifications.get(taskId);
    if (pending) {
      this.pendingNotifications.delete(taskId);
      const errorCard = buildErrorCard(sanitizeError(error));
      if (pending.messageId) {
        await this.updateCard(pending.messageId, errorCard);
      } else {
        await this.sendCard(pending.chatId, errorCard);
      }
    }
  }

  // ─── Simulation methods (for testing) ──────────────────

  async simulateTextMessage(text: string): Promise<{ intent: string; success: boolean }> {
    console.log(`[Feishu:Sim] Text: "${text}"`);

    if (!text.trim()) {
      console.log('[Feishu:Sim] Empty text, skipping');
      return { intent: 'none', success: true };
    }

    // Quick commands
    const quickCard = this.tryQuickCommand(text);
    if (quickCard) {
      await this.sendNotificationToAdmin(quickCard);
      return { intent: 'quick_cmd', success: true };
    }

    // Intent classification + execute
    const intent = await this.intentClassifier.classify(text);
    console.log(`[Feishu:Sim] Intent: ${intent.intent}`, intent.params);
    const card = await this.executeIntent(intent, text);
    await this.sendNotificationToAdmin(card);
    return { intent: intent.intent, success: true };
  }

  async simulateVoiceMessage(wavPath: string): Promise<{ intent: string; transcription: string; success: boolean }> {
    console.log(`[Feishu:Sim] Voice: ${wavPath}`);

    if (!fs.existsSync(wavPath)) {
      throw new Error(`WAV file not found: ${wavPath}`);
    }

    // Whisper transcription
    const settings = loadSettings();
    const result = await this.transcriber.transcribe(wavPath, settings.whisperModel || 'sensevoice');
    const rawText = result.full_text?.trim();

    if (!rawText) {
      await this.sendNotificationToAdmin(buildTextCard('📝', '转写结果为空', 'grey'));
      return { intent: 'empty', transcription: '', success: true };
    }

    console.log(`[Feishu:Sim] Transcribed: "${rawText.slice(0, 100)}"`);

    // LLM refinement
    const text = await this.optimizer.cleanText(rawText);
    console.log(`[Feishu:Sim] Refined: "${text.slice(0, 100)}"`);

    // Intent classification (voice source)
    const intent = await this.intentClassifier.classify(text, 'voice');
    console.log(`[Feishu:Sim] Voice intent: ${intent.intent}`, intent.params);

    if (intent.intent === 'transcribe') {
      // Enqueue to full pipeline
      this.getProcessor().enqueue(wavPath);
      await this.sendNotificationToAdmin(buildTextCard(
        '⏳ 已加入队列',
        `${path.basename(wavPath)} → 完整转录处理`,
        'blue',
      ));
    } else {
      const card = await this.executeIntent(intent, text);
      await this.sendNotificationToAdmin(card);
    }

    return { intent: intent.intent, transcription: rawText, success: true };
  }

  async simulateUnsupportedMessage(msgType: string): Promise<void> {
    console.log(`[Feishu:Sim] Unsupported type: ${msgType}`);
    await this.sendNotificationToAdmin(buildTextCard(
      '💡 提示',
      `暂时只支持文字和语音消息哦，${msgType === 'image' ? '图片' : msgType}消息暂不支持。`,
      'grey',
    ));
  }

  /** Remove expired entries from pendingNotifications (I3). */
  private cleanPendingNotifications(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingNotifications) {
      if (now - entry.createdAt > PENDING_TTL) {
        this.pendingNotifications.delete(id);
      }
    }
  }
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
