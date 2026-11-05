#!/usr/bin/env node
// Debug / standalone CLI: preview how a book will be split, optionally write chunks to disk.
import "./stdio-guard.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBook } from "./library.js";
import { bookPages, chunkPageRanges } from "./pages.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: "string" },
    min: { type: "string" },
    matter: { type: "boolean", default: false },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !positionals.length) {
  process.stderr.write(`Usage: book-split <ebook> [--max 12000] [--min 400] [--matter] [--out dir] [--json]\n`);
  process.exit(values.help ? 0 : 1);
}

try {
  const book = await loadBook(positionals[0], {
    maxTokens: values.max ? Number(values.max) : undefined,
    minTokens: values.min ? Number(values.min) : undefined,
    includeMatter: values.matter,
  });

  if (values.out) {
    await mkdir(values.out, { recursive: true });
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    for (const c of book.chunks) {
      const name = `${String(c.index).padStart(3, "0")}-${slug(c.title) || "chunk"}${c.parts > 1 ? `-p${c.part}` : ""}.txt`;
      await writeFile(path.join(values.out, name), `# ${c.title}\n\n${c.text}\n`);
    }
    const { chunks, ...meta } = book;
    await writeFile(path.join(values.out, "manifest.json"),
      JSON.stringify({ ...meta, chunks: chunks.map(({ text, ...c }) => c) }, null, 2));
  }

  if (values.json) {
    const { chunks, ...meta } = book;
    process.stdout.write(JSON.stringify({ ...meta, chunks: chunks.map(({ text, ...c }) => c) }, null, 2) + "\n");
  } else {
    const out = [];
    out.push(`${book.title}${book.author ? ` — ${book.author}` : ""}  [${book.format}]  id=${book.id}`);
    const pg = bookPages(book);
    const pages = pg.count ? `${pg.count} pages (${pg.source})` : `~${pg.estimate} pages (est. ${pg.range} @ ${pg.words_per_page} words/page)`;
    out.push(`${book.chunks.length} chunks · ${book.chapterCount} chapters · ${book.words.toLocaleString("en-US")} words · ${pages} · ~${book.totalTokens.toLocaleString("en-US")} tokens\n`);
    const ranges = chunkPageRanges(book);
    for (const c of book.chunks) {
      const where = c.path?.length ? `${c.path.join(" › ")} › ` : "";
      const part = c.parts > 1 ? ` (${c.part}/${c.parts})` : "";
      out.push(`${String(c.index).padStart(4)}  ${String(c.words).padStart(6)} w  ${ranges[c.index].padEnd(15)} ${where}${c.title}${part}`);
    }
    if (book.skipped.length) out.push(`\nSkipped: ${book.skipped.map((s) => s.title).join(", ")}`);
    for (const w of book.warnings) out.push(`Warning: ${w}`);
    if (values.out) out.push(`\nWrote ${book.chunks.length} files to ${values.out}`);
    process.stdout.write(out.join("\n") + "\n");
  }
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}
