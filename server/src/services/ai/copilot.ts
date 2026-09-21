import { Types } from 'mongoose';
import { Task, Project } from '../../models/Project';
import { Member, WorkspaceDoc } from '../../models/Workspace';
import { DocumentModel, DocChunk } from '../../models/Knowledge';
import { getPlan } from '../../config/plans';
import { complete, completeJson, llmAvailable, untrusted, GUARD } from './llm';
import { summarizeText, focusedExcerpt, extractTasks, Candidate, analyzeMeeting, MeetingAnalysis } from './heuristics';
import { search, Hit } from '../rag/ragService';
import { computeAnalytics, computeInsights } from '../analyticsService';
import { notFound, badRequest } from '../../utils/errors';

export interface Source {
  documentId: string;
  name: string;
  pageNumber: number;
  snippet: string;
}
export const toSources = (hits: Hit[]): Source[] => hits.map((h) => ({ documentId: h.documentId, name: h.name, pageNumber: h.pageNumber, snippet: h.text.slice(0, 240) }));

const SYSTEM = `You are the AI Copilot inside a team productivity workspace. Answer using ONLY the workspace facts and document excerpts provided. If they don't contain the answer, say so plainly. Be concise, use short lists where helpful, and cite documents as [Document name, p.N]. Never make claims about individual employees' worth or performance. ${GUARD}`;

const fmtDate = (d?: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : 'no due date');
const fmtTask = (t: any) => `${t.title} [${t.priority}, ${t.status}, ${fmtDate(t.dueDate)}]`;

async function workspaceFacts(workspaceId: Types.ObjectId, userId: Types.ObjectId) {
  const now = new Date();
  const [projects, overdue, mine, analytics] = await Promise.all([
    Project.find({ workspaceId }).select('name status deadline').limit(30),
    Task.find({ workspaceId, status: { $ne: 'DONE' }, dueDate: { $lt: now } }).sort({ dueDate: 1 }).limit(15),
    Task.find({ workspaceId, assigneeId: userId, status: { $ne: 'DONE' } }).limit(50),
    computeAnalytics(workspaceId),
  ]);
  const rank = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;
  const mineSorted = [...mine].sort((a, b) => rank[a.priority] - rank[b.priority] || (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity));
  return { projects, overdue, mine: mineSorted, totals: analytics.totals };
}

type Facts = Awaited<ReturnType<typeof workspaceFacts>>;
const factsText = (f: Facts) =>
  [
    `Totals: ${JSON.stringify(f.totals)}`,
    `Projects: ${f.projects.map((p) => `${p.name} (${p.status}${p.deadline ? ', deadline ' + fmtDate(p.deadline) : ''})`).join('; ') || 'none'}`,
    `Overdue tasks: ${f.overdue.map(fmtTask).join('; ') || 'none'}`,
    `Tasks assigned to the asking user (by priority): ${f.mine.slice(0, 15).map(fmtTask).join('; ') || 'none'}`,
  ].join('\n');

type Intent = 'overdue' | 'next' | 'project' | 'insights' | 'docs';
function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/\b(overdue|late|past due|missed deadline)/.test(s)) return 'overdue';
  if (/(what (should|do) i (work|do|focus)|work on next|my (tasks|priorities)|what'?s next|prioriti[sz]e)/.test(s)) return 'next';
  if (/\b(insight|risk|blocker|bottleneck|attention|status report|health)\b/.test(s)) return 'insights';
  if (/\b(summari[sz]e|summary|overview|status of)\b.*\b(project)\b|\bproject\b.*\b(summary|status|progress)\b/.test(s)) return 'project';
  return 'docs';
}

function offlineAnswer(intent: Intent, f: Facts, hits: Hit[], question: string, projectName?: string): string {
  if (intent === 'overdue') {
    return f.overdue.length ? `You have ${f.overdue.length} overdue task${f.overdue.length > 1 ? 's' : ''}:\n${f.overdue.map((t) => `• ${fmtTask(t)}`).join('\n')}` : 'Nothing is overdue right now. 🎉';
  }
  if (intent === 'next') {
    if (!f.mine.length) return 'You have no open tasks assigned to you. Check unassigned work in your projects or ask a manager for priorities.';
    return `Suggested order for your open tasks (priority first, then earliest due date):\n${f.mine.slice(0, 5).map((t, i) => `${i + 1}. ${fmtTask(t)}`).join('\n')}`;
  }
  if (intent === 'project' || intent === 'insights') {
    const t = f.totals;
    return `${projectName ? `Project "${projectName}"` : 'Workspace'} snapshot: ${t.total} tasks — ${t.completed} done (${t.completionRate}%), ${t.pending} pending, ${t.overdue} overdue, ${t.unassigned} unassigned.`;
  }
  if (!hits.length) return "I couldn't find anything in your uploaded documents that answers that. Try uploading the relevant document in Documents, or rephrase with terms from the document.";
  const best = hits.slice(0, 3).map((h) => `• "${focusedExcerpt(h.text, question, 2)}" — [${h.name}, p.${h.pageNumber}]`);
  return `Here is what the documents say about "${question.slice(0, 80)}":\n${best.join('\n')}\n\n(Offline mode: showing the most relevant excerpts. Set AI_API_KEY for synthesized answers.)`;
}

export async function chat(opts: { workspace: WorkspaceDoc; userId: Types.ObjectId; message: string; history: { role: string; content: string }[] }) {
  const { workspace, userId, message } = opts;
  const intent = detectIntent(message);
  const facts = await workspaceFacts(workspace._id, userId);

  // Match a project by name mention so "summarize the Website Redesign project" is scoped.
  const named = facts.projects.find((p) => message.toLowerCase().includes(p.name.toLowerCase()));
  const scopedTotals = named ? (await computeAnalytics(workspace._id, named._id)).totals : facts.totals;
  const scopedFacts = { ...facts, totals: scopedTotals };

  const ragOn = getPlan(workspace.plan).features.rag;
  const hits = ragOn && (intent === 'docs' || intent === 'project') ? await search(workspace._id, message, 5, named ? { projectId: named._id } : {}) : [];

  let text: string | null = null;
  if (llmAvailable()) {
    const hist = opts.history.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    const docs = hits.map((h, i) => `[${i + 1}] ${h.name}, p.${h.pageNumber}\n${h.text}`).join('\n\n');
    text = await complete({
      system: SYSTEM,
      prompt: `Workspace facts:\n${factsText(scopedFacts)}\n\n${docs ? untrusted('documents', docs) : '(no document excerpts retrieved)'}\n\nConversation so far:\n${hist || '(none)'}\n\nUser question: ${message}`,
    });
  }
  const answer = text || offlineAnswer(intent, scopedFacts, hits, message, named?.name);
  return { answer, sources: toSources(hits), intent, mode: text ? 'llm' : 'offline' };
}

export async function documentQuery(opts: { workspace: WorkspaceDoc; question: string; projectId?: Types.ObjectId; documentIds?: Types.ObjectId[] }) {
  const hits = await search(opts.workspace._id, opts.question, 6, { projectId: opts.projectId, documentIds: opts.documentIds });
  if (!hits.length) return { answer: "I couldn't find relevant content in the selected documents.", sources: [], mode: 'offline' as const };
  let text: string | null = null;
  if (llmAvailable()) {
    const docs = hits.map((h, i) => `[${i + 1}] ${h.name}, p.${h.pageNumber}\n${h.text}`).join('\n\n');
    text = await complete({ system: SYSTEM, prompt: `${untrusted('documents', docs)}\n\nQuestion: ${opts.question}\nAnswer strictly from the documents and cite them.` });
  }
  const answer = text || `Most relevant passages:\n${hits.slice(0, 3).map((h) => `• "${focusedExcerpt(h.text, opts.question, 2)}" — [${h.name}, p.${h.pageNumber}]`).join('\n')}`;
  return { answer, sources: toSources(hits), mode: text ? ('llm' as const) : ('offline' as const) };
}

async function docText(workspaceId: Types.ObjectId, documentId: Types.ObjectId, cap = 24000) {
  const doc = await DocumentModel.findOne({ _id: documentId, workspaceId, status: 'READY' });
  if (!doc) throw notFound('Document', 'DOCUMENT_NOT_FOUND');
  const chunks = await DocChunk.find({ workspaceId, documentId }).sort({ chunkIndex: 1 });
  return { doc, text: chunks.map((c) => c.text).join('\n').slice(0, cap) };
}

export async function summarize(opts: { workspace: WorkspaceDoc; projectId?: Types.ObjectId; documentId?: Types.ObjectId; text?: string }) {
  const w = opts.workspace._id;
  let subject = '';
  let material = '';
  if (opts.projectId) {
    const p = await Project.findOne({ _id: opts.projectId, workspaceId: w });
    if (!p) throw notFound('Project', 'PROJECT_NOT_FOUND');
    const [a, tasks] = await Promise.all([computeAnalytics(w, p._id), Task.find({ workspaceId: w, projectId: p._id }).sort({ updatedAt: -1 }).limit(40)]);
    subject = `project "${p.name}"`;
    material = `Description: ${p.description || '(none)'}\nStatus: ${p.status}, deadline ${fmtDate(p.deadline)}\nTotals: ${JSON.stringify(a.totals)}\nTasks:\n${tasks.map(fmtTask).join('\n')}`;
    const offline = `Project "${p.name}" is ${p.status.toLowerCase().replace('_', ' ')}: ${a.totals.completed}/${a.totals.total} tasks done (${a.totals.completionRate}%), ${a.totals.overdue} overdue, ${a.totals.unassigned} unassigned.${p.description ? ' ' + summarizeText(p.description, 2) : ''}`;
    return { summary: (await complete({ system: SYSTEM, prompt: `Summarize ${subject} in one short paragraph plus up to 3 bullet points on risks/next steps.\n\n${untrusted('data', material)}` })) || offline, subject };
  }
  if (opts.documentId) {
    const { doc, text } = await docText(w, opts.documentId);
    subject = `document "${doc.name}"`;
    return { summary: (await complete({ system: SYSTEM, prompt: `Summarize this ${subject}: key points, requirements, and open questions.\n\n${untrusted('documents', text)}` })) || summarizeText(text, 6), subject };
  }
  if (opts.text) return { summary: (await complete({ system: SYSTEM, prompt: `Summarize:\n\n${untrusted('documents', opts.text.slice(0, 24000))}` })) || summarizeText(opts.text, 5), subject: 'text' };
  throw badRequest('Provide projectId, documentId or text', 'NOTHING_TO_SUMMARIZE');
}

const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export async function resolveCandidates(workspaceId: Types.ObjectId, cands: Candidate[]) {
  const members = await Member.find({ workspaceId }).populate('userId', 'name');
  const people = members.filter((m) => m.userId).map((m) => ({ id: String((m.userId as any)._id), name: (m.userId as any).name as string }));
  return cands.map((c) => {
    const first = c.assigneeName?.trim().toLowerCase();
    const match = first ? people.find((p) => p.name.toLowerCase() === first) || people.find((p) => p.name.toLowerCase().split(' ')[0] === first.split(' ')[0]) : undefined;
    return { ...c, priority: priorities.includes(c.priority) ? c.priority : 'MEDIUM', assigneeId: match?.id ?? null, assigneeName: match?.name ?? c.assigneeName ?? null, dueDate: c.dueDate && !isNaN(Date.parse(c.dueDate)) ? c.dueDate : null };
  });
}

/** Returns *candidates only*. Nothing is written to the project until a human approves (POST /tasks/bulk). */
export async function generateTasks(opts: { workspace: WorkspaceDoc; text?: string; documentId?: Types.ObjectId }) {
  let text = opts.text || '';
  if (opts.documentId) text = (await docText(opts.workspace._id, opts.documentId, 30000)).text;
  if (!text.trim()) throw badRequest('Provide text or a documentId', 'NOTHING_TO_ANALYZE');
  const members = await Member.find({ workspaceId: opts.workspace._id }).populate('userId', 'name');
  const roster = members.filter((m) => m.userId).map((m) => (m.userId as any).name).join(', ');
  const today = new Date().toISOString().slice(0, 10);

  const llm = await completeJson<{ tasks: Candidate[] }>({
    system: `You turn requirements or notes into actionable project tasks. ${GUARD}`,
    prompt: `Today is ${today}. Team members: ${roster}.\nExtract up to 15 concrete tasks from the content. Return {"tasks":[{"title":"imperative, <=80 chars","description":"1-2 sentences","priority":"LOW|MEDIUM|HIGH|URGENT","assigneeName":"exact team member name or null","dueDate":"ISO date or null"}]}. Only include assigneeName/dueDate when explicitly stated.\n\n${untrusted('documents', text.slice(0, 30000))}`,
    maxTokens: 3000,
  });
  const cands = llm?.tasks?.filter((t) => t?.title) ?? extractTasks(text);
  return { candidates: await resolveCandidates(opts.workspace._id, cands.slice(0, 20)), mode: llm ? 'llm' : 'offline' };
}

export async function analyzeTranscript(transcript: string): Promise<MeetingAnalysis & { mode: 'llm' | 'offline' }> {
  const today = new Date().toISOString().slice(0, 10);
  const llm = await completeJson<MeetingAnalysis>({
    system: `You are a meeting assistant. ${GUARD}`,
    prompt: `Today is ${today}. Analyze the transcript. Return {"summary":"3-5 sentences","decisions":["..."],"deadlines":["..."],"actionItems":[{"title":"imperative","description":"","priority":"LOW|MEDIUM|HIGH|URGENT","assigneeName":"name or null","dueDate":"ISO or null"}]}.\n\n${untrusted('transcript', transcript.slice(0, 40000))}`,
    maxTokens: 3000,
  });
  if (llm?.summary && Array.isArray(llm.actionItems)) return { ...llm, decisions: llm.decisions || [], deadlines: llm.deadlines || [], mode: 'llm' };
  return { ...analyzeMeeting(transcript), mode: 'offline' };
}

export async function insights(opts: { workspace: WorkspaceDoc; projectId?: Types.ObjectId }) {
  const data = await computeInsights(opts.workspace._id, opts.projectId);
  const narrative = await complete({
    system: `${SYSTEM} Write 3-5 sentences of decision-support commentary about the work items. Do not evaluate individuals.`,
    prompt: `Insights (JSON):\n${JSON.stringify(data.items.map((i) => ({ severity: i.severity, title: i.title, detail: i.detail, tasks: i.tasks?.map((t) => t.title) })))}`,
    maxTokens: 500,
  });
  const top = data.items.filter((i) => i.severity !== 'info').slice(0, 3).map((i) => i.title);
  return { ...data, narrative: narrative || (top.length ? `Attention areas: ${top.join('; ')}.` : data.items[0].detail), mode: narrative ? 'llm' : 'offline' };
}
