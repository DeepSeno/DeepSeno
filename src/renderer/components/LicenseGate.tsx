import { useState } from 'react';
import { ShieldAlert, Key, X, ExternalLink, ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useLicense } from '../hooks/useLicense';
import { SITE_BASE_URL } from '../config';

/**
 * LicenseGate — persistent top banner shown when the trial has expired.
 * NOT a full-screen blocker. Basic features remain accessible.
 * Dismissible — after dismissal, a compact badge remains visible.
 */
export default function LicenseGate() {
  const { t } = useI18n();
  const api = useApi();
  const license = useLicense();
  const s = t.settings;

  const [dismissed, setDismissed] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleActivate = async () => {
    if (!licenseKey.trim()) return;
    setActivating(true);
    setError(null);
    try {
      const result = await api.licenseActivate(licenseKey.trim());
      if (result.success) {
        await license.refresh();
      } else {
        setError(result.error || s.license_error);
      }
    } catch (err) {
      setError(s.license_error);
    }
    setActivating(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleActivate();
    }
  };

  // Collapsed badge — shown after user dismisses the full banner
  if (dismissed) {
    return (
      <div
        style={{
          WebkitAppRegion: 'drag',
          borderBottom: '1px solid var(--line)',
          background: 'var(--c-warn-bg)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        <button
          onClick={() => setDismissed(false)}
          className="w-full flex items-center gap-2 px-3 py-1.5 kz-mono cursor-pointer transition-colors"
          style={{
            WebkitAppRegion: 'no-drag',
            background: 'transparent',
            color: 'var(--c-warn)',
            fontSize: '11px',
            // Clear macOS traffic lights (at x:14, ~68px wide)
            paddingLeft: '92px',
          }}
        >
          <ShieldAlert size={12} />
          <span>{s.license_gate_title}</span>
          <ChevronDown size={10} />
        </button>
      </div>
    );
  }

  // Full banner
  return (
    <div
      className="w-full"
      style={{
        WebkitAppRegion: 'drag',
        background: 'var(--bg-sunken)',
        borderBottom: '1px solid var(--line)',
        color: 'var(--ink)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Header row */}
      <div
        className="flex items-center justify-between py-2"
        style={{
          borderBottom: '1px solid var(--line-soft)',
          // Clear macOS traffic lights (at x:14, ~68px wide)
          paddingLeft: '92px',
          paddingRight: '16px',
        }}
      >
        <div
          className="flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <span className="kz-sdot kz-sdot--warn" />
          <ShieldAlert size={14} style={{ color: 'var(--c-warn)' }} />
          <span className="kz-serif-italic" style={{ color: 'var(--c-warn)', fontSize: '12.5px', letterSpacing: '0.02em' }}>
            {s.license_gate_title}
          </span>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="kz-btn kz-btn--ghost kz-btn--sm"
          title={s.license_gate_dismiss}
          aria-label={s.license_gate_dismiss}
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div
        className="py-3 space-y-3"
        style={{
          WebkitAppRegion: 'no-drag',
          paddingLeft: '92px',
          paddingRight: '16px',
        }}
      >
        <p className="kz-text-soft" style={{ fontSize: '12.5px', lineHeight: 1.6 }}>
          {s.license_gate_desc}
        </p>

        {/* Activation input */}
        <div className="flex items-center gap-2">
          <div className="kz-search-wrap flex-1">
            <Key size={12} className="kz-text-mute flex-shrink-0" />
            <input
              type="text"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={s.license_key_placeholder}
              className="kz-mono"
              disabled={activating}
            />
          </div>
          <button
            onClick={handleActivate}
            disabled={activating || !licenseKey.trim()}
            className="kz-btn kz-btn--accent whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {activating ? s.license_activating : s.license_activate}
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div
            className="kz-badge kz-badge--danger"
            style={{ display: 'block', padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: '11.5px', letterSpacing: 'normal' }}
          >
            {error}
          </div>
        )}

        {/* Footer info */}
        <div className="flex items-center justify-between kz-mono kz-text-mute" style={{ fontSize: '11px' }}>
          <span>{s.license_gate_basic}</span>
          <button
            onClick={() => {
              try { api.openExternal(SITE_BASE_URL + '/'); } catch {}
            }}
            className="flex items-center gap-1 kz-text-accent hover:opacity-80"
          >
            {s.license_gate_purchase} deepseno.enmooy.com
            <ExternalLink size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}
