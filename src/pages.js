// Page numbers travel through parsing/splitting as invisible markers in the text
// (private-use characters), so they survive chapter cuts, merges and paragraph splits.
// They are stripped from the text once each chunk's page range has been read off.

const OPEN = "\uE000";
const CLOSE = "\uE001";
const MARK_RE = /\uE000([^\uE001]*)\uE001/g;

export const DEFAULT_WORDS_PER_PAGE = Number(process.env.BOOK_SPLITTER_WORDS_PER_PAGE) || 300;

/** Text with page markers removed. */
export const stripMarks = (text) => text.replace(MARK_RE, "");

/** Marker for "print page <label> starts here". */
export const pageMark = (label) => `${OPEN}${String(label).replace(/[\uE000\uE001]/g, "").trim()}${CLOSE}`;

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
export const countWords = (text) => (text.match(WORD_RE) ?? []).length;

/**
 * True when the text's first page marker comes within its first few words — e.g. at the very top, or
 * right after the chapter heading, where publishers often place it. Then that marker is the start page.
 */
function opensWithMark(text) {
  const i = text.indexOf(OPEN);
  return i >= 0 && countWords(text.slice(0, i)) < 25;
}

/**
 * Give every raw chapter a leading marker for the page it starts on (carried over from
 * the previous chapter when the chapter begins mid-page), and summarize the book's pagination.
 * Must run on ALL raw chapters, before front/back matter is skipped.
 * @returns {{count:number, labels:number}|null}  null when the book has no page markers
 */
export function propagatePages(chapters) {
  let current = null;
  const labels = [];
  for (const ch of chapters) {
    if (current !== null && /\S/.test(ch.text) && !opensWithMark(ch.text)) ch.text = pageMark(current) + "\n\n" + ch.text;
    for (const m of ch.text.matchAll(MARK_RE)) labels.push(m[1]);
    if (labels.length) current = labels[labels.length - 1];
  }
  if (!labels.length) return null;
  const distinct = [...new Set(labels)];
  // Printed page count = highest arabic page number (roman-numbered front matter not counted)
  const arabic = distinct.filter((l) => /^\d+$/.test(l)).map(Number);
  return { count: arabic.length ? Math.max(...arabic) : distinct.length, labels: distinct.length };
}

/**
 * Read page range + word count off each chunk, then strip the markers from its text.
 * Mutates and returns the chunks.
 */
export function finalizePages(chunks, estimateTokens) {
  let current = null;
  for (const c of chunks) {
    const labels = [...c.text.matchAll(MARK_RE)].map((m) => m[1]);
    const start = opensWithMark(c.text) ? labels[0] : current ?? labels[0];
    if (labels.length) current = labels[labels.length - 1];
    c.text = c.text.replace(MARK_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    c.tokens = estimateTokens(c.text);
    c.words = countWords(c.text);
    if (start != null) c.printPages = { start, end: current ?? start };
  }
  return chunks;
}

/** Estimated pages for a word count, with a plausible range across common print layouts. */
export function estimatePages(words, wordsPerPage = DEFAULT_WORDS_PER_PAGE) {
  return {
    estimate: Math.max(1, Math.round(words / wordsPerPage)),
    range: [Math.max(1, Math.round(words / (wordsPerPage * 1.17))), Math.max(1, Math.round(words / (wordsPerPage * 0.83)))],
  };
}

/** Page-range strings for each chunk: real print pages when known, else estimated from word position. */
export function chunkPageRanges(book, wordsPerPage = DEFAULT_WORDS_PER_PAGE) {
  let cum = 0;
  return book.chunks.map((c) => {
    if (c.printPages) {
      const { start, end } = c.printPages;
      return start === end ? `p. ${start}` : `pp. ${start}–${end}`;
    }
    const a = Math.floor(cum / wordsPerPage) + 1;
    cum += c.words ?? 0;
    const b = Math.max(a, Math.ceil(cum / wordsPerPage));
    return a === b ? `~p. ${a}` : `~pp. ${a}–${b}`;
  });
}

/** Book-level page info for display: real count when known, otherwise an estimate with a range. */
export function bookPages(book, wordsPerPage = DEFAULT_WORDS_PER_PAGE) {
  if (book.pagination) return { ...book.pagination };
  const { estimate, range } = estimatePages(book.words ?? 0, wordsPerPage);
  return { estimate, range: `${range[0]}–${range[1]}`, words_per_page: wordsPerPage, source: "estimate from word count" };
}
