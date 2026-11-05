import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const TOKEN = "test-token-123";
let dir, proc, base;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "book-splitter-http-"));
  const chapters = Array.from({ length: 6 }, (_, i) =>
    `CHAPTER ${i + 1}\n\nTitle ${i + 1}\n\n` + `Sentence number ${i + 1} goes on. `.repeat(400)).join("\n\n");
  await writeFile(path.join(dir, "novel.txt"), chapters);
  proc = spawn(process.execPath, ["src/index.js", "--http", "--port", "0"], {
    env: { ...process.env, BOOK_SPLITTER_ROOTS: dir, BOOK_SPLITTER_CACHE: path.join(dir, "cache"), MCP_AUTH_TOKEN: TOKEN },
    stdio: ["ignore", "ignore", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/listening on (http:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`server exited (${code}): ${buf}`)));
  });
});

after(async () => {
  proc?.kill();
  await rm(dir, { recursive: true, force: true });
});

const auth = { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } };
async function connect(kind) {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = kind === "sse"
    ? new SSEClientTransport(new URL(`${base}/sse`), { ...auth, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}` } }) } })
    : new StreamableHTTPClientTransport(new URL(`${base}/mcp`), auth);
  await client.connect(transport);
  return client;
}
const text = (r) => r.content[0].text;

test("streamable HTTP: list tools, load a book, fetch every chapter in parallel", async () => {
  const client = await connect("streamable");
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "load_book"));

  const loaded = text(await client.callTool({ name: "load_book", arguments: { path: "novel.txt" } }));
  const book = JSON.parse(loaded.split("\n\nNext:")[0]);
  assert.equal(book.chunk_count, 6);

  const all = await Promise.all(book.chunks.map((c) =>
    client.callTool({ name: "get_chapter", arguments: { book_id: book.book_id, index: c.index } })));
  all.forEach((r, i) => assert.match(text(r), new RegExp(`Sentence number ${i + 1} goes on`)));
  await client.close();
});

test("legacy SSE transport works and shares the same cache", async () => {
  const client = await connect("sse");
  const list = JSON.parse(text(await client.callTool({ name: "list_books", arguments: {} })));
  assert.equal(list[0].title, "novel");
  const ch = await client.callTool({ name: "get_chapter", arguments: { book_id: list[0].book_id, index: 2 } });
  assert.match(text(ch), /Sentence number 3/);
  await client.close();
});

test("rejects missing/wrong token and foreign Host headers; /health is open", async () => {
  const post = (headers) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: "Bearer nope" })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}` })).status, 200);
  assert.equal((await post({ "X-API-Key": TOKEN })).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);

  // DNS-rebinding protection: a page on evil.com resolving to 127.0.0.1 must be refused
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/mcp`);
    const req = http.request({ host: u.hostname, port: u.port, path: "/mcp", method: "POST",
      headers: { host: "evil.example.com", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } },
    (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403);
});
