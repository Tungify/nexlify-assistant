"use strict";

// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited), zero deps.
// Claude Code spawns this and discovers two tools. When a tool is called, we
// forward it over a unix socket to host.js, which relays it to the browser
// extension to run against the live DOM, and returns the result.

const net = require("net");

const SOCK = process.env.FB_BRIDGE_SOCK;
const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "get_page",
    description:
      "Read the browser tab the user is currently looking at. Returns { url, title, text } where text is the page's visible text. Use this to see the Featurebase conversation / page content.",
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "number", description: "Max characters of body text (default 12000)." },
      },
    },
  },
  {
    name: "query_dom",
    description:
      "Query the current tab's DOM with a CSS selector. Returns { count, matches } — the innerText (or outerHTML if html=true) of matched elements. Use for targeted extraction.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector." },
        limit: { type: "number", description: "Max elements (default 20)." },
        html: { type: "boolean", description: "Return outerHTML instead of text." },
      },
      required: ["selector"],
    },
  },
];

// ---- unix socket to host.js ----------------------------------------------

let sock = null;
let sockBuf = "";
let counter = 0;
const prefix = Math.random().toString(36).slice(2, 8);
const pending = new Map(); // callId -> { resolve, reject, timer }

function ensureSock() {
  return new Promise((resolve, reject) => {
    if (sock && !sock.destroyed) return resolve(sock);
    if (!SOCK) return reject(new Error("FB_BRIDGE_SOCK not set"));
    const s = net.connect(SOCK);
    s.on("connect", () => {
      sock = s;
      resolve(s);
    });
    s.on("error", (e) => {
      sock = null;
      reject(e);
    });
    s.on("data", (d) => {
      sockBuf += d.toString("utf8");
      let nl;
      while ((nl = sockBuf.indexOf("\n")) >= 0) {
        const line = sockBuf.slice(0, nl);
        sockBuf = sockBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.callId);
        if (!p) continue;
        pending.delete(msg.callId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || "tool failed"));
      }
    });
  });
}

function callTool(tool, args) {
  return new Promise(async (resolve, reject) => {
    let s;
    try {
      s = await ensureSock();
    } catch (e) {
      return reject(new Error("browser bridge not connected: " + e.message));
    }
    const callId = `${prefix}-${++counter}`;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error("timed out waiting for the browser (is the side panel open?)"));
    }, 30000);
    pending.set(callId, { resolve, reject, timer });
    s.write(JSON.stringify({ type: "call", callId, tool, args }) + "\n");
  });
}

// ---- JSON-RPC over stdio -------------------------------------------------

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "fbbridge", version: "0.2.0" },
      });
      break;
    case "notifications/initialized":
      break; // notification, no response
    case "ping":
      reply(id, {});
      break;
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!TOOLS.some((t) => t.name === name)) {
        return replyError(id, -32602, "unknown tool: " + name);
      }
      try {
        const data = await callTool(name, args);
        reply(id, { content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: "Error: " + e.message }], isError: true });
      }
      break;
    }
    default:
      if (id !== undefined) replyError(id, -32601, "method not found: " + method);
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    handle(req);
  }
});

process.stdin.on("end", () => process.exit(0));
