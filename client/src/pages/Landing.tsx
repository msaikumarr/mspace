import { Link } from 'react-router-dom';
import { Kanban, MessageSquare, FileText, Sparkles, Mic, BarChart3, ShieldCheck, Check } from 'lucide-react';
import { useAuth } from '../store/auth';

const FEATURES = [
  [Kanban, 'Projects & Kanban', 'Plan work with boards, priorities, due dates and live drag-and-drop that syncs to everyone instantly.'],
  [MessageSquare, 'Team chat', 'Channels, DMs, threads-lite replies, reactions, mentions and typing indicators — no extra app needed.'],
  [FileText, 'Document knowledge base', 'Upload PDFs, Word and Markdown. Ask questions and get answers with the exact page as the source.'],
  [Sparkles, 'AI Copilot', 'Summarise projects, find overdue work, decide what to do next, and turn requirements into tasks you approve.'],
  [Mic, 'Meeting assistant', 'Paste a transcript and get a summary, decisions, deadlines and reviewable action items.'],
  [BarChart3, 'Analytics & insights', 'Completion rate, workload, weekly throughput and explainable signals on where to look.'],
  [ShieldCheck, 'Multi-tenant & secure', 'Workspace isolation enforced on the server, role-based access, audit logs and plan-based limits.'],
] as const;

const PLANS = [
  ['Free', '$0', ['3 members', '3 projects', 'Kanban, chat, docs', '15 AI requests/mo']],
  ['Pro', '$12', ['25 members', 'AI Copilot + RAG', 'Meeting assistant', 'Advanced analytics'], true],
  ['Business', '$39', ['500 members', 'Audit logs', 'Highest AI limits', 'API access']],
] as const;

export default function Landing() {
  const user = useAuth((s) => s.user);
  return (
    <div className="min-h-full bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <span className="flex items-center gap-2 text-lg font-bold"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">M</span> M-Space</span>
        <nav className="flex items-center gap-3 text-sm">
          {user ? <Link to="/app" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">Open app</Link> : (
            <>
              <Link to="/login" className="font-medium text-slate-600 hover:text-slate-900">Sign in</Link>
              <Link to="/register" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">Get started</Link>
            </>
          )}
        </nav>
      </header>

      <section className="bg-gradient-to-b from-brand-50 to-white">
        <div className="mx-auto max-w-4xl px-5 py-20 text-center">
          <span className="rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700">AI-native team workspace</span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-900 sm:text-6xl">Projects, chat, docs and AI — in one place.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">Stop juggling five tools. M-Space gives your team tasks, real-time collaboration and a Copilot that actually knows your workspace.</p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/register" className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white shadow-sm hover:bg-brand-700">Start free</Link>
            <a href="#features" className="rounded-lg border border-slate-300 px-6 py-3 font-medium text-slate-700 hover:bg-slate-50">See features</a>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-center text-2xl font-bold text-slate-900">Everything a team needs</h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([Icon, t, d]) => (
            <div key={t} className="rounded-xl border border-slate-200 p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon className="h-5 w-5" strokeWidth={1.75} /></div>
              <h3 className="mt-3 font-semibold text-slate-900">{t}</h3>
              <p className="mt-1 text-sm text-slate-600">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="mx-auto max-w-5xl px-5">
          <h2 className="text-center text-2xl font-bold text-slate-900">Simple pricing</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {PLANS.map(([name, price, items, hot]) => (
              <div key={name} className={`rounded-xl border bg-white p-6 ${hot ? 'border-brand-500 ring-2 ring-brand-200' : 'border-slate-200'}`}>
                <h3 className="font-semibold">{name}</h3>
                <p className="mt-2 text-3xl font-bold">{price}<span className="text-sm font-normal text-slate-500">/mo</span></p>
                <ul className="mt-4 space-y-2 text-sm text-slate-600">{items.map((i) => <li key={i} className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-brand-600" strokeWidth={2.25} />{i}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>
      <footer className="py-8 text-center text-sm text-slate-400">© {new Date().getFullYear()} M-Space</footer>
    </div>
  );
}
