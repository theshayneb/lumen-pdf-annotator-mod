import type { NormalizedRect } from "./model";

/** One run of PDF text on a page: its offsets in the document text and its box. */
export interface MatchTextSpan {
  start: number;
  end: number;
  rect: NormalizedRect;
}

export interface MatchPage {
  page: number;
  start: number;
  end: number;
  spans: MatchTextSpan[];
}

/** A PDF's text, as built for quote matching, with each page's place in it. */
export interface MatchDocument {
  text: string;
  pages: MatchPage[];
}

/** Document text with whitespace removed, so quotes match whatever spacing either PDF version uses. */
export interface CompactText {
  text: string;
  /** For each compact character, its offset in the full document text. */
  offsets: number[];
}

export interface MatchedPart {
  page: number;
  rects: NormalizedRect[];
}

const MAX_CANDIDATES = 500;

export function compactText(document: MatchDocument): CompactText {
  let text = "";
  const offsets: number[] = [];
  for (let offset = 0; offset < document.text.length; offset++) {
    const character = document.text[offset];
    if (/\s/.test(character)) continue;
    text += character;
    offsets.push(offset);
  }
  return { text, offsets };
}

function compactQuote(quote: string): string {
  return quote.toLocaleLowerCase().replace(/\s+/g, "");
}

/** The boxes covering document text [start, end), one entry per page. */
function partsForRange(document: MatchDocument, start: number, end: number): MatchedPart[] {
  const parts: MatchedPart[] = [];
  for (const page of document.pages) {
    if (page.end <= start || page.start >= end) continue;
    const rects = page.spans.filter(span => span.end > start && span.start < end).map(span => {
      const overlapStart = Math.max(span.start, start);
      const overlapEnd = Math.min(span.end, end);
      const length = Math.max(1, span.end - span.start);
      return {
        ...span.rect,
        x: span.rect.x + span.rect.width * ((overlapStart - span.start) / length),
        width: span.rect.width * ((overlapEnd - overlapStart) / length),
      };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    if (rects.length) parts.push({ page: page.page, rects });
  }
  return parts;
}

/**
 * Finds `quote` in another version of a PDF. When it occurs more than once,
 * the occurrence closest to where it was (page, then height on the page) wins.
 * Returns null when the text is not in this version.
 */
export function locateQuote(document: MatchDocument, compact: CompactText, quote: string, page: number, y: number): MatchedPart[] | null {
  const needle = compactQuote(quote);
  if (!needle) return null;
  let best: { parts: MatchedPart[]; score: number } | null = null;
  let from = 0;
  for (let count = 0; count < MAX_CANDIDATES; count++) {
    const at = compact.text.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const start = compact.offsets[at];
    const end = compact.offsets[at + needle.length - 1] + 1;
    const parts = partsForRange(document, start, end);
    if (!parts.length) continue;
    const first = parts[0];
    const top = Math.min(...first.rects.map(rect => rect.y));
    const score = Math.abs(first.page - page) * 10 + Math.abs(top - y);
    if (!best || score < best.score) best = { parts, score };
    if (score === 0) break;
  }
  return best?.parts ?? null;
}
