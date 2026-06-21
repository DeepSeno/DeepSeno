import { useState, useEffect } from 'react';
import { useApi } from './useApi';

export type FeatureLevel = 'beginner' | 'intermediate' | 'advanced';

/**
 * Numeric rank for each feature level, used to compare levels.
 */
const LEVEL_RANK: Record<FeatureLevel, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

/**
 * Returns true if `current` is at least `required`.
 * e.g. meetsLevel('intermediate', 'beginner') => true
 */
export function meetsLevel(current: FeatureLevel, required: FeatureLevel): boolean {
  return LEVEL_RANK[current] >= LEVEL_RANK[required];
}

/**
 * Hook that determines the current feature disclosure level.
 *
 * Priority:
 * 1. If `showAllFeatures` is enabled in settings, returns 'advanced'.
 * 2. Otherwise auto-detects based on recording count:
 *    - 0-4   recordings → 'beginner'
 *    - 5-19  recordings → 'intermediate'
 *    - 20+   recordings → 'advanced'
 */
export function useFeatureLevel(): FeatureLevel {
  const api = useApi();
  const [level, setLevel] = useState<FeatureLevel>('advanced');

  useEffect(() => {
    api.loadSettings().then((settings) => {
      if (settings.showAllFeatures) {
        setLevel('advanced');
        return;
      }
      // Auto-detect based on recording count
      api.getDbStats().then((stats) => {
        if (stats.recordingCount >= 20) {
          setLevel('advanced');
        } else if (stats.recordingCount >= 5) {
          setLevel('intermediate');
        } else {
          setLevel('beginner');
        }
      }).catch(() => {
        // If DB is unavailable, show all features
        setLevel('advanced');
      });
    }).catch(() => {
      // If settings fail, show all features
      setLevel('advanced');
    });
  }, []);

  return level;
}
