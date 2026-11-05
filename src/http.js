// HTTP entry point: Streamable HTTP at /mcp (current MCP spec) plus legacy SSE at /sse + /messages,
// for clients like LibreChat that can't launch a local stdio process.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
// Names a local container uses to reach this machine (Docker Desktop) — not attacker-controllable DNS
const LOCAL_ALIASES = new Set(["host.docker.internal", "gateway.docker.internal"]);
const MAX_BODY = 4 * 1024 * 1024;

export async function startHttp({ host = "127.0.0.1", port = 8787, token, allowedHosts = [], tlsCert, tlsKey } = {}) {
  const sseSessions = new Map(); // sessionId -> SSEServerTransport
  const loopbackOnly = LOOPBACK.has(host);
  const hostOk = (req) => {
    // DNS-rebinding protection: when bound to loopback (or an allow-list is given), only accept known Host headers
    if (!loopbackOnly && !allowedHosts.length) return true;
    const name = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK.has(name) || LOCAL_ALIASES.has(name) || allowedHosts.includes(name);
  };
  const authOk = (req) => {
    if (!token) return true;
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? req.headers["x-api-key"] ?? "";
    const a = Buffer.from(String(given));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const send = (res, status, obj) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
  };
  const rpcError = (res, status, message) => send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request body too large"), { status: 413 })); req.destroy(); }
      else parts.push(d);
    });
    req.on("end", () => {
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : undefined); }
      catch { reject(Object.assign(new Error("Invalid JSON body"), { status: 400 })); }
    });
    req.on("error", reject);
  });

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://local");
    try {
      if (url.pathname === "/health") return send(res, 200, { ok: true, name: "book-splitter" });
      if (!hostOk(req)) return rpcError(res, 403, "Host header not allowed");
      if (!authOk(req)) {
        res.setHeader("www-authenticate", "Bearer");
        return rpcError(res, 401, "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>");
      }

      // ---- Streamable HTTP (stateless: a fresh server per request; book state lives in the shared cache)
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          return rpcError(res, 405, "Method not allowed (this server is stateless; use POST)");
        }
        const body = await readJson(req);
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      // ---- Legacy HTTP+SSE: GET /sse opens the stream, client POSTs to /messages?sessionId=…
      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        const server = createServer();
        sseSessions.set(transport.sessionId, transport);
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
        res.on("close", () => {
          clearInterval(keepAlive);
          sseSessions.delete(transport.sessionId);
          server.close();
        });
        return await server.connect(transport);
      }
      if (url.pathname === "/messages" && req.method === "POST") {
        const transport = sseSessions.get(url.searchParams.get("sessionId"));
        if (!transport) return rpcError(res, 404, "Unknown or expired SSE session");
        return await transport.handlePostMessage(req, res, await readJson(req));
      }

      return send(res, 404, { error: "Not found. Endpoints: POST /mcp (streamable HTTP), GET /sse (legacy SSE), GET /health" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      rpcError(res, err.status ?? 500, err.status ? err.message : "Internal server error");
    }
  };

  const httpServer = tlsCert && tlsKey
    ? https.createServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
    : http.createServer(handler);
  // Tool calls on big books can take a while; don't let Node cut long requests/streams
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const scheme = tlsCert && tlsKey ? "https" : "http";
  const shown = host.includes(":") ? `[${host}]` : host;
  console.error(`book-splitter MCP server listening on ${scheme}://${shown}:${httpServer.address().port}`);
  console.error(`  Streamable HTTP: ${scheme}://${shown}:${httpServer.address().port}/mcp`);
  console.error(`  Legacy SSE:      ${scheme}://${shown}:${httpServer.address().port}/sse`);
  if (!token && !loopbackOnly) {
    console.error("  WARNING: listening on a non-loopback address without MCP_AUTH_TOKEN — anyone who can reach this port can read your books.");
  }
  if (!process.env.BOOK_SPLITTER_ROOTS) {
    console.error("  WARNING: BOOK_SPLITTER_ROOTS is not set — clients can ask for any file path this process can read.");
  }
  return httpServer;
}
