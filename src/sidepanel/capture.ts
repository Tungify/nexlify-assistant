// Console + network capture via the Chrome DevTools Protocol (chrome.debugger).
//
// When the "Capture console & network" setting is on, the panel attaches the
// debugger to whatever tab is active and buffers what it sees — console output,
// uncaught errors, browser log entries (CORS/CSP/mixed-content…), and every
// network request. The CLI reads that buffer through the get_console_logs /
// get_network_requests / get_network_request tools to answer "why didn't this
// event fire / this request go out".
//
// Only ONE debugger client can own a tab, so if DevTools is open on the tab the
// attach fails — that's surfaced through onStatus. Attaching also shows Chrome's
// yellow "… is debugging this browser" banner; that's expected while capture is
// on.

const PROTOCOL = "1.3";
const CONSOLE_CAP = 600; // ring-buffer sizes — keep memory bounded on chatty pages
const NET_CAP = 400;
const BODY_MAX = 200_000; // cap a single response/request body we hand back

export interface ConsoleEntry {
  ts: number; // wall-clock ms (Date.now) when we saw it
  level: string; // log | info | warning | error | debug
  text: string;
  url?: string;
  line?: number;
}

export interface NetEntry {
  id: string; // CDP requestId
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  blockedReason?: string;
  fromCache?: boolean;
  finished?: boolean;
  encodedDataLength?: number;
  hasPostData?: boolean;
  reqHeaders?: Record<string, string>;
  reqPostData?: string;
  respHeaders?: Record<string, string>;
}

export interface CaptureStatus {
  enabled: boolean;
  attached: boolean;
  tabId: number | null;
  error?: string;
}

type Debuggee = chrome.debugger.Debuggee;

// A CDP RemoteObject as it shows up in Runtime.consoleAPICalled args.
interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: { name: string; value: string }[] };
  unserializableValue?: string;
}

function fmtRemote(o: RemoteObject): string {
  if (!o) return "";
  if (o.type === "string") return String(o.value ?? "");
  if (o.type === "undefined") return "undefined";
  if ("value" in o && o.value !== undefined) return String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.description) return o.description; // functions, errors (w/ stack), numbers…
  if (o.preview?.properties?.length) {
    return "{" + o.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ") + "}";
  }
  return o.subtype || o.type;
}

function headersToObject(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) out[k] = h[k];
  return out;
}

export class Capture {
  enabled = false;
  private tabId: number | null = null;
  private attached = false;
  private consoleBuf: ConsoleEntry[] = [];
  private net = new Map<string, NetEntry>();
  private netOrder: string[] = [];
  private onStatus?: (s: CaptureStatus) => void;
  // Bound once so add/removeListener line up.
  private evtBound = (source: Debuggee, method: string, params?: object) => this.onEvent(source, method, params);
  private detachBound = (source: Debuggee, reason: string) => this.onDetach(source, reason);
  private listening = false;

  constructor(onStatus?: (s: CaptureStatus) => void) {
    this.onStatus = onStatus;
  }

  private emit(error?: string) {
    this.onStatus?.({ enabled: this.enabled, attached: this.attached, tabId: this.tabId, error });
  }

  isEnabled() {
    return this.enabled;
  }

  // Turn capture on: start listening for CDP events and attach to the active
  // tab. Buffering begins immediately (so logs exist before the user asks).
  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    if (!this.listening) {
      chrome.debugger.onEvent.addListener(this.evtBound);
      chrome.debugger.onDetach.addListener(this.detachBound);
      this.listening = true;
    }
    await this.attachToActive();
  }

  async disable() {
    this.enabled = false;
    if (this.listening) {
      chrome.debugger.onEvent.removeListener(this.evtBound);
      chrome.debugger.onDetach.removeListener(this.detachBound);
      this.listening = false;
    }
    await this.detach();
    this.emit();
  }

  private async activeTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // Move the attachment to the currently active tab. Called on enable and on
  // every tab switch / navigation while capture is on.
  async attachToActive() {
    if (!this.enabled) return;
    const tab = await this.activeTab();
    const id = tab?.id;
    const url = tab?.url ?? "";
    if (id == null || !/^https?:/i.test(url)) {
      // chrome://, extension pages, the web store, etc. can't be debugged.
      if (this.attached) await this.detach();
      this.emit(id == null ? undefined : "capture skips non-web pages (chrome://, extensions)");
      return;
    }
    if (this.attached && this.tabId === id) return; // already on this tab
    if (this.attached) await this.detach();
    try {
      await chrome.debugger.attach({ tabId: id }, PROTOCOL);
      this.tabId = id;
      this.attached = true;
      const t: Debuggee = { tabId: id };
      await chrome.debugger.sendCommand(t, "Network.enable", {});
      await chrome.debugger.sendCommand(t, "Runtime.enable", {});
      await chrome.debugger.sendCommand(t, "Log.enable", {});
      this.emit();
    } catch (e) {
      this.attached = false;
      this.tabId = null;
      const msg = e instanceof Error ? e.message : String(e);
      // The usual cause is DevTools already owning the tab.
      this.emit(/devtools|already attached|another/i.test(msg) ? "close DevTools on this tab to capture" : msg);
    }
  }

  private async detach() {
    const id = this.tabId;
    this.attached = false;
    this.tabId = null;
    if (id == null) return;
    try {
      await chrome.debugger.detach({ tabId: id });
    } catch {
      /* already gone */
    }
  }

  private onDetach(source: Debuggee, reason: string) {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    this.tabId = null;
    // The user dismissed the banner → treat it as turning capture off so the UI
    // toggle stays honest. Otherwise (tab closed/navigated) try to re-attach.
    if (reason === "canceled_by_user") {
      this.enabled = false;
      if (this.listening) {
        chrome.debugger.onEvent.removeListener(this.evtBound);
        chrome.debugger.onDetach.removeListener(this.detachBound);
        this.listening = false;
      }
      this.emit("capture stopped (debugger banner dismissed)");
    } else {
      this.emit();
      void this.attachToActive();
    }
  }

  // ---- event ingestion ----------------------------------------------------

  private pushConsole(e: ConsoleEntry) {
    this.consoleBuf.push(e);
    if (this.consoleBuf.length > CONSOLE_CAP) this.consoleBuf.splice(0, this.consoleBuf.length - CONSOLE_CAP);
  }

  private ensureNet(id: string): NetEntry {
    let rec = this.net.get(id);
    if (!rec) {
      rec = { id, ts: Date.now(), method: "", url: "" };
      this.net.set(id, rec);
      this.netOrder.push(id);
      if (this.netOrder.length > NET_CAP) {
        const drop = this.netOrder.shift();
        if (drop) this.net.delete(drop);
      }
    }
    return rec;
  }

  private onEvent(source: Debuggee, method: string, params?: object) {
    if (source.tabId !== this.tabId) return;
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case "Runtime.consoleAPICalled":
        this.pushConsole({
          ts: Date.now(),
          level: p.type || "log",
          text: (p.args || []).map((a: RemoteObject) => fmtRemote(a)).join(" "),
          url: p.stackTrace?.callFrames?.[0]?.url,
          line: p.stackTrace?.callFrames?.[0]?.lineNumber,
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails || {};
        this.pushConsole({
          ts: Date.now(),
          level: "error",
          text: d.exception?.description || d.text || "uncaught exception",
          url: d.url || d.stackTrace?.callFrames?.[0]?.url,
          line: d.lineNumber,
        });
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry || {};
        this.pushConsole({
          ts: Date.now(),
          level: e.level || "info",
          text: `[${e.source || "log"}] ${e.text || ""}`.trim(),
          url: e.url,
          line: e.lineNumber,
        });
        break;
      }
      case "Network.requestWillBeSent": {
        const rec = this.ensureNet(p.requestId);
        const req = p.request || {};
        rec.ts = Date.now();
        rec.method = req.method || rec.method;
        rec.url = req.url || rec.url;
        rec.resourceType = p.type || rec.resourceType;
        rec.reqHeaders = headersToObject(req.headers) || rec.reqHeaders;
        rec.hasPostData = !!req.hasPostData || rec.hasPostData;
        if (typeof req.postData === "string") rec.reqPostData = req.postData.slice(0, BODY_MAX);
        break;
      }
      case "Network.responseReceived": {
        const rec = this.ensureNet(p.requestId);
        const res = p.response || {};
        rec.status = res.status;
        rec.statusText = res.statusText;
        rec.mimeType = res.mimeType;
        rec.respHeaders = headersToObject(res.headers) || rec.respHeaders;
        rec.fromCache = !!res.fromDiskCache || !!res.fromPrefetchCache;
        rec.resourceType = p.type || rec.resourceType;
        break;
      }
      case "Network.loadingFinished": {
        const rec = this.net.get(p.requestId);
        if (rec) {
          rec.finished = true;
          rec.encodedDataLength = p.encodedDataLength;
        }
        break;
      }
      case "Network.loadingFailed": {
        const rec = this.ensureNet(p.requestId);
        rec.failed = true;
        rec.finished = true;
        rec.errorText = p.errorText;
        rec.blockedReason = p.blockedReason;
        rec.resourceType = p.type || rec.resourceType;
        break;
      }
    }
  }

  // ---- queries (called from the tool bridge) ------------------------------

  getConsoleLogs(opts: { level?: string; contains?: string; limit?: number } = {}) {
    if (!this.enabled) return { error: "capture is off — enable 'Capture console & network' in settings" };
    const limit = typeof opts.limit === "number" ? opts.limit : 100;
    const level = opts.level?.toLowerCase();
    const needle = opts.contains?.toLowerCase();
    let rows = this.consoleBuf;
    // Prefix match so a "warn" query catches CDP's "warning" level.
    if (level) rows = rows.filter((r) => r.level.toLowerCase().startsWith(level));
    if (needle) rows = rows.filter((r) => r.text.toLowerCase().includes(needle));
    const out = rows.slice(-limit).map((r) => ({
      level: r.level,
      text: r.text.length > 4000 ? r.text.slice(0, 4000) + "…" : r.text,
      at: r.url ? `${r.url}${r.line != null ? ":" + (r.line + 1) : ""}` : undefined,
    }));
    return { attached: this.attached, tabId: this.tabId, total: rows.length, returned: out.length, logs: out };
  }

  getNetworkRequests(
    opts: { urlContains?: string; method?: string; status?: number; failedOnly?: boolean; resourceType?: string; limit?: number } = {},
  ) {
    if (!this.enabled) return { error: "capture is off — enable 'Capture console & network' in settings" };
    const limit = typeof opts.limit === "number" ? opts.limit : 50;
    const urlNeedle = opts.urlContains?.toLowerCase();
    const method = opts.method?.toUpperCase();
    const rt = opts.resourceType?.toLowerCase();
    let rows = this.netOrder.map((id) => this.net.get(id)!).filter(Boolean);
    if (urlNeedle) rows = rows.filter((r) => r.url.toLowerCase().includes(urlNeedle));
    if (method) rows = rows.filter((r) => r.method.toUpperCase() === method);
    if (typeof opts.status === "number") rows = rows.filter((r) => r.status === opts.status);
    if (opts.failedOnly) rows = rows.filter((r) => r.failed || (r.status != null && r.status >= 400));
    if (rt) rows = rows.filter((r) => (r.resourceType || "").toLowerCase() === rt);
    const out = rows.slice(-limit).map((r) => ({
      id: r.id,
      method: r.method,
      url: r.url.length > 300 ? r.url.slice(0, 300) + "…" : r.url,
      status: r.failed ? `failed: ${r.errorText || r.blockedReason || "error"}` : r.status ?? "pending",
      type: r.resourceType,
      pending: !r.finished && !r.failed && r.status == null,
    }));
    return { attached: this.attached, tabId: this.tabId, total: rows.length, returned: out.length, requests: out };
  }

  // Full detail for one request, fetching request/response bodies on demand
  // (they aren't buffered up front — only pulled when the CLI asks for them).
  async getNetworkRequest(id: string) {
    if (!this.enabled) return { error: "capture is off — enable 'Capture console & network' in settings" };
    const rec = this.net.get(id);
    if (!rec) return { error: `no request ${id} in the buffer (it may have scrolled out)` };
    let respBody: string | undefined;
    let respBase64 = false;
    let reqPostData = rec.reqPostData;
    if (this.attached && this.tabId != null) {
      const t: Debuggee = { tabId: this.tabId };
      if (rec.finished && !rec.failed) {
        try {
          const r = (await chrome.debugger.sendCommand(t, "Network.getResponseBody", { requestId: id })) as {
            body: string;
            base64Encoded: boolean;
          };
          respBody = r.body?.slice(0, BODY_MAX);
          respBase64 = r.base64Encoded;
        } catch {
          /* body evicted / not available (redirect, no content, cross-navigation) */
        }
      }
      if (rec.hasPostData && reqPostData == null) {
        try {
          const r = (await chrome.debugger.sendCommand(t, "Network.getRequestPostData", { requestId: id })) as {
            postData: string;
          };
          reqPostData = r.postData?.slice(0, BODY_MAX);
        } catch {
          /* not available */
        }
      }
    }
    return {
      id: rec.id,
      method: rec.method,
      url: rec.url,
      resourceType: rec.resourceType,
      status: rec.status,
      statusText: rec.statusText,
      mimeType: rec.mimeType,
      failed: rec.failed,
      errorText: rec.errorText,
      blockedReason: rec.blockedReason,
      fromCache: rec.fromCache,
      requestHeaders: rec.reqHeaders,
      requestBody: reqPostData,
      responseHeaders: rec.respHeaders,
      responseBody: respBody,
      responseBodyBase64: respBase64,
    };
  }
}
