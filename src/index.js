#!/usr/bin/env node
import "./stdio-guard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULTS, findBooks, getBook, listBooks, loadBook } from "./library.js";

const server = new McpServer({ name: "book-splitter", version: "0.1.0" });

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

function chunkList(book) {
  return book.chunks.map((c) => ({
    index: c.index,
    title: c.title,
    ...(c.path?.length ? { within: c.path.join(" › ") } : {}),
    chapter: c.chapter,
    ...(c.parts > 1 ? { part: `${c.part}/${c.parts}` } : {}),
    tokens: c.tokens,
  }));
}

function bookSummary(book) {
  return {
    book_id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    ...(book.pages ? { pages: book.pages } : {}),
    total_tokens: book.totalTokens,
    chapter_count: book.chapterCount,
    chunk_count: book.chunks.length,
    chunks: chunkList(book),
    ...(book.skipped.length ? { skipped_sections: book.skipped.map((s) => s.title) } : {}),
    ...(book.warnings.length ? { warnings: book.warnings } : {}),
  };
}

server.registerTool("load_book", {
  title: "Load book",
  description:
    "Parse an ebook (EPUB, PDF, TXT, Markdown; MOBI/AZW3/FB2/DOCX if Calibre is installed) and split it into " +
    "chapter-sized chunks. Returns a book_id and the chunk list. Chunks are self-contained and can be fetched " +
    "and summarized independently / in parallel with get_chapter. Oversized chapters are split into parts " +
    "(same `chapter` number, `part` n/m); tiny sections are merged into the next chapter; front/back matter " +
    "(copyright, contents, acknowledgments…) is skipped unless include_matter is true. Results are cached.",
  inputSchema: {
    path: z.string().describe("Path to the ebook: absolute, or relative to the book folder (as returned by find_books)"),
    max_tokens: z.number().int().min(1000).max(200000).optional()
      .describe(`Max approx tokens per chunk (default ${DEFAULTS.maxTokens})`),
    min_tokens: z.number().int().min(0).max(20000).optional()
      .describe(`Sections smaller than this are merged forward (default ${DEFAULTS.minTokens})`),
    include_matter: z.boolean().optional().describe("Keep front/back matter such as copyright, contents, index"),
  },
  annotations: readOnly,
}, async ({ path, max_tokens, min_tokens, include_matter }) => {
  try {
    const book = await loadBook(path, { maxTokens: max_tokens, minTokens: min_tokens, includeMatter: include_matter });
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
      `Approx. ${c.tokens.toLocaleString("en-US")} tokens`,
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
  description: "List books that have already been loaded with load_book (including cached ones from earlier sessions). To see files on disk, use find_books.",
  inputSchema: {},
  annotations: readOnly,
}, async () => {
  try {
    return ok(json(await listBooks()));
  } catch (err) {
    return fail(err);
  }
});

server.registerPrompt("summarize_book", {
  title: "Summarize a book",
  description: "Map-reduce summary of an ebook using the book-splitter tools",
  argsSchema: {
    path: z.string().describe("Path to the ebook, or a file name inside the book folder"),
    focus: z.string().optional().describe("Optional focus or style, e.g. 'key arguments' or 'plot and characters'"),
  },
}, ({ path, focus }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: `Summarize the book at ${path}.${focus ? ` Focus: ${focus}.` : ""}

1. Call load_book with that path (if it isn't found, use find_books to locate the file). Note the book_id and chunk list.
2. Call get_overview and write a 5–10 line "book brief": genre, premise, main characters or core concepts.
3. For every chunk index, call get_chapter and summarize it in 150–300 words, using the brief for context.
   Chunks are independent — process them in parallel if you can. Chunks sharing a chapter number are parts of
   one chapter; treat them together.
4. Combine the chapter summaries into a final summary: a one-paragraph overview, then a section per chapter
   (or per part of the book), then key themes/takeaways. Resolve names and threads across chapters.`,
    },
  }],
}));

await server.connect(new StdioServerTransport());
console.error("book-splitter MCP server running on stdio");
