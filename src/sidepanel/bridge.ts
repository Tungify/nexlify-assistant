// Bridge between the side panel and the native host (com.nexlify.assistant).
//
// Outbound: chat requests {id, cli, prompt, page, capture, repoPath, …}.
// Inbound:  streamed events (chunk / tool_use / stderr / error / done) AND
//           tool_request messages — when the CLI calls a browser tool, the host
//           asks us to run it and we post the result back. Read/control tools
//           run in the active tab via chrome.scripting (../pageTools, shared with
//           the background worker); the debug tools read the CDP capture buffer,
//           which the background worker owns (../capture) so it survives the
//           panel being closed.

import { type CaptureStatus } from "../capture";
import { PAGE_TOOLS, runPageToolOn, screenshotTab } from "../pageTools";
import { TAB_TOOLS, runTabTool, activeTab } from "../tabTools";
import { drive } from "./drive";

const HOST_NAME = "com.nexlify.assistant";

// Host of the Featurebase inbox/admin app. The merchant summary card is only
// shown while the active tab is on this host (or a subdomain of it) — on any
// ordinary page it stays hidden. If your inbox runs on a custom domain, change
// this to that host: it's a suffix match, so "featurebase.app" already covers
// "app.featurebase.app", "<org>.featurebase.app", …
const FB_HOST = "featurebase.app";

// True when `url` points at a Featurebase page (see FB_HOST). Pure/sync so it
// can gate work before we touch the tab.
export function isFeaturebaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === FB_HOST || host.endsWith(`.${FB_HOST}`);
  } catch {
    return false;
  }
}

// Tools answered from the CDP capture buffer rather than by running in the page.
// The buffer lives in the background worker (single debugger owner), so these are
// the one group we delegate instead of running here.
const DEBUG_TOOLS = new Set(["get_console_logs", "get_network_requests", "get_network_request"]);
// PAGE_TOOLS (chrome.scripting) and TAB_TOOLS (chrome.tabs.*) are shared with the
// background worker — see ../pageTools and ../tabTools.

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
  mcpTeam: boolean; // inherit the user's own claude MCP servers into the panel
  mcpAllow: string[]; // read tools/servers to auto-run; others go through the popup
  shell: boolean; // Bash allowed, every command approved through the popup
  systemPrompt?: string; // appended to the CLI's system prompt (support role in the Featurebase tab)
  lean?: boolean; // narrow tool set + only the support skill's plugin (Featurebase tab)
}

// A tool call the CLI wants approved (team-MCP mode: anything not auto-allowed).
// The panel shows an allow/deny popup and answers with the CLI-expected shape.
export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

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

// True when the active tab is a Featurebase page.
export async function isFeaturebasePage(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return isFeaturebaseUrl(tab?.url);
}

// Find the merchant's myshopify domain on the active tab. Two sources, so the
// card works both in the support inbox and while browsing the merchant's store:
//   • Featurebase ticket — the app signs the shop into the Featurebase identity
//     as company.website, so a regex over the page text finds it (isolated world,
//     selector-independent and robust).
//   • Shopify storefront — read window.Shopify.shop, which holds the canonical
//     xxx.myshopify.com even when the store runs on a CUSTOM domain. That global
//     lives in the page's MAIN world, so we inject there. A non-Shopify page has
//     no window.Shopify and no Shopify assets → we return "" and the card stays
//     hidden (it never shows on ordinary pages).
// executeScript throws on restricted URLs (chrome://, web store, …) — guard it.
export async function readShopDomain(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url ?? "")) return "";

  if (isFeaturebaseUrl(tab.url)) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const hay = `${document.body?.innerText ?? ""}\n${document.body?.innerHTML ?? ""}`;
          const m = hay.match(/\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/i);
          return m ? m[0].toLowerCase() : "";
        },
      });
      return (res?.result as string) ?? "";
    } catch {
      return "";
    }
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN", // window.Shopify lives in the page's main world
      func: () => {
        const norm = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
        try {
          const S = (window as unknown as { Shopify?: { shop?: string } }).Shopify;
          if (S && typeof S.shop === "string" && /\.myshopify\.com$/i.test(S.shop)) return norm(S.shop);
        } catch {
          /* window.Shopify not readable */
        }
        // Custom-domain store whose window.Shopify isn't populated: only trust a
        // myshopify match when the page is unmistakably a Shopify storefront.
        try {
          const html = document.documentElement?.innerHTML ?? "";
          const isShopify =
            /cdn\.shopify\.com|\/cdn\/shop\/|shopify-features|Shopify\.theme/i.test(html) ||
            !!document.querySelector(
              'meta[name="shopify-digital-wallet"], meta[name="shopify-checkout-api-token"], link[href*="cdn.shopify.com"]',
            );
          if (!isShopify) return "";
          const m =
            html.match(/Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i) ||
            html.match(/([a-z0-9][a-z0-9-]*\.myshopify\.com)/i);
          return m ? norm(m[1]) : "";
        } catch {
          return "";
        }
      },
    });
    return (res?.result as string) ?? "";
  } catch {
    return "";
  }
}

export class Bridge {
  private port: chrome.runtime.Port | null = null;
  private summaryId = 0;
  private pendingSummary = new Map<number, (r: ShopSummaryResult) => void>();
  private folderId = 0;
  private pendingFolder = new Map<number, (r: FolderPickResult) => void>();
  private driveTabId: number | null = null; // tab currently showing the "AI driving" overlay
  // Mirror of the worker-owned capture state, pushed to us on every change.
  private onCaptureStatusBound: ((m: unknown) => void) | null = null;

  constructor(
    private onEvent: (e: HostEvent) => void,
    private onCaptureStatus?: (s: CaptureStatus) => void,
    // Called when the CLI wants to run a tool that isn't auto-allowed (team-MCP
    // mode): the panel shows an allow/deny popup and we relay the answer back.
    private onPermission?: (ask: PermissionAsk) => Promise<PermissionDecision>,
  ) {}

  connect() {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      // e.g. "Extension context invalidated": the extension was reloaded under this page.
      this.port = null;
      this.onEvent({ type: "disconnected", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    port.onMessage.addListener((m) => this.handle(m));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      // A port we already replaced (post() reconnected) is old news.
      if (this.port !== port) return;
      this.port = null;
      this.onEvent({ type: "disconnected", error: err?.message });
    });
    this.port = port;
    this.watchCaptureStatus();
  }

  private ensure(): chrome.runtime.Port | null {
    if (!this.port) this.connect();
    return this.port;
  }

  // Send to the host. When the host has just exited, Chrome throws "Attempting to
  // use a disconnected port object" before onDisconnect clears the port; we drop
  // the dead port and retry once on a fresh one instead of throwing into React.
  private post(msg: object): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = this.ensure();
      if (!port) return false;
      try {
        port.postMessage(msg);
        return true;
      } catch {
        if (this.port === port) this.port = null;
      }
    }
    return false;
  }

  // For replies on the current port only (tool results, cancel): a dead port
  // means the turn is gone, so there is nobody to reconnect for.
  private reply(msg: object) {
    try {
      this.port?.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  // Closing the panel does NOT stop the capture: the worker owns it and an
  // external CLI may still be reading the buffer. The user's off switches are the
  // settings toggle and Chrome's own "being debugged" banner.
  disconnect() {
    this.port?.disconnect();
    this.port = null;
    if (this.onCaptureStatusBound) {
      chrome.runtime.onMessage.removeListener(this.onCaptureStatusBound);
      this.onCaptureStatusBound = null;
    }
  }

  // ---- capture (owned by the background worker) ----------------------------

  // Subscribe to the worker's capture status and ask for the current value, so a
  // freshly opened panel shows "● capturing tab N" straight away.
  private watchCaptureStatus() {
    if (!this.onCaptureStatus || this.onCaptureStatusBound) return;
    const cb = (m: unknown) => {
      const msg = m as { type?: string; status?: CaptureStatus } | null;
      if (msg?.type === "nx_capture_status" && msg.status) this.onCaptureStatus?.(msg.status);
    };
    this.onCaptureStatusBound = cb;
    chrome.runtime.onMessage.addListener(cb);
    try {
      chrome.runtime.sendMessage({ type: "nx_capture_status" }, (resp?: { status?: CaptureStatus }) => {
        void chrome.runtime.lastError; // worker still waking up — the next push covers us
        if (resp?.status) this.onCaptureStatus?.(resp.status);
      });
    } catch {
      /* extension reloaded under this page */
    }
  }

  // The "Allow console & network capture" permission was revoked → tell the
  // worker to detach now (that's what clears Chrome's banner).
  setCaptureEnabled(enabled: boolean) {
    try {
      chrome.runtime.sendMessage({ type: "nx_capture_enabled", enabled }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded under this page */
    }
  }

  // Read one debug tool out of the worker's CDP buffer.
  private readCapture(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "nx_capture_read", tool, args },
        (resp: { ok?: boolean; data?: unknown; error?: string } | undefined) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr || !resp) {
            reject(new Error(`"${tool}" needs the extension's background worker (${lastErr?.message ?? "no reply"})`));
          } else if (resp.ok) resolve(resp.data);
          else reject(new Error(resp.error || `"${tool}" failed`));
        },
      );
    });
  }

  send(req: { id: number; prompt: string } & SessionCfg) {
    this.post(req);
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
    this.post({ type: "prewarm", ...cfg });
  }

  // End the current conversation and prewarm a fresh session for the next one.
  reset(cfg: SessionCfg) {
    this.post({ type: "reset", ...cfg });
  }

  cancel(id: number) {
    this.reply({ type: "cancel", id });
  }

  // Request the merchant summary for a shop domain (request/response; resolves
  // when the host's shop_summary_result with the matching id comes back).
  shopSummary(domain: string, apiUrl?: string, accessKey?: string): Promise<ShopSummaryResult> {
    const id = ++this.summaryId;
    return new Promise((resolve) => {
      this.pendingSummary.set(id, resolve);
      if (!this.post({ type: "shop_summary", id, domain, apiUrl, accessKey })) {
        this.pendingSummary.delete(id);
        resolve({ data: null, error: "native host not reachable" });
        return;
      }
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
      if (!this.post({ type: "pick_folder", id })) {
        this.pendingFolder.delete(id);
        resolve({ path: "", error: "host not connected" });
        return;
      }
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

  // The CLI asked (via the host) to run a browser tool. permission_request is
  // host-session-only; everything else routes through execTool (shared with the
  // background worker's delegate path). Only the host path shows the "AI is
  // driving" overlay — it clears it on turn-end, which the delegate path lacks.
  private async runTool(req: ToolRequest) {
    try {
      let data: unknown;
      if (req.tool === "permission_request") {
        // Team-MCP mode: approve/deny a not-auto-allowed tool call in the panel.
        const a = (req.args ?? {}) as { tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string };
        data = this.onPermission
          ? await this.onPermission({ toolName: a.tool_name ?? "", input: a.input ?? {}, toolUseId: a.tool_use_id })
          : ({ behavior: "deny", message: "No approver available" } as PermissionDecision);
      } else {
        data = await this.execTool(req.tool, (req.args ?? {}) as Record<string, unknown>, { drive: true });
      }
      this.reply({ type: "tool_result", callId: req.callId, ok: true, data });
    } catch (e) {
      this.reply({
        type: "tool_result",
        callId: req.callId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Run ONE browser tool against the live tab (or CDP capture buffer) and RETURN
  // its result (throws on failure). Called from runTool — the host-port path: the
  // in-panel chat CLI, or an external CLI whose host happens to own the public
  // bridge socket. { drive: true } adds the cursor overlay on page-changing tools.
  //
  // Everything here runs from shared modules the background worker also uses, so
  // the same call works with the panel closed; only the debug tools are delegated
  // (the worker is the single owner of the CDP debugger).
  // permission_request is intentionally NOT handled here (host-session-only).
  async execTool(
    tool: string,
    args: Record<string, unknown>,
    opts?: { drive?: boolean },
  ): Promise<unknown> {
    if (DEBUG_TOOLS.has(tool)) return await this.readCapture(tool, args);
    if (TAB_TOOLS.has(tool)) return await runTabTool(tool, args);
    if (tool === "screenshot") return await this.screenshot(args);
    if (!PAGE_TOOLS.has(tool)) throw new Error("unknown tool: " + tool);

    const tabId = (await activeTab())?.id;
    if (tabId == null) throw new Error("no active tab");
    // Show the "AI is driving" overlay only for tools that actually change the
    // page, and only on the host path (opts.drive) — reads shouldn't lock the
    // user out, and a path with no turn-end can't clear the overlay.
    if (opts?.drive && Bridge.DRIVE_TOOLS.has(tool)) await this.startDrive(tabId, tool, args);
    return await runPageToolOn(tabId, tool, args);
  }

  // Page-changing tools: these light up the "AI is driving" overlay and fly the
  // virtual cursor to their target. Pure reads are intentionally excluded.
  private static DRIVE_TOOLS = new Set(["click", "type_text", "scroll_to", "press_key"]);

  // Turn on the "AI is driving" overlay for this tab and move the cursor onto
  // the target element so the user sees where the action lands.
  private async startDrive(tabId: number, tool: string, args: Record<string, unknown>) {
    this.driveTabId = tabId;
    await drive.on(tabId);
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    if (!selector) return;
    await drive.cursor(tabId, {
      selector,
      nth: typeof args.nth === "number" ? args.nth : 0,
      click: tool === "click",
    });
    await new Promise((r) => setTimeout(r, 320)); // let the cursor visibly travel
  }

  // Tear down the driving overlay once the turn is over.
  private endDrive() {
    const id = this.driveTabId;
    this.driveTabId = null;
    if (id != null) void drive.off(id);
  }

  // Screenshot the visible area of the active tab (../pageTools does the capture).
  // The driving overlay is hidden across the shot so the assistant never sees its
  // own glow.
  private async screenshot(args: Record<string, unknown>): Promise<{ base64: string; mimeType: string }> {
    const hideId = this.driveTabId;
    if (hideId != null) {
      await drive.hide(hideId);
      await new Promise((r) => setTimeout(r, 60)); // let the hide paint before capture
    }
    try {
      return await screenshotTab(args);
    } finally {
      if (hideId != null) await drive.show(hideId);
    }
  }
}
