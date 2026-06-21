import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes merged onto the trigger button (e.g. font / width). */
  className?: string;
  /** Inline style merged onto the trigger button (e.g. width / height overrides). */
  style?: React.CSSProperties;
  /** Accessible label for the trigger. */
  ariaLabel?: string;
}

/**
 * Themed dropdown that replaces the native <select>. Matches the app design
 * tokens (works in both light & dark) and renders its menu in a portal so it
 * is never clipped by a modal or an overflow:hidden container. Supports mouse +
 * keyboard (↑/↓/Enter/Esc/Home/End) and click-outside to close.
 */
export default function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  className = '',
  style,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [flipUp, setFlipUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.value === value);

  const updatePosition = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect(r);
    // Flip the menu above the trigger when there isn't room below.
    const below = window.innerHeight - r.bottom;
    setFlipUp(below < 240 && r.top > below);
  }, []);

  // Reposition on open + while scrolling/resizing.
  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onScroll = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, updatePosition]);

  // Close on outside pointerdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    const cur = options.findIndex((o) => o.value === value);
    setActiveIdx(cur >= 0 ? cur : 0);
    setOpen(true);
  }, [disabled, options, value]);

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      btnRef.current?.focus();
    },
    [onChange, options],
  );

  const moveActive = useCallback(
    (dir: 1 | -1) => {
      setActiveIdx((i) => {
        const n = options.length;
        if (n === 0) return -1;
        let next = i;
        for (let step = 0; step < n; step++) {
          next = (next + dir + n) % n;
          if (!options[next]?.disabled) return next;
        }
        return i;
      });
    },
    [options],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIdx(options.findIndex((o) => !o.disabled));
        break;
      case 'End':
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) { if (!options[i].disabled) { setActiveIdx(i); break; } }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIdx >= 0) commit(activeIdx);
        break;
    }
  };

  const menu = open && rect ? createPortal(
    <ul
      ref={menuRef}
      role="listbox"
      id={listboxId}
      style={{
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
        maxHeight: 264,
        overflowY: 'auto',
        zIndex: 10000,
        background: 'var(--bg-card)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)',
        padding: 4,
      }}
    >
      {options.length === 0 ? (
        <li style={{ padding: '8px 10px', fontSize: 12, color: 'var(--ink-mute)' }} className="kz-serif-italic">
          --
        </li>
      ) : (
        options.map((opt, i) => {
          const isSel = opt.value === value;
          const isActive = i === activeIdx;
          return (
            <li key={opt.value} role="option" aria-selected={isSel}>
              <button
                type="button"
                disabled={opt.disabled}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); commit(i); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: 0,
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  background: isActive ? 'var(--bg-elev)' : 'transparent',
                  color: opt.disabled ? 'var(--ink-faint)' : isSel ? 'var(--ink)' : 'var(--ink-soft)',
                  opacity: opt.disabled ? 0.6 : 1,
                  transition: 'background 0.12s, color 0.12s',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                {isSel && <Check size={13} style={{ color: 'var(--c-accent)', flexShrink: 0 }} />}
              </button>
            </li>
          );
        })
      )}
    </ul>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`kz-input kz-select ${className}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          ...style,
          ...(open ? { borderColor: 'var(--c-accent)', boxShadow: '0 0 0 3px color-mix(in oklch, var(--c-accent) 18%, transparent)' } : {}),
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: selected ? 'var(--ink)' : 'var(--ink-mute)',
          }}
        >
          {selected ? selected.label : (placeholder || '')}
        </span>
        <ChevronDown
          size={14}
          className="kz-text-mute"
          style={{ flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>
      {menu}
    </>
  );
}
