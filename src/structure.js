import { estimateTokens } from "./text.js";

/**
 * Turn a linear list of text segments plus a (possibly nested) table of contents
 * into a flat list of chapters.
 *
 * @param {string[]} segments  Book text in reading order, pre-cut at every TOC target.
 * @param {{title:string, depth:number, seg:number}[]} nodes  TOC entries in pre-order;
 *        `seg` is the index of the segment where the entry starts.
 * @param {{minTokens:number, maxTokens:number}} opts
 *
 * Rule for nested TOCs: an entry is kept whole unless it is a mere container
 * (e.g. "Part One" with almost no text of its own, whose children are chapter-sized) or
 * it is too large for one chunk — in those cases we descend into its children, so
 * oversized chapters get split at real section boundaries before falling back
 * to paragraph splitting.
 */
export function chaptersFromToc(segments, nodes, { minTokens, maxTokens }) {
  const valid = nodes
    .map((n, order) => ({ ...n, order, title: (n.title || "").trim() || "Untitled" }))
    .filter((n) => Number.isInteger(n.seg) && n.seg >= 0 && n.seg < segments.length)
    .sort((a, b) => a.seg - b.seg || a.order - b.order);
  if (!valid.length) return null;

  const prefix = [0];
  for (const s of segments) prefix.push(prefix.at(-1) + estimateTokens(s));
  const tokens = (a, b) => prefix[b] - prefix[a];
  const text = (a, b) => segments.slice(a, b).join("\n\n").trim();

  // index (into `valid`) of the next entry that is not a descendant of i
  const nextIdx = (i) => {
    let j = i + 1;
    while (j < valid.length && valid[j].depth > valid[i].depth) j++;
    return j;
  };
  const endSeg = (i) => {
    const j = nextIdx(i);
    return j < valid.length ? valid[j].seg : segments.length;
  };
  const directChildren = (i) => {
    const j = nextIdx(i);
    const inner = valid.slice(i + 1, j).map((n, k) => ({ n, idx: i + 1 + k }));
    if (!inner.length) return [];
    const d = Math.min(...inner.map((x) => x.n.depth));
    return inner.filter((x) => x.n.depth === d).map((x) => x.idx);
  };

  const chapters = [];
  const firstSeg = valid[0].seg;
  if (firstSeg > 0) {
    chapters.push({ title: "Opening material", path: [], auto: true, text: text(0, firstSeg) });
  }

  const emit = (i, path) => {
    const node = valid[i];
    const end = endSeg(i);
    const kids = directChildren(i);
    if (kids.length) {
      const own = tokens(node.seg, valid[kids[0]].seg);
      const total = tokens(node.seg, end);
      // children look like real chapters (not little subsections) → treat node as a container
      const kidSizes = kids.map((k) => tokens(valid[k].seg, endSeg(k))).sort((a, b) => a - b);
      const chapterSized = kidSizes[Math.floor(kidSizes.length / 2)] >= Math.max(1500, minTokens * 2);
      if (total > maxTokens || (own < minTokens && chapterSized)) {
        const ownText = text(node.seg, valid[kids[0]].seg);
        if (ownText) chapters.push({ title: node.title, path, text: ownText });
        for (const k of kids) emit(k, [...path, node.title]);
        return;
      }
    }
    chapters.push({ title: node.title, path, text: text(node.seg, end) });
  };

  for (let i = 0; i < valid.length; i = nextIdx(i)) emit(i, []);
  return chapters;
}

/** Cut one string at the given character offsets. */
export function cutText(text, offsets) {
  const cuts = [...new Set(offsets)].filter((o) => o > 0 && o < text.length).sort((a, b) => a - b);
  const parts = [];
  let prev = 0;
  for (const c of cuts) {
    parts.push(text.slice(prev, c));
    prev = c;
  }
  parts.push(text.slice(prev));
  return { parts, starts: [0, ...cuts] };
}
