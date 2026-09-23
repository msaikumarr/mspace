import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Mic, Plus, Trash2 } from 'lucide-react';
import { api, del, get, post } from '../services/api';
import { useMembers, useProjects, useWsKey } from '../hooks/useData';
import { useBilling } from '../hooks/useData';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea, priorityTone, toast } from '../components/ui';
import { fmtBytes, fmtDate, timeAgo } from '../utils';
import type { Meeting } from '../types';

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useWsKey();
  const projects = useProjects();
  const { members } = useMembers();
  const m = useQuery({ queryKey: key('meeting', id), queryFn: () => get<Meeting>(`/meetings/${id}`), refetchInterval: (q) => (q.state.data?.status === 'PROCESSING' || q.state.data?.status === 'TRANSCRIBING' ? 1500 : false) });
  const [pick, setPick] = useState<Record<number, boolean>>({});
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [projectId, setProjectId] = useState('');
  const approve = useMutation({
    mutationFn: () => post<{ tasks: unknown[] }>(`/meetings/${id}/approve`, {
      projectId: projectId || projects.data?.[0]?.id,
      items: Object.entries(pick).filter(([, v]) => v).map(([i]) => ({ index: +i, ...(assign[+i] !== undefined ? { assigneeId: assign[+i] || null } : {}) })),
    }),
    onSuccess: (r) => { toast.success(`${r.tasks.length} task${r.tasks.length > 1 ? 's' : ''} created`); setPick({}); qc.invalidateQueries({ queryKey: ['ws'] }); },
  });
  const d = m.data;
  const chosen = Object.values(pick).filter(Boolean).length;
  return (
    <Modal open onClose={onClose} title={d?.title || 'Meeting'} wide>
      {!d || d.status === 'TRANSCRIBING' || d.status === 'PROCESSING' ? <Loading label={d?.status === 'TRANSCRIBING' ? 'Transcribing recording… this can take a few minutes' : 'Analysing transcript…'} /> : d.status === 'FAILED' ? <ErrorBox error={new Error(d.error || 'Processing failed. Try again with a different transcript.')} /> : (
        <div className="space-y-5">
          <section><h3 className="mb-1 text-sm font-semibold">Summary</h3><p className="whitespace-pre-wrap text-sm text-slate-700">{d.summary}</p></section>
          {d.decisions.length > 0 && <section><h3 className="mb-1 text-sm font-semibold">Decisions</h3><ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{d.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
          {d.deadlines.length > 0 && <section><h3 className="mb-1 text-sm font-semibold">Deadlines mentioned</h3><ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{d.deadlines.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Action items <span className="font-normal text-slate-400">— review, then approve</span></h3>
              {d.actionItems.some((a) => !a.approved) && (
                <div className="flex items-center gap-2">
                  <Select className="w-44 py-1.5" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Target project"><option value="">Select project…</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
                  <Button size="sm" onClick={() => approve.mutate()} loading={approve.isPending} disabled={!chosen}>Create {chosen || ''} task{chosen === 1 ? '' : 's'}</Button>
                </div>
              )}
            </div>
            <ErrorBox error={approve.error} />
            {d.actionItems.length === 0 ? <p className="text-sm text-slate-400">No action items detected.</p> : (
              <ul className="mt-2 space-y-2">
                {d.actionItems.map((a, i) => (
                  <li key={i} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                    <input type="checkbox" className="mt-1 h-4 w-4" disabled={a.approved} checked={!!pick[i]} onChange={(e) => setPick({ ...pick, [i]: e.target.checked })} aria-label={`Select ${a.title}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800">{a.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge tone={priorityTone(a.priority) as any}>{a.priority}</Badge>
                        {a.dueDate && <Badge tone="amber">Due {fmtDate(a.dueDate, true)}</Badge>}
                        {a.approved ? <Badge tone="green">✓ Task created</Badge> : (
                          <Select className="w-40 py-1 text-xs" value={assign[i] ?? a.assigneeId ?? ''} onChange={(e) => setAssign({ ...assign, [i]: e.target.value })} aria-label="Assignee">
                            <option value="">{a.assigneeName && !a.assigneeId ? `Unmatched: ${a.assigneeName}` : 'Unassigned'}</option>{members.map((mm) => <option key={mm.user.id} value={mm.user.id}>{mm.user.name}</option>)}
                          </Select>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.source === 'audio' && <p className="text-xs text-slate-400">Transcribed from a recording. Speakers aren't identified, so check who each action item belongs to before approving.</p>}
          <details><summary className="cursor-pointer text-xs text-slate-400">Transcript</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{d.transcript}</pre></details>
        </div>
      )}
    </Modal>
  );
}

export default function Meetings() {
  const qc = useQueryClient();
  const key = useWsKey();
  const billing = useBilling();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [f, setF] = useState({ title: '', transcript: '' });
  const [mode, setMode] = useState<'text' | 'audio'>('text');
  const [recording, setRecording] = useState<File | null>(null);
  const caps = useQuery({ queryKey: key('meetings-capabilities'), queryFn: () => get<{ audio: { enabled: boolean; maxMb: number; formats: string[]; credits: number } }>('/meetings/capabilities'), enabled: !!billing.data?.plan.features.meetings });
  const audio = caps.data?.audio.enabled ? caps.data.audio : null;
  const tooBig = !!(recording && audio && recording.size > audio.maxMb * 1024 * 1024);
  const locked = billing.data && !billing.data.plan.features.meetings;
  const list = useQuery({ queryKey: key('meetings'), queryFn: () => get<Meeting[]>('/meetings'), enabled: !!billing.data && !locked });
  const create = useMutation({
    mutationFn: () => {
      if (mode === 'text') return post<Meeting>('/meetings', f);
      const form = new FormData();
      form.append('title', f.title);
      form.append('audio', recording!);
      return api<Meeting>('/meetings/audio', { method: 'POST', form });
    },
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: key('meetings') }); qc.invalidateQueries({ queryKey: key('billing') });
      setOpen(false); setF({ title: '', transcript: '' }); setRecording(null); setMode('text'); setDetail(m.id);
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/meetings/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: key('meetings') }), onError: toast.error });
  const loadFile = async (file?: File) => {
    if (!file) return;
    const transcript = await file.text();
    setF((p) => ({ title: p.title || file.name.replace(/\.[^.]+$/, ''), transcript }));
  };

  if (locked) return <div><PageHeader title="Meeting assistant" /><Empty icon={Lock} title="Meeting assistant is a Pro feature" hint="Turn transcripts into summaries, decisions and reviewable action items." action={<a href="/app/billing"><Button>See plans</Button></a>} /></div>;
  return (
    <div>
      <PageHeader title="Meeting assistant" subtitle={`${audio ? 'Paste a transcript or upload a recording' : 'Paste a transcript'}. Get a summary, decisions, deadlines and action items you approve before they become tasks.`} actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New meeting</Button>} />
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty icon={Mic} title="No meetings yet" hint={audio ? 'Upload a recording, or paste a transcript from Zoom or Meet.' : "Audio transcription isn't set up on this server. Paste text from your recorder, Zoom or Meet transcript."} action={<Button onClick={() => setOpen(true)}>{audio ? 'Add a meeting' : 'Add a transcript'}</Button>} /> : (
        <Card className="divide-y divide-slate-100">
          {list.data.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <button onClick={() => setDetail(m.id)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-medium text-slate-800">{m.title}</p><p className="flex items-center gap-1 text-xs text-slate-400">{timeAgo(m.createdAt)}{m.source === 'audio' && <><span>·</span><Mic className="h-3 w-3" /><span>recording</span></>} · {m.actionItems.length} action items</p></button>
              <Badge tone={m.status === 'READY' ? 'green' : m.status === 'FAILED' ? 'red' : 'amber'}>{m.status === 'TRANSCRIBING' ? 'Transcribing…' : m.status === 'PROCESSING' ? 'Processing…' : m.status === 'READY' ? 'Ready' : 'Failed'}</Badge>
              <Button size="sm" variant="ghost" aria-label={`Delete ${m.title}`} onClick={() => confirm('Delete this meeting?') && remove.mutate(m.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </Card>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="New meeting" wide>
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
          {audio && (
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm" role="tablist" aria-label="Source">
              {(['text', 'audio'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`flex-1 rounded-md px-3 py-1.5 font-medium ${mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{k === 'text' ? 'Paste transcript' : 'Upload recording'}</button>
              ))}
            </div>
          )}
          <Field label="Title"><Input required autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={150} /></Field>
          {mode === 'audio' && audio ? (
            <>
              <Field label="Recording" hint={`Up to ${audio.maxMb} MB · ${audio.formats.join(', ')}. Speakers aren't identified, so you'll assign action items when you review them. Uses ${audio.credits} AI requests.`}>
                <input type="file" required accept={audio.formats.map((x) => `.${x}`).join(',')} onChange={(e) => setRecording(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700" />
              </Field>
              {recording && <p className={`text-xs ${tooBig ? 'text-red-600' : 'text-slate-400'}`}>{recording.name} · {fmtBytes(recording.size)}{tooBig ? ` is over the ${audio.maxMb} MB limit` : ''}</p>}
            </>
          ) : (
            <Field label="Transcript" hint="Tip: “Name: text” speaker labels help assign action items."><Textarea required rows={10} minLength={20} value={f.transcript} onChange={(e) => setF({ ...f, transcript: e.target.value })} placeholder={'Sam: We decided to ship on 2030-03-01.\nKim: I\'ll write the release notes by Friday.'} /></Field>
          )}
          <div className="flex items-center justify-between">
            {mode === 'text' ? <label className="cursor-pointer text-sm text-brand-600 hover:underline">Load from .txt file<input type="file" accept=".txt,.md,.vtt,.srt" hidden onChange={(e) => loadFile(e.target.files?.[0])} /></label> : <span />}
            <div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={create.isPending} disabled={mode === 'audio' && (!recording || tooBig)}>{mode === 'audio' ? 'Transcribe & analyse' : 'Analyse'}</Button></div>
          </div>
          <ErrorBox error={create.error} />
        </form>
      </Modal>
      {detail && <Detail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
