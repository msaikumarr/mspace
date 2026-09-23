import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerUpLeft, Paperclip, Plus, X } from 'lucide-react';
import { api, del, download, get, patch, post } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { useMembers, useWsKey } from '../hooks/useData';
import { useAuth, useRoleAtLeast } from '../store/auth';
import { Avatar, Button, Empty, ErrorBox, Input, Loading, Modal, toast } from '../components/ui';
import { cn, fmtTime, fmtDate } from '../utils';
import type { Channel, Message } from '../types';

const EMOJI = ['👍', '❤️', '🎉', '😂', '👀'];

export default function Chat() {
  const qc = useQueryClient();
  const key = useWsKey();
  const me = useAuth((s) => s.user)!;
  const workspaceId = useAuth((s) => s.workspaceId);
  const canWrite = useRoleAtLeast('member');
  const canModerate = useRoleAtLeast('manager');
  const { members, byId } = useMembers();
  const [sp, setSp] = useSearchParams();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [typing, setTyping] = useState<Record<string, string>>({});
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [newChannel, setNewChannel] = useState(false);
  const [chName, setChName] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<File | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | undefined>(undefined);
  const lastTyping = useRef(0);

  const channels = useQuery({ queryKey: key('channels'), queryFn: () => get<Channel[]>('/channels') });
  const activeId = sp.get('channel') || channels.data?.find((c) => c.name === 'general')?.id || channels.data?.[0]?.id || null;
  const active = channels.data?.find((c) => c.id === activeId);
  const msgKey = key('messages', activeId);
  const messages = useQuery({ queryKey: msgKey, queryFn: () => get<Message[]>(`/channels/${activeId}/messages`), enabled: !!activeId });

  const dmName = (c: Channel) => byId.get(c.participantIds.find((p) => p !== me.id) || '')?.name || 'Direct message';

  // Presence
  useEffect(() => {
    const s = connectSocket();
    if (!workspaceId) return;
    const load = () => s.emit('presence:list', workspaceId, (ids: string[]) => setOnline(new Set(ids)));
    load();
    const upd = ({ userId, online: on }: { userId: string; online: boolean }) => setOnline((p) => { const n = new Set(p); on ? n.add(userId) : n.delete(userId); return n; });
    s.on('presence:update', upd);
    s.on('connect', load);
    return () => { s.off('presence:update', upd); s.off('connect', load); };
  }, [workspaceId]);

  // Channel subscription + live events
  useEffect(() => {
    const s = connectSocket();
    if (!activeId) return;
    const join = () => s.emit('channel:join', activeId);
    join();
    s.on('connect', join);
    const onNew = (m: Message) => {
      if (m.channelId !== activeId) return;
      qc.setQueryData<Message[]>(msgKey, (old = []) => (old.some((x) => x.id === m.id) ? old : [...old, m]));
      if (m.userId !== me.id) post(`/channels/${activeId}/read`).then(() => qc.invalidateQueries({ queryKey: key('channels') })).catch(() => undefined);
    };
    const onUpd = (m: Message) => qc.setQueryData<Message[]>(msgKey, (old = []) => old.map((x) => (x.id === m.id ? m : x)));
    const onDel = ({ id }: { id: string }) => qc.setQueryData<Message[]>(msgKey, (old = []) => old.map((x) => (x.id === id ? { ...x, deleted: true, text: '', attachment: undefined } : x)));
    const onReact = ({ id, reactions }: { id: string; reactions: Message['reactions'] }) => qc.setQueryData<Message[]>(msgKey, (old = []) => old.map((x) => (x.id === id ? { ...x, reactions } : x)));
    const onTyping = (t: { channelId: string; userId: string; name: string; typing: boolean }) => {
      if (t.channelId !== activeId || t.userId === me.id) return;
      setTyping((p) => { const n = { ...p }; t.typing ? (n[t.userId] = t.name) : delete n[t.userId]; return n; });
      if (t.typing) setTimeout(() => setTyping((p) => { const n = { ...p }; delete n[t.userId]; return n; }), 4000);
    };
    s.on('message:new', onNew); s.on('message:updated', onUpd); s.on('message:deleted', onDel); s.on('message:reactions', onReact); s.on('typing', onTyping);
    post(`/channels/${activeId}/read`).then(() => qc.invalidateQueries({ queryKey: key('channels') })).catch(() => undefined);
    return () => {
      s.emit('channel:leave', activeId);
      s.off('connect', join); s.off('message:new', onNew); s.off('message:updated', onUpd); s.off('message:deleted', onDel); s.off('message:reactions', onReact); s.off('typing', onTyping);
      setTyping({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.data?.length, activeId]);

  const send = useMutation({
    mutationFn: async () => {
      const mentions = members.filter((m) => new RegExp(`@${m.user.name.split(' ')[0]}\\b`, 'i').test(text)).map((m) => m.user.id);
      if (attached) {
        const form = new FormData();
        form.append('file', attached);
        form.append('text', text);
        if (replyTo) form.append('replyTo', replyTo.id);
        mentions.forEach((m) => form.append('mentions', m));
        return api(`/channels/${activeId}/messages`, { method: 'POST', form });
      }
      return post(`/channels/${activeId}/messages`, { text, replyTo: replyTo?.id ?? null, mentions });
    },
    onSuccess: (m: Message) => {
      qc.setQueryData<Message[]>(msgKey, (old = []) => (old.some((x) => x.id === m.id) ? old : [...old, m]));
      setText(''); setReplyTo(null); setAttached(null);
      getSocket()?.emit('typing', { channelId: activeId, typing: false });
    },
    onError: toast.error,
  });
  const saveEdit = useMutation({
    mutationFn: () => patch(`/messages/${editing!.id}`, { text: editing!.text }),
    onSuccess: () => setEditing(null),
    onError: toast.error,
  });
  const react = useMutation({ mutationFn: ({ id, emoji }: { id: string; emoji: string }) => post(`/messages/${id}/reactions`, { emoji }), onError: toast.error });
  const remove = useMutation({ mutationFn: (id: string) => del(`/messages/${id}`), onError: toast.error });
  const openDm = useMutation({
    mutationFn: (userId: string) => post<Channel>('/channels/dm', { userId }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: key('channels') }); setSp({ channel: c.id }); },
    onError: toast.error,
  });
  const createChannel = useMutation({
    mutationFn: () => post<Channel>('/channels', { name: chName }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: key('channels') }); setSp({ channel: c.id }); setNewChannel(false); setChName(''); },
  });

  const onType = (v: string) => {
    setText(v);
    const now = Date.now();
    if (now - lastTyping.current > 2000) { getSocket()?.emit('typing', { channelId: activeId, typing: true }); lastTyping.current = now; }
    clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => { getSocket()?.emit('typing', { channelId: activeId, typing: false }); lastTyping.current = 0; }, 2500);
  };

  const byMsg = useMemo(() => new Map((messages.data || []).map((m) => [m.id, m])), [messages.data]);
  const channelList = channels.data?.filter((c) => c.type === 'channel') || [];
  const dms = channels.data?.filter((c) => c.type === 'dm') || [];
  const typers = Object.values(typing);

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] sm:-m-6 lg:h-screen">
      <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 md:block">
        <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Channels{canWrite && <button onClick={() => setNewChannel(true)} className="text-slate-400 hover:text-brand-600" aria-label="New channel"><Plus className="h-3.5 w-3.5" /></button>}</div>
        {channelList.map((c) => (
          <button key={c.id} onClick={() => setSp({ channel: c.id })} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm', c.id === activeId ? 'bg-brand-100 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
            <span># {c.name}</span>{c.unread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
          </button>
        ))}
        <div className="mb-1 mt-5 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Direct messages</div>
        {dms.map((c) => (
          <button key={c.id} onClick={() => setSp({ channel: c.id })} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm', c.id === activeId ? 'bg-brand-100 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
            <span className="flex items-center gap-2 truncate"><span className={cn('h-2 w-2 rounded-full', online.has(c.participantIds.find((p) => p !== me.id) || '') ? 'bg-emerald-500' : 'bg-slate-300')} />{dmName(c)}</span>
            {c.unread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
          </button>
        ))}
        {canWrite && (
          <details className="mt-2 px-1">
            <summary className="flex cursor-pointer items-center gap-1 px-1 py-1 text-xs text-brand-600"><Plus className="h-3 w-3" />Start a conversation</summary>
            {members.filter((m) => m.user.id !== me.id).map((m) => (
              <button key={m.user.id} onClick={() => openDm.mutate(m.user.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-100">
                <Avatar name={m.user.name} color={m.user.avatarColor} size={20} online={online.has(m.user.id)} />{m.user.name}
              </button>
            ))}
          </details>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-white">
        {!activeId ? <div className="p-6"><Empty title="No channels" /></div> : (
          <>
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div>
                <h1 className="font-semibold text-slate-900">{active?.type === 'dm' ? dmName(active) : `# ${active?.name || ''}`}</h1>
                <p className="text-xs text-slate-400">{online.size} online</p>
              </div>
              <select className="rounded-md border border-slate-300 px-2 py-1 text-sm md:hidden" value={activeId} onChange={(e) => setSp({ channel: e.target.value })} aria-label="Switch channel">
                {channels.data?.map((c) => <option key={c.id} value={c.id}>{c.type === 'dm' ? dmName(c) : `# ${c.name}`}</option>)}
              </select>
            </header>
            <div className="flex-1 space-y-1 overflow-y-auto px-5 py-4">
              {messages.isLoading ? <Loading /> : messages.data?.length === 0 ? <p className="py-10 text-center text-sm text-slate-400">No messages yet — say hello</p> : messages.data?.map((m, i, arr) => {
                const u = m.user || byId.get(m.userId);
                const showDay = i === 0 || fmtDate(arr[i - 1].createdAt) !== fmtDate(m.createdAt);
                const grouped = i > 0 && !showDay && arr[i - 1].userId === m.userId && new Date(m.createdAt).getTime() - new Date(arr[i - 1].createdAt).getTime() < 5 * 60_000 && !m.replyTo;
                const parent = m.replyTo ? byMsg.get(m.replyTo) : null;
                const mine = m.userId === me.id;
                return (
                  <div key={m.id}>
                    {showDay && <div className="my-3 text-center text-xs font-medium text-slate-400">{fmtDate(m.createdAt, true)}</div>}
                    <div className={cn('group relative flex gap-3 rounded-lg px-2 py-1 hover:bg-slate-50', grouped ? 'pt-0' : 'pt-2')}>
                      <div className="w-8 shrink-0">{!grouped && <Avatar name={u?.name} color={u?.avatarColor} size={32} online={online.has(m.userId)} />}</div>
                      <div className="min-w-0 flex-1">
                        {!grouped && <p className="text-sm"><span className="font-semibold text-slate-800">{u?.name || 'Former member'}</span> <span className="ml-1 text-xs text-slate-400">{fmtTime(m.createdAt)}</span></p>}
                        {parent && <p className="mb-0.5 flex items-center gap-1 truncate border-l-2 border-slate-300 pl-2 text-xs text-slate-400"><CornerUpLeft className="h-3 w-3 shrink-0" />{byId.get(parent.userId)?.name}: {parent.deleted ? 'deleted message' : parent.text}</p>}
                        {m.deleted ? <p className="text-sm italic text-slate-400">This message was deleted</p> : editing?.id === m.id ? (
                          <form onSubmit={(e) => { e.preventDefault(); saveEdit.mutate(); }} className="flex gap-2"><Input autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} /><Button size="sm" type="submit">Save</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button></form>
                        ) : (
                          <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{m.text}{m.editedAt && <span className="ml-1 text-[11px] text-slate-400">(edited)</span>}</p>
                        )}
                        {m.attachment && !m.deleted && <button onClick={() => download(m.attachment!.url.replace('/api', ''), m.attachment!.name).catch(toast.error)} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-brand-700 hover:bg-slate-50"><Paperclip className="h-3.5 w-3.5" />{m.attachment.name}</button>}
                        {m.reactions?.length > 0 && !m.deleted && (
                          <div className="mt-1 flex flex-wrap gap-1">{m.reactions.map((r) => (
                            <button key={r.emoji} onClick={() => canWrite && react.mutate({ id: m.id, emoji: r.emoji })} className={cn('rounded-full border px-2 py-0.5 text-xs', r.userIds.includes(me.id) ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white')}>{r.emoji} {r.userIds.length}</button>
                          ))}</div>
                        )}
                      </div>
                      {canWrite && !m.deleted && (
                        <div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1 py-0.5 shadow-sm group-hover:flex group-focus-within:flex">
                          {EMOJI.map((e) => <button key={e} onClick={() => react.mutate({ id: m.id, emoji: e })} className="rounded px-1 text-sm hover:bg-slate-100" aria-label={`React ${e}`}>{e}</button>)}
                          <button onClick={() => setReplyTo(m)} className="rounded px-1.5 text-xs text-slate-500 hover:bg-slate-100">Reply</button>
                          {mine && <button onClick={() => setEditing({ id: m.id, text: m.text })} className="rounded px-1.5 text-xs text-slate-500 hover:bg-slate-100">Edit</button>}
                          {(mine || canModerate) && <button onClick={() => confirm('Delete this message?') && remove.mutate(m.id)} className="rounded px-1.5 text-xs text-red-500 hover:bg-red-50">Delete</button>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={bottom} />
            </div>
            <div className="border-t border-slate-200 p-3">
              <div className="h-4 px-1 text-xs italic text-slate-400" aria-live="polite">{typers.length > 0 && `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…`}</div>
              {replyTo && <div className="mb-2 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-500"><span className="truncate">Replying to <b>{byId.get(replyTo.userId)?.name}</b>: {replyTo.text}</span><button onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X className="h-3.5 w-3.5" /></button></div>}
              {attached && <div className="mb-2 flex items-center justify-between rounded-lg bg-brand-50 px-3 py-1.5 text-xs text-brand-700"><span className="flex items-center gap-1.5"><Paperclip className="h-3.5 w-3.5" />{attached.name}</span><button onClick={() => setAttached(null)} aria-label="Remove attachment"><X className="h-3.5 w-3.5" /></button></div>}
              {canWrite ? (
                <form onSubmit={(e) => { e.preventDefault(); if (text.trim() || attached) send.mutate(); }} className="flex gap-2">
                  <input ref={file} type="file" hidden onChange={(e) => { setAttached(e.target.files?.[0] || null); e.target.value = ''; }} />
                  <Button type="button" variant="secondary" onClick={() => file.current?.click()} aria-label="Attach file"><Paperclip className="h-4 w-4" /></Button>
                  <Input value={text} onChange={(e) => onType(e.target.value)} placeholder={`Message ${active?.type === 'dm' ? dmName(active) : '#' + (active?.name || '')}`} maxLength={8000} aria-label="Message" />
                  <Button type="submit" loading={send.isPending} disabled={!text.trim() && !attached}>Send</Button>
                </form>
              ) : <p className="text-center text-sm text-slate-400">Viewers can read but not post.</p>}
            </div>
          </>
        )}
      </section>

      <Modal open={newChannel} onClose={() => setNewChannel(false)} title="New channel">
        <form onSubmit={(e) => { e.preventDefault(); createChannel.mutate(); }} className="space-y-3">
          <Input autoFocus placeholder="e.g. design" value={chName} onChange={(e) => setChName(e.target.value.toLowerCase())} />
          <ErrorBox error={createChannel.error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setNewChannel(false)}>Cancel</Button><Button type="submit" loading={createChannel.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}
