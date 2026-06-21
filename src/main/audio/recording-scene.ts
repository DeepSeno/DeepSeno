/**
 * Recording scene types and configurations.
 *
 * Defines the four recording scenes supported by DeepSeno,
 * each with its own audio-source and speaker-identification strategy.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four supported recording scenes. */
export type RecordingScene =
  | 'dictation'
  | 'local_meeting'
  | 'online_meeting'
  | 'media';

/** Physical audio source. */
export type AudioSource = 'mic' | 'system';

/** Strategy used to assign speaker labels to a given audio source. */
export type SpeakerStrategy = 'auto_me' | 'auto_system' | 'diarize' | 'none';

// ---------------------------------------------------------------------------
// SceneConfig
// ---------------------------------------------------------------------------

/** Per-scene configuration that drives audio capture and speaker ID. */
export interface SceneConfig {
  /** Scene identifier. */
  scene: RecordingScene;
  /** Human-readable label (English). */
  label: string;
  /** Human-readable label (Chinese). */
  labelZh: string;
  /** Whether the microphone input is used. */
  useMic: boolean;
  /** Whether the system audio output is captured. */
  useSystem: boolean;
  /** Speaker identification strategy for the mic channel. */
  micSpeakerStrategy: 'auto_me' | 'diarize' | 'none';
  /** Speaker identification strategy for the system audio channel. */
  systemSpeakerStrategy: 'auto_system' | 'diarize' | 'none';
  /** Whether to run LLM info extraction (todos/meetings/decisions). */
  extractInfo: boolean;
  /** Whether to extract personal memories to agent_memory. */
  extractMemory: boolean;
  /** Whether to include in daily/weekly summary aggregation. */
  includeSummary: boolean;
}

// ---------------------------------------------------------------------------
// Scene config table
// ---------------------------------------------------------------------------

/**
 * Canonical configuration for every recording scene.
 *
 * | Scene          | Mic | System | Mic strategy | System strategy |
 * |----------------|-----|--------|--------------|-----------------|
 * | dictation      | yes | no     | auto_me      | none            |
 * | local_meeting  | yes | no     | diarize      | none            |
 * | online_meeting | yes | yes    | auto_me      | diarize         |
 * | media          | no  | yes    | none         | diarize         |
 */
export const SCENE_CONFIGS: Record<RecordingScene, SceneConfig> = {
  dictation: {
    scene: 'dictation',
    label: 'Dictation',
    labelZh: '口述',
    useMic: true,
    useSystem: false,
    micSpeakerStrategy: 'auto_me',
    systemSpeakerStrategy: 'none',
    extractInfo: true,
    extractMemory: true,
    includeSummary: true,
  },
  local_meeting: {
    scene: 'local_meeting',
    label: 'Local Meeting',
    labelZh: '现场会议',
    useMic: true,
    useSystem: false,
    micSpeakerStrategy: 'diarize',
    systemSpeakerStrategy: 'none',
    extractInfo: true,
    extractMemory: true,
    includeSummary: true,
  },
  online_meeting: {
    scene: 'online_meeting',
    label: 'Online Meeting',
    labelZh: '线上会议',
    useMic: true,
    useSystem: true,
    micSpeakerStrategy: 'auto_me',
    systemSpeakerStrategy: 'diarize',
    extractInfo: true,
    extractMemory: true,
    includeSummary: true,
  },
  media: {
    scene: 'media',
    label: 'Media Transcription',
    labelZh: '媒体转写',
    useMic: false,
    useSystem: true,
    micSpeakerStrategy: 'none',
    systemSpeakerStrategy: 'diarize',
    extractInfo: false,
    extractMemory: false,
    includeSummary: false,
  },
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Return the SceneConfig for a given scene, falling back to `dictation`
 * if the scene is unknown.
 */
export function getSceneConfig(scene: RecordingScene): SceneConfig {
  return SCENE_CONFIGS[scene] ?? SCENE_CONFIGS.dictation;
}
