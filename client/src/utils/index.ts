export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const initials = (name = '?') => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function fmtDate(d?: string | Date | null, withYear = false) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

export function fmtTime(d: string | Date) {
  return new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(d: string | Date) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days < 30 ? `${days}d ago` : fmtDate(d, true);
}

export const isOverdue = (due?: string | null, status?: string) => !!due && status !== 'DONE' && new Date(due).getTime() < Date.now();

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const statusLabel = (s: string) => s.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** yyyy-mm-dd for <input type="date"> */
export const toDateInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
