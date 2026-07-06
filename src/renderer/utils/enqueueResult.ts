import type { PipelineEnqueueResult } from '../hooks/useApi';

export function isAlreadyProcessedEnqueue(result: PipelineEnqueueResult | null | undefined): boolean {
  return result?.status === 'skipped' && result.reason === 'already_processed';
}

export function isSkippedEnqueue(result: PipelineEnqueueResult | null | undefined): boolean {
  return result?.status === 'skipped';
}

export function isFailedEnqueue(result: PipelineEnqueueResult | null | undefined): boolean {
  return result?.status === 'failed';
}
