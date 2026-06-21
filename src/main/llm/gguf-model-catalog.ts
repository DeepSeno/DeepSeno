/**
 * GGUF Model Catalog — maps internal model IDs to ModelScope download URLs.
 *
 * Primary source: ModelScope (https://modelscope.cn)
 * Fallback mirrors: hf-mirror, ghfast (for network issues)
 *
 * All URLs verified downloadable (HTTP 302 → CDN) on 2026-06-19.
 */

export interface GGUFModelEntry {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  /** ModelScope repo path (owner/repo) */
  msRepo: string;
  /** File path within the ModelScope repo */
  msFilePath: string;
  mirrors: {
    'hf-mirror'?: string;
    'ghfast'?: string;
  };
  type: 'llm' | 'embed';
}

const MS_API = 'https://modelscope.cn/api/v1/models';

/** Build ModelScope download URL for a catalog entry. */
export function getModelScopeUrl(entry: GGUFModelEntry): string {
  return `${MS_API}/${entry.msRepo}/repo?Revision=master&FilePath=${entry.msFilePath}`;
}

/** Build download URL based on mirror preference. */
export function getDownloadUrl(entry: GGUFModelEntry, mirror: string): string {
  if (mirror === 'hf-mirror' && entry.mirrors['hf-mirror']) {
    return entry.mirrors['hf-mirror']!;
  }
  if (mirror === 'ghfast' && entry.mirrors['ghfast']) {
    return entry.mirrors['ghfast']!;
  }
  // Default: ModelScope
  return getModelScopeUrl(entry);
}

// ─── Qwen3.5 GGUF models ────────────────────────────────────
// ModelScope repos: unsloth/Qwen3.5-*-GGUF
// Verified: all return HTTP 302 on 2026-06-19

export const GGUF_CATALOG: GGUFModelEntry[] = [
  // ── Qwen3.5 LLM models ──────────────────────────────────
  {
    id: 'qwen3.5:4b',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    fileSizeBytes: 3_400_000_000,
    msRepo: 'unsloth/Qwen3.5-4B-GGUF',
    msFilePath: 'Qwen3.5-4B-Q4_K_M.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    },
    type: 'llm',
  },
  {
    id: 'qwen3.5:9b',
    fileName: 'Qwen3.5-9B-Q4_K_M.gguf',
    fileSizeBytes: 6_600_000_000,
    msRepo: 'unsloth/Qwen3.5-9B-GGUF',
    msFilePath: 'Qwen3.5-9B-Q4_K_M.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    },
    type: 'llm',
  },
  {
    id: 'qwen3.5:27b',
    fileName: 'Qwen3.5-27B-Q4_K_M.gguf',
    fileSizeBytes: 17_000_000_000,
    msRepo: 'unsloth/Qwen3.5-27B-GGUF',
    msFilePath: 'Qwen3.5-27B-Q4_K_M.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf',
    },
    type: 'llm',
  },
  {
    id: 'qwen3.5:35b',
    fileName: 'Qwen3.5-35B-A3B-Q4_K_M.gguf',
    fileSizeBytes: 24_000_000_000,
    msRepo: 'unsloth/Qwen3.5-35B-A3B-GGUF',
    msFilePath: 'Qwen3.5-35B-A3B-Q4_K_M.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf',
    },
    type: 'llm',
  },
  {
    id: 'qwen3.5:122b',
    fileName: 'Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf',
    fileSizeBytes: 81_000_000_000,
    msRepo: 'unsloth/Qwen3.5-122B-A10B-GGUF',
    msFilePath: 'Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/unsloth/Qwen3.5-122B-A10B-GGUF/resolve/main/Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF/resolve/main/Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf',
    },
    type: 'llm',
  },

  // ── Embedding model ──────────────────────────────────────
  {
    id: 'bge-m3',
    fileName: 'bge-m3-Q8_0.gguf',
    fileSizeBytes: 1_200_000_000,
    msRepo: 'gpustack/bge-m3-GGUF',
    msFilePath: 'bge-m3-Q8_0.gguf',
    mirrors: {
      'hf-mirror': 'https://hf-mirror.com/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf',
      'ghfast': 'https://ghfast.top/https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf',
    },
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
