// Tool/prompt definitions, shared by the stdio and HTTP entry points.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompts } from "./prompts.js";
import { DEFAULTS, findBooks, getBook, listBooks, loadBook, removeBooks } from "./library.js";
import { DEFAULT_WORDS_PER_PAGE, bookPages, chunkPageRanges } from "./pages.js";


const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: `Error: ${err.message ?? err}` }] });
// Pretty JSON, but keep each item of large arrays on one line to save tokens
const json = (obj) => {
  if (Array.isArray(obj)) return "[\n" + obj.map((o) => " " + JSON.stringify(o)).join(",\n") + "\n]";
  const isRows = (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object";
  const rest = Object.fromEntries(Object.entries(obj).filter(([, v]) => !isRows(v)));
  const rows = Object.entries(obj).filter(([, v]) => isRows(v));
  let out = JSON.stringify(rest, null, 1);
  for (const [k, v] of rows) out = out.replace(/\n?}$/, `,\n ${JSON.stringify(k)}: ${json(v).replace(/\n/g, "\n ")}\n}`);
  return out.replace("{,", "{");
};
const readOnly = { readOnlyHint: true, openWorldHint: false };

const wpp = (book) => book.wordsPerPage ?? DEFAULT_WORDS_PER_PAGE;

function chunkList(book) {
  const ranges = chunkPageRanges(book, wpp(book));
  return book.chunks.map((c, i) => ({
    index: c.index,
    title: c.title,
    ...(c.path?.length ? { within: c.path.join(" › ") } : {}),
    chapter: c.chapter,
    ...(c.parts > 1 ? { part: `${c.part}/${c.parts}` } : {}),
    words: c.words,
    pages: ranges[i],
    tokens: c.tokens,
  }));
}

function bookSummary(book) {
  return {
    book_id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    words: book.words,
    pages: bookPages(book, wpp(book)),
    total_tokens: book.totalTokens,
    chapter_count: book.chapterCount,
    chunk_count: book.chunks.length,
    chunks: chunkList(book),
    ...(book.skipped.length ? { skipped_sections: book.skipped.map((s) => s.title) } : {}),
    ...(book.warnings.length ? { warnings: book.warnings } : {}),
  };
}

/** Build a fresh MCP server with all book-splitter tools registered. */
export function createServer() {
  const server = new McpServer({ name: "book-splitter", version: "0.3.0" });

  server.registerTool("load_book", {
    title: "Load book",
    description:
      "Parse an ebook (EPUB, PDF, TXT, Markdown; MOBI/AZW3/FB2/DOCX if Calibre is installed) and split it into " +
      "chapter-sized chunks. Returns a book_id and the chunk list. Chunks are self-contained and can be fetched " +
      "and summarized independently / in parallel with get_chapter. Oversized chapters are split into parts " +
      "(same `chapter` number, `part` n/m); tiny sections are merged into the next chapter; front/back matter " +
      "(copyright, contents, acknowledgments…) is skipped unless include_matter is true. Also reports word count " +
      "and page count — the real print/PDF pages when the file has them, otherwise an estimate from word count " +
      "(chunk page ranges prefixed with ~ are estimates). Results are cached.",
    inputSchema: {
      path: z.string().describe("Path to the ebook: absolute, or relative to the book folder (as returned by find_books)"),
      max_tokens: z.number().int().min(1000).max(200000).optional()
        .describe(`Max approx tokens per chunk (default ${DEFAULTS.maxTokens})`),
      min_tokens: z.number().int().min(0).max(20000).optional()
        .describe(`Sections smaller than this are merged forward (default ${DEFAULTS.minTokens})`),
      include_matter: z.boolean().optional().describe("Keep front/back matter such as copyright, contents, index"),
      words_per_page: z.number().int().min(100).max(1000).optional()
        .describe(`Words per page for page estimates when the file has no real page numbers (default ${DEFAULT_WORDS_PER_PAGE}; ~250 hardcover, ~350 mass-market paperback)`),
    },
    annotations: readOnly,
  }, async ({ path, max_tokens, min_tokens, include_matter, words_per_page }) => {
    try {
      const book = await loadBook(path, { maxTokens: max_tokens, minTokens: min_tokens, includeMatter: include_matter });
      if (words_per_page) book.wordsPerPage = words_per_page;
      return ok(json(bookSummary(book)) +
        `\n\nNext: call get_chapter(book_id="${book.id}", index=N) for each index 0..${book.chunks.length - 1}. ` +
        "Use get_overview first if you want a short context brief (TOC + opening) to share with parallel summarizers.");
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool("get_chapter", {
    title: "Get chapter",
    description: "Return the full text of one chunk of a loaded book, with a header giving its position in the book.",
    inputSchema: {
      book_id: z.string().describe("book_id returned by load_book"),
      index: z.number().int().min(0).describe("Chunk index from load_book's chunk list"),
    },
    annotations: readOnly,
  }, async ({ book_id, index }) => {
    try {
      const book = await getBook(book_id);
      const c = book.chunks[index];
      if (!c) throw new Error(`index ${index} out of range (0..${book.chunks.length - 1})`);
      const header = [
        `Book: ${book.title}${book.author ? ` — ${book.author}` : ""}`,
        `Chunk ${c.index + 1} of ${book.chunks.length} · Chapter ${c.chapter + 1} of ${book.chapterCount}: ${c.title}` +
          (c.parts > 1 ? ` (part ${c.part} of ${c.parts})` : ""),
        c.path?.length ? `Located in: ${c.path.join(" › ")}` : null,
        c.sections ? `Includes sections: ${c.sections.join("; ")}` : null,
        `Pages: ${chunkPageRanges(book, wpp(book))[index]}${c.printPages ? "" : " (estimated)"} · ` +
          `${(c.words ?? 0).toLocaleString("en-US")} words · approx. ${c.tokens.toLocaleString("en-US")} tokens`,
      ].filter(Boolean).join("\n");
      return ok(`${header}\n\n---\n\n${c.text}`);
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool("get_overview", {
    title: "Get book overview",
    description:
      "Return the table of contents plus the opening of the book. Useful for writing a short 'book brief' " +
      "(premise, main characters/concepts) to include in every parallel chapter-summary prompt, so each " +
      "summarizer has context it would otherwise lack.",
    inputSchema: {
      book_id: z.string(),
      opening_tokens: z.number().int().min(0).max(20000).optional().describe("How much opening text to include (default 3000)"),
    },
    annotations: readOnly,
  }, async ({ book_id, opening_tokens = 3000 }) => {
    try {
      const book = await getBook(book_id);
      const toc = book.chunks
        .filter((c) => c.part === 1)
        .map((c) => `${c.chapter + 1}. ${c.path?.length ? c.path.join(" › ") + " › " : ""}${c.title}` +
          (c.parts > 1 ? ` [${c.parts} parts]` : ""))
        .join("\n");
      let opening = "";
      for (const c of book.chunks) {
        if (opening.length >= opening_tokens * 4) break;
        opening += (opening ? "\n\n" : "") + c.text;
      }
      opening = opening.slice(0, opening_tokens * 4);
      return ok(
        `Book: ${book.title}${book.author ? ` — ${book.author}` : ""}\n` +
        `~${book.totalTokens.toLocaleString("en-US")} tokens · ${book.chapterCount} chapters · ${book.chunks.length} chunks\n\n` +
        `## Contents\n${toc}\n\n## Opening (~${opening_tokens} tokens)\n${opening}${opening_tokens ? "…" : ""}`,
      );
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool("find_books", {
    title: "Find book files",
    description:
      "List ebook files available to load: searches the configured book folder(s) recursively (or a given " +
      "directory) for supported formats. Optional `query` filters by words in the file path, e.g. 'dune herbert'. " +
      "Files that were already loaded include their book_id. Pass a result's `path` to load_book.",
    inputSchema: {
      query: z.string().optional().describe("Words that must all appear in the file path (case-insensitive)"),
      directory: z.string().optional().describe("Directory to search instead of the configured book folder(s)"),
      limit: z.number().int().min(1).max(2000).optional().describe("Max results (default 200)"),
    },
    annotations: readOnly,
  }, async ({ query, directory, limit }) => {
    try {
      return ok(json(await findBooks({ query, directory, limit })));
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool("list_books", {
    title: "List books",
    description: "List books that have already been loaded with load_book (cached, so they persist across sessions). " +
      "Books whose source file has been moved or deleted are flagged `missing: true` — their chunks are still readable " +
      "from the cache. To see files on disk, use find_books; to clean up, use remove_books.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    try {
      return ok(json(await listBooks()));
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool("remove_books", {
    title: "Remove cached books",
    description:
      "Delete books from the cache. With no arguments, removes only books whose source file no longer exists. " +
      "Pass book_id to remove one specific book, or all=true to clear the whole cache. Source ebook files are never " +
      "touched — a removed book can simply be loaded again.",
    inputSchema: {
      book_id: z.string().optional().describe("Remove just this book"),
      all: z.boolean().optional().describe("Remove every cached book"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ book_id, all }) => {
    try {
      return ok(json(await removeBooks({ bookId: book_id, all })));
    } catch (err) {
      return fail(err);
    }
  });

  registerPrompts(server);

  return server;
}
