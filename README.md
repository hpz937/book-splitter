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

### LibreChat and other HTTP clients (Streamable HTTP / SSE)

Clients that can't start a local process connect over HTTP instead. Run the server in HTTP mode:

```bash
node src/index.js --http                 # or: npm run start:http
```

| Endpoint | Transport |
|---|---|
| `POST /mcp` | Streamable HTTP, the current MCP transport. Use this one. |
| `GET /sse` + `POST /messages` | Legacy HTTP+SSE, for older clients |
| `GET /health` | Health check, no auth required |

By default the server listens on `127.0.0.1:8787` (`--port` / `--host`, or `MCP_PORT` / `MCP_HOST`).

**Windows + LibreChat in Docker Desktop.** This is the common setup: the server runs on your PC and
LibreChat's container reaches it at `host.docker.internal`.

1. Generate a token: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
2. Start the server (PowerShell):
   ```powershell
   $env:BOOK_SPLITTER_ROOTS = "C:\Users\YourName\Books"
   $env:MCP_AUTH_TOKEN = "<token>"
   node C:\path\to\book-splitter\src\index.js --http --host 0.0.0.0
   ```
   `0.0.0.0` lets the container reach the server. If Windows Firewall asks, allow **Private networks** only.
3. In LibreChat's `.env`, add `BOOK_SPLITTER_TOKEN=<token>`. In `librechat.yaml`:
   ```yaml
   mcpSettings:
     allowedAddresses:
       - 'host.docker.internal:8787'   # LibreChat blocks private/local addresses unless listed

   mcpServers:
     book-splitter:
       type: streamable-http
       url: http://host.docker.internal:8787/mcp
       headers:
         Authorization: 'Bearer ${BOOK_SPLITTER_TOKEN}'
       timeout: 120000                 # first load of a large PDF can take a while
   ```
   For the legacy transport, use `type: sse` and `url: http://host.docker.internal:8787/sse` instead.
4. Restart LibreChat.

Paths are resolved on the machine running book-splitter, not inside LibreChat's container, so Windows paths
and `find_books` work as usual.

**Security in HTTP mode:**
- `MCP_AUTH_TOKEN`: when set, every request must send `Authorization: Bearer <token>` (or `X-API-Key: <token>`).
  Always set it when listening on anything other than `127.0.0.1`; the server prints a warning if you don't.
- Requests are checked for DNS rebinding: when bound to loopback, only `localhost`, `127.0.0.1`,
  `host.docker.internal` and the names listed in `MCP_ALLOWED_HOSTS` (comma-separated) are accepted.
- HTTPS: set `MCP_TLS_CERT` and `MCP_TLS_KEY` to PEM files, or put the server behind a reverse proxy (Caddy, nginx)
  for a public hostname. In that case, raise the proxy's timeouts for long tool calls.
- Streamable HTTP is stateless: each request gets a fresh MCP session, and book state lives in the shared cache.
  Parallel `get_chapter` calls are therefore safe, and a server restart doesn't break a summary in progress.

### Docker / Docker Compose

This runs the HTTP server in a container. It needs no Node install on the host and restarts automatically.

```bash
cp .env.example .env        # set BOOKS_DIR and MCP_AUTH_TOKEN
docker compose up -d --build
docker compose logs -f      # shows the listening URLs
```

- **Books:** `BOOKS_DIR` is mounted **read-only** at `/books` inside the container. On Windows, use forward
  slashes: `BOOKS_DIR=C:/Users/YourName/Books`. Tools see paths like `/books/Herbert/Dune.epub`; `find_books`
  lists them, and relative paths (`Herbert/Dune.epub`) work too.
- **Cache:** stored in the `book-cache` named volume, so it survives rebuilds. Clear it with `docker compose down -v`.
- **Port:** published on `127.0.0.1:8787` only. Change `HOST_PORT` to use a different port, or edit `ports:` to
  expose it on your LAN.
- **MOBI / AZW3 / FB2 / DOCX:** set `INSTALL_CALIBRE=true` in `.env` and rebuild. This adds about 500 MB.
- **Runs as** the unprivileged `node` user, with a healthcheck on `/health`.

**Connecting LibreChat to the container:**

- **LibreChat in its own Docker stack (recommended):** join the two stacks on one network. Uncomment the
  `networks:` blocks in `docker-compose.yml`, and check the network name with `docker network ls` (it's usually
  `librechat_default`). Then, in `librechat.yaml`:
  ```yaml
  mcpSettings:
    allowedAddresses:
      - 'book-splitter:8787'
  mcpServers:
    book-splitter:
      type: streamable-http
      url: http://book-splitter:8787/mcp
      headers:
        Authorization: 'Bearer ${BOOK_SPLITTER_TOKEN}'
      timeout: 120000
  ```
- **Without sharing a network:** use `url: http://host.docker.internal:8787/mcp` and
  `allowedAddresses: ['host.docker.internal:8787']`. This goes through the published port.

## Tools

| Tool | Purpose |
|---|---|
| `find_books(query?, directory?)` | List ebook files in your book folder(s) (`BOOK_SPLITTER_ROOTS`), searched recursively. `query` filters by words in the path. Already-loaded files show their `book_id`. |
| `load_book(path, max_tokens?, min_tokens?, include_matter?, words_per_page?)` | Parse and split. `path` can be absolute or relative to the book folder (e.g. `Herbert/Dune.epub`). Returns `book_id`, metadata, `words`, `pages`, and the chunk list `[{index, title, within, chapter, part, words, pages, tokens}]`. |
| `get_chapter(book_id, index)` | Full text of one chunk, with a header giving its position in the book (chapter n of m, part x of y, parent section). |
| `get_overview(book_id, opening_tokens?)` | Contents list + the book's opening. Use it to write a short "book brief" that every parallel summarizer gets as context. |
| `list_books()` | Books already loaded with `load_book` (cached, so ids survive restarts). Books whose file was moved or deleted are flagged `"missing": true`. Not a directory listing — use `find_books` for that. |
| `remove_books(book_id?, all?)` | Clean up the cache. No arguments = remove only missing books; `book_id` = one book; `all: true` = everything. Never touches your ebook files. |

There are also four built-in MCP **prompts** (`summarize_book`, `character_guide`, `book_synopsis`, `book_blurb`); see [Prompts](#prompts). They contain the full map-reduce instructions,
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

## Word and page counts

`load_book` reports the book's word count and page count, and gives each chunk a page range. Summaries can use
the ranges for references like "Chapter 3 (pp. 45–67)".

- **Real pages are used when the file has them:**
  - **PDF:** the PDF's page count. Chunk ranges use the printed page labels if the PDF defines them
    (e.g. `xii`, `45`); otherwise they use physical page numbers.
  - **EPUB with print page numbers:** many publisher EPUBs embed the print edition's pagination (a `page-list`
    and/or `epub:type="pagebreak"` markers). The count is the highest page number, so roman-numeral front matter
    isn't counted. A chunk that starts partway through a page gets that page as its start.
- **Otherwise pages are estimated from word count**, at 300 words per page by default, and reported with a
  range (250–350 words per page) because print layouts vary. Estimated chunk ranges start with `~`
  (`~pp. 45–67`). Change the rate per call with `words_per_page`, or set the default with
  `BOOK_SPLITTER_WORDS_PER_PAGE`. Use about 250 for hardcovers and about 350 for mass-market paperbacks.
  Estimates are usually within 10–20% of a print edition, but less reliable for books with heavy dialogue,
  poetry or many images.

```json
"words": 213757,
"pages": { "estimate": 713, "range": "609–858", "words_per_page": 300, "source": "estimate from word count" }
```

Word counts cover the chunks that are kept, so skipped front and back matter isn't included.

## The cache

Loaded books are cached by **file content**, not by path. This means:

- **Moved or renamed file:** loading it from the new location reuses the cache, and the stored path is updated.
- **Deleted file:** the book stays in the cache. `list_books` marks it `missing`, but `get_chapter` still works,
  because the text is stored in the cache. Ask the model to "clean up missing books" (`remove_books` with no
  arguments) to drop it.
- **Edited file:** the content hash changes, so it's treated as a new book with a new `book_id`. The old entry
  becomes `missing` and is cleared by the same cleanup.

To clear the cache by hand, delete the cache folder (`%USERPROFILE%\.cache\book-splitter` on Windows,
`~/.cache/book-splitter` elsewhere, or wherever `BOOK_SPLITTER_CACHE` points). Each loaded book takes up
roughly the size of its plain text, typically 0.5–2 MB.

## Configuration (env vars)

| Variable | Default | |
|---|---|---|
| `BOOK_SPLITTER_ROOTS` | *(unset = any path)* | Colon-separated (`;` on Windows) list of directories the server may read from. Recommended. |
| `BOOK_SPLITTER_CACHE` | `~/.cache/book-splitter` | Cache directory. |
| `BOOK_SPLITTER_MAX_TOKENS` | `12000` | Default max chunk size. |
| `BOOK_SPLITTER_MIN_TOKENS` | `400` | Default merge threshold. |
| `BOOK_SPLITTER_WORDS_PER_PAGE` | `300` | Words per page for page estimates. |
| `MCP_TRANSPORT` | `stdio` | `http` is the same as `--http`. |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `8787` | HTTP listen address. |
| `MCP_AUTH_TOKEN` | *(unset)* | Bearer token required in HTTP mode. |
| `MCP_ALLOWED_HOSTS` | *(unset)* | Extra `Host` header names accepted when bound to loopback. |
| `MCP_TLS_CERT` / `MCP_TLS_KEY` | *(unset)* | PEM files; serve HTTPS instead of HTTP. |
| `EBOOK_CONVERT` | `ebook-convert` | Path to Calibre's converter. |

## Prompts

### Built-in MCP prompts

The server includes four ready-made prompts. When one runs, it first finds and loads the book (you can just
type words like `dune`). The model then starts with the `book_id`, the chunk list with page ranges, and a
note-length budget scaled to the book's size.

| Prompt | Arguments | What you get |
|---|---|---|
| `summarize_book` | `book`, `length` (brief / standard / detailed), `focus`, `up_to` | Plot summary: overview, the story by part or chapter, characters, themes, ending |
| `character_guide` | `book`, `spoilers` (yes / no), `detail` (main / all), `up_to` | Who's who: arcs, relationships, first appearances; aliases merged |
| `book_synopsis` | `book`, `length` (short / standard / long), `audience` | Full plot including the ending, in present tense (agent/editor style) |
| `book_blurb` | `book`, `style`, `words` | Spoiler-free back-cover blurb, short listing blurb, tagline and hooks |

`up_to` (for example `chapter 12` or `page 240`) limits reading to that point. This makes a spoiler-safe recap for
someone partway through the book.

**Where they appear:** clients show prompts differently. In Claude Desktop, use the **+** / attach menu → the
book-splitter server. In Claude Code, they're slash commands: `/mcp__book-splitter__character_guide dune`. Some
clients only use MCP *tools* and never show prompts; for those, paste one of the text prompts below. The tools are
the same either way.

### Copy-paste prompts

These work in any client that has the book-splitter tools.

**Story summary**
```
Summarize the book "Dune" using the book-splitter tools.
1. find_books (query "dune") → load_book. Then get_overview, and write a short brief: genre, setting,
   premise, protagonist.
2. Read every chunk with get_chapter, in parallel if you can. Give each reader the brief. For each chunk,
   note in ~200 words: the events in order, who appears and what they do, and threads opened or resolved.
3. Combine the notes into: a one-paragraph overview; the story by part (headings with page ranges, about
   1,500 words); the main characters, one line each; 3–5 themes; and how it ends.
Use only what's in the text, not outside knowledge. Keep names consistent across chapters.
```

**Character guide**
```
Make a character guide for "Dune" with the book-splitter tools (find_books → load_book → get_overview).
Read every chunk with get_chapter (in parallel if possible). For each chunk, list each named character who
appears, along with any other names or titles used for them, what they do, what we learn about them,
relationships, and status changes (death, reveal, betrayal).
Then merge aliases and output:
- Main characters: role, description, arc with chapter references, key relationships, fate.
- Supporting characters: 1–2 lines each, with their first appearance.
- Key relationships and how they develop.
Spoiler-free version: replace "fate" with "no late reveals" and describe characters only as introduced.
Reader partway through: "Only read up to chapter 12, and reveal nothing after it."
```

**Synopsis**
```
Write a one-page synopsis (500–600 words) of "Dune" with the book-splitter tools.
Read every chunk and note the plot beats in order (setup, inciting incident, turning points, climax,
resolution), the protagonist's goal and stakes, and how they change.
Then write the complete story, including the ending, in present tense and third person, in chronological
order. Put each main character's name in CAPS the first time it appears. No teaser questions.
```

**Blurb**
```
Write spoiler-free back-cover copy for "Dune" with the book-splitter tools.
Read the first third of the chunks closely: the protagonist, setting, inciting incident, what they want,
what stands in the way, and the stakes. Skim the rest for tone and genre only.
Output:
- a back-cover blurb of 150–200 words that opens with a hook and ends on tension;
- a 50-word short blurb;
- a tagline under 15 words;
- two alternative hooks.
Match the genre's voice. No spoilers, no clichés ("in a world where…"), and no invented review quotes or
awards.
```

### Tips

- **Parallel reading** gets fast, consistent results on long books. In Claude Code or the Agent SDK, ask for
  one sub-agent per chunk (or per few chunks), each given the brief from `get_overview`.
- **Long books with a small-context model:** load with a smaller `max_tokens` (e.g. 6000), and ask for shorter
  per-chunk notes so all the notes fit in the final step.
- **Blurbs and synopses** improve with a second pass: ask the model to tighten the draft, cut adjectives, and
  check that it doesn't reveal the ending.

## Limitations

- Scanned PDFs have no text layer. Run OCR first (for example `ocrmypdf`); the server warns you when it detects one.
- DRM-protected EPUBs are rejected.
- Chapter detection in plain text is heuristic. Use the CLI to check the result, and change `min_tokens` /
  `max_tokens` if needed.
