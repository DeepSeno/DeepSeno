import { ExternalLink } from 'lucide-react';
import { ToggleSwitch } from '../../components/settings';
import type { AppSettings } from '../../hooks/useApi';

interface GeneralSectionProps {
  settings: AppSettings;
  s: any;
  updateField: (partial: Partial<AppSettings>) => void;
  onDirChange: (field: 'watchDir' | 'outputDir') => void;
  onLangChange: (lang: 'en' | 'zh') => void;
  currentLang: 'en' | 'zh';
  onOpenExternal: (path: string) => void;
}

export default function GeneralSection({
  settings,
  s,
  updateField,
  onDirChange,
  onLangChange,
  currentLang,
  onOpenExternal,
}: GeneralSectionProps) {
  return (
    <div>
      {/* ── Profile ───────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_profile || 'Profile'}</span>
      </h3>
      <div className="kz-card" style={{ padding: '6px 18px', marginBottom: 22 }}>
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{s.nickname_label || 'Nickname'}</div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              {s.nickname_hint || 'How the dashboard greeting addresses you. Leave blank for default.'}
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <input
              type="text"
              value={settings.userNickname || ''}
              onChange={(e) => updateField({ userNickname: e.target.value })}
              placeholder={s.nickname_placeholder || ''}
              maxLength={32}
              className="kz-input"
              style={{ width: 200, height: 30, padding: '0 10px', fontSize: 13 }}
            />
          </div>
        </div>
      </div>

      {/* ── Directories ───────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_directories || 'Directories'}</span>
        <span className="kz-section-title__count">2</span>
      </h3>
      <div className="kz-card" style={{ padding: '6px 18px', marginBottom: 22 }}>
        {/* Watch dir */}
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)', marginBottom: 4 }}>{s.watch_dir}</div>
            <div className="kz-mono" style={{ fontSize: 12, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {settings.watchDir || s.not_set}
            </div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              {s.watch_dir_hint || 'Audio files placed here will be automatically processed'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button onClick={() => onDirChange('watchDir')} className="kz-btn kz-btn--sm">{s.change}</button>
            {settings.watchDir && (
              <button
                onClick={() => onOpenExternal(settings.watchDir)}
                className="kz-btn kz-btn--sm kz-btn--ghost"
                title={s.open_folder}
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Auto-process toggle */}
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{s.auto_process_label || 'Auto-process new files'}</div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              {s.auto_process_desc || 'When off, you must manually import files to process'}
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <ToggleSwitch
              checked={settings.autoProcessWatchDir !== false}
              onChange={(v) => updateField({ autoProcessWatchDir: v })}
            />
          </div>
        </div>

        {/* Output dir */}
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)', marginBottom: 4 }}>{s.output_dir}</div>
            <div className="kz-mono" style={{ fontSize: 12, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {settings.outputDir || s.not_set}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button onClick={() => onDirChange('outputDir')} className="kz-btn kz-btn--sm">{s.change}</button>
            {settings.outputDir && (
              <button
                onClick={() => onOpenExternal(settings.outputDir)}
                className="kz-btn kz-btn--sm kz-btn--ghost"
                title={s.open_folder}
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Language & Display ─────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_language_display || 'Language & Display'}</span>
      </h3>
      <div className="kz-card" style={{ padding: '6px 18px' }}>
        <div className="kz-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{s.language}</div>
            <div className="kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              {s.section_language_display_desc || 'Set your preferred language and display options'}
            </div>
          </div>
          <div style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-card)' }}>
            <button
              onClick={() => onLangChange('en')}
              className="kz-mono"
              style={{
                fontSize: 10.5,
                padding: '6px 9px',
                letterSpacing: '0.06em',
                background: currentLang === 'en' ? 'var(--c-accent)' : 'transparent',
                color: currentLang === 'en' ? 'var(--c-accent-ink)' : 'var(--ink-mute)',
                border: 0,
                cursor: 'pointer',
              }}
            >
              EN
            </button>
            <button
              onClick={() => onLangChange('zh')}
              className="kz-mono"
              style={{
                fontSize: 10.5,
                padding: '6px 9px',
                letterSpacing: '0.06em',
                background: currentLang === 'zh' ? 'var(--c-accent)' : 'transparent',
                color: currentLang === 'zh' ? 'var(--c-accent-ink)' : 'var(--ink-mute)',
                border: 0,
                cursor: 'pointer',
              }}
            >
              ZH
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
