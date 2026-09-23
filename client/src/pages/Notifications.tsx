import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, CheckCircle2, Clock, CreditCard, FolderKanban, MessageSquare, Pencil, Pin, Sparkles, UserPlus, type LucideIcon } from 'lucide-react';
import { get, post } from '../services/api';
import { useWsKey } from '../hooks/useData';
import { Button, Card, Empty, Loading, PageHeader } from '../components/ui';
import { cn, timeAgo } from '../utils';
import type { Notification } from '../types';

const ICON: Record<string, LucideIcon> = {
  TASK_ASSIGNED: Pin, TASK_UPDATED: Pencil, TASK_COMPLETED: CheckCircle2, MENTION: AtSign, COMMENT: MessageSquare,
  DEADLINE: Clock, INVITATION: UserPlus, PROJECT_UPDATE: FolderKanban, AI_ALERT: Sparkles, BILLING: CreditCard,
};

export default function Notifications() {
  const qc = useQueryClient();
  const key = useWsKey();
  const nav = useNavigate();
  const q = useQuery({ queryKey: key('notifications'), queryFn: () => get<{ items: Notification[]; unread: number }>('/notifications') });
  const refresh = () => qc.invalidateQueries({ queryKey: key('notifications') });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read-all'), onSuccess: refresh });
  const readOne = useMutation({ mutationFn: (id: string) => post(`/notifications/${id}/read`), onSuccess: refresh });

  return (
    <div>
      <PageHeader title="Notifications" subtitle={q.data ? `${q.data.unread} unread` : undefined} actions={<Button variant="secondary" onClick={() => readAll.mutate()} disabled={!q.data?.unread}>Mark all as read</Button>} />
      {q.isLoading ? <Loading /> : !q.data?.items.length ? <Empty icon={Bell} title="You're all caught up" hint="Assignments, mentions, comments and deadlines show up here." /> : (
        <Card className="divide-y divide-slate-100">
          {q.data.items.map((n) => {
            const Icon = ICON[n.type] || Bell;
            return (
            <button key={n.id} onClick={() => { if (!n.read) readOne.mutate(n.id); if (n.link) nav(n.link); }} className={cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50', !n.read && 'bg-brand-50/50')}>
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"><Icon className="h-4 w-4" strokeWidth={1.75} /></span>
              <span className="min-w-0 flex-1"><span className={cn('block text-sm', n.read ? 'text-slate-600' : 'font-medium text-slate-900')}>{n.title}</span>{n.body && <span className="block truncate text-xs text-slate-400">{n.body}</span>}<span className="text-[11px] text-slate-400">{timeAgo(n.createdAt)}</span></span>
              {!n.read && <span className="mt-2 h-2 w-2 rounded-full bg-brand-600" aria-label="Unread" />}
            </button>
            );
          })}
        </Card>
      )}
    </div>
  );
}
