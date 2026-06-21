import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

interface ModelComboboxProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
}

const INPUT = 'kz-input kz-mono w-full';

export default function ModelCombobox({
  value,
  onChange,
  suggestions,
  placeholder,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external value changes into internal input state
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Update dropdown position when opened or window resizes/scrolls
  const updatePosition = useCallback(() => {
    if (inputRef.current) {
      setDropdownRect(inputRef.current.getBoundingClientRect());
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  const filtered = suggestions.filter((s) =>
    s.toLowerCase().includes(inputValue.toLowerCase()),
  );

  const handleSelect = useCallback(
    (model: string) => {
      setInputValue(model);
      onChange(model);
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onChange(inputValue);
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const handleFocus = () => {
    setOpen(true);
  };

  const handleBlur = () => {
    // Small delay so click on suggestion registers before close
    setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) {
        setOpen(false);
        // Commit whatever the user typed
        if (inputValue !== value) {
          onChange(inputValue);
        }
      }
    }, 150);
  };

  const dropdown = open && filtered.length > 0 && dropdownRect ? createPortal(
    <ul
      style={{
        position: 'fixed',
        top: dropdownRect.bottom + 4,
        left: dropdownRect.left,
        width: dropdownRect.width,
        padding: 4,
        zIndex: 9999,
      }}
      className="max-h-48 overflow-auto kz-paper"
      role="listbox"
    >
      {filtered.map((model) => (
        <li key={model}>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleSelect(model);
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 kz-mono kz-text-soft transition-colors text-left"
            style={{ fontSize: 12.5, borderRadius: 8 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elev)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span className="truncate">{model}</span>
            {model === value && (
              <Check size={13} className="kz-text-accent flex-shrink-0 ml-2" />
            )}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  ) : null;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`${INPUT} pr-8`}
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            if (open) {
              setOpen(false);
            } else {
              inputRef.current?.focus();
            }
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 kz-text-mute transition-colors"
        >
          <ChevronDown
            size={14}
            className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {dropdown}
    </div>
  );
}
