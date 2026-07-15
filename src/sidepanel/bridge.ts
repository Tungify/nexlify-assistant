// Bridge between the side panel and the native host (com.nexlify.assistant).
//
// Outbound: chat requests {id, cli, prompt, page, capture, repoPath, …}.
// Inbound:  streamed events (chunk / tool_use / stderr / error / done) AND
//           tool_request messages — when the CLI calls a browser tool, the host
//           asks us to run it and we post the result back. Read/control tools
//           run in the active tab via chrome.scripting; the debug tools read the
//           CDP capture buffer (see capture.ts).

import { Capture, type CaptureStatus } from "./capture";
import { drive } from "./drive";
import { TAB_TOOLS, runTabTool, activeTab } from "../tabTools";

const HOST_NAME = "com.nexlify.assistant";

// CSS selector for Featurebase's open-conversation panel. Point this at the real
// thread container (right-click the conversation → Inspect → copy selector) so
// get_page reads ONLY the conversation, not the ticket-list sidebar or nav.
// Empty string = fall back to <main> / [role=main] / <article>.
const FB_CONVO_SELECTOR = "";

// Host of the Featurebase inbox/admin app. The merchant summary card is only
// shown while the active tab is on this host (or a subdomain of it) — on any
// ordinary page it stays hidden. If your inbox runs on a custom domain, change
// this to that host: it's a suffix match, so "featurebase.app" already covers
// "app.featurebase.app", "<org>.featurebase.app", …
const FB_HOST = "featurebase.app";

// True when `url` points at a Featurebase page (see FB_HOST). Pure/sync so it
// can gate work before we touch the tab.
function isFeaturebaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === FB_HOST || host.endsWith(`.${FB_HOST}`);
  } catch {
    return false;
  }
}

// Tools answered from the CDP capture buffer rather than by running in the page.
const DEBUG_TOOLS = new Set(["get_console_logs", "get_network_requests", "get_network_request"]);
// TAB_TOOLS (chrome.tabs.*) are shared with the background worker — see ../tabTools.

export type Cli = "claude" | "chatgpt";

// Launch config shared by send / prewarm / reset. `page` = read+control DOM
// tools; `capture` = console/network debug tools; `repoPath` = local repo the
// CLI may read (Read/Grep/Glob) with cwd set there.
export interface SessionCfg {
  cli: Cli;
  page: boolean;
  tabs: boolean; // open/close/switch/navigate tabs (chrome.tabs.*)
  capture: boolean;
  repoPath: string;
  model: string;
  effort: string;
}

export type HostEvent =
  | { type: "chunk"; id: number; data: string }
  | { type: "tool_use"; id: number; name: string }
  | { type: "thinking"; id: number }
  | { type: "stderr"; id: number; data: string }
  | { type: "error"; id?: number; error: string }
  | { type: "done"; id: number; code: number }
  | { type: "disconnected"; error?: string };

// Merchant summary the host fetches from the pod-shopify-backend admin GraphQL.
export interface ShopSummary {
  domain: string;
  accountId: string;
  email: string | null;
  name: string | null;
  createdAt: string; // account creation → "using the app for …"
  planName: string | null;
  planAmount: string | null;
  interval: string | null; // MONTHLY / YEARLY
  activatedAt: string | null;
  subscriptionStatus: string | null;
  mrr: string | null;
  creditBalance: number | null;
  optionSets: number | null;
  designTemplates: number | null;
  orders: number | null;
  libraries: number | null;
  shopCount: number | null;
  shopStatus: string | null; // the ticket shop: ACTIVE / DEACTIVE (uninstalled)
  currentPeriodEnd: string | null; // renewal date
  subscriptionShopDomain: string | null;
}
export interface ShopSummaryResult {
  data: ShopSummary | null;
  error?: string;
}

interface ToolRequest {
  type: "tool_request";
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ShopSummaryMsg {
  type: "shop_summary_result";
  id: number;
  data: ShopSummary | null;
  error?: string;
}

interface FolderPickedMsg {
  type: "folder_picked";
  id: number;
  path: string;
  error?: string;
}

export interface FolderPickResult {
  path: string;
  error?: string;
}

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

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// Scrape the merchant's myshopify domain from the open Featurebase ticket. The
// app signs it into the Featurebase identity as company.website, so it appears
// on the ticket — a regex over the page is selector-independent and robust.
// True when the active tab is a Featurebase page. The panel gates the merchant
// card on this so it never shows on ordinary tabs.
export async function isFeaturebasePage(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return isFeaturebaseUrl(tab?.url);
}

export async function readShopDomain(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The shop domain comes off the open Featurebase ticket — off Featurebase
  // there's nothing to read, so report "no shop" and don't inject a script.
  if (!tab?.id || !isFeaturebaseUrl(tab.url)) return "";
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const hay = `${document.body?.innerText ?? ""}\n${document.body?.innerHTML ?? ""}`;
      const m = hay.match(/\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/i);
      return m ? m[0].toLowerCase() : "";
    },
  });
  return (res?.result as string) ?? "";
}

export class Bridge {
  private port: chrome.runtime.Port | null = null;
  private summaryId = 0;
  private pendingSummary = new Map<number, (r: ShopSummaryResult) => void>();
  private folderId = 0;
  private pendingFolder = new Map<number, (r: FolderPickResult) => void>();
  private driveTabId: number | null = null; // tab currently showing the "AI driving" overlay
  readonly capture: Capture;

  constructor(
    private onEvent: (e: HostEvent) => void,
    onCaptureStatus?: (s: CaptureStatus) => void,
  ) {
    this.capture = new Capture(onCaptureStatus);
  }

  connect() {
    const port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((m) => this.handle(m));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      this.port = null;
      this.onEvent({ type: "disconnected", error: err?.message });
    });
    this.port = port;
  }

  private ensure(): chrome.runtime.Port | null {
    if (!this.port) this.connect();
    return this.port;
  }

  disconnect() {
    this.port?.disconnect();
    this.port = null;
    void this.capture.disable();
  }

  send(req: { id: number; prompt: string } & SessionCfg) {
    this.ensure()?.postMessage(req);
  }

  // The tab the user is looking at RIGHT NOW (url + title). Seeded into each turn
  // so the model always acts on the current tab and notices a tab switch, instead
  // of trusting a get_page it ran earlier on a tab that's no longer active.
  async activeTabInfo(): Promise<{ url: string; title: string } | null> {
    const t = await activeTab();
    if (!t) return null;
    return { url: t.url || t.pendingUrl || "", title: t.title || "" };
  }

  // Ask the host to spin up an idle CLI session now, so the next send() only
  // waits on the API instead of paying cold-start after the click.
  prewarm(cfg: SessionCfg) {
    this.ensure()?.postMessage({ type: "prewarm", ...cfg });
  }

  // End the current conversation and prewarm a fresh session for the next one.
  reset(cfg: SessionCfg) {
    this.ensure()?.postMessage({ type: "reset", ...cfg });
  }

  cancel(id: number) {
    this.port?.postMessage({ type: "cancel", id });
  }

  // Request the merchant summary for a shop domain (request/response; resolves
  // when the host's shop_summary_result with the matching id comes back).
  shopSummary(domain: string, apiUrl?: string, accessKey?: string): Promise<ShopSummaryResult> {
    const id = ++this.summaryId;
    return new Promise((resolve) => {
      this.pendingSummary.set(id, resolve);
      this.ensure()?.postMessage({ type: "shop_summary", id, domain, apiUrl, accessKey });
      setTimeout(() => {
        if (this.pendingSummary.delete(id)) resolve({ data: null, error: "timed out" });
      }, 20000);
    });
  }

  // Pop the OS folder picker via the host and resolve to the chosen path ("" if
  // the user cancels). Used by the "Browse…" button so the repo path needn't be
  // typed by hand.
  pickFolder(): Promise<FolderPickResult> {
    const id = ++this.folderId;
    return new Promise((resolve) => {
      this.pendingFolder.set(id, resolve);
      const port = this.ensure();
      if (!port) {
        this.pendingFolder.delete(id);
        resolve({ path: "", error: "host not connected" });
        return;
      }
      port.postMessage({ type: "pick_folder", id });
      // The dialog is modal on the user's side; give it room but don't hang forever.
      setTimeout(() => {
        if (this.pendingFolder.delete(id)) resolve({ path: "", error: "timed out" });
      }, 180000);
    });
  }

  private handle(m: HostEvent | ToolRequest | ShopSummaryMsg | FolderPickedMsg) {
    const t = (m as { type: string }).type;
    if (t === "tool_request") {
      void this.runTool(m as ToolRequest);
    } else if (t === "shop_summary_result") {
      const r = m as ShopSummaryMsg;
      const cb = this.pendingSummary.get(r.id);
      if (cb) {
        this.pendingSummary.delete(r.id);
        cb({ data: r.data, error: r.error });
      }
    } else if (t === "folder_picked") {
      const r = m as FolderPickedMsg;
      const cb = this.pendingFolder.get(r.id);
      if (cb) {
        this.pendingFolder.delete(r.id);
        cb({ path: r.path, error: r.error });
      }
    } else {
      // A turn that touched the browser ends here — clear the driving overlay.
      if (t === "done" || t === "error" || t === "disconnected") this.endDrive();
      this.onEvent(m as HostEvent);
    }
  }

  // The CLI asked (via the host) to run a browser tool. Debug tools read the CDP
  // capture buffer; everything else runs in the active tab.
  private async runTool(req: ToolRequest) {
    try {
      let data: unknown;
      if (DEBUG_TOOLS.has(req.tool)) {
        // Capture is "AI decides": the CDP debugger attaches lazily the first
        // time the assistant actually reads the buffer (that's when Chrome's
        // "being debugged" banner appears), not eagerly from a settings toggle.
        if (!this.capture.enabled) await this.capture.enable();
        const a = (req.args ?? {}) as Record<string, unknown>;
        if (req.tool === "get_console_logs") data = this.capture.getConsoleLogs(a);
        else if (req.tool === "get_network_requests") data = this.capture.getNetworkRequests(a);
        else data = await this.capture.getNetworkRequest(String(a.id ?? ""));
      } else if (TAB_TOOLS.has(req.tool)) {
        data = await runTabTool(req.tool, (req.args ?? {}) as Record<string, unknown>);
      } else if (req.tool === "screenshot") {
        data = await this.screenshot((req.args ?? {}) as Record<string, unknown>);
      } else {
        const tabId = await activeTabId();
        if (!tabId) throw new Error("no active tab");
        // Show the "AI is driving" overlay only for tools that actually change
        // the page — reads (get_page/query_dom/wait_for) shouldn't lock the user
        // out or pay an extra injection.
        if (Bridge.DRIVE_TOOLS.has(req.tool)) await this.startDrive(tabId, req);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: domTool,
          args: [req.tool, req.args ?? {}, FB_CONVO_SELECTOR],
        });
        data = res?.result;
      }
      this.port?.postMessage({ type: "tool_result", callId: req.callId, ok: true, data });
    } catch (e) {
      this.port?.postMessage({
        type: "tool_result",
        callId: req.callId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Page-changing tools: these light up the "AI is driving" overlay and fly the
  // virtual cursor to their target. Pure reads are intentionally excluded.
  private static DRIVE_TOOLS = new Set(["click", "type_text", "scroll_to", "press_key"]);

  // Turn on the "AI is driving" overlay for this tab and move the cursor onto
  // the target element so the user sees where the action lands.
  private async startDrive(tabId: number, req: ToolRequest) {
    this.driveTabId = tabId;
    await drive.on(tabId);
    const a = (req.args ?? {}) as Record<string, unknown>;
    const selector = typeof a.selector === "string" ? a.selector : undefined;
    if (!selector) return;
    await drive.cursor(tabId, {
      selector,
      nth: typeof a.nth === "number" ? a.nth : 0,
      click: req.tool === "click",
    });
    await new Promise((r) => setTimeout(r, 320)); // let the cursor visibly travel
  }

  // Tear down the driving overlay once the turn is over.
  private endDrive() {
    const id = this.driveTabId;
    this.driveTabId = null;
    if (id != null) void drive.off(id);
  }

  // Screenshot the visible area of the active tab and hand it back as image
  // bytes (mcp-server turns this into an MCP image block). The driving overlay
  // is hidden across the capture so the assistant never sees its own glow.
  private async screenshot(args: Record<string, unknown>): Promise<{ base64: string; mimeType: string }> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId == null) throw new Error("no active tab");
    const hideId = this.driveTabId;
    if (hideId != null) {
      await drive.hide(hideId);
      await new Promise((r) => setTimeout(r, 60)); // let the hide paint before capture
    }
    try {
      const format = args.format === "png" ? "png" : "jpeg";
      const quality = typeof args.quality === "number" ? args.quality : 80;
      const opts =
        format === "jpeg" ? ({ format: "jpeg", quality } as const) : ({ format: "png" } as const);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
      const comma = dataUrl.indexOf(",");
      return {
        mimeType: format === "png" ? "image/png" : "image/jpeg",
        base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      };
    } finally {
      if (hideId != null) await drive.show(hideId);
    }
  }
}
