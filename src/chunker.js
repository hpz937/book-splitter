import { estimateTokens } from "./text.js";
import { stripMarks } from "./pages.js";

// Sections that rarely matter for a summary. Skipped unless include_matter is set.
const MATTER_RE = new RegExp(
  "^(?:" + [
    "cover", "title\\s*page", "half\\s*title", "copyright(?:\\s*page)?", "dedication", "epigraph",
    "(?:table\\s+of\\s+)?contents", "also\\s+by\\b.*", "praise\\s+for\\b.*", "books\\s+by\\b.*",
    "about\\s+the\\s+(?:author|authors|publisher|translator)s?", "acknowledge?ments?", "index",
    "colophon", "imprint", "newsletter.*", "sign\\s+up.*", "front\\s*matter", "back\\s*matter",
    "list\\s+of\\s+(?:illustrations|figures|tables|maps)", "illustrations", "landmarks",
  ].join("|") + ")$",
  "i",
);

/**
 * Clean, merge and split raw chapters into summarization-sized chunks.
 * - drops empty sections and (by default) front/back matter
 * - merges tiny sections (part title pages, epigraphs) into the following chapter
 * - splits oversized chapters at paragraph (then sentence) boundaries
 */
export function finalizeChunks(rawChapters, { minTokens, maxTokens, includeMatter }) {
  const skipped = [];
  const chapters = [];
  for (const c of rawChapters) {
    const text = c.text?.trim();
    if (!text || !stripMarks(text).trim()) continue;
    const tokens = estimateTokens(text);
    const isMatter = MATTER_RE.test(c.title.trim().replace(/[.:]$/, ""));
    // Untitled content before the first TOC entry: drop if small (cover/title/copyright pages)
    if (!includeMatter && (isMatter || (c.auto && tokens < 1500))) {
      skipped.push({ title: c.title, tokens });
      continue;
    }
    chapters.push({ title: c.title, path: c.path ?? [], text, tokens });
  }

  // ---- merge tiny sections forward ----------------------------------------
  const merged = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const big = group.filter((g) => g.tokens >= minTokens);
    const main = big[0] ?? group[group.length - 1];
    // Name the chunk after its sibling sections; a merged-in parent heading ("Part One") just becomes context
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const siblings = group.filter((g) => same(g.path, main.path));
    const title = siblings.length <= 1
      ? main.title
      : siblings.length === 2
        ? `${siblings[0].title} + ${siblings[1].title}`
        : `${siblings[0].title} … ${siblings[siblings.length - 1].title}`;
    merged.push({
      title,
      path: main.path,
      text: group.map((g) => g.text).join("\n\n"),
      tokens: group.reduce((n, g) => n + g.tokens, 0),
      sections: group.length > 1 ? group.map((g) => g.title) : undefined,
    });
    group = [];
  };
  for (const c of chapters) {
    group.push(c);
    if (group.reduce((n, g) => n + g.tokens, 0) >= minTokens) flush();
  }
  if (group.length) {
    const leftover = group.reduce((n, g) => n + g.tokens, 0);
    if (merged.length && leftover < minTokens) {
      const last = merged[merged.length - 1];
      last.text += "\n\n" + group.map((g) => g.text).join("\n\n");
      last.tokens += leftover;
      last.sections = [...(last.sections ?? [last.title]), ...group.map((g) => g.title)];
      group = [];
    } else flush();
  }

  // ---- split oversized chapters --------------------------------------------
  const chunks = [];
  merged.forEach((ch, chapterIdx) => {
    const pieces = ch.tokens > maxTokens ? splitText(ch.text, maxTokens) : [ch.text];
    pieces.forEach((text, i) => {
      chunks.push({
        index: chunks.length,
        chapter: chapterIdx,
        title: ch.title,
        path: ch.path,
        part: i + 1,
        parts: pieces.length,
        tokens: estimateTokens(text),
        sections: ch.sections,
        text,
      });
    });
  });
  return { chunks, skipped, chapterCount: merged.length };
}

/** Split into roughly equal pieces under maxTokens, preferring paragraph boundaries. */
function splitText(text, maxTokens) {
  const total = estimateTokens(text);
  const n = Math.ceil(total / maxTokens);
  const target = total / n;

  // units: paragraphs, with any oversized paragraph broken into sentences / hard slices
  const maxChars = maxTokens * 4;
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= maxChars) { units.push(para); continue; }
    let buf = "";
    for (const s of para.match(/[^.!?]+[.!?]+["')\]”’]*\s*|[^.!?]+$/g) ?? [para]) {
      if (buf.length + s.length > maxChars && buf) { units.push(buf.trim()); buf = ""; }
      if (s.length > maxChars) {
        for (let i = 0; i < s.length; i += maxChars) units.push(s.slice(i, i + maxChars));
      } else buf += s;
    }
    if (buf.trim()) units.push(buf.trim());
  }

  const pieces = [];
  let cur = [];
  let curTok = 0;
  for (const u of units) {
    const t = estimateTokens(u);
    if (cur.length && (curTok + t > maxTokens || (curTok >= target && pieces.length < n - 1))) {
      pieces.push(cur.join("\n\n"));
      cur = [];
      curTok = 0;
    }
    cur.push(u);
    curTok += t;
  }
  if (cur.length) pieces.push(cur.join("\n\n"));
  return pieces;
}
