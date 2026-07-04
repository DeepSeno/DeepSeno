import { useState, useCallback } from 'react';
import { FolderOpen, Mic, Database, HelpCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useSettings } from '../hooks/useSettings';
import { useNotifications } from '../components/NotificationCenter';
import GeneralSection from './settings/GeneralSection';
import RecordingSection from './settings/RecordingSection';
import SystemSection from './settings/SystemSection';
import Help from './Help';

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const s = t.settings;
  const { settings, saved, updateField } = useSettings();

  // ─── Section navigation ──────────────────────────────────────
  const [activeSection, setActiveSection] = useState('general');

  const TABS = [
    { key: 'general',   label: s.nav_general,   icon: FolderOpen },
    { key: 'recording', label: s.nav_recording, icon: Mic },
    { key: 'system',    label: s.nav_data,      icon: Database },
    { key: 'help',      label: t.menu.help,     icon: HelpCircle },
  ];

  // ─── Callbacks ─────────────────────────────────────────────
  const handleDirChange = useCallback(async (field: 'watchDir' | 'outputDir') => {
    const dir = await api.selectDirectory();
    if (dir) {
      updateField({ [field]: dir });
    }
  }, [api, updateField]);

  const handleLangChange = useCallback((newLang: 'en' | 'zh') => {
    setLang(newLang);
    updateField({ language: newLang });
  }, [setLang, updateField]);

  const handleUpdateSceneShortcut = useCallback(async (scene: string, shortcut: string) => {
    const ok = await api.updateSceneShortcut(scene, shortcut);
    if (ok) {
      toast('success', s.recording_shortcut_ok);
    } else {
      toast('error', s.recording_shortcut_fail);
    }
    return ok;
  }, [api, s, toast]);

  const handleOpenExternal = useCallback((path: string) => {
    try { api.openExternal(path); } catch {}
  }, [api]);

  // ─── Loading state ───────────────────────────────────────────
  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-text-mute kz-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div>
      {/* Page header */}
      <div className="kz-ph">
        <div>
          <div className="kz-ph__title">{t.menu.settings}</div>
          <div className="kz-ph__sub">{s.nav_general} · {s.nav_recording} · {s.nav_data} · {t.menu.help}</div>
        </div>
        {saved && (
          <div className="kz-ph__right">
            <span className="kz-badge kz-badge--success kz-badge--dot">auto-saved</span>
          </div>
        )}
      </div>

      {/* Top tab pills — Settings uses design's larger spec (per page-settings.jsx) */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-card)',
            width: 'fit-content',
          }}
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            const on = activeSection === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 16px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  background: on ? 'var(--c-accent)' : 'transparent',
                  color: on ? 'var(--c-accent-ink)' : 'var(--ink-soft)',
                  border: 0,
                  cursor: 'pointer',
                  transition: 'background 0.14s, color 0.14s',
                }}
              >
                <Icon size={13} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Full-width content */}
      <div className="min-w-0">
        {activeSection === 'general' && (
          <GeneralSection
            settings={settings}
            s={s}
            updateField={updateField}
            onDirChange={handleDirChange}
            onLangChange={handleLangChange}
            currentLang={lang}
            onOpenExternal={handleOpenExternal}
          />
        )}

        {activeSection === 'recording' && (
          <RecordingSection
            settings={settings}
            s={s}
            updateField={updateField}
            onUpdateSceneShortcut={handleUpdateSceneShortcut}
          />
        )}

        {activeSection === 'system' && (
          <SystemSection
            settings={settings}
            s={s}
            updateField={updateField}
          />
        )}

        {activeSection === 'help' && (
          <Help embedded />
        )}
      </div>
    </div>
  );
}
