import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  ArrowUp,
  Bug,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  FolderGit2,
  Globe,
  Headset,
  History,
  Layers,
  LoaderCircle,
  Palette,
  Plus,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Sparkles,
  Square,
  Store,
  Trash2,
} from "lucide-react";
import { Bridge, isFeaturebasePage, readShopDomain, type Cli, type HostEvent, type ShopSummary } from "./bridge";
import { type CaptureStatus } from "./capture";
import { APP_NAME, DRAFT_REPLY_INSTRUCTION, GENERAL_PREAMBLE } from "./tools";
import {
  clearConversations,
  deleteConversation,
  deriveTitle,
  loadConversations,
  newConversationId,
  saveConversation,
  type Conversation,
} from "./history";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

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

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Resuming a saved conversation: the native CLI session is gone, so we seed the
// fresh session's first turn with the whole transcript as context.
function buildReplayPrompt(history: Msg[], newText: string): string {
  const transcript = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
  return (
    GENERAL_PREAMBLE +
    "\n\nYou are resuming an earlier conversation. Transcript so far:\n\n" +
    transcript +
    "\n\n---\nContinue the conversation. The user now says:\n" +
    (newText || "(continue)")
  );
}

// Assistant output as rendered markdown — proportional prose, fenced code as
// highlighted code blocks (js → js, text → text). Handles partial markdown
// gracefully while streaming.
function AssistantText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </Markdown>
    </div>
  );
}

export default function App() {
  // settings — apply to the NEXT conversation (a live one keeps its config)
  const [model, setModel] = useState("sonnet");
  const [effort, setEffort] = useState("medium");
  const [pageOn, setPageOn] = useState(true); // read + control the live tab
  // Let the assistant manage tabs (open/close/switch/navigate). On by default —
  // the same agentic, no-friction stance as page control.
  const [tabsOn, setTabsOn] = useState(() => localStorage.getItem("fb_tabs_on") !== "0");
  // Permission for the assistant to capture console/network. On by default; the
  // debugger only actually attaches (and shows Chrome's banner) when the AI
  // first uses it, so "on" is banner-free until then.
  const [captureOn, setCaptureOn] = useState(() => localStorage.getItem("fb_capture_on") !== "0");
  const [repoPath, setRepoPath] = useState(() => localStorage.getItem("fb_repo_path") ?? "");
  const [browsing, setBrowsing] = useState(false); // folder picker in flight
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Merchant-summary API URL + access key (override the host's env); persisted.
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem("pod_api_url") ?? "");
  const [accessKey, setAccessKey] = useState(() => localStorage.getItem("pod_access_key") ?? "");
  useEffect(() => void localStorage.setItem("pod_api_url", apiUrl), [apiUrl]);
  useEffect(() => void localStorage.setItem("pod_access_key", accessKey), [accessKey]);
  useEffect(() => void localStorage.setItem("fb_capture_on", captureOn ? "1" : "0"), [captureOn]);
  useEffect(() => void localStorage.setItem("fb_tabs_on", tabsOn ? "1" : "0"), [tabsOn]);
  useEffect(() => void localStorage.setItem("fb_repo_path", repoPath), [repoPath]);

  // conversation
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ label: string; tone: Tone }>({ label: "ready", tone: "idle" });
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<Conversation[]>([]);

  // merchant summary card — contextual: only shown when a shop is detected on
  // the current page (Featurebase ticket), hidden on ordinary pages.
  const [summary, setSummary] = useState<ShopSummary | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "idle" | "error">("loading");
  const [summaryErr, setSummaryErr] = useState<string | undefined>();
  const [shopDetected, setShopDetected] = useState(false);

  const bridgeRef = useRef<Bridge | null>(null);
  const reqIdRef = useRef(0);
  const activeRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Streaming smoothing: incoming (chunky) deltas buffer here and a rAF loop
  // reveals them a slice at a time so it reads as realtime typing.
  const pendingRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const loadedDomainRef = useRef<string>("");
  const pollGenRef = useRef(0);
  const reloadRef = useRef<() => Promise<void>>();
  const stopRef = useRef<() => void>(); // latest stop(), for the Esc-to-take-over handler
  // Conversation bookkeeping. messagesRef mirrors messages for stale-free saves;
  // convIdRef is the id we persist under; replayPendingRef marks a reopened
  // conversation whose next turn must re-seed the transcript as context.
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const convIdRef = useRef<string | null>(null);
  const replayPendingRef = useRef(false);
  const cli: Cli = "claude";

  const buildCfg = () => ({
    cli,
    page: pageOn,
    tabs: tabsOn,
    capture: captureOn,
    repoPath: repoPath.trim(),
    model,
    effort,
  });

  // Pop the OS folder picker (via the native host) and fill in the repo path.
  const browseRepo = async () => {
    if (browsing) return;
    setBrowsing(true);
    try {
      const r = await bridgeRef.current?.pickFolder();
      if (r?.path) setRepoPath(r.path);
    } finally {
      setBrowsing(false);
    }
  };

  // Persist the current conversation (upsert by id). No-op when empty.
  const saveCurrent = () => {
    const msgs = messagesRef.current;
    if (!msgs.length) return;
    if (!convIdRef.current) convIdRef.current = newConversationId();
    void saveConversation({
      id: convIdRef.current,
      title: deriveTitle(msgs),
      updatedAt: Date.now(),
      messages: msgs.map((m) => ({ role: m.role, text: m.text })),
    });
  };

  // Append text to the in-flight assistant message (the last one).
  const appendToLast = (delta: string) =>
    setMessages((ms) => {
      if (!ms.length || ms[ms.length - 1].role !== "assistant") return ms;
      const next = ms.slice();
      next[next.length - 1] = { role: "assistant", text: next[next.length - 1].text + delta };
      return next;
    });

  // Drain the buffer a slice per frame; the slice scales with how much is
  // waiting, so it catches up under fast bursts but still animates.
  const pump = () => {
    const pending = pendingRef.current;
    if (!pending) {
      rafRef.current = null;
      return;
    }
    const step = Math.max(2, Math.ceil(pending.length / 5));
    appendToLast(pending.slice(0, step));
    pendingRef.current = pending.slice(step);
    rafRef.current = requestAnimationFrame(pump);
  };
  const enqueue = (delta: string) => {
    pendingRef.current += delta;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(pump);
  };
  // Reveal whatever's left immediately (turn ended / interrupted).
  const flushStream = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current) {
      appendToLast(pendingRef.current);
      pendingRef.current = "";
    }
  };
  // Drop any buffered text without showing it (starting a different turn).
  const resetStream = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = "";
  };

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
          enqueue(e.data);
          break;
        case "tool_use":
          setStatus({ label: `→ ${e.name}`, tone: "info" });
          break;
        case "thinking":
          setStatus({ label: "thinking…", tone: "info" });
          break;
        case "stderr":
          flushStream();
          appendToLast(`\n\n⚠️ ${e.data}`);
          break;
        case "error":
          flushStream();
          appendToLast(`\n\n⚠️ ${e.error}`);
          finish("error", "critical");
          break;
        case "done":
          flushStream();
          finish(e.code === 0 ? "done" : `exit ${e.code}`, e.code === 0 ? "success" : "critical");
          break;
        case "disconnected":
          flushStream();
          appendToLast(
            `\n\n⚠️ native host not reachable. Run ./install.sh <extension-id> and restart Chrome.\n${e.error ?? ""}`,
          );
          finish("host offline", "critical");
          break;
      }
    };
    // Just mirror the capture status. Dismissing the debugger banner detaches
    // the CDP session, but we no longer revoke the permission — the assistant
    // re-attaches on-demand the next time it reads console/network.
    const b = new Bridge(onEvent, (s) => setCaptureStatus(s));
    b.connect();
    bridgeRef.current = b;
    return () => {
      saveCurrent();
      b.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave to history whenever a turn finishes (running → false with content).
  useEffect(() => {
    if (running || !messagesRef.current.length) return;
    saveCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Keep a prewarmed session matching the current settings so the first turn of
  // the next conversation only waits on the API, not cold-start.
  useEffect(() => {
    bridgeRef.current?.prewarm({ cli, page: pageOn, tabs: tabsOn, capture: captureOn, repoPath: repoPath.trim(), model, effort });
  }, [cli, pageOn, tabsOn, captureOn, repoPath, model, effort]);

  // Capture is "AI decides": the CDP debugger attaches on-demand when the
  // assistant first reads console/network (see bridge.runTool), not from this
  // toggle. The toggle is only a permission — turning it off detaches at once.
  useEffect(() => {
    const b = bridgeRef.current;
    if (!b) return;
    if (!captureOn) void b.capture.disable();
  }, [captureOn]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Fetch + render the summary for a shop domain. Empty domain → hide the card.
  const applySummary = async (domain: string) => {
    setShopDetected(!!domain);
    setSummaryState("loading");
    setSummaryErr(undefined);
    if (!domain) {
      loadedDomainRef.current = "";
      setSummary(null);
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

  // Manual/forced load (first open, ↻): re-detect and reload no matter what.
  const loadSummary = async () => {
    await applySummary(await readShopDomain());
  };

  // Auto path. Featurebase is an SPA: switching tickets swaps the shop in place.
  // Poll a few times; reload on a *different* shop, and hide the card once we're
  // confident there's no shop on the page (ordinary tab). A newer signal
  // supersedes an in-flight poll so triggers don't stack.
  const reloadIfShopChanged = async () => {
    const gen = ++pollGenRef.current;
    // Off Featurebase there's never a shop — hide the card at once instead of
    // polling readShopDomain for 3s waiting for an SPA that isn't there.
    if (!(await isFeaturebasePage())) {
      if (gen === pollGenRef.current && loadedDomainRef.current) await applySummary("");
      return;
    }
    for (let i = 0; i < 6; i++) {
      if (gen !== pollGenRef.current) return; // a newer signal took over
      const domain = await readShopDomain();
      if (domain) {
        if (domain !== loadedDomainRef.current) await applySummary(domain);
        return;
      }
      await sleep(500);
    }
    // No shop domain after ~3s → hide the card if one was showing.
    if (gen === pollGenRef.current && loadedDomainRef.current) await applySummary("");
  };
  reloadRef.current = reloadIfShopChanged;

  // Load once on open.
  useEffect(() => {
    void loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-detect the merchant + follow the active tab (for capture) whenever the
  // open tab may have changed: SPA URL change / full load, tab switch, refocus.
  useEffect(() => {
    const trigger = () => {
      void reloadRef.current?.();
      void bridgeRef.current?.capture.attachToActive();
    };
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (_tabId, changeInfo, tab) => {
      if (tab.active && (changeInfo.url || changeInfo.status === "complete")) trigger();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(trigger);
    window.addEventListener("focus", trigger);
    // The driving overlay posts this from the page when the user hits Esc to
    // take over — interrupt the turn so the AI stops acting on the tab.
    const onMsg = (msg: unknown) => {
      if (msg && typeof msg === "object" && (msg as { __nexlifyDrive?: string }).__nexlifyDrive === "stop") {
        stopRef.current?.();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(trigger);
      window.removeEventListener("focus", trigger);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);

  // One turn. `seed` is an optional instruction prepended (Draft reply). A
  // reopened conversation replays its transcript as context on the next turn.
  const submit = (seed?: string) => {
    if (running) return;
    resetStream();
    const text = input.trim();
    const replay = replayPendingRef.current;
    const first = messages.length === 0;
    if (!text && !seed && !replay) {
      setStatus({ label: "type a message", tone: "warning" });
      return;
    }
    let prompt: string;
    if (replay) {
      prompt = buildReplayPrompt(messagesRef.current, seed ? `${seed}\n\n${text}` : text);
      replayPendingRef.current = false;
    } else if (first) {
      prompt = [seed || GENERAL_PREAMBLE, text].filter(Boolean).join("\n\n");
    } else {
      prompt = seed ? [seed, text].filter(Boolean).join("\n\n") : text;
    }
    const shown = text || (seed ? "Draft a reply to the open ticket" : "(continue)");

    setMessages((ms) => [...ms, { role: "user", text: shown }, { role: "assistant", text: "" }]);
    setInput("");

    const id = ++reqIdRef.current;
    activeRef.current = id;
    setRunning(true);
    setStatus({ label: "running…", tone: "info" });
    bridgeRef.current?.send({ id, prompt, ...buildCfg() });
  };

  const stop = () => {
    if (activeRef.current === null) return;
    bridgeRef.current?.cancel(activeRef.current); // interrupt — keeps the conversation
    flushStream(); // show whatever streamed so far
    setStatus({ label: "stopping…", tone: "warning" });
  };
  stopRef.current = stop;

  const newChat = () => {
    saveCurrent(); // keep the one we're leaving
    resetStream();
    bridgeRef.current?.reset(buildCfg());
    activeRef.current = null;
    convIdRef.current = null;
    replayPendingRef.current = false;
    setRunning(false);
    setMessages([]);
    setInput("");
    setStatus({ label: "ready", tone: "idle" });
  };

  const openHistory = async () => {
    setHistoryList(await loadConversations());
    setHistoryOpen(true);
  };

  // Reopen a saved conversation: show its transcript and arm a context replay so
  // the next message continues it in a fresh session.
  const openConversation = (conv: Conversation) => {
    saveCurrent(); // save the current one before switching away
    resetStream();
    const msgs: Msg[] = conv.messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages(msgs);
    messagesRef.current = msgs;
    convIdRef.current = conv.id;
    replayPendingRef.current = true;
    bridgeRef.current?.reset(buildCfg());
    activeRef.current = null;
    setRunning(false);
    setInput("");
    setStatus({ label: "resumed — send to continue", tone: "idle" });
    setHistoryOpen(false);
  };

  const removeConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteConversation(id);
    if (convIdRef.current === id) convIdRef.current = null;
    setHistoryList(await loadConversations());
  };

  const clearHistory = async () => {
    await clearConversations();
    setHistoryList([]);
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
      submit();
    }
  };

  const empty = messages.length === 0;
  const live = messages.length > 0;

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold">{APP_NAME}</span>
        <div className="ml-auto flex items-center gap-1">
          <StatusPill status={status} />

          {/* history */}
          <div className="relative">
            <IconBtn
              label="History"
              onClick={() => (historyOpen ? setHistoryOpen(false) : void openHistory())}
              className={historyOpen ? "bg-border/50 text-fg" : ""}
            >
              <History className="h-4 w-4" />
            </IconBtn>
            {historyOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1.5 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 text-neutral-800 shadow-lg">
                  {historyList.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-neutral-500">No saved conversations yet.</p>
                  ) : (
                    <>
                      {historyList.map((c) => (
                        <div
                          key={c.id}
                          onClick={() => openConversation(c)}
                          className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{c.title}</span>
                            <span className="block text-[10px] text-neutral-500">
                              {relTime(c.updatedAt)} · {c.messages.length} msgs
                            </span>
                          </span>
                          <span
                            role="button"
                            aria-label="Delete conversation"
                            onClick={(e) => removeConversation(c.id, e)}
                            className="shrink-0 rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      ))}
                      <button
                        onClick={clearHistory}
                        className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-100"
                      >
                        Clear all
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <IconBtn label="New chat" onClick={newChat} disabled={empty && !running}>
            <Plus className="h-4 w-4" />
          </IconBtn>

          {/* settings */}
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
                      checked={pageOn}
                      onChange={(e) => setPageOn(e.target.checked)}
                    />
                    <Globe className="h-4 w-4 text-muted" />
                    Read &amp; control page
                  </label>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={tabsOn}
                      onChange={(e) => setTabsOn(e.target.checked)}
                    />
                    <AppWindow className="h-4 w-4 text-muted" />
                    Control browser tabs
                  </label>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={captureOn}
                      onChange={(e) => setCaptureOn(e.target.checked)}
                    />
                    <Bug className="h-4 w-4 text-muted" />
                    Allow console &amp; network capture
                  </label>
                  {captureOn && (
                    <p className="mt-1 pl-6 text-[10px] leading-tight text-neutral-500">
                      {captureStatus?.error
                        ? `⚠️ ${captureStatus.error}`
                        : captureStatus?.attached
                          ? `● capturing tab ${captureStatus.tabId} — Chrome shows a "being debugged" banner.`
                          : 'AI attaches this when it needs console/network (Chrome shows a "being debugged" banner then).'}
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                      <FolderGit2 className="h-3.5 w-3.5" />
                      Local repo path
                    </span>
                    <div className="flex gap-1.5">
                      <input
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="/Users/you/Workspace/your-repo"
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                      <button
                        type="button"
                        onClick={browseRepo}
                        disabled={browsing}
                        title="Pick a folder"
                        className="shrink-0 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                      >
                        {browsing ? "…" : "Browse…"}
                      </button>
                    </div>
                    <span className="text-[10px] leading-tight text-neutral-500">
                      When set, Claude may read &amp; grep files here (no writes, no shell).
                    </span>
                  </div>
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
                  {live && (
                    <p className="mt-2 text-[11px] text-neutral-500">
                      Model, effort, page/capture/repo apply to a new chat.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* pinned merchant summary — only when a shop is detected on the page */}
      {shopDetected && (
        <MerchantCard
          summary={summary}
          state={summaryState}
          err={summaryErr}
          onRefresh={loadSummary}
          onDraftReply={() => submit(DRAFT_REPLY_INSTRUCTION)}
          busy={running}
        />
      )}

      {/* message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted">
            <Sparkles className="h-7 w-7 opacity-60" />
            <p className="text-sm">Ask anything, or tell me what to do on this tab.</p>
            <p className="text-xs">
              I can read &amp; control the page, open/switch/close tabs, debug its console/network, and read your repo. On
              a Featurebase ticket, use “Draft reply” on the merchant card.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-accent px-3 py-2 text-sm text-accent-fg">
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                </div>
              ) : (
                <div key={i} className="group max-w-[92%] self-start rounded-xl rounded-bl-sm border border-border bg-surface px-3 py-2">
                  {m.text ? (
                    <AssistantText text={m.text} />
                  ) : running && i === messages.length - 1 ? (
                    <span className="text-sm text-muted">…</span>
                  ) : null}
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
          placeholder="Ask anything, or tell me what to do on this tab…"
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
              onClick={() => submit()}
              disabled={!input.trim()}
              aria-label="Send message"
              title="Send (⌘/Ctrl+↵)"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
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
  onDraftReply,
  busy,
}: {
  summary: ShopSummary | null;
  state: "loading" | "idle" | "error";
  err?: string;
  onRefresh: () => void;
  onDraftReply: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const clickable = !!summary;

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
      <div className={cx("px-3 pt-2.5", clickable && "cursor-pointer")} onClick={clickable ? () => setOpen((o) => !o) : undefined}>
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 shrink-0 text-muted" />
          <span className="truncate text-sm font-semibold">
            {summary?.domain ?? (state === "loading" ? "Detecting merchant…" : "Merchant")}
          </span>
          {clickable && (
            <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")} />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDraftReply();
              }}
              disabled={busy}
              title="Draft a support reply into the chat"
              className="inline-flex items-center gap-1 rounded-lg bg-accent-soft px-2 py-1 text-xs font-medium text-accent transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Headset className="h-3.5 w-3.5" />
              Draft reply
            </button>
            <button
              aria-label="Refresh merchant"
              title="Refresh"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-border/40 hover:text-fg"
            >
              <RefreshCw className={cx("h-3.5 w-3.5", state === "loading" && "animate-spin")} />
            </button>
          </div>
        </div>

        {state === "error" && <p className="pb-2.5 pt-1 text-xs text-muted">⚠️ {err || "lookup failed"}</p>}
        {state === "loading" && !summary && <p className="pb-2.5 pt-1 text-xs text-muted">Loading account summary…</p>}

        {summary && (
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
