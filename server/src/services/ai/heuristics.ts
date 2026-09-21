import { tokenize } from '../rag/embeddings';

/**
 * Deterministic, offline NLP used when no LLM key is configured (and as a safety net if the LLM call fails).
 * Intentionally simple and transparent: extractive summaries and pattern-based task/decision extraction.
 */
export interface Candidate {
  title: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  assigneeName?: string;
  dueDate?: string; // ISO
}

export const sentences = (text: string) =>
  text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);

export function summarizeText(text: string, max = 5): string {
  const ss = sentences(text);
  if (ss.length <= max) return ss.join(' ');
  const freq = new Map<string, number>();
  for (const s of ss) for (const t of tokenize(s)) freq.set(t, (freq.get(t) || 0) + 1);
  const scored = ss.map((s, i) => {
    const toks = tokenize(s);
    const score = toks.reduce((a, t) => a + (freq.get(t) || 0), 0) / Math.sqrt(toks.length || 1);
    return { s, i, score: score * (i < 2 ? 1.25 : 1) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
}

/** Picks the sentences that best overlap the question (document order); falls back to a generic summary when nothing overlaps. */
export function focusedExcerpt(text: string, question: string, max = 2): string {
  const ss = sentences(text);
  const q = new Set(tokenize(question));
  const scored = ss.map((s, i) => ({ s, i, score: new Set(tokenize(s).filter((t) => q.has(t))).size }));
  if (!scored.some((x) => x.score > 0)) return summarizeText(text, max);
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDeadline(text: string, now = new Date()): string | undefined {
  const t = text.toLowerCase();
  const iso = t.match(/\b(?:by|before|until|due|on)?\s*(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12)).toISOString();
  const md = t.match(/\b(?:by|before|until|due|on)\s+(?:the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (md) {
    let y = md[3] ? +md[3] : now.getUTCFullYear();
    let d = new Date(Date.UTC(y, MONTHS.indexOf(md[1]), +md[2], 12));
    if (!md[3] && d < now) d = new Date(Date.UTC(++y, MONTHS.indexOf(md[1]), +md[2], 12));
    return d.toISOString();
  }
  const wd = t.match(/\b(?:by|before|until|due|on|next)\s+(?:end of\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
    let diff = (WEEKDAYS.indexOf(wd[1]) - d.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString();
  }
  if (/\b(tomorrow)\b/.test(t)) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12)).toISOString();
  if (/\b(end of (?:the )?week|eow)\b/.test(t)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    return d.toISOString();
  }
  const rel = t.match(/\bin (\d+) (day|week)s?\b/);
  if (rel) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + +rel[1] * (rel[2] === 'week' ? 7 : 1), 12)).toISOString();
  return undefined;
}

export function guessPriority(s: string): Candidate['priority'] {
  const t = s.toLowerCase();
  if (/\b(urgent|asap|immediately|critical|blocker|blocking|p0)\b/.test(t)) return 'URGENT';
  if (/\b(must|required|high priority|important|essential|shall|p1|security)\b/.test(t)) return 'HIGH';
  if (/\b(nice to have|optional|could|maybe|eventually|low priority|later|p3)\b/.test(t)) return 'LOW';
  return 'MEDIUM';
}

const ACTION_VERB = 'implement|build|create|add|design|develop|write|draft|update|fix|review|test|deploy|set up|setup|prepare|send|schedule|research|investigate|migrate|integrate|document|configure|support|provide|enable|ensure|define|finali[sz]e|launch|publish|refactor|remove|improve|analy[sz]e|follow up|check|share|book|contact|call';
const VERB_START = new RegExp(String.raw`^(?:${ACTION_VERB})\b`, 'i');
const VERB_ANYWHERE = new RegExp(String.raw`\b(?:${ACTION_VERB})\b`, 'i');
const REQUIREMENT = new RegExp(`\\b(must|shall|should|need(?:s)? to|required to|has to|have to|will need to|todo|to-do|action item|action:|next step)\\b|^(?:${ACTION_VERB})\\b`, 'i');
// First-person commitments said aloud ("I'll write the notes", "let's schedule a follow-up"). Speech-to-text has no speaker
// labels, so these become unassigned action items; labelled transcripts are rewritten to "Name will ..." before this runs.
const FIRST_PERSON = String.raw`(?:I(?:'ll|'m going to| will| am going to| can)|let's)`;
const COMMITMENT = new RegExp(String.raw`\b${FIRST_PERSON}\s+(?:${ACTION_VERB})\b`, 'i');
const ASSIGN = /(?:^|\s)@?([A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?\s+(?:will|to|should|needs to|is going to|can|'ll|has to|must)\b|assigned to\s+@?([A-Z][a-z]+)|\b(?:owner|assignee)\s*[:-]\s*@?([A-Z][a-z]+)/;
const NOT_NAMES = new Set(['Someone', 'Somebody', 'Anyone', 'Anybody', 'Nobody', 'Everybody', 'We', 'The', 'It', 'This', 'That', 'They', 'You', 'There', 'Users', 'User', 'System', 'Team', 'Action', 'Todo', 'Also', 'And', 'But', 'Next', 'Please', 'All', 'Each', 'Everyone']);

function toTitle(s: string) {
  let t = s
    .replace(/^[\s\-*•\d.)\]]+/, '')
    .replace(/^[A-Z][a-z]+ says:\s*/, '')
    .replace(/^(?:action item|action|todo|to-do|next step)\s*[:-]\s*/i, '')
    .replace(new RegExp(String.raw`^${FIRST_PERSON}\s+`, 'i'), '')
    .replace(/^(?:@?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:will|to|should|needs to|is going to|has to|must)\s+/, '')
    .replace(/^(?:we|the team|the system|users?|it)\s+(?:must|shall|should|need to|needs to|will need to|has to|have to|will)\s+/i, '')
    .replace(/^(?:must|shall|should|need to|needs to)\s+/i, '')
    .split(/(?<=[a-z0-9)])[.;]\s+(?=[A-Z])/)[0]
    .replace(/[.;:]+$/, '')
    .trim();
  if (t.length > 90) t = t.slice(0, 87).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function extractTasks(text: string, now = new Date(), limit = 15): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const lines = text.split(/\n+/).flatMap((l) => (/^\s*(?:[-*•]|\d+[.)])\s+/.test(l) ? [l] : sentences(l)));
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 8 || line.length > 400 || /\?$/.test(line)) continue;
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    const body = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
    const a = body.match(ASSIGN);
    const name = a && [a[1], a[2], a[3]].find((n) => n && !NOT_NAMES.has(n));
    const startsWithVerb = VERB_START.test(body);
    const namedAction = !!name && VERB_ANYWHERE.test(body);
    if (!REQUIREMENT.test(body) && !startsWithVerb && !namedAction && !COMMITMENT.test(body)) continue;
    const title = toTitle(line);
    const key = title.toLowerCase();
    if (title.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, description: line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), priority: guessPriority(line), assigneeName: name || undefined, dueDate: parseDeadline(line, now) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface MeetingAnalysis {
  summary: string;
  decisions: string[];
  deadlines: string[];
  actionItems: Candidate[];
}

export function analyzeMeeting(transcript: string, now = new Date()): MeetingAnalysis {
  const ss = sentences(transcript);
  const decisions = ss.filter((s) => /\b(decided|agreed|approved|we(?:'ll| will) go with|let's go with|the decision|conclusion|settled on|resolved to)\b/i.test(s)).map((s) => s.replace(/^[\w .'-]{1,30}:\s+/, '')).slice(0, 10);
  const deadlines = ss.filter((s) => parseDeadline(s, now) && /\b(deadline|due|by|before|until|launch|release|ship)\b/i.test(s)).map((s) => s.replace(/^[\w .'-]{1,30}:\s+/, '')).slice(0, 10);
  const stripSpeaker = transcript.replace(/^\s*[\w .'-]{1,30}:\s+/gm, '');
  return {
    summary: summarizeText(stripSpeaker, 4),
    decisions,
    deadlines,
    actionItems: extractTasks(transcript.replace(/^\s*([A-Z][\w.'-]{0,20}):\s+/gm, '$1 says: ').replace(/(\w+) says: (I'll|I will|I can)/g, '$1 will'), now),
  };
}
