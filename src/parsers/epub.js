import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import path from "node:path";
import { htmlToText } from "../text.js";
import { chaptersFromToc, cutText } from "../structure.js";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["item", "itemref", "navPoint", "rootfile", "creator", "title"].includes(name),
});

const posix = path.posix;
const textOf = (v) => {
  if (v == null) return null;
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === "object") return textOf(v["#text"]);
  return String(v).trim() || null;
};
const resolveHref = (baseFile, href) => {
  const [p, frag] = href.split("#");
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch {}
  return { file: posix.normalize(posix.join(posix.dirname(baseFile), decoded)).replace(/^\.\//, ""), frag: frag || null };
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function parseEpub(file, opts) {
  const zip = new AdmZip(file);
  const entries = new Map();
  for (const e of zip.getEntries()) {
    let name = e.entryName;
    try { name = decodeURIComponent(name); } catch {}
    entries.set(name.toLowerCase(), e);
  }
  const read = (name) => entries.get(name.toLowerCase())?.getData().toString("utf8") ?? null;
  const warnings = [];

  const encryption = read("META-INF/encryption.xml");
  if (encryption && /URI=["'][^"']+\.x?html?["']/i.test(encryption)) {
    throw new Error("This EPUB is DRM-protected (encrypted content documents). Remove DRM before splitting.");
  }

  const container = xml.parse(read("META-INF/container.xml") ?? "");
  const opfPath = container?.container?.rootfiles?.rootfile?.[0]?.["@_full-path"];
  if (!opfPath) throw new Error("Invalid EPUB: META-INF/container.xml has no rootfile.");
  const opf = xml.parse(read(opfPath) ?? "").package;
  if (!opf) throw new Error(`Invalid EPUB: cannot read ${opfPath}`);

  const meta = opf.metadata ?? {};
  const title = textOf(meta.title);
  const author = (meta.creator ?? []).map(textOf).filter(Boolean).join(", ") || null;

  const manifest = new Map();
  for (const it of opf.manifest?.item ?? []) {
    manifest.set(it["@_id"], {
      ...resolveHref(opfPath, it["@_href"]),
      type: it["@_media-type"],
      props: it["@_properties"] ?? "",
    });
  }

  // ---- reading order -------------------------------------------------------
  const spineFiles = [];
  for (const ref of opf.spine?.itemref ?? []) {
    if (ref["@_linear"] === "no") continue;
    const it = manifest.get(ref["@_idref"]);
    if (it && /html|xml/.test(it.type ?? "") && !spineFiles.includes(it.file)) spineFiles.push(it.file);
  }
  if (!spineFiles.length) throw new Error("EPUB spine is empty.");

  // ---- table of contents ---------------------------------------------------
  let toc = [];
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) toc = readNav(read(navItem.file), navItem.file);
  if (!toc.length) {
    const ncxItem = manifest.get(opf.spine?.["@_toc"]) ??
      [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
    if (ncxItem) toc = readNcx(read(ncxItem.file), ncxItem.file);
  }

  // ---- cut spine files at every TOC fragment target ------------------------
  const fragsByFile = new Map();
  for (const t of toc) {
    if (!t.frag) continue;
    if (!fragsByFile.has(t.file)) fragsByFile.set(t.file, new Set());
    fragsByFile.get(t.file).add(t.frag);
  }

  const segments = [];
  const anchors = new Map(); // "file" or "file#frag" -> segment index
  const fileHeadings = new Map();
  for (const f of spineFiles) {
    const html = read(f);
    if (html == null) { warnings.push(`Missing spine file: ${f}`); continue; }
    const offsets = new Map();
    for (const frag of fragsByFile.get(f) ?? []) {
      const m = new RegExp(`\\s(?:xml:)?id\\s*=\\s*["']${escapeRe(frag)}["']`).exec(html);
      if (m) offsets.set(frag, html.lastIndexOf("<", m.index));
    }
    const { parts, starts } = cutText(html, [...offsets.values()]);
    const base = segments.length;
    anchors.set(f, base);
    parts.forEach((p) => segments.push(htmlToText(p)));
    for (const [frag, off] of offsets) {
      const i = starts.indexOf(off);
      anchors.set(`${f}#${frag}`, base + (i === -1 ? 0 : i));
    }
    if (!toc.length) {
      const h = parseHtml(html).querySelector("h1, h2, h3, title");
      fileHeadings.set(f, h?.text.replace(/\s+/g, " ").trim());
    }
  }

  let nodes = toc
    .map((t) => ({ title: t.title, depth: t.depth, seg: anchors.get(t.frag ? `${t.file}#${t.frag}` : t.file) ?? anchors.get(t.file) }))
    .filter((n) => n.seg !== undefined);

  if (!nodes.length) {
    warnings.push("No usable table of contents; using one section per spine file.");
    nodes = spineFiles
      .filter((f) => anchors.has(f))
      .map((f, i) => ({ title: fileHeadings.get(f) || `Section ${i + 1}`, depth: 0, seg: anchors.get(f) }));
  }

  return {
    title: title ?? path.basename(file, path.extname(file)),
    author,
    format: "epub",
    chapters: chaptersFromToc(segments, nodes, opts),
    warnings,
  };
}

function readNav(html, navFile) {
  if (!html) return [];
  const root = parseHtml(html, { lowerCaseTagName: true });
  const navs = root.querySelectorAll("nav");
  const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute("epub:type") ?? n.getAttribute("role") ?? "")) ?? navs[0];
  const ol = nav?.querySelector("ol");
  if (!ol) return [];
  const out = [];
  const walk = (list, depth) => {
    for (const li of list.childNodes.filter((c) => c.rawTagName?.toLowerCase() === "li")) {
      const kids = li.childNodes.filter((c) => c.nodeType === 1);
      const a = kids.find((c) => c.rawTagName.toLowerCase() === "a");
      const href = a?.getAttribute("href");
      const linked = href && !/^[a-z]+:/i.test(href);
      if (linked) out.push({ title: a.text.replace(/\s+/g, " ").trim(), depth, ...resolveHref(navFile, href) });
      const sub = kids.find((c) => c.rawTagName.toLowerCase() === "ol");
      // label-only entries (<span>Author</span><ol>…) don't add a nesting level
      if (sub) walk(sub, linked ? depth + 1 : depth);
    }
  };
  walk(ol, 0);
  return out;
}

function readNcx(src, ncxFile) {
  if (!src) return [];
  const map = xml.parse(src)?.ncx?.navMap;
  const out = [];
  const walk = (points, depth) => {
    for (const p of points ?? []) {
      const href = p.content?.["@_src"];
      if (href) out.push({ title: textOf(p.navLabel?.text), depth, ...resolveHref(ncxFile, href) });
      walk(p.navPoint, depth + 1);
    }
  };
  walk(map?.navPoint, 0);
  return out;
}
