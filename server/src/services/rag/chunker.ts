import { PageText } from './extract';

export interface Chunk {
  pageNumber: number;
  chunkIndex: number;
  text: string;
}

/** Sentence-aware splitter: ~`target` chars per chunk with a trailing overlap so context isn't cut mid-thought. */
export function chunkPages(pages: PageText[], target = 800, overlap = 120): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    const sentences = page.text.split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
    let cur = '';
    const push = () => {
      if (cur.trim()) chunks.push({ pageNumber: page.pageNumber, chunkIndex: chunks.length, text: cur.trim() });
    };
    for (let s of sentences) {
      while (s.length > target * 1.5) {
        // very long unbroken run (tables, code): hard-split
        if (cur) { push(); cur = ''; }
        cur = s.slice(0, target);
        push();
        cur = '';
        s = s.slice(target - overlap);
      }
      if (cur && cur.length + s.length + 1 > target) {
        push();
        const tail = cur.slice(-overlap);
        cur = tail.slice(Math.max(0, tail.indexOf(' ') + 1)) + ' ' + s;
      } else cur += (cur ? ' ' : '') + s;
    }
    push();
  }
  return chunks;
}
