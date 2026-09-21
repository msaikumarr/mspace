import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export const ALLOWED_EXT = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const;
export interface PageText {
  pageNumber: number;
  text: string;
}

/** Cleans extracted text: normalises whitespace, removes control chars, rejoins hyphenated line breaks. */
export function clean(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPages(buffer: Buffer, ext: string): Promise<PageText[]> {
  if (ext === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const r = await parser.getText();
      return r.pages.map((p) => ({ pageNumber: p.num, text: clean(p.text) })).filter((p) => p.text);
    } finally {
      await parser.destroy();
    }
  }
  if (ext === 'docx') {
    const r = await mammoth.extractRawText({ buffer });
    return splitVirtualPages(clean(r.value));
  }
  return splitVirtualPages(clean(buffer.toString('utf8')));
}

/** Formats without real pages (docx/txt/md) are split into ~3000-char "pages" so citations stay useful. */
function splitVirtualPages(text: string, size = 3000): PageText[] {
  if (!text) return [];
  const pages: PageText[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > size) {
      pages.push({ pageNumber: pages.length + 1, text: cur.trim() });
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur.trim()) pages.push({ pageNumber: pages.length + 1, text: cur.trim() });
  return pages;
}

/** Magic-byte check so a renamed file cannot masquerade as a PDF/DOCX. */
export function sniffMatchesExt(buf: Buffer, ext: string) {
  if (ext === 'pdf') return buf.subarray(0, 5).toString() === '%PDF-';
  if (ext === 'docx') return buf[0] === 0x50 && buf[1] === 0x4b; // zip
  return !buf.subarray(0, 4096).includes(0); // text formats must not contain NUL bytes
}
