import { useEffect, useRef, useState } from "react";
import {
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  Globe,
  Layers,
  LoaderCircle,
  Palette,
  Plus,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Square,
  Store,
} from "lucide-react";
import { Bridge, readShopDomain, type Cli, type HostEvent, type ShopSummary } from "./bridge";
import { TOOL } from "./tools";

const MODELS = [
  { label: "Sonnet", value: "sonnet" },
  { label: "Opus", value: "opus" },
  { label: "Haiku", value: "haiku" },
];
const EFFORTS = ["low", "medium", "high", "xhigh"].map((v) => ({
  label: v[0].toUpperCase() + v.slice(1),
  value: v,
}));

type Tone = "idle" | "info" | "success" | "warning" | "critical";
// Monochrome: state is carried by the label text, not colour. Running pulses.
const TONE_DOT: Record<Tone, string> = {
  idle: "bg-muted/60",
  info: "bg-fg animate-pulse",
  success: "bg-fg",
  warning: "bg-muted",
  critical: "bg-fg ring-2 ring-fg/20",
};

type Role = "user" | "assistant";
interface Msg {
  role: Role;
  text: string;
}

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function App() {
  const tool = TOOL;
  const Icon = tool.icon;

  // settings — apply to the NEXT conversation (a live one keeps its config)
  const [model, setModel] = useState("sonnet");
  const [effort, setEffort] = useState("medium");
  const [readPageOn, setReadPageOn] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Merchant-summary API URL + access key (override the host's env); persisted.
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem("pod_api_url") ?? "");
  const [accessKey, setAccessKey] = useState(() => localStorage.getItem("pod_access_key") ?? "");
  useEffect(() => {
    localStorage.setItem("pod_api_url", apiUrl);
  }, [apiUrl]);
  useEffect(() => {
    localStorage.setItem("pod_access_key", accessKey);
  }, [accessKey]);

  // conversation
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ label: string; tone: Tone }>({ label: "ready", tone: "idle" });
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // merchant summary card (auto-loaded from the open ticket)
  const [summary, setSummary] = useState<ShopSummary | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "idle" | "empty" | "error">("loading");
  const [summaryErr, setSummaryErr] = useState<string | undefined>();

  const bridgeRef = useRef<Bridge | null>(null);
  const reqIdRef = useRef(0);
  const activeRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // The shop currently shown on the card, so auto-triggers can tell whether the
  // open ticket actually switched merchants. pollGenRef cancels a stale poll
  // loop; reloadRef lets the once-registered tab listeners call the latest
  // closure (which captures the current apiUrl/accessKey).
  const loadedDomainRef = useRef<string>("");
  const pollGenRef = useRef(0);
  const reloadRef = useRef<() => Promise<void>>();
  const cli: Cli = "claude";

  // Append streamed text to the in-flight assistant message (the last one).
  const appendToLast = (delta: string) =>
    setMessages((ms) => {
      if (!ms.length || ms[ms.length - 1].role !== "assistant") return ms;
      const next = ms.slice();
      next[next.length - 1] = { role: "assistant", text: next[next.length - 1].text + delta };
      return next;
    });

  useEffect(() => {
    const finish = (label: string, tone: Tone) => {
      activeRef.current = null;
      setRunning(false);
      setStatus({ label, tone });
    };
    const onEvent = (e: HostEvent) => {
      if (e.type !== "disconnected" && e.id !== undefined) {
        if (activeRef.current !== null && e.id !== activeRef.current) return;
      }
      switch (e.type) {
        case "chunk":
          appendToLast(e.data);
          break;
        case "tool_use":
          setStatus({ label: `→ ${e.name}`, tone: "info" });
          break;
        case "stderr":
          appendToLast(`\n\n⚠️ ${e.data}`);
          break;
        case "error":
          appendToLast(`\n\n⚠️ ${e.error}`);
          finish("error", "critical");
          break;
        case "done":
          finish(e.code === 0 ? "done" : `exit ${e.code}`, e.code === 0 ? "success" : "critical");
          break;
        case "disconnected":
          appendToLast(
            `\n\n⚠️ native host not reachable. Run ./install.sh <extension-id> and restart Chrome.\n${e.error ?? ""}`,
          );
          finish("host offline", "critical");
          break;
      }
    };
    const b = new Bridge(onEvent);
    b.connect();
    bridgeRef.current = b;
    return () => b.disconnect();
  }, []);

  // Keep a prewarmed session matching the current settings so the first turn of
  // the next conversation only waits on the API, not cold-start.
  useEffect(() => {
    bridgeRef.current?.prewarm({ cli, tools: readPageOn && tool.usesTools, model, effort });
  }, [cli, readPageOn, tool.usesTools, model, effort]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Fetch + render the summary for a specific shop domain (empty → show the
  // "no shop" state). Records the domain so auto-triggers can dedupe.
  const applySummary = async (domain: string) => {
    setSummaryState("loading");
    setSummaryErr(undefined);
    if (!domain) {
      loadedDomainRef.current = "";
      setSummary(null);
      setSummaryState("empty");
      return;
    }
    const r = await bridgeRef.current?.shopSummary(
      domain,
      apiUrl.trim() || undefined,
      accessKey.trim() || undefined,
    );
    loadedDomainRef.current = domain;
    if (r?.data) {
      setSummary(r.data);
      setSummaryState("idle");
    } else {
      setSummary(null);
      setSummaryState("error");
      setSummaryErr(r?.error);
    }
  };

  // Manual/forced load (first open, New chat, ↻): re-detect and reload no
  // matter what.
  const loadSummary = async () => {
    await applySummary(await readShopDomain());
  };

  // Auto path. Featurebase is an SPA: switching conversations swaps the ticket
  // in place — no page reload — and the new shop's details render a beat later.
  // So on a navigation signal we poll the domain a few times and reload only
  // once a *different* shop appears; a newer signal supersedes an in-flight
  // poll so triggers don't stack.
  const reloadIfShopChanged = async () => {
    const gen = ++pollGenRef.current;
    for (let i = 0; i < 6; i++) {
      if (gen !== pollGenRef.current) return; // a newer signal took over
      const domain = await readShopDomain();
      if (domain && domain !== loadedDomainRef.current) {
        await applySummary(domain);
        return;
      }
      await sleep(500);
    }
  };
  reloadRef.current = reloadIfShopChanged;

  // Load once on open.
  useEffect(() => {
    void loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-detect the merchant whenever the open ticket may have changed: an SPA
  // URL change or full load in the active tab, switching browser tabs, or
  // refocusing the window. Registered once; always runs the latest closure via
  // reloadRef so it sees the current API URL / access key.
  useEffect(() => {
    const trigger = () => void reloadRef.current?.();
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      _tabId,
      changeInfo,
      tab,
    ) => {
      if (tab.active && (changeInfo.url || changeInfo.status === "complete")) trigger();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(trigger);
    window.addEventListener("focus", trigger);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(trigger);
      window.removeEventListener("focus", trigger);
    };
  }, []);

  const send = () => {
    if (running) return;
    const text = input.trim();
    const first = messages.length === 0;
    if (!first && !text) {
      setStatus({ label: "type a message", tone: "warning" });
      return;
    }
    // The first turn carries the CS instruction; follow-ups are the raw message.
    const prompt = first ? [tool.instruction, text].filter(Boolean).join("\n\n") : text;
    const shown = first ? text || "Draft a reply to the open ticket" : text;

    setMessages((ms) => [...ms, { role: "user", text: shown }, { role: "assistant", text: "" }]);
    setInput("");

    const id = ++reqIdRef.current;
    activeRef.current = id;
    setRunning(true);
    setStatus({ label: "running…", tone: "info" });
    bridgeRef.current?.send({ id, cli, prompt, tools: readPageOn && tool.usesTools, model, effort });
  };

  const stop = () => {
    if (activeRef.current === null) return;
    bridgeRef.current?.cancel(activeRef.current); // interrupt — keeps the conversation
    setStatus({ label: "stopping…", tone: "warning" });
  };

  const newChat = () => {
    bridgeRef.current?.reset({ cli, tools: readPageOn && tool.usesTools, model, effort });
    activeRef.current = null;
    setRunning(false);
    setMessages([]);
    setInput("");
    setStatus({ label: "ready", tone: "idle" });
    void loadSummary(); // switching tickets → re-detect the merchant
  };

  const copy = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* ignore */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  const empty = messages.length === 0;
  const live = messages.length > 0;

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold">{tool.name}</span>
        <div className="ml-auto flex items-center gap-1">
          <StatusPill status={status} />
          <IconBtn label="New chat" onClick={newChat} disabled={empty && !running}>
            <Plus className="h-4 w-4" />
          </IconBtn>
          <div className="relative">
            <IconBtn
              label="Settings"
              onClick={() => setSettingsOpen((o) => !o)}
              className={settingsOpen ? "bg-border/50 text-fg" : ""}
            >
              <Settings2 className="h-4 w-4" />
            </IconBtn>
            {settingsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSettingsOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-neutral-200 bg-white p-3 text-neutral-800 shadow-lg">
                  <div className="grid grid-cols-2 gap-2.5">
                    <NativeSelect label="Model" value={model} onChange={setModel} options={MODELS} />
                    <NativeSelect label="Effort" value={effort} onChange={setEffort} options={EFFORTS} />
                  </div>
                  <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={readPageOn}
                      onChange={(e) => setReadPageOn(e.target.checked)}
                    />
                    <Globe className="h-4 w-4 text-muted" />
                    Let Claude read the page
                  </label>
                  <label className="mt-2.5 flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                      Merchant API URL
                    </span>
                    <input
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="http://localhost:3000"
                      spellCheck={false}
                      className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                    />
                  </label>
                  <label className="mt-2.5 flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                      Admin access key
                    </span>
                    <input
                      type="password"
                      value={accessKey}
                      onChange={(e) => setAccessKey(e.target.value)}
                      placeholder="customei_ak_…"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                    />
                    <span className="text-[10px] leading-tight text-neutral-500">
                      is_admin key for pod-shopify-backend; stored in this panel.
                    </span>
                  </label>
                  {live && <p className="mt-2 text-[11px] text-neutral-500">Model/effort apply to a new chat.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* pinned merchant summary — stays at top while the chat scrolls under it */}
      <MerchantCard summary={summary} state={summaryState} err={summaryErr} onRefresh={loadSummary} />

      {/* message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted">
            <Icon className="h-7 w-7 opacity-60" />
            <p className="text-sm">{tool.blurb}</p>
            <p className="text-xs">Hit {tool.verb} to draft from the open ticket, then refine by chatting.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-accent px-3 py-2 text-sm text-accent-fg">
                  <pre className="fb-out">{m.text}</pre>
                </div>
              ) : (
                <div key={i} className="group max-w-[92%] self-start rounded-xl rounded-bl-sm border border-border bg-surface px-3 py-2">
                  <pre className="fb-out text-sm">
                    {m.text || (running && i === messages.length - 1 ? "…" : "")}
                  </pre>
                  {m.text && (
                    <button
                      onClick={() => copy(i, m.text)}
                      className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted opacity-0 transition-opacity hover:bg-border/40 hover:text-fg group-hover:opacity-100"
                    >
                      {copiedIdx === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedIdx === i ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* composer */}
      <div className="border-t border-border px-3 py-2.5" onKeyDown={onKeyDown}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={empty ? tool.inputPlaceholder : "Reply to the assistant…"}
          rows={empty ? 3 : 2}
          className="w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <div className="mt-2 flex items-center gap-2">
          {running ? (
            <button
              onClick={stop}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 py-2 text-sm hover:bg-border/40"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
            >
              {empty ? tool.verb : "Send"}
            </button>
          )}
          {running && <LoaderCircle className="h-4 w-4 animate-spin text-muted" />}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted">
            <CornerDownLeft className="h-3 w-3" />
            ⌘↵
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- merchant card ------------------------------ */

function usageSince(iso: string): string {
  const then = new Date(iso).getTime();
  if (!then || isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${years}y ${rem}mo` : `${years}y`;
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000);
}

const money = (a: string | null) => (a == null || a === "" ? "—" : `$${a}`);

function MerchantCard({
  summary,
  state,
  err,
  onRefresh,
}: {
  summary: ShopSummary | null;
  state: "loading" | "idle" | "empty" | "error";
  err?: string;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const clickable = !!summary && state !== "empty";

  const copyEmail = (e: React.MouseEvent, email: string) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(email).then(() => {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 1500);
    });
  };

  const trialing = summary?.subscriptionStatus === "TRIALING";
  const cpeDays = daysUntil(summary?.currentPeriodEnd ?? null);

  return (
    <div className="relative mx-3 mt-2 shrink-0 rounded-xl border border-border bg-surface">
      <div
        className={cx("px-3 pt-2.5", clickable && "cursor-pointer")}
        onClick={clickable ? () => setOpen((o) => !o) : undefined}
      >
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 shrink-0 text-muted" />
          <span className="truncate text-sm font-semibold">
            {summary?.domain ?? (state === "loading" ? "Detecting merchant…" : "Merchant")}
          </span>
          {clickable && (
            <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
          )}
          <button
            aria-label="Refresh merchant"
            title="Refresh"
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-border/40 hover:text-fg"
          >
            <RefreshCw className={cx("h-3.5 w-3.5", state === "loading" && "animate-spin")} />
          </button>
        </div>

        {state === "empty" && (
          <p className="pb-2.5 pt-1 text-xs text-muted">No shop detected on this page. Open a ticket, then hit ↻.</p>
        )}
        {state === "error" && <p className="pb-2.5 pt-1 text-xs text-muted">⚠️ {err || "lookup failed"}</p>}
        {state === "loading" && !summary && <p className="pb-2.5 pt-1 text-xs text-muted">Loading account summary…</p>}

        {summary && state !== "empty" && (
          <div className="pb-2.5 pt-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                {summary.planName || "No plan"}
              </span>
              {summary.subscriptionStatus && (
                <span className="text-muted">{summary.subscriptionStatus.toLowerCase()}</span>
              )}
              <span className="text-muted">· {usageSince(summary.createdAt)} using</span>
              {summary.currentPeriodEnd && (
                <span className="inline-flex items-center gap-1 text-muted">
                  <CalendarClock className="h-3 w-3" />
                  {trialing ? "trial ends" : "renews"} {shortDate(summary.currentPeriodEnd)}
                  {trialing && cpeDays != null && cpeDays >= 0 ? ` (${cpeDays}d)` : ""}
                </span>
              )}
              {summary.shopStatus && summary.shopStatus !== "ACTIVE" && (
                <span className="rounded-md bg-fg/10 px-1.5 py-0.5 font-semibold text-fg">
                  shop {summary.shopStatus.toLowerCase()}
                </span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              <Stat icon={Layers} value={summary.optionSets} label="Option sets" />
              <Stat icon={Palette} value={summary.designTemplates} label="Designs" />
              <Stat icon={ShoppingBag} value={summary.orders} label="Orders" />
              <Stat icon={Building2} value={summary.shopCount} label="Shops" />
            </div>
          </div>
        )}
      </div>

      {open && summary && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-[65vh] overflow-y-auto rounded-xl border border-border bg-elevated px-3 pb-3 pt-1 shadow-lg">
            <DetailHead>Contact</DetailHead>
            <Row label="Name" value={summary.name || "—"} />
            <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
              <span className="shrink-0 text-muted">Email</span>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate">{summary.email || "—"}</span>
                {summary.email && (
                  <button onClick={(e) => copyEmail(e, summary.email!)} className="shrink-0 text-muted hover:text-fg">
                    {copiedEmail ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </button>
                )}
              </span>
            </div>

            <DetailHead>Plan</DetailHead>
            <Row label="Plan" value={summary.planName || "No plan"} />
            <Row
              label="Price"
              value={`${money(summary.planAmount)}${summary.interval ? " / " + summary.interval.toLowerCase() : ""}`}
            />
            <Row label="Status" value={summary.subscriptionStatus || "—"} />
            <Row label="MRR" value={money(summary.mrr)} />
            <Row label="Activated" value={shortDate(summary.activatedAt)} />
            <Row label={trialing ? "Trial ends" : "Renews"} value={shortDate(summary.currentPeriodEnd)} />

            <DetailHead>Usage</DetailHead>
            <Row label="Option sets" value={summary.optionSets ?? "—"} />
            <Row label="Design templates" value={summary.designTemplates ?? "—"} />
            <Row label="Orders" value={summary.orders ?? "—"} />
            <Row label="Libraries" value={summary.libraries ?? "—"} />
            <Row label="Credits" value={summary.creditBalance ?? "—"} />

            <DetailHead>Account</DetailHead>
            <Row label="Shops" value={summary.shopCount ?? "—"} />
            {summary.subscriptionShopDomain && summary.subscriptionShopDomain !== summary.domain && (
              <Row label="Subscription on" value={summary.subscriptionShopDomain} />
            )}
            <Row label="Shop status" value={summary.shopStatus || "—"} warn={!!summary.shopStatus && summary.shopStatus !== "ACTIVE"} />
            <Row label="Installed" value={shortDate(summary.createdAt)} />
            <Row label="Account ID" value={<span className="font-mono text-[11px]">{summary.accountId}</span>} />
          </div>
        </>
      )}
    </div>
  );
}

function DetailHead({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-0.5 mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted first:mt-1">{children}</p>
  );
}

function Row({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={cx("min-w-0 truncate text-right tabular-nums", warn && "font-semibold text-fg")}>{value}</span>
    </div>
  );
}

function Stat({
  icon: I,
  value,
  label,
}: {
  icon: typeof Layers;
  value: number | null;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-elevated px-1 py-1.5">
      <I className="h-3.5 w-3.5 text-muted" />
      <span className="mt-0.5 text-sm font-semibold tabular-nums">{value ?? "—"}</span>
      <span className="text-[10px] leading-tight text-muted">{label}</span>
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function StatusPill({ status }: { status: { label: string; tone: Tone } }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} />
      {status.label}
    </span>
  );
}

function IconBtn({
  label,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-border/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30 disabled:hover:bg-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function NativeSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <div className="relative">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-lg border border-border bg-elevated px-2.5 py-1.5 pr-7 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      </div>
    </label>
  );
}
