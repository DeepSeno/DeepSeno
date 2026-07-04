import { createLLMClient, getLLMModel } from './create-client';
import type { AppSettings } from '../settings';

const LIGHT_MODEL = 'qwen3.5:4b';
// Models large enough to benefit from a lighter paste-clean model.
// Any of these substrings in the main-model name triggers automatic downgrade
// to LIGHT_MODEL for mid-recording clean calls (main model still used for
// Q&A / post-processing).
const HEAVY_MODEL_PATTERNS = [
  '9b', '14b', '27b', '32b', '35b', '70b', '65b', '72b', '122b',
  'moe',
];

// Cache model list to avoid repeated Local API calls
let cachedModels: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 60_000; // 60s

/**
 * Resolve the model name for paste-clean optimization.
 * Client always follows llmProvider setting — this only determines the model name.
 *
 * Rules:
 * - User explicitly set pasteCleanModel → use that model name
 * - Local Local with heavy model (14b+) → use 7b, auto-pull if needed
 * - Otherwise → use main model
 */
export async function resolvePasteCleanModel(
  settings: AppSettings,
): Promise<{ model: string; keepAlive?: string }> {
  const mainModel = getLLMModel(settings);
  const client = createLLMClient(settings);

  // User explicitly set pasteCleanModel → use it directly
  if (settings.pasteCleanModel) {
    // For local Local, verify model exists
    if (settings.llmProvider !== 'openai') {
      try {
        let models: string[];
        if (cachedModels && Date.now() < cacheExpiry) {
          models = cachedModels;
        } else {
          models = await client.listModels();
          cachedModels = models;
          cacheExpiry = Date.now() + CACHE_TTL;
        }
        if (!models.includes(settings.pasteCleanModel)) {
          console.warn(`[paste-clean] "${settings.pasteCleanModel}" not found locally, falling back to ${mainModel}`);
          return { model: mainModel };
        }
      } catch {
        console.warn(`[paste-clean] Cannot verify "${settings.pasteCleanModel}", falling back to ${mainModel}`);
        return { model: mainModel };
      }
      return { model: settings.pasteCleanModel, keepAlive: '5m' };
    }
    // Cloud provider — use the user-specified model name directly
    return { model: settings.pasteCleanModel };
  }

  // Cloud API — use main cloud model
  if (settings.llmProvider === 'openai') {
    return { model: mainModel };
  }

  // Local Local: check if main model is heavy enough to benefit from a lighter model
  const isHeavy = HEAVY_MODEL_PATTERNS.some((p) => mainModel.includes(p));
  if (!isHeavy) {
    return { model: mainModel };
  }

  // Heavy model — try to use lighter model for paste-clean
  try {
    let models: string[];
    if (cachedModels && Date.now() < cacheExpiry) {
      models = cachedModels;
    } else {
      models = await client.listModels();
      cachedModels = models;
      cacheExpiry = Date.now() + CACHE_TTL;
    }

    if (!models.includes(LIGHT_MODEL)) {
      console.log(`[paste-clean] ${LIGHT_MODEL} not installed, falling back to ${mainModel}`);
      return { model: mainModel };
    }

    return { model: LIGHT_MODEL, keepAlive: '5m' };
  } catch {
    return { model: mainModel };
  }
}
