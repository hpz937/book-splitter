import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeWhitespace } from "../text.js";
import { detectHeadings } from "../headings.js";
import { chaptersFromToc, cutText } from "../structure.js";

/** Plain text (.txt) and Markdown (.md). Handles Project Gutenberg boilerplate. */
export async function parseText(file, opts) {
  let text = (await readFile(file, "utf8")).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const warnings = [];
  let title = null;
  let author = null;

  // Project Gutenberg header/footer
  const start = text.match(/^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start) {
    const header = text.slice(0, start.index);
    title = header.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? null;
    author = header.match(/^Author:\s*(.+)$/m)?.[1]?.trim() ?? null;
    text = text.slice(start.index + start[0].length);
    const end = text.match(/^\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG.*$/im);
    if (end) text = text.slice(0, end.index);
  }

  const isMd = /\.(md|markdown)$/i.test(file);
  if (isMd) {
    const fm = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/);
    if (fm) {
      const field = (k) => fm[1].match(new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1] ?? null;
      title ??= field("title");
      author ??= field("author");
      text = text.slice(fm[0].length);
    }
  }
  let heads = [];
  if (isMd) {
    let inFence = false;
    const re = /^.*$/gm;
    let m;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (/^\s*(```|~~~)/.test(m[0])) inFence = !inFence;
      const h = !inFence && m[0].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) heads.push({ offset: m.index, title: h[2], depth: h[1].length - 1 });
    }
    if (!title) {
      const h1 = heads.filter((h) => h.depth === 0);
      if (h1.length === 1) {
        title = h1[0].title; // single H1 = book title, not a chapter
        heads = heads.filter((h) => h !== h1[0]);
      }
    }
  }
  if (!heads.length) heads = detectHeadings(text);

  let chapters = null;
  if (heads.length) {
    const { parts, starts } = cutText(text, heads.map((h) => h.offset));
    const segments = parts.map(normalizeWhitespace);
    const nodes = heads.map((h) => ({ title: h.title, depth: h.depth, seg: starts.indexOf(h.offset) }));
    chapters = chaptersFromToc(segments, nodes, opts);
  }
  if (!chapters) {
    warnings.push("No chapter headings detected; splitting by size only.");
    chapters = [{ title: "Full text", path: [], text: normalizeWhitespace(text) }];
  }

  return {
    title: title ?? path.basename(file).replace(/\.[^.]+$/, ""),
    author,
    format: isMd ? "markdown" : "text",
    chapters,
    warnings,
  };
}
