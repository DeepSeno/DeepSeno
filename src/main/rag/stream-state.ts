export type RagStreamKind = 'global' | 'scoped';

interface BaseRagStreamState {
  kind: RagStreamKind;
  question: string;
  text: string;
  status: string;
  active: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface GlobalRagStreamState extends BaseRagStreamState {
  kind: 'global';
  sessionId?: number;
}

export interface ScopedRagStreamState extends BaseRagStreamState {
  kind: 'scoped';
  recordingId: number;
}

export type RagStreamState = GlobalRagStreamState | ScopedRagStreamState;

export class RagStreamRegistry {
  private globalStream: GlobalRagStreamState | null = null;
  private scopedStream: ScopedRagStreamState | null = null;

  startGlobal(input: { question: string; sessionId?: number }): GlobalRagStreamState {
    const now = Date.now();
    this.globalStream = {
      kind: 'global',
      question: input.question,
      sessionId: input.sessionId,
      text: '',
      status: '',
      active: true,
      startedAt: now,
      updatedAt: now,
    };
    return this.globalStream;
  }

  appendGlobalChunk(chunk: string): void {
    if (!this.globalStream || !this.globalStream.active) return;
    this.globalStream.text += chunk;
    this.globalStream.updatedAt = Date.now();
  }

  setGlobalStatus(status: string): void {
    if (!this.globalStream || !this.globalStream.active) return;
    this.globalStream.status = status;
    this.globalStream.updatedAt = Date.now();
  }

  finishGlobal(): void {
    if (!this.globalStream) return;
    this.globalStream.active = false;
    this.globalStream.status = '';
    this.globalStream.updatedAt = Date.now();
  }

  cancelGlobal(): void {
    this.finishGlobal();
  }

  getGlobal(sessionId?: number | null): GlobalRagStreamState | null {
    if (!this.globalStream?.active) return null;
    if (sessionId != null && this.globalStream.sessionId !== sessionId) return null;
    return { ...this.globalStream };
  }

  startScoped(input: { question: string; recordingId: number }): ScopedRagStreamState {
    const now = Date.now();
    this.scopedStream = {
      kind: 'scoped',
      question: input.question,
      recordingId: input.recordingId,
      text: '',
      status: '',
      active: true,
      startedAt: now,
      updatedAt: now,
    };
    return this.scopedStream;
  }

  appendScopedChunk(chunk: string): void {
    if (!this.scopedStream || !this.scopedStream.active) return;
    this.scopedStream.text += chunk;
    this.scopedStream.updatedAt = Date.now();
  }

  setScopedStatus(status: string): void {
    if (!this.scopedStream || !this.scopedStream.active) return;
    this.scopedStream.status = status;
    this.scopedStream.updatedAt = Date.now();
  }

  finishScoped(): void {
    if (!this.scopedStream) return;
    this.scopedStream.active = false;
    this.scopedStream.status = '';
    this.scopedStream.updatedAt = Date.now();
  }

  cancelScoped(): void {
    this.finishScoped();
  }

  getScoped(recordingId?: number | null): ScopedRagStreamState | null {
    if (!this.scopedStream?.active) return null;
    if (recordingId != null && this.scopedStream.recordingId !== recordingId) return null;
    return { ...this.scopedStream };
  }
}

