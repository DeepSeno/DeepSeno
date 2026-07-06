interface EnqueueTaskLike {
  id: string;
  status: string;
  error?: string;
  recordingId?: number;
}

export interface PipelineEnqueueResponse {
  id: string;
  status: string;
  error?: string;
  reason?: string;
  recordingId?: number;
}

export function toPipelineEnqueueResponse(task: EnqueueTaskLike): PipelineEnqueueResponse {
  if (task.error === 'Recording already processed') {
    return {
      id: task.id,
      status: 'skipped',
      reason: 'already_processed',
      recordingId: task.recordingId,
      error: task.error,
    };
  }

  return {
    id: task.id,
    status: task.status,
    recordingId: task.recordingId,
    error: task.error,
  };
}
