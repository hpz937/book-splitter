import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["find_books", "get_chapter", "get_overview", "list_books", "load_book", "remove_books"]);
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

test("moved books keep working; deleted books are flagged and can be removed", async () => {
  // move: same content at a new path reuses the cache and updates the source
  await copyFile(path.join(dir, "book.txt"), path.join(dir, "moved.txt"));
  await rm(path.join(dir, "book.txt"));
  let list = JSON.parse((await call("list_books", {})).text);
  const txt = list.find((b) => b.source.endsWith("book.txt"));
  assert.equal(txt.missing, true);
  assert.equal((await call("get_chapter", { book_id: txt.book_id, index: 0 })).isError, undefined, "still readable from cache");
  await call("load_book", { path: "moved.txt", min_tokens: 100 });
  list = JSON.parse((await call("list_books", {})).text);
  assert.ok(list.find((b) => b.book_id === txt.book_id).source.endsWith("moved.txt"));
  assert.ok(!list.some((b) => b.missing));

  // delete: flagged, then removed by default cleanup; other books untouched
  await rm(path.join(dir, "moved.txt"));
  const r = JSON.parse((await call("remove_books", {})).text);
  assert.deepEqual(r.removed.map((b) => b.book_id), [txt.book_id]);
  list = JSON.parse((await call("list_books", {})).text);
  assert.ok(!list.some((b) => b.book_id === txt.book_id));
  assert.ok(list.some((b) => b.title === "Fixture Book"));
  assert.equal((await call("get_chapter", { book_id: txt.book_id, index: 0 })).isError, true);

  // explicit id and all=true
  const epubId = list.find((b) => b.title === "Fixture Book").book_id;
  assert.equal(JSON.parse((await call("remove_books", { book_id: epubId })).text).removed.length, 1);
  assert.equal((await call("remove_books", { book_id: "nope" })).isError, true);
  await call("load_book", { path: "book.epub" });
  await call("remove_books", { all: true });
  assert.deepEqual(JSON.parse((await call("list_books", {})).text), []);
});

test("word counts, real EPUB print pages, and page estimates", async () => {
  // EPUB with print page markers: typed <span epub:type="pagebreak"> in ch1, page-list ids in ch2
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
     <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  zip.addFile("content.opf", Buffer.from(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
     <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Paged</dc:title></metadata>
     <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
       <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest>
     <spine><itemref idref="a"/><itemref idref="b"/></spine></package>`));
  const pages2 = Array.from({ length: 5 }, (_, i) => `<li><a href="b.xhtml#pg${20 + i}">${20 + i}</a></li>`).join("");
  zip.addFile("nav.xhtml", Buffer.from(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
     <nav epub:type="toc"><ol><li><a href="a.xhtml">One</a></li><li><a href="b.xhtml">Two</a></li></ol></nav>
     <nav epub:type="page-list"><ol>${pages2}</ol></nav></body></html>`));
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const a = Array.from({ length: 4 }, (_, i) =>
    `<p>${i ? `<span epub:type="pagebreak" id="p${i}" title="${i + 10}"/>` : ""}${words(300)}</p>`).join("");
  const b = Array.from({ length: 5 }, (_, i) => `<p id="pg${20 + i}">${words(300)}</p>`).join("");
  const page = (body) => Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${body}</body></html>`);
  zip.addFile("a.xhtml", page(`<h1>One</h1>${a}`));
  zip.addFile("b.xhtml", page(`<h1>Two</h1>${b}`));
  zip.writeZip(path.join(dir, "paged.epub"));

  const r = await call("load_book", { path: "paged.epub", min_tokens: 100 });
  const book = JSON.parse(r.text.slice(0, r.text.indexOf("\n\nNext:")));
  assert.equal(book.words, 2 + 9 * 300); // two headings + 9 paragraphs
  assert.deepEqual(book.pages, { count: 24, source: "print edition (page list in file)" });
  // One: first marker comes after a full paragraph, but there's no earlier page to carry, so it starts at 11.
  // Two: marker right after the heading → starts on 20, not the carried-over 13.
  assert.deepEqual(book.chunks.map((c) => c.pages), ["pp. 11–13", "pp. 20–24"]);
  assert.deepEqual(book.chunks.map((c) => c.words), [1201, 1501]);

  const ch = await call("get_chapter", { book_id: book.book_id, index: 1 });
  assert.match(ch.text, /Pages: pp\. 20–24 · 1,501 words/);
  assert.ok(!/[]/.test(ch.text), "page markers must be stripped from text");

  // no page markers → estimate, adjustable words_per_page
  const est = JSON.parse((await call("load_book", { path: path.join(dir, "book.epub"), words_per_page: 250 })).text.split("\n\nNext:")[0]);
  assert.equal(est.pages.source, "estimate from word count");
  assert.equal(est.pages.words_per_page, 250);
  assert.equal(est.pages.estimate, Math.round(est.words / 250));
  assert.ok(est.chunks.every((c) => c.pages.startsWith("~")));
});
