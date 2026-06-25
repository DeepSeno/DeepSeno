import { GGUF_CATALOG } from './gguf-model-catalog';

export const GGUF_COMPLETE_RATIO = 0.95;

export function isCompleteGGUFFile(actualBytes: number, expectedBytes: number): boolean {
  return actualBytes >= expectedBytes * GGUF_COMPLETE_RATIO;
}

export function getDownloadedGGUFModelIds(getFileSize: (fileName: string) => number | null): string[] {
  return GGUF_CATALOG
    .filter((model) => {
      const size = getFileSize(model.fileName);
      return size !== null && isCompleteGGUFFile(size, model.fileSizeBytes);
    })
    .map((model) => model.id);
}
