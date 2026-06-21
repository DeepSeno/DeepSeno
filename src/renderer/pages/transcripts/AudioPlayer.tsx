import React, { RefObject, useMemo, useState, useRef, useEffect } from 'react';
import { Play, Pause, ChevronDown } from 'lucide-react';
import { SPEED_OPTIONS } from './types';

// ─── Compact speed picker — replaces 4-tab strip with a dropdown ──────
function SpeedPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const current = SPEED_OPTIONS.find((o) => o.value === value) ?? SPEED_OPTIONS[1];
  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="kz-btn kz-btn--sm"
        style={{
          height: 28,
          padding: '0 8px',
          gap: 4,
          fontSize: 11,
          fontFamily: 'var(--mono)',
          minWidth: 56,
          justifyContent: 'space-between',
        }}
        title="Playback speed"
        aria-label="Playback speed"
      >
        <span>{current.label}</span>
        <ChevronDown size={11} style={{ opacity: 0.7 }} />
      </button>
      {open && (
        <div
          className="kz-card"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            right: 0,
            minWidth: 80,
            padding: 4,
            zIndex: 30,
            boxShadow: '0 8px 24px oklch(0 0 0 / 0.18)',
          }}
        >
          {SPEED_OPTIONS.map((opt) => {
            const isOn = opt.value === value;
            return (
              <button
                key={opt.label}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  border: 0,
                  borderRadius: 5,
                  background: isOn ? 'var(--c-accent-bg)' : 'transparent',
                  color: isOn ? 'var(--c-accent)' : 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => {
                  if (!isOn) e.currentTarget.style.background = 'var(--bg-elev)';
                }}
                onMouseLeave={(e) => {
                  if (!isOn) e.currentTarget.style.background = 'transparent';
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Waveform — real peaks from decoded audio, fills as progress advances ──
const WF_BARS = 48;

// Decode an audio URL into normalized peak amplitudes (0-1) bucketed to WF_BARS.
// Uses 95th-percentile normalization so a single loud spike doesn't flatten the rest.
async function decodePeaks(src: string, bars: number): Promise<number[]> {
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ac: AudioContext = new Ctor();
  try {
    const decoded = await ac.decodeAudioData(buf);
    const ch = decoded.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(ch.length / bars));
    const buckets = new Array<number>(bars).fill(0);
    for (let i = 0; i < bars; i++) {
      const start = i * bucketSize;
      const end = Math.min(ch.length, start + bucketSize);
      let m = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
      buckets[i] = m;
    }
    const sorted = [...buckets].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const ref = Math.max(p95, 1e-4);
    // sqrt curve lifts quiet passages so they stay visible alongside loud ones
    return buckets.map((v) => Math.min(1, Math.sqrt(v / ref)));
  } finally {
    ac.close();
  }
}

function useRealPeaks(audioRef: RefObject<HTMLAudioElement | null>, audioLoaded: boolean) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const lastSrcRef = useRef<string | null>(null);
  useEffect(() => {
    if (!audioLoaded) {
      setPeaks(null);
      lastSrcRef.current = null;
      return;
    }
    const audio = audioRef.current;
    const src = audio?.currentSrc || '';
    if (!src || src === lastSrcRef.current) return;
    lastSrcRef.current = src;
    let cancelled = false;
    setPeaks(null);
    decodePeaks(src, WF_BARS)
      .then((p) => { if (!cancelled) setPeaks(p); })
      .catch((e) => { if (!cancelled) console.warn('[AudioPlayer] peak decode failed', e); });
    return () => { cancelled = true; };
  }, [audioLoaded, audioRef]);
  return peaks;
}

function Waveform({ progress, isPlaying, peaks }: { progress: number; isPlaying: boolean; peaks: number[] | null }) {
  // Placeholder used while peaks are decoding — flat, low-amplitude pattern
  const fallback = useMemo(
    () => Array.from({ length: WF_BARS }, (_, i) => 0.18 + (((i * 47 + 19) % 100) / 320)),
    []
  );
  const heights = peaks ?? fallback;
  const loading = peaks === null;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <>
      {heights.map((h, i) => {
        const pos = (i + 0.5) / WF_BARS;
        const isPlayed = pos <= p;
        const isHead = isPlaying && Math.abs(pos - p) < 1 / WF_BARS;
        return (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              borderRadius: 1.5,
              // Real peaks: 12% floor so silent gaps stay visible; fake/loading: as-is
              height: `${Math.max(12, h * 100)}%`,
              background: isPlayed
                ? 'var(--c-accent)'
                : 'color-mix(in oklch, var(--ink) 14%, transparent)',
              transition: 'background 0.12s, opacity 0.12s, height 0.18s',
              opacity: loading ? 0.35 : isHead ? 1 : isPlayed ? 0.95 : 0.6,
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </>
  );
}

interface AudioPlayerProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  progressRef: RefObject<HTMLDivElement | null>;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackSpeed: number;
  audioLoaded: boolean;
  audioError: boolean;
  liveSelected: boolean;
  onTogglePlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  onProgressClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  tr: Record<string, any>;
}

function formatPlayerTime(totalSec: number): string {
  if (!isFinite(totalSec) || isNaN(totalSec)) return '00:00';
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function AudioPlayer({
  audioRef,
  isPlaying,
  currentTime,
  duration,
  playbackSpeed,
  audioLoaded,
  audioError,
  liveSelected,
  onTogglePlayPause,
  onSpeedChange,
  progressRef,
  onProgressClick,
  tr,
}: AudioPlayerProps) {
  const peaks = useRealPeaks(audioRef, audioLoaded);
  if (liveSelected) return null;
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      style={{
        padding: '12px 22px',
        borderTop: '1px solid var(--line-soft)',
        background: 'var(--bg-elev)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <button
        onClick={onTogglePlayPause}
        disabled={!audioLoaded}
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          background: audioLoaded ? 'var(--c-accent)' : 'var(--line-strong)',
          color: audioLoaded ? 'var(--c-accent-ink)' : 'var(--ink-mute)',
          cursor: audioLoaded ? 'pointer' : 'not-allowed',
          opacity: audioLoaded ? 1 : 0.5,
          transition: 'background 0.14s',
        }}
        title={isPlaying ? tr.pause : tr.play}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>

      <span className="kz-mono kz-text-mute" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {audioError ? tr.audio_error : `${formatPlayerTime(currentTime)} / ${formatPlayerTime(duration)}`}
      </span>

      {/* Waveform — click-to-seek via the same handler as the old progress bar */}
      <div
        ref={progressRef as React.RefObject<HTMLDivElement>}
        onClick={onProgressClick}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          height: 24,
          overflow: 'hidden',
          cursor: audioLoaded ? 'pointer' : 'default',
        }}
      >
        <Waveform progress={progress / 100} isPlaying={isPlaying} peaks={peaks} />
      </div>

      <SpeedPicker value={playbackSpeed} onChange={onSpeedChange} />
    </div>
  );
}
