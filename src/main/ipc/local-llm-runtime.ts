import fs from 'fs';
import path from 'path';

import type { IpcContext } from './context';
import { ensureLlamaServer } from './context';
import type { AppSettings } from '../settings';
import { updateSettings } from '../settings';
import { getLLMModelsDir } from '../paths';
import { findModel } from '../llm/gguf-model-catalog';
import { hasGGUFMagic, readGGUFFileInfo, validateGGUFFilePath } from '../llm/gguf-model-files';
import { prepareLlamaRouterRuntime } from '../llm/llama-router-runtime';
import { appendAppLog } from '../logging/log-bus';

function getSelectedChatModel(settings: AppSettings): string {
  return settings.localLlmModel || settings.llmModel || 'qwen3.5:4b';
}

function validateSelectedChatModel(settings: AppSettings): void {
  const selectedModel = getSelectedChatModel(settings);
  const entry = findModel(selectedModel);
  if (entry) {
    const filePath = path.join(getLLMModelsDir(), entry.fileName);
    const validation = validateGGUFFilePath(filePath, entry.fileSizeBytes);
    if (!validation.ok) {
      throw new Error(validation.error || `Local model file is not ready: ${entry.fileName}`);
    }
    return;
  }

  if (path.isAbsolute(selectedModel) || selectedModel.toLowerCase().endsWith('.gguf')) {
    const filePath = path.isAbsolute(selectedModel)
      ? selectedModel
      : path.join(getLLMModelsDir(), selectedModel);
    const info = readGGUFFileInfo(filePath);
    if (!info || !hasGGUFMagic(info.header)) {
      throw new Error(`Local model file is not ready: ${filePath}`);
    }
    return;
  }

  appendAppLog('warn', 'main', 'local-inference', 'Skipping exact local model file validation for custom model name', {
    selectedModel,
  });
}

export async function ensureLocalChatRuntime(ctx: IpcContext, settings: AppSettings, reason: string): Promise<void> {
  if (settings.llmProvider !== 'local') return;

  const selectedModel = getSelectedChatModel(settings);
  validateSelectedChatModel(settings);

  const server = ensureLlamaServer();
  let status = server.getStatus();
  if (status.running && status.port) {
    appendAppLog('info', 'main', 'local-inference', 'Local chat runtime already running', {
      reason,
      selectedModel,
      port: status.port,
      mode: status.mode,
    });
    return;
  }

  appendAppLog('info', 'main', 'local-inference', 'Starting local chat runtime before LLM request', {
    reason,
    selectedModel,
    previousStatus: status,
  });

  const { modelsDir, presetPath } = prepareLlamaRouterRuntime();
  if (!fs.existsSync(modelsDir)) {
    throw new Error(`Models directory not found: ${modelsDir}`);
  }

  const started = await server.startRouter(modelsDir, {
    maxModels: 2,
    flashAttn: true,
    presetPath,
  });
  updateSettings({ llamaServerPort: started.port });
  ctx.resetLLMClient();
  status = server.getStatus();

  appendAppLog('info', 'main', 'local-inference', 'Local chat runtime started before LLM request', {
    reason,
    selectedModel,
    port: started.port,
    status,
  });
}
