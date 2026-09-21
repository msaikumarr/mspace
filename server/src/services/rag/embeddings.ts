/**
 * Local, dependency-free embedding model: signed feature hashing over stemmed unigrams and bigrams, L2-normalised.
 * It needs no API key and is deterministic, so RAG works out of the box and is cheap to test. It captures
 * lexical overlap (not deep semantics). To upgrade, implement `embed()` against a hosted embedding model and bump
 * EMBEDDING_VERSION so existing chunks get re-embedded; nothing else in the pipeline changes.
 */
export const EMBEDDING_DIM = 512;
export const EMBEDDING_VERSION = 'hash-512-v1';

const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its of on or that the their there these they this to was were will with you your we our can could should would do does not no if then than so such into about over also any all more most other some which who whom what when where why how'.split(' '),
);

export function stem(w: string) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const toks = tokenize(text);
  const add = (feat: string, w: number) => {
    const h = fnv1a(feat);
    v[h % EMBEDDING_DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < toks.length; i++) {
    add(toks[i], 1);
    if (i + 1 < toks.length) add(`${toks[i]} ${toks[i + 1]}`, 0.6);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export const cosine = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
