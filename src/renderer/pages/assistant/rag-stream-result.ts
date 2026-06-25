export interface RagStreamResult {
  success: boolean;
  error?: string;
}

export function getRagStreamFailureMessage(result: RagStreamResult, fallback: string): string | null {
  if (result.success) return null;
  const message = result.error?.trim();
  return message || fallback;
}
