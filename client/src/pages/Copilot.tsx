import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../services/api';
import { useProjects, useWsKey } from '../hooks/useData';
import { useRoleAtLeast } from '../store/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, Tabs, Textarea, priorityTone, toast } from '../components/ui';
import { SourceList } from './Documents';
import { cn, fmtDate, timeAgo } from '../utils';
import type { Candidate, DocumentRow, Source } from '../types';

const SUGGESTIONS = ['What should I work on next?', 'Which tasks are overdue?', 'Give me a status overview of the workspace', 'What risks or blockers need attention?'];

interface Turn { role: 'user' | 'assistant'; content: string; sources?: Source[] }

function ChatTab() {
  const qc = useQueryClient();
  const key = useWsKey();
  const canUse = useRoleAtLeast('member');
  const [convId, setConvId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const convos = useQuery({ queryKey: key('ai-convos'), queryFn: () => get<{ id: string; title: string; updatedAt: string }[]>('/ai/conversations') });
  const send = useMutation({
    mutationFn: (message: string) => post<{ conversationId: string; answer: string; sources: Source[]; mode: string }>('/ai/chat', { message, conversationId: convId || undefined }),
    onMutate: (message) => setTurns((t) => [...t, { role: 'user', content: message }]),
    onSuccess: (r) => {
      setConvId(r.conversationId);
      setTurns((t) => [...t, { role: 'assistant', content: r.answer, sources: r.sources }]);
      qc.invalidateQueries({ queryKey: key('ai-convos') });
      qc.invalidateQueries({ queryKey: key('billing') });
    },
    onError: (e) => { setTurns((t) => t.slice(0, -1)); toast.error(e); },
  });
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns.length, send.isPending]);
  const open = async (id: string) => {
    const c = await get<{ id: string; messages: Turn[] }>(`/ai/conversations/${id}`);
    setConvId(c.id); setTurns(c.messages);
  };
  const ask = (m: string) => { if (m.trim() && !send.isPending) { send.mutate(m.trim()); setText(''); } };

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <aside className="space-y-1">
        <Button variant="secondary" className="mb-2 w-full" onClick={() => { setConvId(null); setTurns([]); }}>＋ New chat</Button>
        {convos.data?.map((c) => (
          <div key={c.id} className={cn('group flex items-center justify-between rounded-lg px-2.5 py-2 text-sm hover:bg-slate-100', c.id === convId && 'bg-brand-50')}>
            <button onClick={() => open(c.id)} className="min-w-0 flex-1 truncate text-left text-slate-700">{c.title}<span className="block text-[11px] text-slate-400">{timeAgo(c.updatedAt)}</span></button>
            <button aria-label="Delete conversation" onClick={() => del(`/ai/conversations/${c.id}`).then(() => { qc.invalidateQueries({ queryKey: key('ai-convos') }); if (c.id === convId) { setConvId(null); setTurns([]); } })} className="hidden text-slate-400 hover:text-red-500 group-hover:block">✕</button>
          </div>
        ))}
      </aside>
      <Card className="flex h-[65vh] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {turns.length === 0 && (
            <div className="py-8 text-center">
              <div className="text-4xl">✨</div>
              <h2 className="mt-2 font-semibold text-slate-800">Ask anything about your workspace</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">The Copilot sees your projects, tasks and (on Pro+) uploaded documents. Answers cite their sources.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} disabled={!canUse} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50">{s}</button>)}</div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm', t.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800')}>
                <p className="whitespace-pre-wrap break-words">{t.content}</p>
                {t.role === 'assistant' && t.sources && <SourceList sources={t.sources} />}
              </div>
            </div>
          ))}
          {send.isPending && <div className="flex"><div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-500">Thinking…</div></div>}
          <div ref={end} />
        </div>
        <div className="border-t border-slate-100 p-3">
          {send.error && <div className="mb-2"><ErrorBox error={send.error} /></div>}
          {canUse ? (
            <form onSubmit={(e) => { e.preventDefault(); ask(text); }} className="flex gap-2">
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the Copilot…" maxLength={4000} aria-label="Ask the Copilot" />
              <Button type="submit" loading={send.isPending} disabled={!text.trim()}>Send</Button>
            </form>
          ) : <p className="text-center text-sm text-slate-400">Viewers can't use the Copilot.</p>}
        </div>
      </Card>
    </div>
  );
}

function TasksTab() {
  const qc = useQueryClient();
  const key = useWsKey();
  const projects = useProjects();
  const docs = useQuery({ queryKey: key('documents', undefined), queryFn: () => get<DocumentRow[]>('/documents') });
  const [text, setText] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [cands, setCands] = useState<(Candidate & { keep: boolean })[] | null>(null);
  const gen = useMutation({
    mutationFn: () => post<{ candidates: Candidate[]; mode: string }>('/ai/generate-tasks', documentId ? { documentId } : { text }),
    onSuccess: (r) => { setCands(r.candidates.map((c) => ({ ...c, keep: true }))); qc.invalidateQueries({ queryKey: key('billing') }); },
  });
  const approve = useMutation({
    mutationFn: () => post('/tasks/bulk', { projectId: projectId || projects.data?.[0]?.id, source: 'ai', tasks: cands!.filter((c) => c.keep).map((c) => ({ title: c.title, description: c.description, priority: c.priority, assigneeId: c.assigneeId, dueDate: c.dueDate })) }),
    onSuccess: (r: any[]) => { toast.success(`${r.length} task${r.length > 1 ? 's' : ''} added`); setCands(null); setText(''); qc.invalidateQueries({ queryKey: ['ws'] }); },
  });
  const edit = (i: number, p: Partial<Candidate & { keep: boolean }>) => setCands((c) => c!.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const ready = docs.data?.filter((d) => d.status === 'READY') || [];
  const kept = cands?.filter((c) => c.keep).length || 0;

  return (
    <div className="space-y-5">
      <Card className="space-y-3 p-5">
        <p className="text-sm text-slate-600">Paste requirements or notes (or pick an uploaded document). The AI proposes tasks — <b>nothing is created until you approve</b>.</p>
        <Field label="From a document"><Select value={documentId} onChange={(e) => setDocumentId(e.target.value)}><option value="">— paste text below instead —</option>{ready.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        {!documentId && <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="- The system must support SSO&#10;- Send weekly digest emails by Friday…" />}
        <ErrorBox error={gen.error} />
        <Button onClick={() => gen.mutate()} loading={gen.isPending} disabled={!documentId && text.trim().length < 10}>✨ Suggest tasks</Button>
      </Card>

      {cands && (cands.length === 0 ? <Empty title="No actionable tasks found" hint="Try text with requirements like “must…”, “should…” or action verbs." icon="🤔" /> : (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Review {cands.length} suggestion{cands.length > 1 ? 's' : ''}</h3>
            <div className="flex items-center gap-2">
              <Select className="w-48" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Target project"><option value="">Select project…</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
              <Button onClick={() => approve.mutate()} loading={approve.isPending} disabled={!kept || !(projectId || projects.data?.length)}>Add {kept} to project</Button>
            </div>
          </div>
          <ErrorBox error={approve.error} />
          <ul className="mt-3 space-y-2">
            {cands.map((c, i) => (
              <li key={i} className={cn('flex gap-3 rounded-lg border p-3', c.keep ? 'border-slate-200' : 'border-slate-100 opacity-50')}>
                <input type="checkbox" checked={c.keep} onChange={(e) => edit(i, { keep: e.target.checked })} className="mt-1.5 h-4 w-4" aria-label={`Include ${c.title}`} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Input value={c.title} onChange={(e) => edit(i, { title: e.target.value })} className="font-medium" />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Select className="w-28 py-1 text-xs" value={c.priority} onChange={(e) => edit(i, { priority: e.target.value as Candidate['priority'] })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p}>{p}</option>)}</Select>
                    {c.assigneeName && <Badge tone="brand">👤 {c.assigneeName}</Badge>}
                    {c.dueDate && <Badge tone="amber">Due {fmtDate(c.dueDate, true)}</Badge>}
                    <Badge tone={priorityTone(c.priority) as any}>{c.priority}</Badge>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function InsightsTab() {
  const qc = useQueryClient();
  const key = useWsKey();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const m = useMutation({ mutationFn: () => post<any>('/ai/insights', { projectId: projectId || undefined }), onSuccess: () => qc.invalidateQueries({ queryKey: key('billing') }) });
  useEffect(() => { m.mutate(); /* eslint-disable-next-line */ }, [projectId]);
  const tone = { high: 'red', medium: 'amber', info: 'blue' } as const;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Select className="max-w-56" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">Whole workspace</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><Button variant="secondary" onClick={() => m.mutate()} loading={m.isPending}>Refresh</Button></div>
      <ErrorBox error={m.error} />
      {m.isPending && !m.data ? <Loading label="Analysing work…" /> : m.data && (
        <>
          <Card className="border-brand-200 bg-brand-50/50 p-5"><p className="text-sm text-slate-700">✨ {m.data.narrative}</p><p className="mt-2 text-xs text-slate-400">Decision-support only — these signals describe work items, not people's performance.</p></Card>
          <div className="space-y-3">
            {m.data.items.map((it: any, i: number) => (
              <Card key={i} className="p-4">
                <div className="flex items-start gap-3"><Badge tone={tone[it.severity as keyof typeof tone]}>{it.severity}</Badge><div className="min-w-0 flex-1"><p className="font-medium text-slate-800">{it.title}</p><p className="text-sm text-slate-500">{it.detail}</p>
                  {it.tasks?.length > 0 && <ul className="mt-2 space-y-1">{it.tasks.map((t: any) => <li key={t.id}><Link className="text-sm text-brand-600 hover:underline" to={`/app/projects/${t.projectId}?task=${t.id}`}>{t.title}</Link> <Badge tone={priorityTone(t.priority) as any}>{t.priority}</Badge>{t.dueDate && <span className="ml-2 text-xs text-slate-400">due {fmtDate(t.dueDate)}</span>}</li>)}</ul>}</div></div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Copilot() {
  const [tab, setTab] = useState<'chat' | 'tasks' | 'insights'>('chat');
  return (
    <div>
      <PageHeader title="AI Copilot" subtitle="Ask questions, turn documents into tasks, and spot what needs attention." />
      <Tabs tabs={[{ id: 'chat', label: 'Chat' }, { id: 'tasks', label: 'Generate tasks' }, { id: 'insights', label: 'Insights' }]} value={tab} onChange={setTab} />
      {tab === 'chat' ? <ChatTab /> : tab === 'tasks' ? <TasksTab /> : <InsightsTab />}
    </div>
  );
}
