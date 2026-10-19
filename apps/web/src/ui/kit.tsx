/** Small, accessible UI primitives. */
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, X } from 'lucide-preact';
import { toast } from '../state/app.ts';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md' | 'lg';
  icon?: ComponentChildren;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({ variant = 'secondary', size = 'md', icon, children, class: cls, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} class={`btn btn-${variant} btn-${size} ${cls ?? ''}`} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, children, active, class: cls, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" class={`icon-btn ${active ? 'active' : ''} ${cls ?? ''}`} aria-label={label} title={label} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  return (
    <label class={`switch-row ${disabled ? 'disabled' : ''}`}>
      <span class="switch-text">
        <span class="switch-label">{label}</span>
        {hint && <span class="hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" class="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true" />;
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'success', undefined, 2000);
  } catch {
    // Fallback for browsers without async clipboard permission.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? `${what} to clipboard` : 'Could not copy — select and copy manually', ok ? 'success' : 'warn', undefined, 2000);
  }
}

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      onClick={async () => {
        await copyText(text, what);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={18} /> : <Copy size={18} />}
    </IconButton>
  );
}

export function Modal({ title, onClose, children, footer, wide, labelledBy }: { title: ComponentChildren; onClose?: () => void; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Never auto-focus a button: a stray Enter must not accept an incoming connection.
    const target = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not([type=radio]), textarea') ?? ref.current;
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? 'modal-title'} ref={ref} tabIndex={-1}>
        <div class="modal-head">
          <h2 id={labelledBy ?? 'modal-title'}>{title}</h2>
          {onClose && (
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          )}
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Dropdown menu anchored to a trigger button. */
export function Menu({ trigger, children, align = 'left', label }: { trigger: ComponentChildren; children: (close: () => void) => ComponentChildren; align?: 'left' | 'right'; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      <button type="button" class={`icon-btn menu-trigger ${open ? 'active' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div class={`menu ${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, checked, icon, danger, disabled }: { children: ComponentChildren; onClick: () => void; checked?: boolean; icon?: ComponentChildren; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} class={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span class="menu-icon">{checked ? <Check size={16} /> : icon}</span>
      <span>{children}</span>
    </button>
  );
}

export const MenuLabel = ({ children }: { children: ComponentChildren }) => <div class="menu-label">{children}</div>;
export const MenuSep = () => <div class="menu-sep" role="separator" />;

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
