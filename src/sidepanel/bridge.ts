// Bridge between the side panel and the native host (com.nexlify.assistant).
//
// Outbound: chat requests {id, cli, prompt, tools}.
// Inbound:  streamed events (chunk / tool_use / stderr / error / done) AND
//           tool_request messages — when Claude calls a DOM tool, the host asks
//           us to run it in the active tab, and we post the result back.

const HOST_NAME = "com.nexlify.assistant";

// CSS selector for Featurebase's open-conversation panel. Point this at the real
// thread container (right-click the conversation → Inspect → copy selector) so
// get_page reads ONLY the conversation, not the ticket-list sidebar or nav.
// Empty string = fall back to <main> / [role=main] / <article>.
const FB_CONVO_SELECTOR = "";

export type Cli = "claude" | "chatgpt";

export type HostEvent =
  | { type: "chunk"; id: number; data: string }
  | { type: "tool_use"; id: number; name: string }
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

// Runs INSIDE the inspected page (serialized by chrome.scripting). Must be
// fully self-contained — no references to anything outside this function, so
// the Featurebase selector is threaded in as an argument.
function domTool(tool: string, args: Record<string, unknown>, fbSelector: string): unknown {
  const cap = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
  // Collapse the whitespace noise you get from innerText dumps.
  const clean = (s: string) =>
    s
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  // Prefer the Featurebase conversation panel, then the main content region.
  // Only fall back to <body> (the whole chrome: nav/ticket-list/footer) if
  // nothing narrower has real text — that fallback is the token-heavy path.
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

  if (tool === "get_page") {
    const max = typeof args.maxChars === "number" ? args.maxChars : 6000;
    return {
      url: location.href,
      title: document.title,
      text: cap(clean(convoEl()?.innerText ?? ""), max),
    };
  }

  if (tool === "query_dom") {
    const selector = String(args.selector ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const wantHtml = args.html === true;
    const nodes = Array.from(document.querySelectorAll(selector)).slice(0, limit);
    return {
      count: nodes.length,
      matches: nodes.map((el) =>
        wantHtml
          ? cap((el as HTMLElement).outerHTML, 4000)
          : cap((el as HTMLElement).innerText ?? "", 2000),
      ),
    };
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
export async function readShopDomain(): Promise<string> {
  const tabId = await activeTabId();
  if (!tabId) return "";
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
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

  constructor(private onEvent: (e: HostEvent) => void) {}

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
  }

  send(req: {
    id: number;
    cli: Cli;
    prompt: string;
    tools: boolean;
    model: string;
    effort: string;
  }) {
    this.ensure()?.postMessage(req);
  }

  // Ask the host to spin up an idle CLI session now, so the next send() only
  // waits on the API instead of paying cold-start after the click.
  prewarm(cfg: { cli: Cli; tools: boolean; model: string; effort: string }) {
    this.ensure()?.postMessage({ type: "prewarm", ...cfg });
  }

  // End the current conversation and prewarm a fresh session for the next one.
  reset(cfg: { cli: Cli; tools: boolean; model: string; effort: string }) {
    this.ensure()?.postMessage({ type: "reset", ...cfg });
  }

  cancel(id: number) {
    this.port?.postMessage({ type: "cancel", id });
  }

  // Request the merchant summary for a shop domain (request/response; resolves
  // when the host's shop_summary_result with the matching id comes back).
  // apiUrl / accessKey (optional) override the host's env for this call.
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

  private handle(m: HostEvent | ToolRequest | ShopSummaryMsg) {
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
    } else {
      this.onEvent(m as HostEvent);
    }
  }

  // Claude asked (via the host) to run a DOM tool in the active tab.
  private async runTool(req: ToolRequest) {
    try {
      const tabId = await activeTabId();
      if (!tabId) throw new Error("no active tab");
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: domTool,
        args: [req.tool, req.args ?? {}, FB_CONVO_SELECTOR],
      });
      this.port?.postMessage({
        type: "tool_result",
        callId: req.callId,
        ok: true,
        data: res?.result,
      });
    } catch (e) {
      this.port?.postMessage({
        type: "tool_result",
        callId: req.callId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
