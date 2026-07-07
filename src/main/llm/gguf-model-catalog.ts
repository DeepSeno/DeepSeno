/**
 * GGUF Model Catalog — maps internal model IDs to ModelScope download URLs.
 *
 * Download source: ModelScope (https://modelscope.cn)
 *
 * Single-file sizes verified from ModelScope response headers on 2026-07-07.
 */

export interface GGUFModelEntry {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  /** ModelScope repo path (owner/repo) */
  msRepo: string;
  /** File path within the ModelScope repo */
  msFilePath: string;
  type: 'llm' | 'embed';
}

const MS_API = 'https://modelscope.cn/api/v1/models';

/** Build ModelScope download URL for a catalog entry. */
export function getModelScopeUrl(entry: GGUFModelEntry): string {
  return `${MS_API}/${entry.msRepo}/repo?Revision=master&FilePath=${entry.msFilePath}`;
}

/** Build download URL. mirror is kept for IPC compatibility; downloads always use ModelScope. */
export function getDownloadUrl(entry: GGUFModelEntry, _mirror?: string): string {
  return getModelScopeUrl(entry);
}

// ─── Qwen3.5 GGUF models ────────────────────────────────────
// ModelScope repos: unsloth/Qwen3.5-*-GGUF
// Verified: all single-file models return downloadable ModelScope responses on 2026-07-07.

export const GGUF_CATALOG: GGUFModelEntry[] = [
  // ── Qwen3.5 LLM models ──────────────────────────────────
  {
    id: 'qwen3.5:4b',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    fileSizeBytes: 2_740_937_888,
    msRepo: 'unsloth/Qwen3.5-4B-GGUF',
    msFilePath: 'Qwen3.5-4B-Q4_K_M.gguf',
    type: 'llm',
  },
  {
    id: 'qwen3.5:9b',
    fileName: 'Qwen3.5-9B-Q4_K_M.gguf',
    fileSizeBytes: 5_680_522_464,
    msRepo: 'unsloth/Qwen3.5-9B-GGUF',
    msFilePath: 'Qwen3.5-9B-Q4_K_M.gguf',
    type: 'llm',
  },
  {
    id: 'qwen3.5:27b',
    fileName: 'Qwen3.5-27B-Q4_K_M.gguf',
    fileSizeBytes: 16_740_812_704,
    msRepo: 'unsloth/Qwen3.5-27B-GGUF',
    msFilePath: 'Qwen3.5-27B-Q4_K_M.gguf',
    type: 'llm',
  },
  {
    id: 'qwen3.5:35b',
    fileName: 'Qwen3.5-35B-A3B-Q4_K_M.gguf',
    fileSizeBytes: 22_016_023_168,
    msRepo: 'unsloth/Qwen3.5-35B-A3B-GGUF',
    msFilePath: 'Qwen3.5-35B-A3B-Q4_K_M.gguf',
    type: 'llm',
  },
  // ── Embedding model ──────────────────────────────────────
  {
    id: 'bge-m3',
    fileName: 'bge-m3-Q8_0.gguf',
    fileSizeBytes: 634_553_760,
    msRepo: 'gpustack/bge-m3-GGUF',
    msFilePath: 'bge-m3-Q8_0.gguf',
    type: 'embed',
  },
];

/** Lookup a model entry by its ID (e.g. "qwen3.5:4b"). */
export function findModel(modelId: string): GGUFModelEntry | undefined {
  return GGUF_CATALOG.find((m) => m.id === modelId);
}

/** Get all model IDs of a given type. */
export function getModelIds(type?: 'llm' | 'embed'): string[] {
  const list = type ? GGUF_CATALOG.filter((m) => m.type === type) : GGUF_CATALOG;
  return list.map((m) => m.id);
}
