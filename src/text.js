import { parse } from "node-html-parser";
import { pageMark } from "./pages.js";

/** Rough token estimate (~4 chars per token for English prose). */
export const estimateTokens = (text) => Math.ceil((text?.length ?? 0) / 4);

const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "aside", "main", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figure", "figcaption",
  "table", "tr", "ul", "ol", "dl", "dt", "dd", "hr", "body", "html",
]);
const SKIP = new Set(["script", "style", "head", "title", "svg", "math", "noscript"]);

/**
 * Convert (X)HTML into readable plain text, keeping paragraph breaks.
 * Print page breaks (epub:type="pagebreak", role="doc-pagebreak", or ids listed in the
 * EPUB page-list via `pageIds`: Map<id, label>) become invisible page markers.
 */
export function htmlToText(html, { pageIds } = {}) {
  html = html.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/gi, "");
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });
  const out = [];
  const walk = (node, inPre) => {
    if (node.nodeType === 3) {
      // TextNode: .text decodes entities
      const t = inPre ? node.text : node.text.replace(/\s+/g, " ");
      out.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.rawTagName?.toLowerCase().replace(/^.*:/, "");
    if (tag && SKIP.has(tag)) return;
    const id = node.getAttribute?.("id");
    const typed = /\bpagebreak\b/.test(`${node.getAttribute?.("epub:type") ?? ""} ${node.getAttribute?.("role") ?? ""}`);
    if (typed || (id && pageIds?.has(id))) {
      const label = pageIds?.get(id) ?? node.getAttribute("title") ?? node.getAttribute("aria-label") ??
        (node.text.trim() || id?.replace(/^\D+/, ""));
      if (label) out.push(pageMark(label));
      if (typed) return; // typed page-break elements only hold the printed number
    }
    if (tag === "br") return void out.push("\n");
    if (tag === "img") {
      const alt = node.getAttribute?.("alt")?.trim();
      if (alt && alt.length > 3) out.push(` [Image: ${alt}] `);
      return;
    }
    const block = tag && BLOCK.has(tag);
    if (block) out.push("\n\n");
    if (tag === "li") out.push("\n- ");
    if (tag === "td" || tag === "th") out.push(" | ");
    for (const c of node.childNodes) walk(c, inPre || tag === "pre");
    if (block) out.push("\n\n");
  };
  walk(root, false);
  return normalizeWhitespace(out.join(""));
}

export function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​­﻿]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lowercase, strip punctuation/extra spaces — for fuzzy title matching. */
export const normKey = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
