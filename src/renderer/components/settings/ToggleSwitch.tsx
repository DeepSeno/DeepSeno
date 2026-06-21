interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export default function ToggleSwitch({ checked, onChange, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      style={{
        background: checked ? 'var(--c-accent)' : 'var(--line-strong)',
      }}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full shadow-md ring-1 ring-black/5 transition-transform duration-200 ease-in-out ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
        style={{
          background: checked ? 'var(--c-accent-ink)' : 'var(--bg-card)',
        }}
      />
    </button>
  );
}
