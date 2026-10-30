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

const { spawn, execFile } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");

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
// Well-known socket for EXTERNAL clients (a `claude` CLI you run yourself). We
// listen here too so an outside MCP server can reach the same live extension.
const PUBLIC_SOCK = require("./bridge-sock");
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

// One bridge connection (from mcp-server.js, ours or an external one). Tool
// calls are keyed by a globally-unique callId, so many connections multiplex
// safely over the same host and route back to the right caller.
function handleBridgeConn(conn) {
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
}

// Private per-session bridge: the CLI this host spawns talks to us here.
const server = net.createServer(handleBridgeConn);
try {
  if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
  server.listen(SOCK);
} catch (e) {
  log("socket listen failed:", e.message);
}

// Public bridge: lets an EXTERNAL Claude Code CLI drive the browser through the
// same tools. Several hosts can be alive at once (the panel spawns one, the
// background worker another), so ownership is decided by a live probe rather
// than last-writer-wins: if something already answers PUBLIC_SOCK we leave it;
// if it's absent or stale (a dead host's leftover file) we take it over. A
// periodic re-check means whichever host is still alive reclaims the socket
// within ~10s after the previous owner (e.g. a closed panel) goes away.
let publicServer = null;
function ensurePublicBridge() {
  const probe = net.connect(PUBLIC_SOCK);
  const claim = () => {
    try {
      fs.mkdirSync(path.dirname(PUBLIC_SOCK), { recursive: true, mode: 0o700 });
      if (fs.existsSync(PUBLIC_SOCK)) fs.unlinkSync(PUBLIC_SOCK);
      if (publicServer) publicServer.close();
      publicServer = net.createServer(handleBridgeConn);
      publicServer.on("error", (e) => log("public bridge error:", e.message));
      publicServer.listen(PUBLIC_SOCK, () => log("public bridge listening:", PUBLIC_SOCK));
    } catch (e) {
      log("public bridge failed:", e.message);
    }
  };
  probe.on("connect", () => probe.destroy()); // someone's serving it — leave it
  probe.on("error", claim); // absent or stale — take it over
}
ensurePublicBridge();
const publicReassert = setInterval(ensurePublicBridge, 10000);
if (publicReassert.unref) publicReassert.unref();

// Heartbeat: when our peer is the background service worker (which runs ALL the
// browser tools, so they work with the panel closed), MV3 idle-suspends it after
// ~30s. Any inbound message resets that timer, so ping every 20s to keep it —
// and thus this host, the public socket, and the worker's CDP capture buffer —
// alive. The side-panel peer ignores unknown message types.
const heartbeat = setInterval(() => {
  try {
    send({ type: "__ping" });
  } catch {}
}, 20000);
if (heartbeat.unref) heartbeat.unref();

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

// Browser tools exposed over the fbbridge MCP. PAGE = read + control the live
// tab; TAB = open/close/switch/navigate tabs for the whole window; DEBUG = read
// the console/network capture buffer. The panel gates each group with a setting;
// we advertise only the enabled ones (FB_TOOLS).
const PAGE_TOOLS = ["get_page", "query_dom", "screenshot", "click", "type_text", "press_key", "scroll_to", "wait_for", "run_js"];
const TAB_TOOLS = ["list_tabs", "open_tab", "close_tab", "switch_tab", "navigate", "reload_tab", "go_back", "go_forward"];
const DEBUG_TOOLS = ["get_console_logs", "get_network_requests", "get_network_request"];
// Built-in Claude tools allowed only when a local repo path is set (read-only).
const REPO_TOOLS = ["Read", "Grep", "Glob"];
// Never let Claude edit files directly. The shell is off too, unless the user
// turns on "Run shell commands" — then Bash is allowed but EVERY command goes
// through the in-panel approval popup (see buildArgs).
const NO_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// The user's own claude config may register this very mcp-server.js (e.g. as
// "nexlify-browser", so Claude Code sessions can drive the browser through the
// public socket). Team-MCP mode loads that config, and the panel then sees a
// second copy of its browser tools: not on the auto-run list (an approval popup
// for a page read) and bound to whichever Chrome owns the public socket (it
// listed another profile's tabs). Hide it; the panel has fbbridge.
function ownBrowserServers() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const servers = { ...(cfg.mcpServers || {}) };
    for (const p of Object.values(cfg.projects || {})) Object.assign(servers, (p && p.mcpServers) || {});
    return Object.entries(servers)
      .filter(([, s]) => s && [s.command, ...(s.args || [])].some((a) => typeof a === "string" && path.resolve(a) === MCP_SERVER))
      .map(([name]) => "mcp__" + name);
  } catch {
    return ["mcp__nexlify-browser"];
  }
}

// Lean sessions (the Featurebase support tab): only the plugin the support
// skill lives in. Every other enabled plugin (and skills-dir plugin) is switched
// off for this session only; with the narrow --tools list this took the context
// a session starts with from ~39k to ~11k tokens and cut ~1 s off start-up.
const LEAN_KEEP_PLUGINS = ["customei@skills-dir"];
function leanPluginSettings() {
  const off = {};
  const home = os.homedir();
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude", f), "utf8"));
      for (const [id, on] of Object.entries(cfg.enabledPlugins || {})) if (on) off[id] = false;
    } catch {
      /* missing or unreadable: nothing to switch off */
    }
  }
  try {
    for (const name of fs.readdirSync(path.join(home, ".claude", "skills"))) {
      if (fs.existsSync(path.join(home, ".claude", "skills", name, ".claude-plugin", "plugin.json"))) off[`${name}@skills-dir`] = false;
    }
  } catch {
    /* no skills dir */
  }
  for (const id of LEAN_KEEP_PLUGINS) delete off[id];
  // Hide every skill but the support plugin's from the listing (it was ~17k
  // characters of 35 skills, 3 of them relevant). Names come from the init line
  // of an earlier session (`knownSkills`), so the first session after the host
  // starts still lists them all. Plugin skills ignore overrides; the plugins are
  // off anyway. Bundled skills go with disableBundledSkills.
  const skillOverrides = {};
  for (const name of knownSkills) if (!LEAN_KEEP_SKILL.test(name)) skillOverrides[name] = "off";
  return {
    enabledPlugins: off,
    disableBundledSkills: true,
    skillOverrides,
    autoMemoryEnabled: false,
    attribution: { commit: "", pr: "" },
  };
}
const LEAN_KEEP_SKILL = /^customei:/;
let knownSkills = []; // from the latest session's init line

// The support skill, read from disk and appended to the system prompt: it then
// sits in the cached prefix every session shares, instead of being re-written
// into each session's first message (~7k tokens of cache writes per session).
// "<plugin>:<skill>" resolves to ~/.claude/skills/<plugin>/skills/<skill>/SKILL.md
// (a skills-dir plugin, how nexlify-skills installs). Not found → "" and the
// panel's slash command loads it the usual way.
function skillPrompt(id) {
  const m = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(id || "");
  if (!m) return "";
  const dir = path.join(os.homedir(), ".claude", "skills", m[1], "skills", m[2]);
  try {
    const body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    return `\n\n# The ${m[2]} skill (already loaded; don't invoke it)\n\nBase directory for this skill: ${fs.realpathSync(dir)}\n\n${body}`;
  } catch {
    return "";
  }
}

// A CLI session the panel wants back (a ticket it returned to), if its
// transcript is still on disk. --resume restores the exact context, articles
// read included, instead of replaying the chat as text.
function resumable(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) return false;
  try {
    const root = path.join(os.homedir(), ".claude", "projects");
    return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, id + ".jsonl")));
  } catch {
    return false;
  }
}
// Built-in tools a support session needs: Read (the skill's references),
// Skill, ToolSearch (deferred MCP tools); Bash only with shell on, Grep/Glob
// only with a repo. The rest (subagents, workflows, artifacts, web, cron …)
// carry long descriptions the support tab never uses.
const leanTools = ({ shell, repoPath }) =>
  ["Read", "Skill", "ToolSearch", ...(shell ? ["Bash"] : []), ...(repoPath ? ["Grep", "Glob"] : [])].join(",");

// Forces an approval for every Bash command. Without it Claude Code auto-runs
// commands it deems read-only (echo, ls, cat …) even in default permission mode;
// with "ask" they all reach --permission-prompt-tool. Verified on claude 2.1.314.
const ASK_EVERY_BASH = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command:
              "echo '" +
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason: "Nexlify: every shell command needs approval",
                },
              }) +
              "'",
          },
        ],
      },
    ],
  },
};

function bridgeConfig(toolNames, permission) {
  const env = { FB_BRIDGE_SOCK: SOCK, FB_TOOLS: toolNames.join(",") };
  if (permission) env.FB_PERMISSION_TOOL = "1"; // advertise permission_request
  return JSON.stringify({
    mcpServers: {
      fbbridge: {
        command: process.execPath,
        args: [MCP_SERVER],
        env,
      },
    },
  });
}

// A repo path is usable only if it points at a real directory; otherwise drop
// it (cwd falls back to tmpdir and the file tools stay off).
function validRepo(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  try {
    if (fs.statSync(s).isDirectory()) return s;
  } catch {}
  log("repo path is not a directory, ignoring:", s);
  return "";
}

// Normalize a panel message into the launch config, gating the tool groups
// behind the provider actually supporting tools.
function sessionCfg(msg) {
  const provider = PROVIDERS[msg.cli];
  const canTools = !!(provider && provider.supportsTools);
  const mcpTeam = canTools && !!msg.mcpTeam;
  return {
    page: canTools && !!msg.page,
    tabs: canTools && !!msg.tabs,
    capture: canTools && !!msg.capture,
    repoPath: validRepo(msg.repoPath),
    model: msg.model || "",
    effort: msg.effort || "",
    // Team-MCP mode: inherit the user's own claude MCP servers; auto-run only the
    // read tools/servers they listed, everything else goes through the popup.
    mcpTeam,
    mcpAllow: mcpTeam && Array.isArray(msg.mcpAllow) ? msg.mcpAllow.map((s) => String(s).trim()).filter(Boolean) : [],
    // Shell: Bash allowed, each command approved in the panel popup. Lets skills
    // that run scripts (customei-admin, gemcommerce-admin, …) actually work.
    shell: canTools && !!msg.shell,
    // Standing instructions for the session (the Featurebase tab sends the
    // support role), appended to Claude Code's own system prompt.
    systemPrompt: typeof msg.systemPrompt === "string" ? msg.systemPrompt.trim().slice(0, 12000) : "",
    // Lean: a narrow tool set and only the support skill's plugin (the Featurebase tab).
    lean: canTools && !!msg.lean,
    skill: typeof msg.skill === "string" ? msg.skill : "", // "<plugin>:<skill>" to put in the system prompt
    resume: typeof msg.resume === "string" && resumable(msg.resume) ? msg.resume : "",
  };
}

const PROVIDERS = {
  claude: {
    cmd: process.env.CLAUDE_BIN || "claude",
    format: "claude-stream-json",
    supportsTools: true,
    buildArgs({ page, tabs, capture, repoPath, model, effort, mcpTeam, mcpAllow, shell, systemPrompt, lean, skill, resume }) {
      const a = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--disallowedTools",
        [...(shell ? NO_WRITE_TOOLS : ["Bash", ...NO_WRITE_TOOLS]), ...(mcpTeam ? ownBrowserServers() : [])].join(","),
      ];
      // The approval popup (permission_request) is needed for team-MCP writes and
      // for shell commands.
      const gate = mcpTeam || shell;
      // Off (default): keep the browser bridge isolated — only our fbbridge tools
      // exist. Team-MCP mode: drop strict so the CLI ALSO loads the user's own
      // configured MCP servers (Sentry/ClickUp/Postgres/…), and gate any tool not
      // in --allowedTools behind an in-panel approval via permission_request.
      if (!mcpTeam) a.push("--strict-mcp-config");
      if (model) a.push("--model", model);
      if (effort) a.push("--effort", effort);
      const fullPrompt = systemPrompt + skillPrompt(skill);
      if (fullPrompt) a.push("--append-system-prompt", fullPrompt);
      if (resume) a.push("--resume", resume);
      const bridgeTools = [];
      if (page) bridgeTools.push(...PAGE_TOOLS);
      if (tabs) bridgeTools.push(...TAB_TOOLS);
      if (capture) bridgeTools.push(...DEBUG_TOOLS);
      const allowed = bridgeTools.map((n) => "mcp__fbbridge__" + n);
      if (repoPath) allowed.push(...REPO_TOOLS); // cwd is set to the repo in spawnSession
      if (gate) {
        // The gate itself must auto-run (else it'd recurse), plus the read-only
        // tools/servers the user marked auto-run; everything else hits the popup.
        allowed.push("mcp__fbbridge__permission_request");
        if (mcpTeam) allowed.push(...(mcpAllow || []));
        a.push("--permission-prompt-tool", "mcp__fbbridge__permission_request");
        // The user's own default mode may be "auto", where Claude Code approves
        // tools itself and never calls the gate (verified: Bash `touch` ran
        // unasked). Default mode sends anything not allowed to the popup.
        a.push("--permission-mode", "default");
      }
      if (lean) a.push("--tools", leanTools({ shell, repoPath }));
      // One --settings: the Bash approval hook and/or the lean plugin set.
      const settings = { ...(shell ? ASK_EVERY_BASH : {}), ...(lean ? leanPluginSettings() : {}) };
      if (Object.keys(settings).length) a.push("--settings", JSON.stringify(settings));
      if (bridgeTools.length || gate) a.push("--mcp-config", bridgeConfig(bridgeTools, gate));
      else a.push("--mcp-config", '{"mcpServers":{}}');
      if (allowed.length) a.push("--allowedTools", allowed.join(","));
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
    // Surface the tool name (our bridge tools stripped of the mcp prefix; the
    // built-in Read/Grep/Glob shown as-is) so the panel can show "→ click" etc.
    const name = ev.content_block.name || "tool";
    send({ id, type: "tool_use", name: name.replace(/^mcp__fbbridge__/, "") });
  } else if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "thinking") {
    send({ id, type: "thinking" });
  }
  return null;
}

// ==== Warm sessions & requests =============================================

// Sessions are interchangeable only if their launch config matches — model,
// effort, and whether the DOM tools (and thus MCP) are wired in.
function cfgKey(msg) {
  const c = sessionCfg(msg);
  return JSON.stringify({ cli: msg.cli, page: c.page, tabs: c.tabs, capture: c.capture, repoPath: c.repoPath, model: c.model, effort: c.effort, mcpTeam: c.mcpTeam, mcpAllow: c.mcpAllow, shell: c.shell, systemPrompt: c.systemPrompt, lean: c.lean, skill: c.skill, resume: c.resume });
}

// Spawn an idle stream-json session for this config. The user turn arrives
// later over stdin, so cold-start runs now instead of after the click. cwd is
// the local repo when one is set, so Claude's Read/Grep/Glob resolve there.
function spawnSession(msg) {
  const provider = PROVIDERS[msg.cli];
  const c = sessionCfg(msg);
  const argv = provider.buildArgs(c);
  // Lean: no ~/.claude/CLAUDE.md (repo routing rules the support tab never needs).
  const env = c.lean ? { ...RUN_ENV, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } : RUN_ENV;
  return spawn(provider.cmd, argv, { env, cwd: c.repoPath || os.tmpdir() });
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
      if (line.includes('"subtype":"init"') && line.includes('"type":"system"')) onInit(line);
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

// A session's init line: learn the skill names (for lean listings) and tell the
// panel the CLI session id, so it can --resume this chat later.
function onInit(line) {
  try {
    const o = JSON.parse(line);
    if (Array.isArray(o.skills) && o.skills.length) knownSkills = o.skills.map(String);
    if (o.session_id) send({ type: "cli_session", sessionId: String(o.session_id) });
  } catch {
    /* not JSON after all */
  }
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
  const c = sessionCfg(msg);
  session = { child, key, currentId: null, acc: "", errAcc: "", interrupted: false, skillLoaded: skillPrompt(c.skill) ? c.skill : "" };
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
  let prompt = msg.prompt;
  if (session.skillLoaded && prompt.startsWith("/" + session.skillLoaded)) {
    prompt = prompt.slice(session.skillLoaded.length + 1).replace(/^\s+/, "");
  }
  const turn = { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } };
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
  if (msg.resume) send({ type: "resume", sessionId: msg.resume, ok: !!sessionCfg(msg).resume });
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

// Native folder picker (macOS): pops the standard "choose folder" dialog and
// hands back the POSIX path so the user never types the repo path. Cancelling
// the dialog is normal — reply with an empty path and no error.
function pickFolder(msg) {
  const reply = (p, error) => send({ id: msg.id, type: "folder_picked", path: p || "", error });
  const script =
    'POSIX path of (choose folder with prompt "Select the repo or workspace folder for the assistant")';
  execFile("osascript", ["-e", script], { timeout: 120000 }, (err, stdout) => {
    if (err) {
      // -128 = the user pressed Cancel; not a real error.
      const detail = String((err && (err.stderr || err.message)) || "");
      if (/-128|User canceled/i.test(detail)) return reply("");
      return reply("", detail || "folder picker failed");
    }
    // choose folder yields a trailing-slash path; drop it so it reads normally.
    reply(String(stdout || "").trim().replace(/\/+$/, ""));
  });
}

// ==== Video download (right-click on X / Instagram / Facebook posts) ========
//
// Two engines: if `yt-dlp` is on PATH we hand it the post permalink (it picks
// best video+audio, merges via ffmpeg, and can use the logged-in Chrome cookies)
// — that's the robust path. Otherwise we fall back to fetching the best direct
// MP4 URL the extension scraped from the page (works for progressive IG/X video;
// DASH/HLS-only posts can't be merged without yt-dlp, so we say so).

const DOWNLOAD_DIR = process.env.NEXLIFY_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads");
const DL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Chrome spawns the native host with a minimal PATH (no /opt/homebrew/bin), so a
// brew-installed yt-dlp/ffmpeg isn't on it. Prepend the usual bin dirs for any
// tool we shell out to, and probe absolute paths when locating yt-dlp.
const TOOL_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local/bin"),
  process.env.PATH || "/usr/bin:/bin",
].join(":");
const TOOL_ENV = { ...process.env, PATH: TOOL_PATH };

let _ytdlp; // cache: string path | false | undefined(unknown)
function findYtDlp() {
  if (_ytdlp !== undefined) return Promise.resolve(_ytdlp);
  const candidates = [
    process.env.YT_DLP_BIN,
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    path.join(os.homedir(), ".local/bin/yt-dlp"),
    "yt-dlp", // last: whatever PATH we do have
  ].filter(Boolean);
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        _ytdlp = false;
        return resolve(false);
      }
      const bin = candidates[i++];
      execFile(bin, ["--version"], { timeout: 8000, env: TOOL_ENV }, (err) => {
        if (!err) {
          _ytdlp = bin;
          resolve(bin);
        } else tryNext();
      });
    };
    tryNext();
  });
}

function sanitizeName(s) {
  return (
    String(s || "")
      .replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "video"
  );
}

// Pull the post's own id from its URL so files don't collide (IG reels all share
// the generic title "Instagram", which would otherwise overwrite each other).
function idFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m =
      p.match(/\/status\/(\d+)/) ||
      p.match(/\/reels?\/([^/]+)/) ||
      p.match(/\/p\/([^/]+)/) ||
      p.match(/\/tv\/([^/]+)/) ||
      p.match(/\/videos\/(\d+)/) ||
      p.match(/\/watch\/\?v=(\d+)/);
    if (m) return m[1];
  } catch {}
  return "";
}

// A unique, non-clobbering path in DOWNLOAD_DIR for the given base name.
function uniquePath(base) {
  let out = path.join(DOWNLOAD_DIR, base);
  if (!fs.existsSync(out)) return out;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    out = path.join(DOWNLOAD_DIR, `${stem} (${i})${ext}`);
    if (!fs.existsSync(out)) return out;
  }
  return out;
}

// yt-dlp path: best video+audio merged to mp4, using the logged-in Chrome
// cookies. Streams progress lines back; resolves the saved file path.
function downloadWithYtDlp(bin, msg) {
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(DOWNLOAD_DIR, "%(uploader,uploader_id)s-%(title).60B-%(id)s.%(ext)s");
    const args = [
      // Grab the best quality available. -S prefers H.264 + AAC only as a
      // tie-break at EQUAL resolution/fps, so we keep the top resolution (often
      // VP9/AV1 on IG/FB) yet avoid a needless transcode when a same-res H.264
      // exists (common on FB/X). Whatever still lands as VP9/AV1 — which Apple
      // players can't decode — is transcoded to H.264 afterwards (downloadVideo).
      "-f",
      "bv*+ba/b",
      "-S",
      "res,fps,vcodec:h264,acodec:aac",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--no-part",
      "--restrict-filenames",
      "--newline",
      "-o",
      outTmpl,
      "--cookies-from-browser",
      "chrome",
      msg.permalink || msg.pageUrl,
    ];
    let finalPath = "";
    let errTail = "";
    // TOOL_ENV so yt-dlp finds ffmpeg (needed to merge best video+audio).
    const child = spawn(bin, args, { env: TOOL_ENV });
    const onLine = (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const pct = line.match(/\[download\]\s+([\d.]+)%/);
        if (pct) send({ type: "download_progress", id: msg.id, pct: parseFloat(pct[1]), line: line.trim() });
        const dest = line.match(/\[download\] Destination:\s*(.+)$/) || line.match(/Merging formats into "(.+)"$/);
        if (dest) finalPath = dest[1].trim();
        const already = line.match(/\[download\]\s+(.+?) has already been downloaded/);
        if (already) finalPath = already[1].trim();
      }
    };
    child.stdout.on("data", onLine);
    child.stderr.on("data", (d) => {
      errTail = (errTail + d.toString("utf8")).slice(-2000);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve(finalPath || DOWNLOAD_DIR);
      else reject(new Error(errTail.trim().split(/\r?\n/).slice(-1)[0] || `yt-dlp exited ${code}`));
    });
  });
}

// IG/FB stream media in byte ranges — the URL we grabbed may carry a mid-file
// range (bytestart/byteend), which downloads "fine" but is an unplayable fragment.
// Strip those so we ask for the whole file.
function stripRange(u) {
  try {
    const url = new URL(u);
    for (const k of ["bytestart", "byteend", "range"]) url.searchParams.delete(k);
    return url.toString();
  } catch {
    return u;
  }
}

// A real, standalone MP4 begins with an `ftyp` box (size, then "ftyp" at offset
// 4). A mid-stream fragment (`moof`/`mdat`/`sidx`/`styp`) or an HTML error page
// won't — so we can tell a good download from a broken one instead of blindly ✓.
function looksLikeMp4(head) {
  if (!head || head.length < 12) return false;
  const box = head.toString("latin1", 4, 8);
  return box === "ftyp";
}

// A fragmented MP4 (DASH representation) has `moof`/`sidx`/`styp` top-level boxes
// — it's a single-track stream (usually video WITHOUT audio) that QuickTime can't
// open. Detect it by scanning top-level box headers (seek past mdat, don't read
// it) so we reject it instead of handing over a file that won't play. IG reels
// are always this — the honest answer there is yt-dlp (it grabs video+audio and
// merges them into a normal progressive MP4).
function isFragmentedMp4(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(16);
    let off = 0;
    let sawMoov = false;
    for (let boxes = 0; off + 8 <= size && boxes < 60; boxes++) {
      const n = fs.readSync(fd, hdr, 0, 16, off);
      if (n < 8) break;
      let boxSize = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      if (type === "moof" || type === "sidx" || type === "styp") return true; // fragmented
      if (type === "moov") sawMoov = true;
      if (type === "mdat" && sawMoov) return false; // progressive: moov then mdat, no moof
      if (boxSize === 1) boxSize = Number(hdr.readBigUInt64BE(8)); // 64-bit size
      if (boxSize < 8) break;
      off += boxSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

// Fallback: fetch a direct MP4 URL (no external tool). Picks the best candidate,
// skips manifests we can't merge, streams to a file with a browser-like UA +
// Referer, then verifies it's a real MP4 before reporting success.
async function downloadDirect(msg) {
  const cands = [];
  for (const c of msg.directUrls || []) if (c && c.url) cands.push(c.url);
  if (msg.srcUrl) cands.push(msg.srcUrl);
  const isManifest = (u) => /\.(m3u8|mpd)(\?|$)/i.test(u);
  const picked = cands.find((u) => /^https?:/i.test(u) && !isManifest(u));
  if (!picked) {
    const why = cands.some(isManifest)
      ? "this video is DASH/HLS (streamed in segments) — install yt-dlp to merge it: brew install yt-dlp ffmpeg"
      : "no direct video URL found on the page — install yt-dlp for full support: brew install yt-dlp ffmpeg";
    throw new Error(why);
  }
  const direct = stripRange(picked);
  const res = await fetch(direct, {
    // Range: bytes=0- asks for the WHOLE file from the start (some CDNs only serve
    // media to range requests). We validate the container below regardless.
    headers: { "User-Agent": DL_UA, Referer: msg.referer || msg.pageUrl || "", Accept: "*/*", Range: "bytes=0-" },
  });
  if ((!res.ok && res.status !== 206) || !res.body) throw new Error(`fetch failed: HTTP ${res.status}`);
  const id = idFromUrl(msg.permalink) || idFromUrl(msg.pageUrl);
  const stem = sanitizeName(msg.title) + (id ? "-" + id : "");
  const outPath = uniquePath(stem + ".mp4");
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  let lastPct = -1;
  let head = Buffer.alloc(0);
  const ws = fs.createWriteStream(outPath);
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on("data", (chunk) => {
    if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        send({ type: "download_progress", id: msg.id, pct });
      }
    }
  });
  await new Promise((resolve, reject) => {
    nodeStream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    nodeStream.on("error", reject);
  });
  // Reject a fragment / error page saved as .mp4, or a fragmented (DASH) MP4 that
  // won't play / has no audio — so the user isn't handed a broken file with a ✓.
  // Both are the common IG-reel case; the honest fix is yt-dlp.
  const bad =
    !looksLikeMp4(head)
      ? "only got a partial stream, not a full video"
      : isFragmentedMp4(outPath)
        ? "this is a fragmented DASH stream (video only, won't play in QuickTime)"
        : "";
  if (bad) {
    try {
      fs.unlinkSync(outPath);
    } catch {}
    throw new Error(`${bad} — Instagram reels need yt-dlp: brew install yt-dlp ffmpeg`);
  }
  return outPath;
}

// ---- H.264 transcode (Apple-player compatibility) ------------------------
//
// QuickTime / Preview / Photos can't decode VP9 or AV1. IG (and some FB) serve
// their top resolution only in those codecs, so a "best quality" download can
// open black in Apple players even though the file is fine (VLC plays it). We
// keep the full resolution and re-encode the video to H.264 (audio to AAC) so
// it plays everywhere. H.264 downloads are left untouched — no needless re-encode.

const APPLE_INCOMPATIBLE_VCODEC = /^(vp0?8|vp0?9|av0?1)/i; // vp8/vp9/av1 (yt-dlp: vp09/av01)

// codec of the first video stream + container duration (for transcode progress).
function probeVideo(filePath) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", filePath],
      { timeout: 15000, env: TOOL_ENV },
      (err, stdout) => {
        if (err) return resolve({ vcodec: "", duration: 0 });
        try {
          const j = JSON.parse(stdout);
          const vcodec = String((j.streams && j.streams[0] && j.streams[0].codec_name) || "").toLowerCase();
          resolve({ vcodec, duration: parseFloat(j.format && j.format.duration) || 0 });
        } catch {
          resolve({ vcodec: "", duration: 0 });
        }
      },
    );
  });
}

// Re-encode video to H.264 (libx264, crf 18 ≈ visually lossless, veryfast so a
// short reel finishes in a couple of seconds), audio to AAC, faststart for quick
// open. Writes a sibling temp then renames over the original so the filename the
// user sees is unchanged. Streams progress via ffmpeg's -progress pipe.
function transcodeToH264(inPath, durationSec, msg) {
  return new Promise((resolve, reject) => {
    const tmp = inPath.replace(/\.[^.]+$/, "") + ".h264.mp4";
    const args = [
      "-y",
      "-nostdin",
      "-i",
      inPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-v",
      "error",
      tmp,
    ];
    const child = spawn("ffmpeg", args, { env: TOOL_ENV });
    let errTail = "";
    let acc = "";
    child.stdout.on("data", (d) => {
      acc += d.toString("utf8");
      let nl;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const line = acc.slice(0, nl);
        acc = acc.slice(nl + 1);
        const m = line.match(/^out_time=(\d+):(\d+):([\d.]+)/);
        if (m && durationSec > 0) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.max(0, Math.min(99, Math.round((sec / durationSec) * 100)));
          send({ type: "download_progress", id: msg.id, pct, line: `Converting to H.264… ${pct}%` });
        }
      }
    });
    child.stderr.on("data", (d) => {
      errTail = (errTail + d.toString("utf8")).slice(-2000);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          fs.renameSync(tmp, inPath);
        } catch (e) {
          return reject(e);
        }
        resolve(inPath);
      } else {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        reject(new Error(errTail.trim().split(/\r?\n/).slice(-1)[0] || `ffmpeg exited ${code}`));
      }
    });
  });
}

async function downloadVideo(msg) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const bin = await findYtDlp();
    let outPath;
    let engine;
    if (bin) {
      engine = "yt-dlp";
      outPath = await downloadWithYtDlp(bin, msg);
    } else {
      engine = "direct";
      outPath = await downloadDirect(msg);
    }

    // Make VP9/AV1 downloads playable in Apple players without losing resolution.
    // Non-fatal: if the transcode fails we keep the original (still plays in VLC)
    // rather than throwing away a good download.
    try {
      if (outPath && /\.(mp4|mkv|webm|mov|m4v)$/i.test(outPath) && fs.existsSync(outPath)) {
        const { vcodec, duration } = await probeVideo(outPath);
        if (APPLE_INCOMPATIBLE_VCODEC.test(vcodec)) {
          send({ type: "download_progress", id: msg.id, line: `Converting ${vcodec.toUpperCase()} → H.264 (keeping resolution)…` });
          outPath = await transcodeToH264(outPath, duration, msg);
          engine += " → H.264";
        }
      }
    } catch (e) {
      log("transcode failed, keeping original:", (e && e.message) || e);
    }

    send({ type: "download_result", id: msg.id, ok: true, path: outPath, engine });
  } catch (e) {
    send({ type: "download_result", id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
}

function handle(msg) {
  if (msg.type === "cancel") cancel(msg.id);
  else if (msg.type === "tool_result") toolResult(msg);
  else if (msg.type === "prewarm") prewarm(msg);
  else if (msg.type === "reset") reset(msg);
  else if (msg.type === "shop_summary") shopSummary(msg);
  else if (msg.type === "pick_folder") pickFolder(msg);
  else if (msg.type === "download_video") downloadVideo(msg);
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
    // Leave PUBLIC_SOCK's file in place — a newer host may now own that path;
    // the next startup clears a truly-stale one.
    if (publicServer) publicServer.close();
  } catch {}
  process.exit(0);
});

log("started; sock=" + SOCK);
