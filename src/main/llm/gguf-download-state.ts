export type GGUFDownloadStatus = 'downloading' | 'success' | 'error' | 'cancelled';

export interface GGUFDownloadState {
  model: string;
  status: GGUFDownloadStatus;
  completed: number;
  total: number;
  error?: string;
  updatedAt: number;
}

export class GGUFDownloadStateStore {
  private states = new Map<string, GGUFDownloadState>();

  update(
    model: string,
    patch: Partial<Omit<GGUFDownloadState, 'model' | 'updatedAt'>>,
  ): GGUFDownloadState {
    const prev = this.states.get(model);
    const status = patch.status ?? prev?.status ?? 'downloading';
    let completed = patch.completed ?? prev?.completed ?? 0;
    let total = patch.total ?? prev?.total ?? 0;

    if (status === 'downloading' && prev?.status === 'downloading') {
      completed = Math.max(completed, prev.completed);
      total = Math.max(total, prev.total);
    }

    const next: GGUFDownloadState = {
      model,
      status,
      completed,
      total,
      updatedAt: Date.now(),
    };

    if (patch.error !== undefined) {
      next.error = patch.error;
    } else if (status === 'error' && prev?.error) {
      next.error = prev.error;
    }

    this.states.set(model, next);
    return next;
  }

  get(model: string): GGUFDownloadState | null {
    return this.states.get(model) ?? null;
  }

  snapshot(): GGUFDownloadState[] {
    return Array.from(this.states.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  clear(): void {
    this.states.clear();
  }
}

export const ggufDownloadStateStore = new GGUFDownloadStateStore();
