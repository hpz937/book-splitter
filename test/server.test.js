import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const para = (tag, n) =>
  Array.from({ length: n }, (_, i) => `<p>[${tag}] Paragraph ${i} of the story, where things happen at length and the plot moves forward steadily.</p>`).join("\n");

function makeEpub(file) {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
     <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  zip.addFile("OEBPS/content.opf", Buffer.from(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
     <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:creator>A. Tester</dc:creator></metadata>
     <manifest>
       <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
       <item id="cr" href="text/copyright.xhtml" media-type="application/xhtml+xml"/>
       <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
       <item id="c23" href="text/ch2-3.xhtml" media-type="application/xhtml+xml"/>
     </manifest>
     <spine><itemref idref="cr"/><itemref idref="c1"/><itemref idref="c23"/></spine></package>`));
  zip.addFile("OEBPS/nav.xhtml", Buffer.from(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
     <nav epub:type="toc"><ol>
       <li><a href="text/copyright.xhtml">Copyright</a></li>
       <li><a href="text/ch1.xhtml">Chapter One</a></li>
       <li><a href="text/ch2-3.xhtml#c2">Chapter Two</a></li>
       <li><a href="text/ch2-3.xhtml#c3">Chapter Three</a></li>
     </ol></nav></body></html>`));
  const page = (body) => Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`);
  zip.addFile("OEBPS/text/copyright.xhtml", page("<p>Copyright 2026. All rights reserved.</p>"));
  zip.addFile("OEBPS/text/ch1.xhtml", page(`<h1>Chapter One</h1>${para("C1", 60)}`));
  zip.addFile("OEBPS/text/ch2-3.xhtml", page(
    `<h1 id="c2">Chapter Two</h1>${para("C2", 60)}<h1 id="c3">Chapter Three</h1>${para("C3", 400)}`));
  zip.writeZip(file);
}

let dir, client;
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content[0].text };
};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "book-splitter-test-"));
  makeEpub(path.join(dir, "book.epub"));
  await writeFile(path.join(dir, "book.txt"),
    "CHAPTER I\n\nThe Start\n\n" + "Words here. ".repeat(800) + "\n\nCHAPTER II\n\nThe End\n\n" + "More words. ".repeat(800));
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/index.js")],
    env: { ...process.env, BOOK_SPLITTER_CACHE: path.join(dir, "cache"), BOOK_SPLITTER_ROOTS: dir },
    stderr: "ignore",
  }));
});

after(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

test("exposes tools and prompt", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["find_books", "get_chapter", "get_overview", "list_books", "load_book"]);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, "summarize_book");
});

test("splits an EPUB by TOC, including fragment targets and oversized chapters", async () => {
  const r = await call("load_book", { path: path.join(dir, "book.epub"), max_tokens: 3000 });
  const book = JSON.parse(r.text.slice(0, r.text.indexOf("\n\nNext:")));
  assert.equal(book.title, "Fixture Book");
  assert.equal(book.author, "A. Tester");
  assert.deepEqual(book.skipped_sections, ["Copyright"]);
  const titles = book.chunks.map((c) => c.title);
  assert.equal(titles[0], "Chapter One");
  assert.equal(titles[1], "Chapter Two");
  assert.ok(titles.slice(2).every((t) => t === "Chapter Three"));
  assert.ok(book.chunks.length > 3, "chapter three should be split into parts");
  assert.ok(book.chunks.every((c) => c.tokens <= 3000));

  // each chunk contains only its own chapter's text
  for (const [i, tag] of [[0, "C1"], [1, "C2"], [2, "C3"]]) {
    const ch = await call("get_chapter", { book_id: book.book_id, index: i });
    const tags = new Set(ch.text.match(/\[C\d\]/g));
    assert.deepEqual([...tags], [`[${tag}]`], `chunk ${i}`);
  }
  const part = await call("get_chapter", { book_id: book.book_id, index: 2 });
  assert.match(part.text, /Chapter 3 of 3: Chapter Three \(part 1 of \d\)/);
});

test("splits plain text by heading heuristics", async () => {
  const r = await call("load_book", { path: path.join(dir, "book.txt"), min_tokens: 100 });
  const book = JSON.parse(r.text.slice(0, r.text.indexOf("\n\nNext:")));
  assert.deepEqual(book.chunks.map((c) => c.title), ["CHAPTER I: The Start", "CHAPTER II: The End"]);
});

test("overview, list_books and errors", async () => {
  const list = JSON.parse((await call("list_books", {})).text);
  assert.ok(list.some((b) => b.title === "Fixture Book"));
  const id = list.find((b) => b.title === "Fixture Book").book_id;
  const ov = await call("get_overview", { book_id: id, opening_tokens: 200 });
  assert.match(ov.text, /## Contents\n1\. Chapter One/);

  const bad = await call("get_chapter", { book_id: id, index: 999 });
  assert.equal(bad.isError, true);
  const missing = await call("load_book", { path: path.join(dir, "nope.epub") });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Not found/);
});

test("find_books lists files in the book folder and loads by relative name", async () => {
  const all = JSON.parse((await call("find_books", {})).text);
  assert.deepEqual(all.files.map((f) => f.name).sort(), ["book.epub", "book.txt"]);
  const q = JSON.parse((await call("find_books", { query: "EPUB" })).text);
  assert.equal(q.files.length, 1);
  assert.ok(q.files[0].book_id, "already-loaded book shows its id");
  const r = await call("load_book", { path: "book.txt", min_tokens: 100 });
  assert.equal(r.isError, undefined);
  const outside = await call("load_book", { path: path.resolve("package.json") });
  assert.match(outside.text, /outside BOOK_SPLITTER_ROOTS/);
});
