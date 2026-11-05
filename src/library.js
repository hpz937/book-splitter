import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE, VIA_CALIBRE, parseBook } from "./parsers/index.js";
import { finalizeChunks } from "./chunker.js";
import { finalizePages, propagatePages } from "./pages.js";
import { estimateTokens } from "./text.js";

const PARSER_VERSION = 2;

export const DEFAULTS = {
  maxTokens: Number(process.env.BOOK_SPLITTER_MAX_TOKENS) || 12000,
  minTokens: Number(process.env.BOOK_SPLITTER_MIN_TOKENS) || 400,
  includeMatter: false,
};

const cacheDir = process.env.BOOK_SPLITTER_CACHE || path.join(os.homedir(), ".cache", "book-splitter");
const roots = (process.env.BOOK_SPLITTER_ROOTS || "").split(path.delimiter).filter(Boolean);
const memory = new Map();

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

async function resolveRoots() {
  return (await Promise.all(roots.map((r) => realpath(path.resolve(expandHome(r))).catch(() => null)))).filter(Boolean);
}

async function resolveAllowed(p, { directory = false } = {}) {
  p = expandHome(p.trim().replace(/^["']|["']$/g, ""));
  const allowed = await resolveRoots();
  // Relative paths / bare filenames are looked up inside the configured roots
  const candidates = path.isAbsolute(p) ? [p] : [...allowed.map((r) => path.join(r, p)), path.resolve(p)];
  let abs = null;
  for (const c of candidates) {
    abs = await realpath(c).catch(() => null);
    if (abs) break;
  }
  if (!abs) throw new Error(`Not found: ${p}${directory ? "" : ". Use find_books to see available files."}`);
  if (roots.length) {
    const inside = (root) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    if (!allowed.some(inside)) throw new Error(`Access denied: ${p} is outside BOOK_SPLITTER_ROOTS.`);
  }
  const st = await stat(abs);
  if (directory ? !st.isDirectory() : !st.isFile()) throw new Error(`Not a ${directory ? "directory" : "file"}: ${p}`);
  return abs;
}

/** Recursively list supported ebook files under the given directory (or the configured roots). */
export async function findBooks({ directory, query, limit = 200 } = {}) {
  const dirs = directory ? [await resolveAllowed(directory, { directory: true })] : await resolveRoots();
  if (!dirs.length) {
    throw new Error("No directory given and BOOK_SPLITTER_ROOTS is not set. Pass `directory`, or set BOOK_SPLITTER_ROOTS in the server config.");
  }
  const exts = new Set([...Object.keys(NATIVE), ...VIA_CALIBRE]);
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const loaded = new Map((await listBooks()).map((b) => [b.source?.toLowerCase(), b.book_id]));
  const results = [];
  let truncated = false;
  const walk = async (dir, depth) => {
    if (depth > 8 || truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
        const hay = full.toLowerCase();
        if (words.length && !words.every((w) => hay.includes(w))) continue;
        if (results.length >= limit) { truncated = true; return; }
        const { size } = await stat(full);
        const id = loaded.get(full.toLowerCase());
        results.push({
          path: full,
          name: e.name,
          format: path.extname(e.name).slice(1).toLowerCase(),
          size_mb: Math.round((size / 1048576) * 10) / 10,
          ...(id ? { book_id: id } : {}),
        });
      }
    }
  };
  for (const d of dirs) await walk(d, 0);
  return { searched: dirs, count: results.length, truncated, files: results };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/** Parse and chunk a book (cached on disk by content hash + options). */
export async function loadBook(inputPath, options = {}) {
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  if (opts.minTokens >= opts.maxTokens) throw new Error("min_tokens must be smaller than max_tokens.");
  const file = await resolveAllowed(inputPath);
  const hash = await hashFile(file);
  const id = hash.slice(0, 12);
  const key = `${id}-v${PARSER_VERSION}-${opts.minTokens}-${opts.maxTokens}-${opts.includeMatter ? 1 : 0}`;
  const booksDir = path.join(cacheDir, "books");
  const cacheFile = path.join(booksDir, `${key}.json`);

  let book = await readFile(cacheFile, "utf8").then(JSON.parse).catch(() => null);
  if (!book) {
    const parsed = await parseBook(file, opts, { workDir: cacheDir, hash });
    const printPages = propagatePages(parsed.chapters); // before matter is skipped, so numbering stays intact
    const { chunks, skipped, chapterCount } = finalizeChunks(parsed.chapters, opts);
    if (!chunks.length) throw new Error("No text could be extracted from this book.");
    finalizePages(chunks, estimateTokens);
    book = {
      id,
      title: parsed.title,
      author: parsed.author,
      format: parsed.format,
      pages: parsed.pages,
      source: file,
      options: opts,
      totalTokens: chunks.reduce((n, c) => n + c.tokens, 0),
      words: chunks.reduce((n, c) => n + c.words, 0),
      // real pagination: PDF page count, or the print edition's page list embedded in an EPUB
      pagination: parsed.format === "pdf"
        ? { count: parsed.pages, source: "pdf" }
        : printPages ? { count: printPages.count, source: "print edition (page list in file)" } : null,
      chapterCount,
      chunks,
      skipped,
      warnings: parsed.warnings ?? [],
    };
    await mkdir(booksDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(book));
  }
  if (book.source !== file) {
    // same content found at a new path (file was moved/renamed) — remember where it lives now
    book.source = file;
    await writeFile(cacheFile, JSON.stringify(book)).catch(() => {});
  }
  memory.set(id, book);
  // remember the most recent option set so the id stays usable after a restart
  await mkdir(booksDir, { recursive: true });
  await writeFile(path.join(booksDir, `${id}.latest`), key).catch(() => {});
  return book;
}

export async function getBook(id) {
  if (memory.has(id)) return memory.get(id);
  const booksDir = path.join(cacheDir, "books");
  const key = await readFile(path.join(booksDir, `${id}.latest`), "utf8").catch(() => null);
  const book = key && (await readFile(path.join(booksDir, `${key}.json`), "utf8").then(JSON.parse).catch(() => null));
  if (!book) throw new Error(`Unknown book_id "${id}". Call load_book first.`);
  memory.set(id, book);
  return book;
}

const exists = (p) => access(p).then(() => true, () => false);

export async function listBooks() {
  const booksDir = path.join(cacheDir, "books");
  const files = (await readdir(booksDir).catch(() => [])).filter((f) => f.endsWith(".latest"));
  const out = [];
  for (const f of files) {
    try {
      const b = await getBook(f.replace(/\.latest$/, ""));
      out.push({
        book_id: b.id, title: b.title, author: b.author, chunks: b.chunks.length, source: b.source,
        ...((await exists(b.source)) ? {} : { missing: true }),
      });
    } catch {}
  }
  return out;
}

/**
 * Delete cached books.
 * @param {{bookId?: string, all?: boolean}} opts  default: only books whose source file no longer exists
 */
export async function removeBooks({ bookId, all = false } = {}) {
  const booksDir = path.join(cacheDir, "books");
  const convertedDir = path.join(cacheDir, "converted");
  const books = await listBooks();
  let targets;
  if (bookId) {
    targets = books.filter((b) => b.book_id === bookId);
    if (!targets.length) throw new Error(`Unknown book_id "${bookId}".`);
  } else {
    targets = all ? books : books.filter((b) => b.missing);
  }
  const ids = new Set(targets.map((t) => t.book_id));
  // every option variant (<id>-v1-400-12000-0.json), the .latest pointer, and Calibre conversions (<fullhash>.epub)
  for (const [dir, match] of [[booksDir, (f) => ids.has(f.slice(0, 12))],
                              [convertedDir, (f) => ids.has(f.slice(0, 12))]]) {
    for (const f of await readdir(dir).catch(() => [])) {
      if (match(f)) await rm(path.join(dir, f), { force: true });
    }
  }
  for (const id of ids) memory.delete(id);
  return {
    removed: targets.map(({ book_id, title, source }) => ({ book_id, title, source })),
    remaining: books.length - targets.length,
  };
}
