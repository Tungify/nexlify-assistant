"use strict";

// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited), zero deps.
// Claude Code spawns this and discovers two tools. When a tool is called, we
// forward it over a unix socket to host.js, which relays it to the browser
// extension to run against the live DOM, and returns the result.

const net = require("net");

// When host.js spawns us it sets FB_BRIDGE_SOCK to its private per-session
// socket. Run standalone (e.g. added to an external Claude Code CLI) with
// neither set and we fall back to the well-known public bridge socket that
// host.js also listens on — so an outside CLI reaches the live extension.
const SOCK = process.env.FB_BRIDGE_SOCK || require("./bridge-sock");
const PROTOCOL = "2024-11-05";

// Full catalog. The host narrows it per session via FB_TOOLS (see ACTIVE_TOOLS)
// so only the tools the user enabled in settings are advertised/callable.
const TOOLS = [
  // ---- read ----
  {
    name: "get_page",
    description:
      "Read the browser tab the user is currently looking at. Returns { url, title, text } where text is the page's visible text. Use this to see the Featurebase conversation / page content.",
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "number", description: "Max characters of body text (default 6000)." },
      },
    },
  },
  {
    name: "query_dom",
    description:
      "Query the current tab's DOM with a CSS selector. Returns { count, matches } — the innerText (or outerHTML if html=true) of matched elements. Use for targeted extraction and to find selectors before clicking/typing.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector." },
        limit: { type: "number", description: "Max elements (default 20)." },
        html: { type: "boolean", description: "Return outerHTML instead of text (useful to discover attributes/selectors)." },
      },
      required: ["selector"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the VISIBLE area of the current tab and return it as an image you can actually look at. Use when the DOM/text isn't enough — to check layout, rendering, canvas/image content, or to confirm a UI state visually.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["jpeg", "png"], description: "Image format (default jpeg — smaller; use png for crisp text/UI)." },
        quality: { type: "number", description: "JPEG quality 0-100 (default 80; ignored for png)." },
      },
    },
  },
  // ---- control (write) ----
  {
    name: "click",
    description:
      "Click an element in the current tab (fires mousedown/mouseup + a real click, so navigation/submit and React handlers all run). Find the selector with query_dom first if unsure.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." },
        nth: { type: "number", description: "0-based index when the selector matches several (default 0)." },
      },
      required: ["selector"],
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an <input>/<textarea> or a contenteditable rich editor (e.g. a reply box). Dispatches the events frameworks expect. Set replace=true to overwrite existing content, submit=true to press Enter / submit the form afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the field." },
        text: { type: "string", description: "Text to enter." },
        replace: { type: "boolean", description: "Clear the field first (default false = append)." },
        submit: { type: "boolean", description: "Press Enter / requestSubmit after typing (default false)." },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "press_key",
    description:
      "Dispatch a single keyboard key to an element (or the focused element). Use for Enter, Escape, Tab, Backspace, Arrow keys, etc.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown", or a single character.' },
        selector: { type: "string", description: "Optional target selector; defaults to the active element." },
      },
      required: ["key"],
    },
  },
  {
    name: "scroll_to",
    description: "Scroll an element into view (center of the viewport).",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector." } },
      required: ["selector"],
    },
  },
  {
    name: "wait_for",
    description:
      "Wait until an element appears/becomes visible/disappears (polls up to timeoutMs). Use after a click that triggers async UI before reading or acting again.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector." },
        state: { type: "string", enum: ["present", "visible", "gone"], description: 'Target state (default "present").' },
        timeoutMs: { type: "number", description: "Max wait in ms (default 5000, capped 30000)." },
      },
      required: ["selector"],
    },
  },
  // ---- debug (console + network capture; the CDP debugger attaches the first
  // time you call one of these, so capturing starts NOW — to observe a request
  // that fires on an action, call get_network_requests once first, then do the
  // action, then read again) ----
  {
    name: "get_console_logs",
    description:
      "Read recent console output captured from the active tab (console.*, uncaught errors, and browser log entries like CORS/CSP/mixed-content). Capturing begins when this is first called. Use to debug why something failed on the page.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: 'Filter by level prefix, e.g. "error", "warn", "info".' },
        contains: { type: "string", description: "Only entries whose text contains this substring." },
        limit: { type: "number", description: "Max entries, newest last (default 100)." },
      },
    },
  },
  {
    name: "get_network_requests",
    description:
      "List network requests captured from the active tab (method, URL, status, type). Capturing begins when this is first called, so to catch a request triggered by an action (e.g. a beacon on navigation/unload), call this once to start capturing, perform the action, then call it again. Filter to narrow down, then get_network_request for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Only requests whose URL contains this substring." },
        method: { type: "string", description: "HTTP method filter, e.g. POST." },
        status: { type: "number", description: "Exact HTTP status filter." },
        failedOnly: { type: "boolean", description: "Only failed requests or status >= 400." },
        resourceType: { type: "string", description: 'e.g. "XHR", "Fetch", "Script", "Document".' },
        limit: { type: "number", description: "Max requests, newest last (default 50)." },
      },
    },
  },
  {
    name: "get_network_request",
    description:
      "Full detail for one captured request by id (from get_network_requests): request headers + body, response headers + body, status, and any error. Bodies are fetched on demand and may be unavailable if evicted.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The request id from get_network_requests." } },
      required: ["id"],
    },
  },
  // ---- browser / tab control ----------------------------------------------
  // Manage tabs and navigation for the whole window (not the page DOM). The page
  // tools (get_page/query_dom/click/…) and the console/network capture always
  // act on the ACTIVE tab, so open_tab / switch_tab change what they read next.
  {
    name: "list_tabs",
    description:
      "List the browser's open tabs — { id, url, title, active, windowId, status, index }. Use it to find a tab's id before switch_tab / close_tab / navigate, or to see what the user has open. Defaults to the current window.",
    inputSchema: {
      type: "object",
      properties: {
        allWindows: { type: "boolean", description: "Include tabs from every window, not just the current one (default false)." },
      },
    },
  },
  {
    name: "open_tab",
    description:
      "Open a new browser tab, optionally at a URL, and (by default) make it active so the page/debug tools act on it next. Waits for the page to finish loading before returning.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open — include the scheme, e.g. https://example.com. Omit for a blank tab." },
        active: { type: "boolean", description: "Focus the new tab (default true); false opens it in the background." },
        waitForLoad: { type: "boolean", description: "Wait until the tab finishes loading before returning (default true)." },
      },
    },
  },
  {
    name: "close_tab",
    description:
      "Close a tab by id (from list_tabs). If no id is given, closes the ACTIVE tab. Use with care — this closes the user's tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Id of the tab to close (default: the active tab)." },
      },
    },
  },
  {
    name: "switch_tab",
    description:
      "Make a tab active (and focus its window). Afterwards get_page / query_dom / click / console / network all act on that tab. Get the id from list_tabs.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Id of the tab to activate." } },
      required: ["tabId"],
    },
  },
  {
    name: "navigate",
    description:
      "Navigate a tab to a URL (defaults to the active tab). Waits for the load to finish so you can read the new page immediately after. Use this to go straight to a URL instead of clicking a link.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination URL — include the scheme (https://…)." },
        tabId: { type: "number", description: "Tab to navigate (default: the active tab)." },
        waitForLoad: { type: "boolean", description: "Wait until loading finishes before returning (default true)." },
      },
      required: ["url"],
    },
  },
  {
    name: "reload_tab",
    description:
      "Reload a tab (defaults to the active tab). Handy to re-trigger requests / console output while capture is on.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab to reload (default: the active tab)." },
        bypassCache: { type: "boolean", description: "Hard reload, ignoring the cache (default false)." },
        waitForLoad: { type: "boolean", description: "Wait until loading finishes before returning (default true)." },
      },
    },
  },
  {
    name: "go_back",
    description: "Go back one entry in a tab's history (defaults to the active tab).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab (default: the active tab)." },
        waitForLoad: { type: "boolean", description: "Wait until loading finishes before returning (default true)." },
      },
    },
  },
  {
    name: "go_forward",
    description: "Go forward one entry in a tab's history (defaults to the active tab).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab (default: the active tab)." },
        waitForLoad: { type: "boolean", description: "Wait until loading finishes before returning (default true)." },
      },
    },
  },
];

// The host sets FB_TOOLS to the comma-separated names it enabled for this
// session; advertise/allow only those. Unset (e.g. run standalone) = all tools.
const ENABLED = (process.env.FB_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ACTIVE_TOOLS = ENABLED.length ? TOOLS.filter((t) => ENABLED.includes(t.name)) : TOOLS;

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
      return reject(
        new Error("browser bridge not connected (open the Nexlify Assistant side panel in Chrome): " + e.message),
      );
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
      reply(id, { tools: ACTIVE_TOOLS });
      break;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!ACTIVE_TOOLS.some((t) => t.name === name)) {
        return replyError(id, -32602, "unknown tool: " + name);
      }
      try {
        const data = await callTool(name, args);
        if (name === "screenshot" && data && data.base64) {
          reply(id, { content: [{ type: "image", data: data.base64, mimeType: data.mimeType || "image/jpeg" }] });
        } else {
          reply(id, { content: [{ type: "text", text: JSON.stringify(data) }] });
        }
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
