import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normKey, normalizeWhitespace } from "../text.js";
import { detectHeadings } from "../headings.js";
import { chaptersFromToc, cutText } from "../structure.js";
import { pageMark } from "../pages.js";

export async function parsePdf(file, opts) {
  const data = new Uint8Array(await readFile(file));
  const task = getDocument({
    data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  });
  const doc = await task.promise;
  const warnings = [];

  try {
    const info = (await doc.getMetadata().catch(() => null))?.info ?? {};
    const pageLines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      pageLines.push(toLines((await page.getTextContent()).items));
      page.cleanup();
    }
    stripRunningHeaders(pageLines);
    const plainTexts = pageLines.map(toParagraphs);

    const chars = plainTexts.reduce((n, t) => n + t.length, 0);
    if (chars / doc.numPages < 100) {
      warnings.push("Very little extractable text — this PDF is probably scanned. Run OCR first (e.g. `ocrmypdf in.pdf out.pdf`).");
    }
    // Printed page labels ("iv", "12") when the PDF defines them, else physical page numbers
    const labels = await doc.getPageLabels().catch(() => null);
    const pageTexts = plainTexts.map((t, i) => `${pageMark(labels?.[i] || i + 1)}\n\n${t}`);

    let chapters = null;
    const outline = await doc.getOutline().catch(() => null);
    if (outline?.length) {
      const flat = [];
      const walk = async (items, depth) => {
        for (const it of items) {
          const page = await destToPage(doc, it.dest);
          if (page !== null) flat.push({ title: it.title?.trim(), depth, page });
          if (it.items?.length) await walk(it.items, depth + 1);
        }
      };
      await walk(outline, 0);
      chapters = fromOutline(pageTexts, flat, opts);
    }
    if (!chapters) {
      const full = pageTexts.join("\n\n");
      const heads = detectHeadings(full);
      if (heads.length) {
        const { parts, starts } = cutText(full, heads.map((h) => h.offset));
        chapters = chaptersFromToc(parts, heads.map((h) => ({ ...h, seg: starts.indexOf(h.offset) })), opts);
        warnings.push("PDF has no outline/bookmarks; chapters were detected from heading text.");
      } else {
        warnings.push("PDF has no outline and no recognizable chapter headings; splitting by size only.");
        chapters = [{ title: "Full text", path: [], text: full }];
      }
    }

    const title = String(info.Title ?? "").replace(/^Microsoft Word - /, "").replace(/\.(docx?|pdf)$/i, "").trim();
    return {
      title: title || path.basename(file, path.extname(file)),
      author: String(info.Author ?? "").trim() || null,
      format: "pdf",
      pages: doc.numPages,
      chapters,
      warnings,
    };
  } finally {
    await task.destroy();
  }
}

async function destToPage(doc, dest) {
  try {
    if (typeof dest === "string") dest = await doc.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (typeof ref === "number") return ref;
    return await doc.getPageIndex(ref);
  } catch {
    return null;
  }
}

/** Map outline entries to (page, offset) — cutting mid-page where the heading text is found. */
function fromOutline(pageTexts, flat, opts) {
  const cuts = new Map();
  for (const n of flat) {
    const text = pageTexts[n.page] ?? "";
    const words = normKey(n.title ?? "").split(" ").filter(Boolean).slice(0, 8);
    n.offset = 0;
    if (words.length) {
      const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"), "iu");
      const m = re.exec(text);
      if (m) {
        // back up to the start of that line
        n.offset = text.lastIndexOf("\n", m.index) + 1;
      }
    }
    if (!cuts.has(n.page)) cuts.set(n.page, new Set());
    cuts.get(n.page).add(n.offset);
  }
  const segments = [];
  const segAt = new Map();
  pageTexts.forEach((t, p) => {
    const { parts, starts } = cutText(t, [...(cuts.get(p) ?? [])]);
    parts.forEach((part, i) => {
      segAt.set(`${p}:${starts[i]}`, segments.length);
      segments.push(part.trim());
    });
  });
  const nodes = flat.map((n) => ({ title: n.title, depth: n.depth, seg: segAt.get(`${n.page}:${n.offset}`) ?? segAt.get(`${n.page}:0`) }));
  return chaptersFromToc(segments, nodes, opts);
}

/** Group pdf.js text items into visual lines. */
function toLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const [, , , , x, y] = it.transform;
    const h = Math.abs(it.height || it.transform[3]) || 10;
    if (!cur || Math.abs(y - cur.y) > Math.max(2, h * 0.5)) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { text: "", x, y, h, endX: x };
    } else if (it.str && x > cur.endX + h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
      cur.text += " ";
    }
    cur.text += it.str;
    cur.endX = x + (it.width || 0);
    cur.h = Math.max(cur.h, h);
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines;
}

/** Remove page numbers and running headers/footers that repeat across pages. */
function stripRunningHeaders(pages) {
  const key = (l) => normKey(l.text).replace(/\d+/g, "#");
  const edge = (lines) => [...lines.slice(0, 2), ...lines.slice(-2)];
  const counts = new Map();
  for (const lines of pages) {
    for (const k of new Set(edge(lines).map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.3);
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    const edges = new Set(edge(lines));
    pages[p] = lines.filter((l) => {
      if (!edges.has(l)) return true;
      const t = l.text.trim();
      if (/^(page\s+)?(\d+|[ivxlcdm]+)$/i.test(t)) return false;
      return (counts.get(key(l)) ?? 0) < threshold || key(l).length === 0;
    });
  }
}

/** Reflow lines into paragraphs using vertical gaps and first-line indents. */
function toParagraphs(lines) {
  if (!lines.length) return "";
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i - 1].y - lines[i].y;
    if (d > 0) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] ?? 14;
  const minX = Math.min(...lines.map((l) => l.x));

  let out = "";
  lines.forEach((l, i) => {
    const t = l.text.replace(/\s+/g, " ").trim();
    if (i === 0) return void (out = t);
    const prev = lines[i - 1];
    const d = prev.y - l.y;
    const newPara = d > lineGap * 1.4 || d < 0 || l.x > minX + l.h * 1.2 && prev.x <= minX + l.h * 0.5;
    if (newPara) out += "\n\n" + t;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += " " + t;
  });
  return normalizeWhitespace(out);
}
