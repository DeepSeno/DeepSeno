import type { RefObject } from 'react';
import type { AppSettings } from '../../../hooks/useApi';

export type LocalInstallStage =
  | 'checking'
  | 'not_installed'
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'already_installed'
  | 'error';

export type LocalModelStatus = 'queued' | 'downloading' | 'testing' | 'done' | 'error';

export interface ModelsSectionProps {
  settings: AppSettings;
  s: any;
  updateField: (partial: Partial<AppSettings>) => void;

  // Local LLM (llama.cpp)
  localModels: string[];
  localStatus: 'checking' | 'connected' | 'disconnected';
  onCheckLocal: () => void;
  onTestLocal: (modelName?: string) => void;
  localTesting: boolean;
  recentlyTested: string | null;
  localInstallStage: LocalInstallStage;
  localModelStatuses: Record<string, LocalModelStatus>;
  localModelErrors: Record<string, string>;
  localModelProgress: Record<string, { completed: number; total: number }>;
  onInstallLocal: () => void;
  onPullLocalModel: (modelName: string, force?: boolean) => void;
  onCancelLocalPull: (modelName?: string) => void;
  onLocalNotReady?: () => void;

  // Cloud
  cloudStatus: 'idle' | 'checking' | 'connected' | 'error';
  cloudError: string | null;
  cloudModels: string[];
  onCheckCloud: () => void;

  // Sherpa / SenseVoice
  svModelStatus: 'checking' | 'ready' | 'missing' | 'downloading' | 'error';
  svDownloadProgress: number;
  svError: string | null;
  onDownloadSenseVoice: () => void;
  onCancelSenseVoice: () => void;
  mirror: '' | 'modelscope' | 'hf-mirror' | 'ghfast';
  onMirrorChange: (mirror: '' | 'modelscope' | 'hf-mirror' | 'ghfast') => void;

  // Hardware
  totalMemoryGB: number;

  // Scroll targets (only consumed by EnginesSection)
  sherpaRef?: RefObject<HTMLDivElement>;
  localRef?: RefObject<HTMLDivElement>;
  llmModelListRef?: RefObject<HTMLDivElement>;
}
