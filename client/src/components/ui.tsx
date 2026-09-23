import { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, forwardRef, useEffect } from 'react';
import { create } from 'zustand';
import { Inbox, X, type LucideIcon } from 'lucide-react';
import { cn, initials } from '../utils';
import { ApiError } from '../services/api';

/* ---------- Buttons & fields ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean };
export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...p }: BtnProps) {
  const v = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return (
    <button
      {...p}
      disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed', size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm', v, className)}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} {...p} className={cn(field, className)} />);
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} {...p} className={cn(field, 'resize-y', className)} />);
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} {...p} className={cn(field, 'pr-8', className)}>{children}</select>
));
Input.displayName = 'Input'; Textarea.displayName = 'Textarea'; Select.displayName = 'Select';

export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

/* ---------- Surfaces ---------- */
export const Card = ({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
  <div {...p} className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>{children}</div>
);

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700', red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-800', green: 'bg-emerald-100 text-emerald-700',
  blue: 'bg-sky-100 text-sky-700', brand: 'bg-brand-100 text-brand-700', purple: 'bg-purple-100 text-purple-700',
};
export const Badge = ({ tone = 'slate', children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) => (
  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>
);

export const priorityTone = (p: string) => ({ LOW: 'slate', MEDIUM: 'blue', HIGH: 'amber', URGENT: 'red' }[p] || 'slate');

export function Avatar({ name, color = '#6366f1', size = 28, online }: { name?: string; color?: string; size?: number; online?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" title={name}>
      <span className="inline-flex items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}>{initials(name)}</span>
      {online !== undefined && <span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', online ? 'bg-emerald-500' : 'bg-slate-300')} />}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <svg className={cn('h-5 w-5 animate-spin text-brand-600', className)} viewBox="0 0 24 24" fill="none" aria-label="Loading"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>;
}
export const Loading = ({ label = 'Loading…' }: { label?: string }) => <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Spinner />{label}</div>;

export function Empty({ title, hint, action, icon: Icon = Inbox }: { title: string; hint?: string; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400"><Icon className="h-6 w-6" strokeWidth={1.75} /></div>
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const upgrade = e.code === 'UPGRADE_REQUIRED' || /LIMIT_EXCEEDED$/.test(e.code || '');
  return (
    <div role="alert" className={cn('rounded-lg border px-3 py-2 text-sm', upgrade ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-700')}>
      {e.message || 'Something went wrong'}
      {upgrade && <a href="/app/billing" className="ml-2 font-medium underline">See plans</a>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:py-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn('animate-in w-full rounded-2xl bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-md')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>{t.label}</button>
      ))}
    </div>
  );
}

export function Progress({ value, tone = 'bg-brand-600' }: { value: number; tone?: string }) {
  return <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100"><div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export function StatCard({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold text-slate-900', tone)}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </Card>
  );
}

/* ---------- Toasts ---------- */
interface Toast { id: number; text: string; kind: 'success' | 'error' | 'info' }
export const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), 4500);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));
export const toast = {
  success: (text: string) => useToasts.getState().push({ text, kind: 'success' }),
  error: (e: unknown) => useToasts.getState().push({ text: (e as Error)?.message || 'Something went wrong', kind: 'error' }),
  info: (text: string) => useToasts.getState().push({ text, kind: 'info' }),
};
export function Toaster() {
  const { items, drop } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} onClick={() => drop(t.id)} className={cn('animate-in pointer-events-auto cursor-pointer rounded-lg px-4 py-3 text-sm shadow-lg', t.kind === 'error' ? 'bg-red-600 text-white' : t.kind === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white')}>{t.text}</div>
      ))}
    </div>
  );
}

export function Meter({ label, used, limit, format }: { label: string; used: number; limit: number; format?: (n: number) => string }) {
  const pct = limit ? (used / limit) * 100 : 0;
  const f = format || ((n: number) => String(n));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs"><span className="font-medium text-slate-600">{label}</span><span className="text-slate-500">{f(used)} / {f(limit)}</span></div>
      <Progress value={pct} tone={pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-600'} />
    </div>
  );
}
