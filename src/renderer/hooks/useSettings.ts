import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from './useApi';
import type { AppSettings } from './useApi';
import { useNotifications } from '../components/NotificationCenter';
import { useI18n } from '../i18n';

/**
 * Shared settings state with debounced auto-save.
 * Used by Models, Channels, and Settings pages to avoid triplicating
 * the settings loading, update, and save indicator logic.
 */
export function useSettings() {
  const api = useApi();
  const { toast } = useNotifications();
  const { t } = useI18n();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load settings on mount
  useEffect(() => {
    api.loadSettings().then(setSettings);
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const updateField = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...partial } : prev);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const updated = await api.updateSettings(partial);
        setSettings(updated);
        setSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 1500);
      } catch {
        toast('error', t.common.save_failed);
      }
    }, 500);
  }, [api, toast, t]);

  return { settings, saved, updateField };
}
