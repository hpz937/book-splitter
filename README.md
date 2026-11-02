# book-splitter-mcp

An MCP server that turns an ebook into chapter-sized chunks so a model can summarize them **in parallel**
(map step), then combine the results (reduce step). The server does no LLM calls itself — it only parses,
splits and serves text. The summarizing is left to whatever model you connect it to.

**Formats:** EPUB, PDF, TXT (incl. Project Gutenberg), Markdown natively; MOBI / AZW / AZW3 / FB2 / DOCX /
RTF / ODT / HTML via Calibre's `ebook-convert` if it's installed.

## Install

```bash
npm install
npm test                      # end-to-end test over MCP stdio
node src/cli.js path/to/book.epub   # preview how a book will be split
```

Requires Node 18+.

### Claude Code

```bash
claude mcp add book-splitter -- node /absolute/path/to/book-splitter/src/index.js
```

### Claude Desktop / any MCP client (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "book-splitter": {
      "command": "node",
      "args": ["/absolute/path/to/book-splitter/src/index.js"],
      "env": { "BOOK_SPLITTER_ROOTS": "/Users/me/Books" }
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `find_books(query?, directory?)` | List ebook files in your book folder(s) (`BOOK_SPLITTER_ROOTS`), searched recursively. `query` filters by words in the path. Already-loaded files show their `book_id`. |
| `load_book(path, max_tokens?, min_tokens?, include_matter?)` | Parse and split. `path` can be absolute or relative to the book folder (e.g. `Herbert/Dune.epub`). Returns `book_id`, metadata and the chunk list `[{index, title, within, chapter, part, tokens}]`. |
| `get_chapter(book_id, index)` | Full text of one chunk, with a header giving its position in the book (chapter n of m, part x of y, parent section). |
| `get_overview(book_id, opening_tokens?)` | Contents list + the book's opening. Use it to write a short "book brief" that every parallel summarizer gets as context. |
| `list_books()` | Books already loaded with `load_book` (persisted in the cache, so ids survive restarts). Not a directory listing — use `find_books` for that. |

There's also an MCP **prompt**, `summarize_book(path, focus?)`, which contains the full map-reduce instructions,
so clients that support prompts can start a summary in one step.

## How splitting works

1. **Structure first.** EPUB: spine order + `nav.xhtml` / `toc.ncx`, cutting inside files when TOC entries point
   at `#fragments`. PDF: the outline (bookmarks), cutting mid-page where the heading text is found. Text/PDF with no
   outline: heading heuristics (`CHAPTER IV`, `Part Two`, `Prologue`, Markdown `#`), ignoring printed contents lists.
2. **Nested TOCs.** A "Part" whose children are chapter-sized is treated as a container; its chapters become
   chunks. A small story with little subsections stays whole. An oversized chapter is split at its own
   subsections first.
3. **Cleanup.**
   - Copyright, contents, acknowledgments, "Also by", index and similar sections are skipped (they're listed under
     `skipped_sections`; pass `include_matter: true` to keep them).
   - Sections under `min_tokens` (default 400) are merged into the next chapter.
   - Chapters over `max_tokens` (default 12000) are split into roughly equal parts at paragraph boundaries. The parts
     share a `chapter` number.
4. **PDF text cleanup.** Running headers, footers and page numbers are removed, lines are reflowed into
   paragraphs, and words hyphenated across a line break are rejoined.
5. **Caching.** Results are cached by file hash and options in `~/.cache/book-splitter`, so reloading is instant.

Token counts are estimates (characters ÷ 4).

## Configuration (env vars)

| Variable | Default | |
|---|---|---|
| `BOOK_SPLITTER_ROOTS` | *(unset = any path)* | Colon-separated (`;` on Windows) list of directories the server may read from. Recommended. |
| `BOOK_SPLITTER_CACHE` | `~/.cache/book-splitter` | Cache directory. |
| `BOOK_SPLITTER_MAX_TOKENS` | `12000` | Default max chunk size. |
| `BOOK_SPLITTER_MIN_TOKENS` | `400` | Default merge threshold. |
| `EBOOK_CONVERT` | `ebook-convert` | Path to Calibre's converter. |

## Example plain-text prompt for the summarizing model

```
Summarize Dune.

1. Call find_books with query "dune" and pick the matching file, then call load_book with its path.
2. Call get_overview and write a short book brief (genre, premise, main characters or core ideas).
3. For every chunk index, call get_chapter and summarize it in 150–300 words, using the brief for
   context. The chunks are independent, so process them in parallel. Chunks with the same `chapter`
   number are parts of one chapter.
4. Merge the chapter summaries into: a one-paragraph overview, a section per chapter, and the key
   themes. Make names and plot threads consistent across chapters.
```

If your orchestrator runs sub-agents (Claude Code, the Agent SDK, or your own `Promise.all` over API calls),
give each one the brief plus a single `book_id` and `index`. The chunk sizes are chosen so that each one fits
comfortably in a single summarization call.

## Limitations

- Scanned PDFs have no text layer. Run OCR first (for example `ocrmypdf`); the server warns you when it detects one.
- DRM-protected EPUBs are rejected.
- Chapter detection in plain text is heuristic. Use the CLI to check the result, and change `min_tokens` /
  `max_tokens` if needed.
