import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, download, get, post } from '../services/api';
import { useWsKey } from '../hooks/useData';
import { useRoleAtLeast } from '../store/auth';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, PageHeader, toast } from '../components/ui';
import { cn, fmtBytes, timeAgo } from '../utils';
import type { DocumentRow, Source } from '../types';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown';
const TONE = { PENDING: 'slate', PROCESSING: 'amber', READY: 'green', FAILED: 'red' } as const;

export function SourceList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sources</p>
      {sources.map((s, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <p className="font-medium text-slate-700">📄 {s.name} <span className="text-slate-400">· page {s.pageNumber}</span></p>
          <p className="mt-0.5 line-clamp-2 text-slate-500">“{s.snippet}”</p>
        </div>
      ))}
    </div>
  );
}

/** Reusable panel: shown on the Documents page and inside a project's "Files" tab. */
export default function DocumentsPanel({ projectId }: { projectId?: string }) {
  const qc = useQueryClient();
  const key = useWsKey();
  const canUpload = useRoleAtLeast('member');
  const canDelete = useRoleAtLeast('manager');
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [q, setQ] = useState('');
  const docs = useQuery({
    queryKey: key('documents', projectId),
    queryFn: () => get<DocumentRow[]>(`/documents${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING') ? 2000 : false),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        if (projectId) form.append('projectId', projectId);
        await api('/documents', { method: 'POST', form });
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: key('documents') }); qc.invalidateQueries({ queryKey: key('billing') }); toast.success('Uploaded — processing for search'); },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/documents/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key('documents') }); toast.success('Document deleted'); },
    onError: toast.error,
  });
  const ask = useMutation({ mutationFn: () => post<{ answer: string; sources: Source[]; mode: string }>('/ai/document-query', { question: q, projectId }) });

  const pick = (files: FileList | null) => files?.length && upload.mutate([...files]);

  return (
    <div className="space-y-5">
      {canUpload && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}
          className={cn('rounded-xl border-2 border-dashed p-6 text-center transition', drag ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white')}
        >
          <p className="text-sm text-slate-600">Drag files here, or <button className="font-medium text-brand-600 hover:underline" onClick={() => input.current?.click()}>browse</button></p>
          <p className="mt-1 text-xs text-slate-400">PDF, DOCX, TXT or Markdown · up to 15 MB each</p>
          <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
          {upload.isPending && <p className="mt-2 text-sm text-brand-600">Uploading…</p>}
        </div>
      )}

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Ask your documents</h3>
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim().length > 1) ask.mutate(); }} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. What are the authentication requirements?" maxLength={2000} />
          <Button type="submit" loading={ask.isPending}>Ask</Button>
        </form>
        <div className="mt-3"><ErrorBox error={ask.error} /></div>
        {ask.data && (
          <div className="mt-3 animate-in">
            <p className="whitespace-pre-wrap text-sm text-slate-700">{ask.data.answer}</p>
            <SourceList sources={ask.data.sources} />
          </div>
        )}
      </Card>

      {docs.isLoading ? <Loading /> : !docs.data?.length ? (
        <Empty title="No documents yet" icon="📄" hint="Upload requirements, specs or notes and ask the AI questions about them." />
      ) : (
        <Card className="divide-y divide-slate-100">
          {docs.data.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="text-xl">📄</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{d.name}</p>
                <p className="text-xs text-slate-400">{fmtBytes(d.size)} · {d.status === 'READY' ? `${d.pageCount} page${d.pageCount === 1 ? '' : 's'}, ${d.chunkCount} chunks · ` : ''}{typeof d.uploadedBy === 'object' ? d.uploadedBy?.name : ''} · {timeAgo(d.createdAt)}</p>
                {d.status === 'FAILED' && <p className="text-xs text-red-600">{d.error}</p>}
              </div>
              <Badge tone={TONE[d.status]}>{d.status === 'PROCESSING' || d.status === 'PENDING' ? 'Processing…' : d.status === 'READY' ? 'Ready' : 'Failed'}</Badge>
              <Button size="sm" variant="secondary" onClick={() => download(`/documents/${d.id}/download`, d.name).catch(toast.error)}>Download</Button>
              {canDelete && <Button size="sm" variant="ghost" onClick={() => confirm(`Delete "${d.name}"?`) && remove.mutate(d.id)} aria-label={`Delete ${d.name}`}>🗑</Button>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export function DocumentsPage() {
  return (
    <div>
      <PageHeader title="Documents" subtitle="Your team's knowledge base. Upload files, then ask the AI questions grounded in them." />
      <DocumentsPanel />
    </div>
  );
}
