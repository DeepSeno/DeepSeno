import { Folder } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useApi } from '../../hooks/useApi';

interface Props {
  watchDir: string;
  outputDir: string;
  onWatchDir: (dir: string) => void;
  onOutputDir: (dir: string) => void;
}

export default function StepDirectories({ watchDir, outputDir, onWatchDir, onOutputDir }: Props) {
  const { t } = useI18n();
  const api = useApi();
  const w = t.wizard;

  async function selectDir(setter: (dir: string) => void) {
    const dir = await api.selectDirectory();
    if (dir) setter(dir);
  }

  return (
    <div className="flex flex-col flex-1 px-12 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Folder size={18} className="kz-text-accent" />
        <h2 className="kz-serif" style={{ fontSize: '22px', color: 'var(--ink)' }}>{w.dir_title}</h2>
      </div>

      {/* Watch directory */}
      <div className="mb-6">
        <div className="kz-serif-italic" style={{ fontSize: '13px', color: 'var(--ink-soft)', marginBottom: 4 }}>{w.watch_label}</div>
        <div className="kz-text-mute mb-3" style={{ fontSize: '12px' }}>{w.watch_desc}</div>
        <div className="flex items-center gap-2">
          <div
            className="flex-1 kz-mono truncate flex items-center"
            style={{
              padding: '0 12px',
              minHeight: 38,
              border: '1px solid var(--line)',
              borderRadius: 8,
              background: 'var(--bg-sunken)',
              color: 'var(--ink-soft)',
              fontSize: '12px',
            }}
          >
            {watchDir || <span className="kz-serif-italic kz-text-faint">{w.not_selected}</span>}
          </div>
          <button
            onClick={() => selectDir(onWatchDir)}
            className="kz-btn flex-shrink-0"
          >
            {w.select}
          </button>
        </div>
      </div>

      {/* Output directory */}
      <div>
        <div className="kz-serif-italic" style={{ fontSize: '13px', color: 'var(--ink-soft)', marginBottom: 4 }}>{w.output_label}</div>
        <div className="kz-text-mute mb-3" style={{ fontSize: '12px' }}>{w.output_desc}</div>
        <div className="flex items-center gap-2">
          <div
            className="flex-1 kz-mono truncate flex items-center"
            style={{
              padding: '0 12px',
              minHeight: 38,
              border: '1px solid var(--line)',
              borderRadius: 8,
              background: 'var(--bg-sunken)',
              color: 'var(--ink-soft)',
              fontSize: '12px',
            }}
          >
            {outputDir || <span className="kz-serif-italic kz-text-faint">{w.not_selected}</span>}
          </div>
          <button
            onClick={() => selectDir(onOutputDir)}
            className="kz-btn flex-shrink-0"
          >
            {w.select}
          </button>
        </div>
      </div>
    </div>
  );
}
