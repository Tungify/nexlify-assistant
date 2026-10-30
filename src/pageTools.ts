// In-page tools: read + control the live tab, plus the visible-area screenshot.
// Shared by the side-panel bridge AND the background service worker so both run
// identical logic — that's what lets the browser tools work with the side panel
// CLOSED (the worker owns the public bridge socket external CLIs connect to).
//
// domTool() is serialized by chrome.scripting and runs INSIDE the page, so it
// must stay fully self-contained — no references to anything outside it.

import { activeTab } from "./tabTools";

// CSS selector for Featurebase's open-conversation panel. Point this at the real
// thread container (right-click the conversation → Inspect → copy selector) so
// get_page reads ONLY the conversation, not the ticket-list sidebar or nav.
// Empty string = fall back to <main> / [role=main] / <article>.
export const FB_CONVO_SELECTOR = "";

// Mirrors host.js's PAGE_TOOLS group. Two members don't go through domTool:
// "screenshot" is routed to captureVisibleTab, "run_js" to runJs (it needs its
// own world/engine handling — see the run_js section at the bottom).
export const PAGE_TOOLS = new Set([
  "get_page",
  "query_dom",
  "screenshot",
  "click",
  "type_text",
  "press_key",
  "scroll_to",
  "wait_for",
  "run_js",
]);

// Runs INSIDE the inspected page (serialized by chrome.scripting). Must be
// fully self-contained — no references to anything outside this function, so
// the Featurebase selector is threaded in as an argument. Async so wait_for can
// poll; chrome.scripting resolves the returned promise.
async function domTool(tool: string, args: Record<string, unknown>, fbSelector: string): Promise<unknown> {
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);
  // Collapse the whitespace noise you get from innerText dumps.
  const clean = (s: string) =>
    s
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  // Prefer the Featurebase conversation panel, then the main content region.
  const convoEl = () => {
    for (const sel of [fbSelector, "main", "[role='main']", "article"]) {
      if (!sel) continue;
      try {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el && (el.innerText ?? "").trim().length > 40) return el;
      } catch {
        /* invalid selector — skip */
      }
    }
    return document.body;
  };
  const one = (sel: string) => {
    try {
      return document.querySelector(sel) as HTMLElement | null;
    } catch {
      return null;
    }
  };

  // ---- reads --------------------------------------------------------------

  if (tool === "get_page") {
    const max = typeof args.maxChars === "number" ? (args.maxChars as number) : 6000;
    return { url: location.href, title: document.title, text: cap(clean(convoEl()?.innerText ?? ""), max) };
  }

  if (tool === "query_dom") {
    const selector = String(args.selector ?? "");
    const limit = typeof args.limit === "number" ? (args.limit as number) : 20;
    const wantHtml = args.html === true;
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector)).slice(0, limit);
    } catch {
      return { error: "invalid selector: " + selector };
    }
    return {
      count: nodes.length,
      matches: nodes.map((el) =>
        wantHtml ? cap((el as HTMLElement).outerHTML, 4000) : cap((el as HTMLElement).innerText ?? "", 2000),
      ),
    };
  }

  // ---- writes / control ---------------------------------------------------

  if (tool === "click") {
    const selector = String(args.selector ?? "");
    const nth = typeof args.nth === "number" ? (args.nth as number) : 0;
    let els: Element[] = [];
    try {
      els = selector ? Array.from(document.querySelectorAll(selector)) : [];
    } catch {
      return { ok: false, error: "invalid selector: " + selector };
    }
    const el = els[nth] as HTMLElement | undefined;
    if (!el) return { ok: false, error: `no element to click (${els.length} matched)`, selector };
    el.scrollIntoView({ block: "center", inline: "center" });
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* not focusable */
    }
    const mo = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", mo));
    el.dispatchEvent(new MouseEvent("mouseup", mo));
    el.click(); // real click → default action (navigation / submit) + handlers
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").slice(0, 120),
    };
  }

  if (tool === "type_text") {
    const selector = String(args.selector ?? "");
    const text = String(args.text ?? "");
    const replace = args.replace === true;
    const submit = args.submit === true;
    const el = one(selector);
    if (!el) return { ok: false, error: "no element for selector", selector };
    el.scrollIntoView({ block: "center" });
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // Use the native setter so React's onChange sees the value (a plain
      // `.value =` is swallowed by React's controlled-input tracker).
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = replace ? text : (input.value ?? "") + text;
      if (setter) setter.call(input, next);
      else input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (replace) {
        // Select everything, then delete it, so the field starts empty.
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("delete");
      } else {
        // Caret to the end so we append.
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      // execCommand("insertText") drives the browser's editing pipeline, which
      // rich editors (ProseMirror/Slate/Lexical/Draft) listen to via beforeinput.
      const ok = document.execCommand("insertText", false, text);
      if (!ok) {
        el.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }),
        );
        el.textContent = (replace ? "" : el.textContent ?? "") + text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    } else {
      return { ok: false, error: `<${tag}> is not typeable (need input/textarea/contenteditable)` };
    }
    if (submit) {
      const kev = (t: string) =>
        new KeyboardEvent(t, {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        } as KeyboardEventInit);
      el.dispatchEvent(kev("keydown"));
      el.dispatchEvent(kev("keypress"));
      el.dispatchEvent(kev("keyup"));
      const form = el.closest("form");
      if (form) {
        try {
          (form as HTMLFormElement).requestSubmit();
        } catch {
          /* no submit button / not submittable */
        }
      }
    }
    const value = (el as HTMLInputElement).value ?? el.textContent ?? "";
    return { ok: true, tag, submitted: submit, value: String(value).slice(0, 200) };
  }

  if (tool === "press_key") {
    const selector = args.selector ? String(args.selector) : "";
    const key = String(args.key ?? "");
    if (!key) return { ok: false, error: "key required" };
    const target = (selector ? one(selector) : (document.activeElement as HTMLElement) || document.body) as HTMLElement | null;
    if (!target) return { ok: false, error: "no target element", selector };
    const CODES: Record<string, number> = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
      Delete: 46,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      Space: 32,
    };
    const k = key === "Space" ? " " : key;
    const code = k.length === 1 ? (/[a-z]/i.test(k) ? "Key" + k.toUpperCase() : "Digit" + k) : key;
    const kc = CODES[key] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    const mk = (t: string) =>
      new KeyboardEvent(t, { bubbles: true, cancelable: true, key: k, code, keyCode: kc, which: kc } as KeyboardEventInit);
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    target.dispatchEvent(mk("keydown"));
    target.dispatchEvent(mk("keypress"));
    target.dispatchEvent(mk("keyup"));
    return { ok: true, key: k };
  }

  if (tool === "scroll_to") {
    const selector = String(args.selector ?? "");
    const el = one(selector);
    if (!el) return { ok: false, error: "no element for selector", selector };
    el.scrollIntoView({ block: "center", inline: "center" });
    return { ok: true };
  }

  if (tool === "wait_for") {
    const selector = String(args.selector ?? "");
    const timeout = typeof args.timeoutMs === "number" ? Math.min(args.timeoutMs as number, 30000) : 5000;
    const state = String(args.state ?? "present"); // present | visible | gone
    const start = Date.now();
    const hit = () => {
      const el = one(selector);
      if (state === "gone") return !el;
      if (!el) return false;
      if (state === "visible") {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      }
      return true;
    };
    while (Date.now() - start < timeout) {
      if (hit()) return { ok: true, waitedMs: Date.now() - start };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, error: `timeout after ${timeout}ms waiting for "${state}": ${selector}` };
  }

  return { error: "unknown tool: " + tool };
}

// ---- callers (side panel + service worker) --------------------------------

// Run one in-page tool against a KNOWN tab. Split out so the panel can light up
// its "AI is driving" overlay on that same tab before the action lands.
export async function runPageToolOn(
  tabId: number,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (tool === "run_js") return await runJs(tabId, args);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: domTool,
    args: [tool, args, FB_CONVO_SELECTOR],
  });
  return res?.result;
}

// Run one page tool against the tab the user is looking at right now.
export async function runPageTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (tool === "screenshot") return await screenshotTab(args);
  const tabId = (await activeTab())?.id;
  if (tabId == null) throw new Error("no active tab");
  return await runPageToolOn(tabId, tool, args);
}

// ==== run_js ===============================================================
//
// Arbitrary JavaScript in the live tab — the DevTools console the assistant
// never had. Three decisions make it work on real pages:
//
//   • The code is INLINED into the injected source instead of being eval'd, so
//     Chrome's userScripts API can run it in the page's OWN world even when the
//     page's CSP forbids 'unsafe-eval'. That's the preferred engine.
//   • When that API isn't allowed (its per-extension "Allow user scripts" toggle
//     is off) we fall back to chrome.scripting + `new Function`, and if the page
//     CSP kills that, to the extension's ISOLATED world — reported in `note`,
//     because there the site's own `window.*` globals aren't visible.
//   • Async code parks its result in a page-side slot that we poll, so we never
//     depend on Chrome awaiting a promise across the injection boundary.
//
// Values come back serialized (see nxRunner): DOM nodes, errors, Map/Set and
// friends become readable stand-ins, with depth/size caps so a stray `document`
// can't flood the model's context.

type JsWorld = "main" | "isolated";
type JsEngine = "userScripts" | "scripting";

interface JsLimits {
  depth: number; // object nesting kept
  items: number; // array/collection entries kept
  chars: number; // per-string cap
  logs: number; // console lines kept
  total: number; // whole-result cap (JSON chars)
  timeoutMs: number;
}

// Statement keywords: code starting with one of these can't be wrapped as a
// single expression (see looksLikeExpression).
const JS_STATEMENT_START =
  /^(?:const|let|var|function|class|if|for|while|do|switch|try|throw|return|import|export|debugger)\b/;

const JS_ISOLATED_NOTE =
  "This page's Content-Security-Policy blocked evaluating code in the page's own JS world, so it ran in the " +
  "extension's isolated world instead: the DOM, cookies, localStorage/sessionStorage and fetch are still the " +
  'page\'s, but variables the site defines on `window` are NOT visible there. To run in the page world on such ' +
  'pages, turn on "Allow user scripts" for Nexlify Assistant at chrome://extensions (extension details).';

// Runs INSIDE the page. Injected as SOURCE TEXT (buildRunSource splices its
// .toString() into the expression it builds), so — like domTool — it must be
// fully self-contained: no references to anything outside this function.
//
// `body` is the user's code already wrapped in a function. Returns the finished
// result for sync code, or { pending: id } after parking an async result on
// window.__nxRunJs[id] for the caller to poll.
function nxRunner(body: () => unknown, id: string, o: JsLimits): unknown {
  const cap = (s: string) => (s.length > o.chars ? s.slice(0, o.chars) + "…[truncated]" : s);
  const kind = (v: unknown): string => {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    const t = typeof v;
    if (t !== "object") return t;
    try {
      const c = (v as object).constructor;
      if (c && c.name) return c.name;
    } catch {
      /* null-prototype object */
    }
    return "object";
  };

  // JSON-safe view of any value.
  const ser = (v: unknown, d: number, seen: unknown[]): unknown => {
    if (v === undefined) return "[undefined]"; // JSON drops a bare undefined
    if (v === null) return null;
    const t = typeof v;
    if (t === "string") return cap(v as string);
    if (t === "number") return Number.isFinite(v as number) ? v : String(v);
    if (t === "boolean") return v;
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return String(v);
    if (t === "function") return "[function " + ((v as { name?: string }).name || "anonymous") + "]";
    if (seen.indexOf(v) >= 0) return "[circular]";
    const k = kind(v);
    const any = v as Record<string, any>;

    if (typeof window !== "undefined" && v === window) return "[Window]";
    if (typeof Node !== "undefined" && v instanceof Node) {
      if ((v as Node).nodeType !== 1) return "[" + k + "]"; // text node, document, fragment…
      const el = v as unknown as HTMLElement;
      const out: Record<string, unknown> = { el: el.tagName ? el.tagName.toLowerCase() : k };
      if (el.id) out.id = el.id;
      const cls = el.getAttribute("class");
      if (cls) out.class = cls.slice(0, 200);
      for (const a of ["href", "src", "value", "type", "name", "aria-label"]) {
        const val = el.getAttribute ? el.getAttribute(a) : null;
        if (val) {
          out[a] = val.slice(0, 300);
          break;
        }
      }
      const txt = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt) out.text = txt.slice(0, 300);
      return out;
    }
    if (v instanceof Error) {
      return {
        error: (v.name || "Error") + ": " + v.message,
        stack: String(v.stack || "").split("\n").slice(0, 4).join("\n"),
      };
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Promise !== "undefined" && v instanceof Promise) return "[Promise]";
    if (d >= o.depth) return "[" + k + "]";

    const next = seen.concat([v]);
    const listOf = (rows: unknown[], total: number) => {
      const out = rows.slice(0, o.items).map((x) => ser(x, d + 1, next));
      if (total > o.items) out.push("…" + (total - o.items) + " more (of " + total + ")");
      return out;
    };
    if (Array.isArray(v)) return listOf(v, v.length);
    if (typeof Map !== "undefined" && v instanceof Map) {
      const rows = Array.from(v.entries()).map(([mk, mv]) => [ser(mk, d + 1, next), ser(mv, d + 1, next)]);
      return { Map: rows.slice(0, o.items), size: v.size };
    }
    if (typeof Set !== "undefined" && v instanceof Set) return { Set: listOf(Array.from(v.values()), v.size) };
    // NodeList / HTMLCollection / DOMTokenList / arguments — array-like.
    if (typeof any.length === "number" && (typeof any.item === "function" || k === "Arguments")) {
      return listOf(Array.prototype.slice.call(any), any.length);
    }
    if (any.buffer && typeof any.byteLength === "number") return "[" + k + " byteLength=" + any.byteLength + "]";

    let keys: string[] = [];
    try {
      keys = Object.keys(any); // own enumerable only — a DOM object's prototype chain is endless
    } catch {
      /* exotic object */
    }
    if (!keys.length) {
      let s = "";
      try {
        s = String(v);
      } catch {
        s = "";
      }
      return s && s !== "[object Object]" ? "[" + k + ": " + cap(s) + "]" : k === "object" ? {} : "[" + k + "]";
    }
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, o.items)) {
      try {
        out[key] = ser(any[key], d + 1, next);
      } catch (e) {
        out[key] = "[getter threw: " + String(e) + "]";
      }
    }
    if (keys.length > o.items) out["…"] = keys.length - o.items + " more keys";
    return out;
  };

  // ---- console capture (so a habitual console.log still tells us something) --
  const logs: string[] = [];
  const fmtArg = (a: unknown) => {
    if (typeof a === "string") return cap(a);
    const s = ser(a, 1, []);
    if (typeof s === "string") return s;
    try {
      return JSON.stringify(s) ?? String(a);
    } catch {
      return String(a);
    }
  };
  const con = console as unknown as Record<string, any>;
  const METHODS = ["log", "info", "warn", "error", "debug"];
  const saved: Record<string, any> = {};
  let patched = false;
  const patch = () => {
    if (con.log && con.log.__nx) return; // an outer run_js already owns the console
    for (const m of METHODS) {
      const orig = con[m];
      saved[m] = orig;
      const wrapped: any = function (...a: unknown[]) {
        if (logs.length < o.logs) logs.push((m === "log" ? "" : m + ": ") + a.map(fmtArg).join(" "));
        else if (logs.length === o.logs) logs.push("…more console output suppressed");
        try {
          orig.apply(console, a);
        } catch {
          /* keep going */
        }
      };
      wrapped.__nx = true;
      con[m] = wrapped;
    }
    patched = true;
  };
  const restore = () => {
    if (!patched) return;
    patched = false;
    for (const m of METHODS) con[m] = saved[m];
  };

  const withLogs = (r: Record<string, unknown>) => {
    if (logs.length) r.logs = logs;
    return r;
  };
  const finish = (v: unknown) => {
    const r = ser(v, 0, []);
    let text = "";
    try {
      text = JSON.stringify(r) ?? "";
    } catch {
      text = "";
    }
    if (text.length > o.total) {
      return withLogs({
        ok: true,
        type: kind(v),
        truncated: true,
        size: text.length,
        result: text.slice(0, o.total) + "…[truncated — return less data, or raise maxTotalChars]",
      });
    }
    return withLogs({ ok: true, type: kind(v), result: r });
  };
  const fail = (e: unknown) => {
    const err = e as { name?: string; message?: string; stack?: string };
    return withLogs({
      ok: false,
      error: err && err.message ? (err.name || "Error") + ": " + err.message : String(e),
      stack: err && err.stack ? String(err.stack).split("\n").slice(0, 5).join("\n") : undefined,
    });
  };

  patch();
  let out: unknown;
  try {
    out = body();
  } catch (e) {
    restore();
    return fail(e);
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    const w = window as unknown as { __nxRunJs?: Record<string, unknown> };
    const slot = w.__nxRunJs || (w.__nxRunJs = {});
    slot[id] = { pending: true };
    const settle = (r: unknown) => {
      restore();
      const cur = slot[id] as { pending?: boolean } | undefined;
      if (cur && cur.pending) slot[id] = r;
    };
    (out as Promise<unknown>).then(
      (v) => settle(finish(v)),
      (e) => settle(fail(e)),
    );
    // Safety net: don't leave the console patched (or the slot pending) forever
    // if the promise never settles.
    setTimeout(
      () => settle(withLogs({ ok: false, error: "timed out after " + o.timeoutMs + "ms — the code never settled" })),
      o.timeoutMs,
    );
    return { pending: id };
  }
  restore();
  return finish(out);
}

// The only thing chrome.scripting can inject is a function, so this shim
// compiles our assembled source inside the page. That `new Function` is exactly
// what a page CSP without 'unsafe-eval' rejects — hence the engine ladder.
function nxEval(src: string): unknown {
  return new Function("return " + src)();
}

// Chrome ≥135. Present only when the user allowed user scripts for this
// extension, so it's typed locally and probed at call time.
interface UserScriptsApi {
  execute(injection: {
    target: { tabId: number };
    js: { code: string }[];
    world?: "MAIN" | "USER_SCRIPT";
  }): Promise<{ result?: unknown; error?: unknown }[]>;
}

let userScriptsBlocked = false; // set once Chrome tells us the API isn't allowed

function userScriptsApi(): UserScriptsApi | null {
  if (userScriptsBlocked) return null;
  try {
    const api = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
    return api && typeof api.execute === "function" ? api : null;
  } catch {
    return null; // touching the namespace throws when it isn't allowed
  }
}

// Evaluate one source string in a tab and hand back its completion value.
async function injectSource(tabId: number, world: JsWorld, engine: JsEngine, src: string): Promise<unknown> {
  if (engine === "userScripts") {
    const api = userScriptsApi();
    if (!api) throw new Error("the userScripts API isn't available");
    let res: { result?: unknown; error?: unknown }[];
    try {
      res = await api.execute({
        target: { tabId },
        world: world === "main" ? "MAIN" : "USER_SCRIPT",
        js: [{ code: src }],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Allow user scripts" is off / developer mode is off → stop trying it.
      if (/user script|developer mode|not allowed|permission/i.test(msg)) userScriptsBlocked = true;
      throw e;
    }
    const first = res && res[0];
    if (first && first.error) throw new Error(String(first.error));
    return first ? first.result : undefined;
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: world === "main" ? "MAIN" : "ISOLATED",
    func: nxEval,
    args: [src],
  });
  return res?.result;
}

// DevTools ergonomics: a bare one-liner is returned as its value; anything with
// statements runs as a function body where you `return` what you want.
function looksLikeExpression(code: string): boolean {
  const t = code.trim();
  if (!t || t.includes("\n") || t.includes(";")) return false;
  return !JS_STATEMENT_START.test(t);
}

// Assemble the source to inject, plus the line offset at which the user's code
// lands in it — cleanStack subtracts that so a reported line number means the
// line the caller actually wrote.
function buildRunSource(code: string, id: string, o: JsLimits, form: "expr" | "body"): { src: string; offset: number } {
  const asy = /\bawait\b/.test(code) ? "async " : ""; // sync code skips the polling round-trip
  const head = `(${nxRunner.toString()})(${asy}function () {\n` + (form === "expr" ? "return (\n" : "");
  const tail = (form === "expr" ? "\n);" : "") + `\n}, ${JSON.stringify(id)}, ${JSON.stringify(o)})`;
  return { src: head + code + tail, offset: head.split("\n").length - 1 };
}

// Rewrite an in-page stack so it reads against the caller's own snippet: drop the
// injection wrapper's eval preamble and shift line numbers back by `offset`.
function cleanStack(stack: string, offset: number): string {
  return stack
    .replace(/eval at [^,]*, /g, "")
    .replace(/<anonymous>:(\d+):(\d+)/g, (_m, l: string, c: string) => `your code:${Math.max(1, Number(l) - offset)}:${c}`);
}

function isSyntaxError(msg: string): boolean {
  return /SyntaxError|Unexpected (token|identifier|end of input|string)|Illegal return/i.test(msg);
}

// Wait out an async run by polling the page-side slot the runner parked.
async function awaitSlot(
  tabId: number,
  world: JsWorld,
  engine: JsEngine,
  id: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const key = JSON.stringify(id);
  const readSrc =
    `(function () { var s = window.__nxRunJs; if (!s) return null; var r = s[${key}];` +
    ` if (r && !r.pending) delete s[${key}]; return r || null; })()`;
  const deadline = Date.now() + timeoutMs + 1500;
  let wait = 60; // back off so a long-running snippet isn't polled hundreds of times
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(400, Math.round(wait * 1.4));
    let cur: unknown;
    try {
      cur = await injectSource(tabId, world, engine, readSrc);
    } catch (e) {
      return { ok: false, error: "lost the page while awaiting the result: " + (e instanceof Error ? e.message : String(e)) };
    }
    const rec = cur as Record<string, unknown> | null;
    if (!rec) return { ok: false, error: "the page navigated away before the code finished" };
    if (!rec.pending) return rec;
  }
  return { ok: false, error: `timed out after ${timeoutMs}ms waiting for the code to finish` };
}

// Run arbitrary JS in one tab. Never throws for a fault in the USER's code (that
// comes back as { ok: false, error }); it throws only when we couldn't run
// anything at all in the tab.
export async function runJs(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) return { ok: false, error: "code required" };
  const wantWorld: JsWorld = args.world === "isolated" ? "isolated" : "main";
  const int = (v: unknown, dflt: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt;
  const o: JsLimits = {
    depth: int(args.maxDepth, 4, 1, 8),
    items: int(args.maxItems, 100, 1, 2000),
    chars: int(args.maxChars, 4000, 100, 200000),
    logs: 40,
    total: int(args.maxTotalChars, 30000, 500, 400000),
    // Capped well under mcp-server's 30s call timeout.
    timeoutMs: int(args.timeoutMs, 8000, 100, 25000),
  };
  const id = "js" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const forms: ("expr" | "body")[] = looksLikeExpression(code) ? ["expr", "body"] : ["body"];

  // Engine ladder, best first. The last rung only exists for the default
  // (page-world) request: it trades the site's globals for working at all.
  const plans: { engine: JsEngine; world: JsWorld; note?: string }[] = [];
  if (userScriptsApi()) plans.push({ engine: "userScripts", world: wantWorld });
  plans.push({ engine: "scripting", world: wantWorld });
  if (wantWorld === "main") plans.push({ engine: "scripting", world: "isolated", note: JS_ISOLATED_NOTE });

  const started = Date.now();
  let lastErr = "";
  for (const plan of plans) {
    for (let i = 0; i < forms.length; i++) {
      const last = i === forms.length - 1;
      const { src, offset } = buildRunSource(code, id, o, forms[i]);
      let raw: unknown;
      try {
        raw = await injectSource(tabId, plan.world, plan.engine, src);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        // Broken user code: the other wrapper may parse, but no other engine
        // will — don't burn the ladder on it.
        if (isSyntaxError(msg)) {
          if (!last) continue;
          return { ok: false, error: msg, engine: plan.engine, world: plan.world };
        }
        break; // injection refused (CSP / no access) → next engine
      }
      const rec = raw as Record<string, unknown> | null | undefined;
      if (!rec || typeof rec !== "object") {
        lastErr = `the page returned no result (${String(rec)})`;
        break;
      }
      let out = rec;
      if (typeof rec.pending === "string") out = await awaitSlot(tabId, plan.world, plan.engine, id, o.timeoutMs);
      // A SyntaxError the runner caught in-page — same story as above.
      if (out.ok === false && !last && typeof out.error === "string" && isSyntaxError(out.error)) continue;
      // The scripting engine compiles our source with `new Function`, and V8
      // prepends "function anonymous(\n) {\n" to that body — two more lines to
      // discount when we map a stack back onto the caller's snippet.
      if (typeof out.stack === "string") {
        out = { ...out, stack: cleanStack(out.stack, offset + (plan.engine === "scripting" ? 2 : 0)) };
      }
      // A silent `undefined` is the classic run_js surprise — say what to do.
      const hint =
        out.ok === true && out.type === "undefined" && !/\breturn\b/.test(code)
          ? "The code produced no value because it never returns one — add a `return` (or pass a single expression) to get data back."
          : "";
      return {
        ...out,
        engine: plan.engine,
        world: plan.world,
        tookMs: Date.now() - started,
        ...(hint ? { hint } : {}),
        ...(plan.note ? { note: plan.note } : {}),
      };
    }
  }
  throw new Error(
    `couldn't run JavaScript in this tab: ${lastErr || "injection refused"}. ` +
      `If the page's CSP blocks eval, turn on "Allow user scripts" for Nexlify Assistant at ` +
      `chrome://extensions (extension details) — run_js then uses Chrome's userScripts API, which needs no eval.`,
  );
}

// Screenshot the visible area of the active tab and hand it back as image bytes
// (mcp-server turns this into an MCP image block).
export async function screenshotTab(
  args: Record<string, unknown>,
): Promise<{ base64: string; mimeType: string }> {
  const tab = await activeTab();
  if (tab?.windowId == null) throw new Error("no active tab");
  const format = args.format === "png" ? "png" : "jpeg";
  const quality = typeof args.quality === "number" ? args.quality : 80;
  const opts = format === "jpeg" ? ({ format: "jpeg", quality } as const) : ({ format: "png" } as const);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
  const comma = dataUrl.indexOf(",");
  return {
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
  };
}
