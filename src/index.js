#!/usr/bin/env node
// Entry point. Default: stdio (for Claude Desktop, Claude Code, mcp.json tools).
// With --http (or MCP_TRANSPORT=http): Streamable HTTP + legacy SSE server (for LibreChat etc.).
import "./stdio-guard.js";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    http: { type: "boolean", default: false },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stderr.write(`book-splitter MCP server

  node src/index.js                      stdio transport (default)
  node src/index.js --http [--port 8787] [--host 127.0.0.1]
                                         Streamable HTTP at /mcp, legacy SSE at /sse

Env: MCP_TRANSPORT=http, MCP_PORT, MCP_HOST, MCP_AUTH_TOKEN, MCP_ALLOWED_HOSTS,
     MCP_TLS_CERT, MCP_TLS_KEY, BOOK_SPLITTER_ROOTS, BOOK_SPLITTER_CACHE …  (see README)
`);
  process.exit(0);
}

const useHttp = values.http || /^(http|sse|streamable-http)$/i.test(process.env.MCP_TRANSPORT ?? "");

if (useHttp) {
  const { startHttp } = await import("./http.js");
  await startHttp({
    host: values.host ?? process.env.MCP_HOST ?? "127.0.0.1",
    port: Number(values.port ?? process.env.MCP_PORT ?? process.env.PORT ?? 8787),
    token: process.env.MCP_AUTH_TOKEN || undefined,
    allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    tlsCert: process.env.MCP_TLS_CERT,
    tlsKey: process.env.MCP_TLS_KEY,
  });
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createServer } = await import("./server.js");
  await createServer().connect(new StdioServerTransport());
  console.error("book-splitter MCP server running on stdio");
}
