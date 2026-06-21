import { useState, useEffect } from 'react';
import {
  Mic, Users, Monitor, Tv, Keyboard,
  type LucideIcon,
} from 'lucide-react';
import { ToggleSwitch } from '../../components/settings';
import type { AppSettings } from '../../hooks/useApi';

interface RecordingSectionProps {
  settings: AppSettings;
  s: any;
  updateField: (partial: Partial<AppSettings>) => void;
  onUpdateSceneShortcut: (scene: string, shortcut: string) => Promise<boolean>;
}

const SCENES: readonly { key: string; icon: LucideIcon; needsScreen: boolean }[] = [
  { key: 'dictation', icon: Mic, needsScreen: false },
  { key: 'local_meeting', icon: Users, needsScreen: false },
  { key: 'online_meeting', icon: Monitor, needsScreen: true },
  { key: 'media', icon: Tv, needsScreen: true },
];

export default function RecordingSection({
  settings,
  s,
  updateField,
  onUpdateSceneShortcut,
}: RecordingSectionProps) {
  const [screenPermission, setScreenPermission] = useState<string>('unknown');
  const [localShortcuts, setLocalShortcuts] = useState(settings.sceneShortcuts);

  useEffect(() => {
    setLocalShortcuts(settings.sceneShortcuts);
  }, [settings.sceneShortcuts]);

  useEffect(() => {
    window.api.checkScreenPermission?.().then(setScreenPermission).catch(() => {});
  }, []);

  const handleShortcutBlur = async (scene: string, value: string) => {
    const original = settings.sceneShortcuts[scene as keyof typeof settings.sceneShortcuts];
    if (value === original) return;
    const ok = await onUpdateSceneShortcut(scene, value);
    if (ok) {
      updateField({
        sceneShortcuts: { ...settings.sceneShortcuts, [scene]: value },
      });
    } else {
      setLocalShortcuts((prev) => ({ ...prev, [scene]: original }));
    }
  };

  return (
    <div>
      {/* ── Scene Shortcuts ─────────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_scene_shortcuts || 'Scene Shortcuts'}</span>
        <span className="kz-section-title__count">{SCENES.length}</span>
      </h3>

      <div className="kz-card" style={{ padding: 14, marginBottom: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {SCENES.map(({ key, icon: Icon, needsScreen }) => (
            <div key={key} className="kz-paper" style={{ padding: 14, background: 'var(--bg-elev)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span
                  style={{
                    width: 26, height: 26, borderRadius: 7,
                    background: 'var(--bg-card)', color: 'var(--ink-soft)',
                    display: 'grid', placeItems: 'center',
                    border: '1px solid var(--line)',
                    flexShrink: 0,
                  }}
                >
                  <Icon size={13} />
                </span>
                <span className="kz-serif" style={{ fontSize: 14, flex: 1 }}>
                  {s[`recording_scene_${key}`] || key}
                </span>
                {needsScreen && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span
                      className={`kz-sdot ${
                        screenPermission === 'granted'
                          ? 'kz-sdot--success'
                          : screenPermission === 'unknown'
                            ? 'kz-sdot--mute'
                            : 'kz-sdot--warn'
                      }`}
                    />
                    <span className="kz-mono" style={{ fontSize: 10, color: 'var(--ink-mute)' }}>
                      {screenPermission === 'granted'
                        ? s.screen_permission_granted || 'OK'
                        : screenPermission === 'unknown'
                          ? '...'
                          : s.screen_permission_not_granted || 'N/A'}
                    </span>
                  </span>
                )}
              </div>

              <div className="kz-text-mute" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.5 }}>
                {s[`recording_scene_${key}_desc`] || ''}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Keyboard size={11} style={{ color: 'var(--ink-faint)', flexShrink: 0 }} />
                <input
                  type="text"
                  value={localShortcuts[key as keyof typeof localShortcuts] || ''}
                  onChange={(e) =>
                    setLocalShortcuts((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  onBlur={(e) => handleShortcutBlur(key, e.target.value)}
                  className="kz-input kz-mono"
                  style={{
                    height: 28,
                    fontSize: 11,
                    padding: '0 10px',
                    flex: 1,
                  }}
                  placeholder={s.recording_shortcut_placeholder || 'Set shortcut...'}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="kz-text-mute kz-mono" style={{ fontSize: 10.5, marginTop: 12 }}>
          {s.recording_shortcut_hint}
        </div>
      </div>

      {/* ── Post-Recording Behavior ──────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_post_recording || 'Post-Recording'}</span>
      </h3>
      <div className="kz-card" style={{ padding: '6px 18px' }}>
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{s.auto_paste}</div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>{s.auto_paste_desc}</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <ToggleSwitch
              checked={settings.autoPasteAfterRecording}
              onChange={(checked) => updateField({ autoPasteAfterRecording: checked })}
            />
          </div>
        </div>

        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{s.clipboard_continuous}</div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>{s.clipboard_continuous_desc}</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <ToggleSwitch
              checked={settings.clipboardContinuous}
              onChange={(checked) => updateField({ clipboardContinuous: checked })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
