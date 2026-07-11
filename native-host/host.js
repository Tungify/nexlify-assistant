"use strict";

// Native messaging host + tool bridge hub for the FB Assistant side panel.
//
// Two roles:
//   1. Chrome <-> host over stdin/stdout: 4-byte little-endian length prefix +
//      UTF-8 JSON. Runs the chosen CLI provider, streams text back.
//   2. host <-> mcp-server over a unix socket (JSONL). When Claude calls a DOM
//      tool, mcp-server forwards it here; we relay it to the extension as a
//      "tool_request" and route the extension's "tool_result" back.
//
// Everything is spawned on demand by Chrome and dies when the port closes —
// no standalone daemon.
//
// IMPORTANT: never write to stdout except framed messages — use log() (stderr).

const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Load native-host/.env.local (POD_ADMIN_API_URL, POD_ADMIN_ACCESS_KEY, …) so
// creds live in a git-ignored file, not baked into host.sh. Shell env wins.
try {
  const envFile = path.join(__dirname, ".env.local");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const SOCK = path.join(os.tmpdir(), `fb-bridge-${process.pid}.sock`);
const MCP_SERVER = path.join(__dirname, "mcp-server.js");

// Skip the ~1s of non-essential startup work (update check, telemetry, error
// reporting) on every spawn — we just want the CLI up and answering.
const RUN_ENV = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
};

let session = null; // { child, key, currentId, acc, errAcc, interrupted } — the live conversation
let warm = null; // { child, key, drain } — a prewarmed idle session for the next conversation
const pendingTools = new Map(); // callId -> socket connection awaiting a result

function log(...a) {
  process.stderr.write("[host] " + a.join(" ") + "\n");
}

// ---- Chrome framing (stdout) ---------------------------------------------

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// ---- unix socket hub (host <-> mcp-server) -------------------------------

const server = net.createServer((conn) => {
  let acc = "";
  conn.on("data", (d) => {
    acc += d.toString("utf8");
    let nl;
    while ((nl = acc.indexOf("\n")) >= 0) {
      const line = acc.slice(0, nl);
      acc = acc.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "call") {
        pendingTools.set(msg.callId, conn);
        send({ type: "tool_request", callId: msg.callId, tool: msg.tool, args: msg.args || {} });
      }
    }
  });
  conn.on("close", () => {
    for (const [callId, c] of pendingTools) if (c === conn) pendingTools.delete(callId);
  });
  conn.on("error", () => {});
});

try {
  if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
  server.listen(SOCK);
} catch (e) {
  log("socket listen failed:", e.message);
}

// ==== Provider registry ====================================================
//
// To add a CLI provider later (e.g. chatgpt/codex):
//   1. Add an entry to PROVIDERS with { cmd, format, supportsTools, buildArgs }.
//   2. The session is driven over stdin as stream-json; a provider speaking a
//      different protocol needs its own handling in attach().
//
// buildArgs({ tools, model, effort }) -> argv (no prompt — the user turn is
// written to stdin so we can spawn/prewarm before we have it). `tools` is
// already gated by supportsTools.

const BRIDGE_TOOLS = "mcp__fbbridge__get_page,mcp__fbbridge__query_dom";
// Keep Claude a pure responder: no shell / file mutations, only our DOM tools.
const NO_BUILTIN_TOOLS = "Bash,Edit,Write,MultiEdit,NotebookEdit";

function bridgeConfig() {
  return JSON.stringify({
    mcpServers: {
      fbbridge: { command: process.execPath, args: [MCP_SERVER], env: { FB_BRIDGE_SOCK: SOCK } },
    },
  });
}

const PROVIDERS = {
  claude: {
    cmd: process.env.CLAUDE_BIN || "claude",
    format: "claude-stream-json",
    supportsTools: true,
    buildArgs({ tools, model, effort }) {
      const a = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--disallowedTools",
        NO_BUILTIN_TOOLS,
        "--strict-mcp-config",
      ];
      if (model) a.push("--model", model);
      if (effort) a.push("--effort", effort);
      if (tools) a.push("--mcp-config", bridgeConfig(), "--allowedTools", BRIDGE_TOOLS);
      else a.push("--mcp-config", '{"mcpServers":{}}');
      return a;
    },
  },

  // chatgpt: {   // TODO: install a codex/chatgpt CLI, then uncomment + adjust.
  //   cmd: process.env.CODEX_BIN || "codex",
  //   format: "text",           // raw passthrough; add a parser if it streams JSON
  //   supportsTools: false,     // no DOM bridge yet for this provider
  //   buildArgs({ prompt }) {
  //     return ["exec", prompt];
  //   },
  // },
};

// Parse one line of Claude's stream-json output; forward text deltas and a
// lightweight signal when it starts using a DOM tool. Returns true when the
// turn ends. Returns null while streaming, or {error} when the turn completes
// (a top-level `result`); `error` is a string on failure, null on success. The
// caller decides what to do (e.g. suppress the error on a deliberate interrupt).
function emitStreamLine(id, line) {
  const s = line.trim();
  if (!s) return null;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (obj.type === "result") {
    return { error: obj.is_error ? obj.result || obj.api_error_status || "CLI error" : null };
  }
  const ev = obj.type === "stream_event" ? obj.event : null;
  if (!ev) return null;
  if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
    send({ id, type: "chunk", data: ev.delta.text });
  } else if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
    const name = ev.content_block.name || "";
    if (name.indexOf("fbbridge") !== -1) {
      send({ id, type: "tool_use", name: name.replace(/^mcp__fbbridge__/, "") });
    }
  }
  return null;
}

// ==== Warm sessions & requests =============================================

// Sessions are interchangeable only if their launch config matches — model,
// effort, and whether the DOM tools (and thus MCP) are wired in.
function cfgKey(msg) {
  const provider = PROVIDERS[msg.cli];
  const tools = !!msg.tools && !!(provider && provider.supportsTools);
  return JSON.stringify({ cli: msg.cli, tools, model: msg.model || "", effort: msg.effort || "" });
}

// Spawn an idle stream-json session for this config. The user turn arrives
// later over stdin, so cold-start runs now instead of after the click.
function spawnSession(msg) {
  const provider = PROVIDERS[msg.cli];
  const tools = !!msg.tools && provider.supportsTools;
  const argv = provider.buildArgs({ tools, model: msg.model, effort: msg.effort });
  return spawn(provider.cmd, argv, { env: RUN_ENV, cwd: os.tmpdir() });
}

// Keep (at most) one prewarmed session matching the current settings.
function prewarm(msg) {
  const provider = PROVIDERS[msg.cli];
  if (!provider) return;
  const key = cfgKey(msg);
  if (warm && warm.key === key && !warm.child.killed) return; // already warm
  if (warm && !warm.child.killed) {
    try { warm.child.kill("SIGTERM"); } catch {}
  }
  let child;
  try {
    child = spawnSession(msg);
  } catch (e) {
    warm = null;
    log("prewarm failed:", e.message);
    return;
  }
  // Drain stderr while idle so a chatty init can't stall the pipe. Leave stdout
  // buffered so the `system` init line is still there when we attach().
  const drain = () => {};
  child.stderr.on("data", drain);
  const forget = () => {
    if (warm && warm.child === child) warm = null;
  };
  child.on("error", forget);
  child.on("close", forget);
  warm = { child, key, drain };
  log("prewarmed", key);
}

// A conversation is ONE long-lived child. We wire its output once and route
// each turn's chunks to whichever request id is currently in flight
// (`s.currentId`); on `result` we finish that turn but keep the child alive for
// the next one. This is what makes the assistant able to discuss / refine.
function attachSession(s) {
  s.child.stdout.on("data", (d) => {
    s.acc += d.toString("utf8");
    let nl;
    while ((nl = s.acc.indexOf("\n")) >= 0) {
      const line = s.acc.slice(0, nl);
      s.acc = s.acc.slice(nl + 1);
      const res = emitStreamLine(s.currentId, line);
      if (!res) continue; // still streaming this turn
      if (s.currentId != null) {
        // A deliberate interrupt ends the turn as an "error" — swallow it; the
        // partial reply already streamed and the session stays usable.
        if (res.error && !s.interrupted) send({ id: s.currentId, type: "error", error: res.error });
        send({ id: s.currentId, type: "done", code: 0 });
      }
      s.currentId = null;
      s.interrupted = false;
    }
  });
  s.child.stderr.on("data", (d) => {
    s.errAcc += d.toString("utf8");
  });
  const die = (label, code) => {
    if (s.currentId != null) {
      if (s.errAcc.trim()) send({ id: s.currentId, type: "stderr", data: s.errAcc.trim() });
      send({ id: s.currentId, type: label === "error" ? "error" : "done", ...(label === "error" ? { error: "session ended" } : { code: code || 1 }) });
      s.currentId = null;
    }
    if (session === s) session = null;
  };
  s.child.on("error", () => die("error"));
  s.child.on("close", (code) => die("close", code));
}

// Start a fresh conversation: retire any live session, then take the warm
// child (if its config matches) or spawn one, and wire it up.
function startSession(msg) {
  if (session && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch {}
  }
  const key = cfgKey(msg);
  let child;
  if (warm && warm.key === key && !warm.child.killed) {
    child = warm.child;
    child.stderr.removeListener("data", warm.drain); // attachSession takes over stderr
    warm = null;
  } else {
    if (warm && !warm.child.killed) {
      try { warm.child.kill("SIGTERM"); } catch {}
    }
    warm = null;
    child = spawnSession(msg); // may throw — caller handles
  }
  session = { child, key, currentId: null, acc: "", errAcc: "", interrupted: false };
  attachSession(session);
  return session;
}

// One user turn. Continues the live conversation, or opens a new one if there
// isn't a matching live session yet.
function run(msg) {
  const provider = PROVIDERS[msg.cli];
  if (!provider) {
    send({ id: msg.id, type: "error", error: "unknown cli: " + msg.cli });
    return;
  }
  try {
    // No live session yet → open one with this turn's config. An existing
    // conversation keeps its original config (settings apply on the next reset).
    if (!session || session.child.killed) {
      startSession(msg);
    }
  } catch (e) {
    send({ id: msg.id, type: "error", error: String(e.message || e) });
    return;
  }
  session.currentId = msg.id;
  session.interrupted = false;
  const turn = { type: "user", message: { role: "user", content: [{ type: "text", text: msg.prompt }] } };
  try {
    session.child.stdin.write(JSON.stringify(turn) + "\n");
  } catch (e) {
    send({ id: msg.id, type: "error", error: String(e.message || e) });
  }
}

// Stop the current turn WITHOUT ending the conversation (see interrupt test):
// send a control_request; the turn returns an error result we then swallow.
function cancel(id) {
  if (!session || session.currentId !== id) return;
  session.interrupted = true;
  try {
    session.child.stdin.write(JSON.stringify({ type: "control_request", request_id: "int", request: { subtype: "interrupt" } }) + "\n");
  } catch {}
}

// End the conversation and ready a warm session for the next one.
function reset(msg) {
  if (session && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch {}
  }
  session = null;
  prewarm(msg);
}

// ==== POD merchant summary (admin GraphQL) =================================
//
// On conversation open the panel scrapes the shop's myshopify domain and asks
// us for a support summary. We call the pod-shopify-backend admin GraphQL with
// an is_admin access key. Two hops (Ent where-inputs): account-by-domain for
// plan + counts, then the account's shops' current subscription for the renewal
// date — an account has many shops but only one carries the subscription.
const POD_API_URL = (process.env.POD_ADMIN_API_URL || "").replace(/\/+$/, "");
const POD_ACCESS_KEY = process.env.POD_ADMIN_ACCESS_KEY || "";
const POD_ACCESS_KEY_HEADER = process.env.POD_ADMIN_ACCESS_KEY_HEADER || "X-Access-Key";

// NB: no `shops { … }` here — Account.shops 500s on the backend. shopCount comes
// from resourceCounts, and the subscription is fetched by accountID below.
const POD_ACCOUNT_QUERY = `query($domain: String!) {
  accounts(where: { hasShopsWith: [{ domain: $domain }] }, first: 1) {
    edges { node {
      id email name createdAt
      planName planAmount subscriptionStatus mrr creditBalance
      resourceCounts { customizationTemplates designTemplates orders libraries shops }
    } }
  }
}`;

// Account-scoped: finds the current subscription across ALL the account's shops
// (one account has many shops but only one carries the subscription).
const POD_SUBS_QUERY = `query($accountId: ID!) {
  subscriptions(where: { statusIn: [ACTIVE, TRIALING, PENDING, PAST_DUE], hasShopWith: [{ accountID: $accountId }] }, first: 50) {
    edges { node { status planName planAmount interval activatedAt currentPeriodEnd createdAt shopDomain } }
  }
}`;

// The ticket's own shop — its status (ACTIVE/DEACTIVE) tells support whether the
// merchant still has the app installed.
const POD_SHOP_QUERY = `query($domain: String!) {
  shops(where: { domain: $domain }, first: 1) { edges { node { status } } }
}`;

async function podGraphql(query, variables, shopDomain, baseUrl, accessKey) {
  // URL + access key can both be overridden per-request from the panel's
  // settings, else fall back to .env.local (POD_ADMIN_API_URL / _ACCESS_KEY).
  const base = (baseUrl && baseUrl.replace(/\/+$/, "")) || POD_API_URL;
  const key = accessKey || POD_ACCESS_KEY;
  if (!base) throw new Error("no API URL — set it in settings or POD_ADMIN_API_URL");
  if (!key) throw new Error("no access key — set it in settings or POD_ADMIN_ACCESS_KEY");
  const headers = { "Content-Type": "application/json", [POD_ACCESS_KEY_HEADER]: key };
  // The access-key middleware back-fills the tenant from a shop-domain header;
  // the is_admin key is what unlocks the cross-tenant @admin queries.
  if (shopDomain) headers["X-Shopify-Shop-Domain"] = shopDomain;
  const res = await fetch(`${base}/api/admin/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`admin API ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message || "graphql error");
  return json.data;
}

async function shopSummary(msg) {
  const domain = String(msg.domain || "").trim().toLowerCase();
  const apiUrl = String(msg.apiUrl || "").trim();
  const accessKey = String(msg.accessKey || "").trim();
  const reply = (data, error) => send({ id: msg.id, type: "shop_summary_result", data: data || null, error });
  if (!domain) return reply(null, "no shop domain");
  try {
    const d1 = await podGraphql(POD_ACCOUNT_QUERY, { domain }, domain, apiUrl, accessKey);
    const acc = d1 && d1.accounts && d1.accounts.edges && d1.accounts.edges[0] && d1.accounts.edges[0].node;
    if (!acc) return reply(null, `no account found for ${domain}`);

    // Subscription (renewal etc.) and the ticket shop's status are non-fatal —
    // show the account summary even if one of them hiccups.
    let sub = null;
    try {
      const d2 = await podGraphql(POD_SUBS_QUERY, { accountId: acc.id }, domain, apiUrl, accessKey);
      const recs = ((d2 && d2.subscriptions && d2.subscriptions.edges) || []).map((e) => e.node);
      recs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      sub = recs[0] || null; // newest by created_at = the account's current subscription
    } catch (e) {
      log("subs query failed:", e.message);
    }

    let shopStatus = null;
    try {
      const d3 = await podGraphql(POD_SHOP_QUERY, { domain }, domain, apiUrl, accessKey);
      const node = d3 && d3.shops && d3.shops.edges && d3.shops.edges[0] && d3.shops.edges[0].node;
      shopStatus = (node && node.status) || null;
    } catch (e) {
      log("shop query failed:", e.message);
    }

    const rc = acc.resourceCounts || {};
    reply({
      domain,
      accountId: acc.id,
      email: acc.email,
      name: acc.name,
      createdAt: acc.createdAt, // "using the app for …" baseline
      planName: acc.planName,
      planAmount: acc.planAmount,
      interval: sub ? sub.interval : null,
      activatedAt: sub ? sub.activatedAt : null,
      subscriptionStatus: acc.subscriptionStatus,
      mrr: acc.mrr,
      creditBalance: acc.creditBalance,
      optionSets: rc.customizationTemplates ?? null,
      designTemplates: rc.designTemplates ?? null,
      orders: rc.orders ?? null,
      libraries: rc.libraries ?? null,
      shopCount: rc.shops ?? null,
      shopStatus,
      currentPeriodEnd: sub ? sub.currentPeriodEnd : null,
      subscriptionShopDomain: sub ? sub.shopDomain : null,
    });
  } catch (e) {
    reply(null, String((e && e.message) || e));
  }
}

// Extension answered a tool_request — relay it back to the waiting mcp-server.
function toolResult(msg) {
  const conn = pendingTools.get(msg.callId);
  if (!conn) return;
  pendingTools.delete(msg.callId);
  try {
    conn.write(
      JSON.stringify({ type: "result", callId: msg.callId, ok: msg.ok, data: msg.data, error: msg.error }) + "\n",
    );
  } catch (e) {
    log("toolResult write failed:", e.message);
  }
}

function handle(msg) {
  if (msg.type === "cancel") cancel(msg.id);
  else if (msg.type === "tool_result") toolResult(msg);
  else if (msg.type === "prewarm") prewarm(msg);
  else if (msg.type === "reset") reset(msg);
  else if (msg.type === "shop_summary") shopSummary(msg);
  else run(msg);
}

// ---- Chrome framing (stdin) ----------------------------------------------

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    try {
      handle(JSON.parse(body.toString("utf8")));
    } catch (e) {
      log("bad message:", e.message);
    }
  }
});

process.stdin.on("end", () => {
  if (session && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch {}
  }
  if (warm && !warm.child.killed) {
    try { warm.child.kill("SIGTERM"); } catch {}
  }
  try {
    server.close();
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
  } catch {}
  process.exit(0);
});

log("started; sock=" + SOCK);
