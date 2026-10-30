// Adds a "Claude" tab next to "Details" / "Copilot" in the Featurebase inbox
// sidebar (#user-details-panel). Opening it shows the full Nexlify Assistant —
// the same React app as the side panel, loaded as an extension-page iframe, so
// it keeps chrome.* access (native host → local `claude` CLI, page/tab tools,
// merchant card, history). The page never sees the chat: the iframe is
// cross-origin to Featurebase.
//
// The iframe lives in a fixed container on <html>, OUTSIDE Featurebase's React
// tree, and is only laid over the sidebar's content area. React re-renders and
// switching conversations therefore never reload it (moving an iframe in the DOM
// would), so the chat survives navigation. Only the small tab heading lives in
// their tree, and it's re-inserted whenever React drops it.

const PANEL_ID = "user-details-panel";
const HOST_ID = "nexlify-fb-claude";
const TAB_ATTR = "data-nexlify-tab";
const DRIVE_ID = "__nexlify_drive__"; // the "AI is driving" overlay (drive.ts)
const STORE_KEY = "nexlify_fb_claude_open";

// Featurebase's own tab classes, as seen on the live inbox. Used only until we
// can copy them from the native tabs (which we prefer, so a restyle carries over).
const FALLBACK_ACTIVE =
  "!text-[15px] capitalize min-h-[66px] flex items-center main-transition border-b -mb-[2px] leading-none text-title border-accent cursor-pointer";
const FALLBACK_INACTIVE =
  "!text-[15px] capitalize min-h-[66px] flex items-center main-transition border-b -mb-[2px] leading-none text-foreground border-transparent hover:border-foreground/20 hover:dark:text-gray-100/90 hover:text-gray-600/90 cursor-pointer";

let activeCls = FALLBACK_ACTIVE;
let inactiveCls = FALLBACK_INACTIVE;

let open = readOpen();
let host: HTMLDivElement | null = null;
let frame: HTMLIFrameElement | null = null;
let classObserver: MutationObserver | null = null;
let observedTabs: Element | null = null;
let observedColumn: Element | null = null;
const resizeObserver = new ResizeObserver(() => schedule());

function readOpen(): boolean {
  try {
    return sessionStorage.getItem(STORE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(v: boolean) {
  try {
    sessionStorage.setItem(STORE_KEY, v ? "1" : "0");
  } catch {
    /* storage blocked — the tab just won't stay open across reloads */
  }
}

// ---- locating Featurebase's sidebar ---------------------------------------

interface Sidebar {
  panel: HTMLElement; // #user-details-panel (carries the sidebar's background)
  column: HTMLElement; // header + content
  header: HTMLElement; // tab strip + toggle button
  tabs: HTMLElement; // the "details" / "copilot" headings
  native: HTMLElement[];
}

function findSidebar(): Sidebar | null {
  const panel = document.getElementById(PANEL_ID);
  const column = panel?.firstElementChild as HTMLElement | null;
  const header = column?.firstElementChild as HTMLElement | null;
  if (!panel || !column || !header) return null;
  // The tab strip is whichever child of the header holds the "copilot" heading.
  // Match on textContent: the label is lowercase and capitalized by CSS.
  const copilot = [...header.querySelectorAll("h2")].find(
    (h) => !h.hasAttribute(TAB_ATTR) && h.textContent?.trim().toLowerCase() === "copilot",
  );
  const tabs = copilot?.parentElement;
  if (!copilot || !tabs) return null;
  const native = [...tabs.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute(TAB_ATTR),
  );
  return { panel, column, header, tabs, native };
}

// Learn the active/inactive class strings from the native tabs while they're
// still in their own state (one active, one not).
function learnClasses(native: HTMLElement[]) {
  if (open) return; // natives are forced inactive while we're open
  const act = native.find((el) => el.className.includes("border-accent"));
  const ina = native.find((el) => !el.className.includes("border-accent"));
  if (act) activeCls = act.className;
  if (ina) inactiveCls = ina.className;
}

// ---- our tab ---------------------------------------------------------------

function ensureTab(sb: Sidebar): HTMLElement {
  let tab = sb.tabs.querySelector<HTMLElement>(`h2[${TAB_ATTR}]`);
  if (!tab) {
    tab = document.createElement("h2");
    tab.setAttribute(TAB_ATTR, "claude");
    tab.setAttribute("role", "button");
    tab.tabIndex = 0;
    tab.title = "Chat with Claude (Nexlify Assistant)";
    tab.textContent = "claude";
    tab.addEventListener("click", () => setOpen(true));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
    });
    sb.tabs.appendChild(tab);
  }
  return tab;
}

// Clicking a native tab closes ours. Bound once per element, in the capture
// phase, so we restore their classes before React's own handler runs.
const boundNative = new WeakSet<HTMLElement>();
function bindNative(native: HTMLElement[]) {
  for (const el of native) {
    if (boundNative.has(el)) continue;
    boundNative.add(el);
    el.addEventListener("click", () => setOpen(false), true);
  }
}

// While we're open the native tabs must look inactive. We remember React's last
// class string in a data attribute and put it back on close, so React's next
// render (or none, if its state didn't change) stays consistent.
function forceNativeInactive(native: HTMLElement[]) {
  for (const el of native) {
    if (el.className === inactiveCls) continue;
    el.dataset.nxOrigClass = el.className;
    el.className = inactiveCls;
  }
}

function restoreNative(native: HTMLElement[]) {
  for (const el of native) {
    const orig = el.dataset.nxOrigClass;
    if (orig != null) {
      el.className = orig;
      delete el.dataset.nxOrigClass;
    }
  }
}

// React may rewrite a heading's class while we're open (its own state changed);
// re-assert ours right away instead of waiting for the next tree mutation.
function watchClasses(tabs: HTMLElement) {
  if (observedTabs === tabs) return;
  classObserver?.disconnect();
  observedTabs = tabs;
  classObserver = new MutationObserver(() => schedule());
  classObserver.observe(tabs, { attributes: true, attributeFilter: ["class"], subtree: true });
}

// ---- the chat frame --------------------------------------------------------

function ensureHost(): HTMLDivElement {
  if (host && document.documentElement.contains(host)) return host;
  host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    zIndex: "40",
    display: "none",
    overflow: "hidden",
  });
  // Shadow root so the page's global CSS (e.g. `iframe { … }`) can't reach in.
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ":host{all:initial} iframe{display:block;width:100%;height:100%;border:0;background:transparent}";
  frame = document.createElement("iframe");
  frame.title = "Nexlify Assistant";
  frame.allow = "clipboard-read; clipboard-write";
  // Loaded lazily (first open) so a Featurebase page load never spawns a CLI.
  root.append(style, frame);
  document.documentElement.appendChild(host);
  return host;
}

const panelUrl = () => chrome.runtime.getURL("src/sidepanel/index.html") + "?embed=featurebase";

function loadFrame() {
  if (!frame || frame.src) return;
  frame.src = panelUrl();
}

// The rounded card the sidebar sits in (the column or its nearest ancestor with
// a bottom corner radius). Our square host must copy its bottom corners and
// stay inside it, or the iframe pokes out past the rounded edge.
let cardCache: { column: HTMLElement; card: HTMLElement | null } | null = null;
function roundedCard(column: HTMLElement): HTMLElement | null {
  if (cardCache?.column === column) return cardCache.card;
  let card: HTMLElement | null = null;
  for (let n: HTMLElement | null = column; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (parseFloat(cs.borderBottomRightRadius) > 0 || parseFloat(cs.borderBottomLeftRadius) > 0) {
      card = n;
      break;
    }
  }
  cardCache = { column, card };
  return card;
}

// A corner of the card that our rect touches, as the inner radius (outer radius
// minus the card's border), else 0.
function innerRadius(touches: boolean, radius: string, border: string): string {
  if (!touches) return "0px";
  return `${Math.max(0, parseFloat(radius) - parseFloat(border))}px`;
}

// Cover the sidebar's content area (below the tab strip), tracking its rect.
function placeHost(sb: Sidebar | null) {
  if (!host) return;
  const col = sb?.column.getBoundingClientRect();
  const head = sb?.header.getBoundingClientRect();
  if (!open || !sb || !col || !head || col.width < 120 || col.height < 120) {
    host.style.display = "none";
    return;
  }
  const top = Math.round(head.bottom);
  const card = roundedCard(sb.column);
  const box = card?.getBoundingClientRect();
  const cs = card ? getComputedStyle(card) : null;
  // Inside the card's border box, never past it.
  const inset = (side: "Left" | "Right" | "Bottom") => (cs ? parseFloat(cs[`border${side}Width`]) || 0 : 0);
  const left = Math.round(box ? Math.max(col.left, box.left + inset("Left")) : col.left);
  const right = Math.round(box ? Math.min(col.right, box.right - inset("Right")) : col.right);
  const bottom = Math.round(box ? Math.min(col.bottom, box.bottom - inset("Bottom")) : col.bottom);
  const atBottom = !!box && bottom >= box.bottom - inset("Bottom") - 1;
  Object.assign(host.style, {
    display: "block",
    // Opaque, in the sidebar's own color (follows Featurebase's light/dark
    // theme), so Copilot never shows through while the assistant page loads.
    background: getComputedStyle(sb.panel).backgroundColor,
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(0, right - left)}px`,
    height: `${Math.max(0, bottom - top)}px`,
    borderBottomLeftRadius: cs
      ? innerRadius(atBottom && left <= box!.left + inset("Left") + 1, cs.borderBottomLeftRadius, cs.borderLeftWidth)
      : "0px",
    borderBottomRightRadius: cs
      ? innerRadius(atBottom && right >= box!.right - inset("Right") - 1, cs.borderBottomRightRadius, cs.borderRightWidth)
      : "0px",
  });
}

// When the assistant drives the page, drive.ts lays a full-viewport blocker at
// the max z-index. Keep the chat above it (same z-index, later in the DOM) so
// its Stop button stays clickable; otherwise sit at a normal level so
// Featurebase's own menus and modals still cover us.
function layerOverDrive() {
  if (!host) return;
  const drive = document.getElementById(DRIVE_ID);
  if (!drive) {
    host.style.zIndex = "40";
    return;
  }
  host.style.zIndex = "2147483647";
  const html = document.documentElement;
  if (drive.parentNode === html && drive.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_PRECEDING) {
    html.insertBefore(drive, host); // move the overlay, never the iframe (that reloads it)
  }
}

// ---- the open conversation, handed to the assistant ---------------------------
// The assistant gets the conversation instead of hunting for the tab and reading
// the page (slow, and it may pick the wrong tab). Featurebase's own dashboard API
// (same origin, the agent's session) has exact times, authors and the customer's
// shop; a compact copy goes into the iframe whenever it changes. Read-only: we
// never call anything that changes the conversation.

const EXT_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, ""); // chrome-extension://<id>
const CTX_POLL_MS = 20_000;

type Who = "customer" | "agent" | "bot" | "note";
interface CtxMessage {
  id: string;
  who: Who;
  name: string;
  text: string;
  at: string; // ISO
}
interface FbContext {
  conversationId: string;
  url: string;
  state: string; // open | closed | snoozed
  customer: { name: string; email: string };
  shop: string; // x.myshopify.com (or the company website), "" if unknown
  company: string;
  messages: CtxMessage[]; // oldest first
  fetchedAt: number;
  loading?: boolean; // a cached copy or a bare placeholder while the fresh one loads
}

const WHO: Record<string, Who> = { user_msg: "customer", admin_msg: "agent", bot_msg: "bot", admin_note: "note" };

const conversationIdFromUrl = () => location.pathname.match(/\/conversation\/(\d+)/)?.[1] ?? "";

// Message bodies are HTML. An inert parsed document runs no script and loads
// nothing; we keep line breaks and note attachments.
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
  doc.querySelectorAll("li").forEach((li) => li.prepend("- "));
  doc.querySelectorAll("p, li, div, h1, h2, h3, h4, blockquote, pre").forEach((el) => el.append("\n"));
  const images = doc.querySelectorAll("img").length;
  const text = (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return images ? `${text}${text ? " " : ""}[${images} image${images > 1 ? "s" : ""}]` : text;
}

const bareDomain = (site: string) =>
  site.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

/* eslint-disable @typescript-eslint/no-explicit-any -- Featurebase's private API, read defensively */
async function fetchContext(id: string): Promise<FbContext | null> {
  const res = await fetch(`/api/v1/messenger/conversations/${id}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const c: any = (await res.json())?.conversation;
  if (!c || String(c.id) !== id) return null;
  const messages: CtxMessage[] = ((c.conversationParts ?? []) as any[])
    .filter((p) => WHO[p.partType])
    .map((p) => ({
      id: String(p.id),
      who: WHO[p.partType],
      name: String(p.author?.name ?? ""),
      text: htmlToText(String(p.body ?? "")) || String(p.bodyText ?? "").trim(),
      at: String(p.createdAt ?? ""),
    }))
    .filter((m) => m.text)
    .slice(-40);
  const person: any = ((c.participants ?? []) as any[]).find((p) => p.type === "customer" || p.type === "lead") ?? {};
  const companies: any[] = [...(c.userSummary?.companies ?? []), ...(person.companies ?? [])];
  const sites = companies.map((co) => bareDomain(String(co.website ?? ""))).filter(Boolean);
  return {
    conversationId: id,
    url: location.href,
    state: String(c.state ?? (c.open ? "open" : "closed")),
    customer: { name: String(person.name ?? ""), email: String(person.email ?? "") },
    shop: sites.find((s) => s.endsWith(".myshopify.com")) ?? sites[0] ?? "",
    company: String(companies[0]?.name ?? ""),
    messages,
    fetchedAt: Date.now(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let ctx: FbContext | null = null;
let ctxSig = ""; // what the iframe last got
// Recently loaded conversations, so switching back is instant (then refreshed).
const ctxCache = new Map<string, FbContext>();
function cacheContext(c: FbContext) {
  ctxCache.delete(c.conversationId);
  ctxCache.set(c.conversationId, c);
  if (ctxCache.size > 30) ctxCache.delete(ctxCache.keys().next().value!);
}
const placeholder = (id: string): FbContext => ({
  conversationId: id,
  url: location.href,
  state: "",
  customer: { name: "", email: "" },
  shop: "",
  company: "",
  messages: [],
  fetchedAt: 0,
});
let ctxGen = 0;
let missingId = ""; // a conversation the API refused: the 20 s poll retries it, not every sync
let threadSig = ""; // newest message element + count, to notice new messages
let refreshTimer = 0;

// Our panel page is cross-origin to Featurebase, so its location can't be read.
// A readable one is about:blank (the panel is still loading: posting to it fails
// with "target origin … does not match") or a Featurebase page that replaced the
// chat (a link followed inside it): neither gets our messages, and the latter is
// sent back to the chat.
let recoveredAt = 0;
function frameReady(): boolean {
  if (!frame?.src || !frame.contentWindow) return false;
  let href: string;
  try {
    href = frame.contentWindow.location.href;
  } catch {
    return true;
  }
  if (href !== "about:blank" && Date.now() - recoveredAt > 5000) {
    recoveredAt = Date.now();
    frame.src = panelUrl();
  }
  return false;
}

function postToFrame(data: unknown) {
  if (frameReady()) frame!.contentWindow!.postMessage(data, EXT_ORIGIN);
}

function postContext(force = false) {
  const sig = ctx
    ? `${ctx.conversationId}|${ctx.state}|${ctx.messages.length}|${ctx.messages.at(-1)?.id ?? ""}|${ctx.loading ? "L" : ""}|${open}`
    : `none|${open}`;
  if (!force && sig === ctxSig) return;
  ctxSig = sig;
  postToFrame({ type: "nexlify:fb-context", ctx, visible: open });
}

async function refreshContext() {
  if (!frameReady()) return; // nothing to feed until the agent opens the tab once
  const id = conversationIdFromUrl();
  const gen = ++ctxGen;
  let next: FbContext | null = null;
  if (id) {
    try {
      next = await fetchContext(id);
      if (next) cacheContext(next);
    } catch {
      // A blip: keep what we had. A bare placeholder stays "loading" and retries.
      const had = ctx?.conversationId === id ? ctx : null;
      if (had && !had.fetchedAt) {
        if (gen === ctxGen) refreshSoon(2000);
        return;
      }
      next = had ? { ...had, loading: false } : null;
    }
  }
  if (gen !== ctxGen) return; // a newer refresh superseded this one
  missingId = id && !next ? id : "";
  ctx = next;
  postContext();
}

function refreshSoon(ms = 350) {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshContext(), ms);
}

// Cheap per-sync check: a conversation switch or a new message in the thread.
function watchThread() {
  const id = conversationIdFromUrl();
  if (id !== (ctx?.conversationId ?? "") && id !== missingId) {
    clearTimeout(refreshTimer);
    if (!id) {
      ctx = null;
      postContext();
    } else {
      // Switch the chat at once (the cached copy, or a placeholder) instead of
      // after the API round trip (~0.3-0.7 s); the fresh copy follows.
      ctx = { ...(ctxCache.get(id) ?? placeholder(id)), url: location.href, loading: true };
      postContext();
      void refreshContext();
    }
  }
  const list = document.querySelector("[data-conversation-message-list]");
  const newest = list?.querySelector('[id^="msg-"]'); // the list renders newest first
  const sig = `${list?.getAttribute("data-conversation-message-list") ?? ""}|${newest?.id ?? ""}|${list?.querySelectorAll('[id^="msg-"]').length ?? 0}`;
  if (sig !== threadSig) {
    threadSig = sig;
    // A new message in the open thread. Not while a switch is loading: the list
    // re-rendering would supersede (and so delay) the fetch already in flight.
    if (list && ctx && !ctx.loading) refreshSoon();
  }
}

// ---- putting a drafted reply into the composer ---------------------------------
// Fills the reply box like a paste would, for the agent to read and send. We
// never press Send. The content script can't reach TipTap's editor object (it
// lives in the page's JS world), but ProseMirror handles a paste event, so we
// dispatch one, with HTML when we have it so bold, lists and links survive. If
// the box still holds our previous insert (or nothing), it is replaced;
// anything the agent typed is kept and the reply goes after it.

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
let lastInserted = ""; // normalized text of the box right after our last insert

function replyEditor(): HTMLElement | null {
  const sidebar = document.getElementById(PANEL_ID);
  const editors = [...document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]')].filter(
    (el) => !sidebar?.contains(el) && el.getBoundingClientRect().width > 0,
  );
  return editors.at(-1) ?? null;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function insertIntoComposer(text: string, html?: string): Promise<boolean> {
  const ed = replyEditor();
  if (!ed) return false;
  const current = norm(ed.innerText);
  const replace = !current || current === lastInserted;
  ed.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(ed);
  if (!replace) range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  // ProseMirror picks up a DOM selection on the next selectionchange; pasting
  // before that would land at the old caret.
  await tick(40);
  const dt = new DataTransfer();
  dt.setData("text/plain", replace ? text : `\n\n${text}`);
  if (html) dt.setData("text/html", replace ? html : `<p></p>${html}`);
  const unhandled = ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  // ProseMirror cancels the paste it handled; if nobody did, type it instead.
  if (unhandled) document.execCommand("insertText", false, replace ? text : `\n\n${text}`);
  await tick(40);
  lastInserted = norm(ed.innerText);
  return true;
}

window.addEventListener("message", (e) => {
  if (!frame || e.source !== frame.contentWindow || e.origin !== EXT_ORIGIN) return;
  const d = e.data as { type?: string; text?: string; html?: string; reqId?: number } | null;
  if (d?.type === "nexlify:fb-hello") {
    if (ctx && ctx.conversationId === conversationIdFromUrl()) postContext(true);
    else void refreshContext().then(() => postContext(true));
  } else if (d?.type === "nexlify:fb-refresh") {
    void refreshContext();
  } else if (d?.type === "nexlify:fb-insert" && typeof d.text === "string") {
    void insertIntoComposer(d.text, typeof d.html === "string" ? d.html : undefined).then((ok) =>
      postToFrame({ type: "nexlify:fb-inserted", reqId: d.reqId, ok }),
    );
  }
});

// ---- state + sync ----------------------------------------------------------

function setOpen(v: boolean) {
  if (open === v) return;
  const sb = findSidebar();
  if (!v && sb) restoreNative(sb.native);
  open = v;
  writeOpen(v);
  if (v) {
    ensureHost();
    loadFrame();
  }
  sync();
  postContext(); // tells the assistant whether it's on screen (auto-drafts only then)
}

function sync() {
  const sb = findSidebar();
  if (sb) {
    learnClasses(sb.native);
    const tab = ensureTab(sb);
    bindNative(sb.native);
    watchClasses(sb.tabs);
    // Re-observing an already-observed element fires the callback again, which
    // would loop through schedule() every frame — only observe a new column.
    if (observedColumn !== sb.column) {
      if (observedColumn) resizeObserver.unobserve(observedColumn);
      resizeObserver.observe(sb.column);
      observedColumn = sb.column;
    }
    if (open) forceNativeInactive(sb.native);
    const want = open ? activeCls : inactiveCls;
    if (tab.className !== want) tab.className = want;
  }
  if (open) {
    ensureHost();
    loadFrame();
  }
  placeHost(sb);
  layerOverDrive();
  if (frameReady()) watchThread();
}

// Coalesce bursts of DOM changes (Featurebase re-renders a lot) into one sync
// per frame.
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    sync();
  });
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("resize", schedule);
// Safety net for moves no observer reports (a panel shifting without resizing),
// only while the chat is showing.
setInterval(() => {
  if (open) schedule();
}, 500);
// State changes (closed, snoozed) and replies that don't re-render the thread.
setInterval(() => void refreshContext(), CTX_POLL_MS);
sync();
