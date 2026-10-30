import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  ArrowUp,
  Bug,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
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
  ShieldAlert,
  ShoppingBag,
  Sparkles,
  Square,
  Store,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  Bridge,
  isFeaturebaseUrl,
  readShopDomain,
  type Cli,
  type HostEvent,
  type PermissionAsk,
  type PermissionDecision,
  type ShopSummary,
} from "./bridge";
import { type CaptureStatus } from "../capture";
import { isGemAdminUrl } from "./experimentExport";
import ExperimentExportCard from "./ExperimentExportCard";
import { APP_NAME, DRAFT_REPLY_INSTRUCTION, GENERAL_PREAMBLE } from "./tools";
import {
  CS_CHECKIN,
  CS_ACK,
  CS_CLOSE,
  CS_DRAFT,
  CS_SKILL,
  CS_SYSTEM,
  CS_WRAPUP,
  acknowledge,
  IN_FEATUREBASE,
  contextBlock,
  contextDelta,
  seenOf,
  detectLanguage,
  insertIntoReply,
  parseReplyCached,
  wasSent,
  subscribeFbContext,
  suggest,
  type FbContext,
  type FollowUpKind,
  type Seen,
  type KnownFollowUp,
} from "./support";
import {
  ASK_WHAT,
  CHECK_IN,
  SHORTER,
  SOFTER,
  ActionRow,
  ConversationTitle,
  EndSessionBar,
  AskPicker,
  NudgeBar,
  ReplyCards,
  type QuickAction,
} from "./SupportUI";
import { Md } from "./Md";
import {
  clearConversations,
  deleteConversation,
  deriveTitle,
  loadConversations,
  newConversationId,
  saveConversation,
  type Conversation,
} from "./history";

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
  return <Md text={text} code />;
}

export default function App() {
  // settings — apply to the NEXT conversation (a live one keeps its config)
  const [model, setModel] = useState("sonnet");
  // In the Featurebase inbox the agent is waiting on a reply: low effort answers
  // ~1.5s sooner with the same drafts (the skill carries the knowledge).
  const [effort, setEffort] = useState(IN_FEATUREBASE ? "low" : "medium");
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
  // Team-MCP mode: expose the user's own claude MCP servers to the panel AI;
  // tools/servers listed in mcpAllowText auto-run, anything else asks via a popup.
  const [mcpTeam, setMcpTeam] = useState(() => localStorage.getItem("fb_mcp_team") === "1");
  const [mcpAllowText, setMcpAllowText] = useState(() => localStorage.getItem("fb_mcp_allow") ?? "");
  useEffect(() => void localStorage.setItem("fb_mcp_team", mcpTeam ? "1" : "0"), [mcpTeam]);
  useEffect(() => void localStorage.setItem("fb_mcp_allow", mcpAllowText), [mcpAllowText]);
  // Shell: Claude may run Bash, but every single command asks first in a popup.
  // This is what lets skills that run scripts (customei-admin, …) work. On by
  // default since nothing runs without a click.
  const [shellOn, setShellOn] = useState(() => localStorage.getItem("fb_shell_on") !== "0");
  useEffect(() => void localStorage.setItem("fb_shell_on", shellOn ? "1" : "0"), [shellOn]);

  // Support mode (the "Claude" tab in the Featurebase inbox): the open
  // conversation, what to do next, and when to nudge.
  const [fbCtx, setFbCtx] = useState<FbContext | null>(null);
  const [fbVisible, setFbVisible] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [csAuto, setCsAuto] = useState(() => localStorage.getItem("fb_cs_auto") !== "0");
  const [checkinMin, setCheckinMin] = useState(() => Number(localStorage.getItem("fb_cs_checkin")) || 5);
  const [closeMin, setCloseMin] = useState(() => Number(localStorage.getItem("fb_cs_close")) || 15);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => void localStorage.setItem("fb_cs_auto", csAuto ? "1" : "0"), [csAuto]);
  useEffect(() => void localStorage.setItem("fb_cs_checkin", String(checkinMin)), [checkinMin]);
  useEffect(() => void localStorage.setItem("fb_cs_close", String(closeMin)), [closeMin]);

  // conversation
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ label: string; tone: Tone }>({ label: "ready", tone: "idle" });
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<Conversation[]>([]);

  // merchant summary card — contextual: shown when a shop is detected on the
  // page (a Featurebase ticket, or a Shopify storefront incl. custom domains),
  // hidden on ordinary pages.
  const [summary, setSummary] = useState<ShopSummary | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "idle" | "error">("loading");
  const [summaryErr, setSummaryErr] = useState<string | undefined>();
  const [shopDetected, setShopDetected] = useState(false);
  // The card is shown on demand (header button / the conversation strip).
  const [merchantOpen, setMerchantOpen] = useState(false);
  const merchantOpenRef = useRef(false);
  merchantOpenRef.current = merchantOpen;
  const detectedRef = useRef(""); // the shop on the page, looked up or not
  // Whether the detected context is a Featurebase ticket (vs a Shopify
  // storefront) — gates the ticket-only "Draft reply" action on the card.
  const [onFb, setOnFb] = useState(false);
  // Whether the active tab is the GemCommerce admin app — gates the experiment
  // CSV export card (which queries the dashboard's own GraphQL session).
  const [onGemAdmin, setOnGemAdmin] = useState(false);
  // Pending tool-approval popup (team-MCP mode: a not-auto-allowed tool call).
  const [permAsk, setPermAsk] = useState<{ ask: PermissionAsk; resolve: (d: PermissionDecision) => void } | null>(null);

  const bridgeRef = useRef<Bridge | null>(null);
  const reqIdRef = useRef(0);
  const activeRef = useRef<number | null>(null);
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
  // Mirrors `merchantConfigured` so the async shop-detection callbacks read the
  // latest value without needing to be re-created on every settings change.
  const merchantConfiguredRef = useRef(false);
  // Support mode bookkeeping: which Featurebase conversation the chat belongs
  // to, the transcript block the model last saw (unchanged → not re-sent), and
  // the customer messages already auto-drafted (survives the iframe reloading).
  const fbConvRef = useRef<string>("");
  // The Featurebase conversation the chat on screen belongs to (names it in history).
  const convTicketRef = useRef<{ id: string; name: string } | null>(null);
  // What the session has seen of the conversation: later turns send only what's new.
  const seenRef = useRef<Seen>(new Map());
  // The CLI session behind the chat on screen (kept with it, for --resume), and
  // the one to resume on the next session start (a chat reopened from history).
  const cliSessionRef = useRef("");
  const resumeRef = useRef("");
  const seenStateRef = useRef("");
  const draftedRef = useRef<Set<string>>(
    new Set((() => {
      try {
        return JSON.parse(sessionStorage.getItem("fb_cs_drafted") ?? "[]") as string[];
      } catch {
        return [];
      }
    })()),
  );
  const cli: Cli = "claude";

  const buildCfg = () => ({
    cli,
    page: pageOn,
    tabs: tabsOn,
    capture: captureOn,
    repoPath: repoPath.trim(),
    model,
    effort,
    mcpTeam,
    mcpAllow: mcpTeam ? mcpAllowText.split(/[\s,]+/).filter(Boolean) : [],
    shell: shellOn,
    // The Featurebase tab is a support copilot for the whole session.
    systemPrompt: IN_FEATUREBASE ? CS_SYSTEM : "",
    lean: IN_FEATUREBASE,
    // The host puts the skill into the system prompt (cached across sessions) and
    // drops the first turn's slash command; if it can't find it, the slash loads it.
    skill: IN_FEATUREBASE ? CS_SKILL.slice(1) : "",
    resume: resumeRef.current || undefined,
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
  const saveCurrent = (opts?: { ended?: boolean }) => {
    const msgs = messagesRef.current;
    if (!msgs.length) return;
    if (!convIdRef.current) convIdRef.current = newConversationId();
    const t = convTicketRef.current;
    void saveConversation({
      id: convIdRef.current,
      title: t ? `${t.name} #${t.id}` : deriveTitle(msgs),
      updatedAt: Date.now(),
      messages: msgs.map((m) => ({ role: m.role, text: m.text })),
      ...(t ? { ticket: { ...t, ...(opts?.ended ? { ended: true } : {}) } } : {}),
      ...(cliSessionRef.current ? { cliSession: cliSessionRef.current } : {}),
      ...(seenRef.current.size
        ? {
            seen: [...seenRef.current].map(([id, v]) => [id, v.h, v.at, v.who] as [string, string, string, string]),
            seenState: seenStateRef.current,
          }
        : {}),
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
        case "cli_session":
          cliSessionRef.current = e.sessionId;
          break;
        case "resume":
          // Resumed: the CLI has the whole chat, no need to replay it as text.
          if (e.ok && e.sessionId === resumeRef.current) replayPendingRef.current = false;
          if (!e.ok && e.sessionId === resumeRef.current) {
            resumeRef.current = "";
            seenRef.current = new Map(); // replaying: the full conversation goes in again
            seenStateRef.current = "";
          }
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
    const b = new Bridge(
      onEvent,
      (s) => setCaptureStatus(s),
      (ask) => new Promise<PermissionDecision>((resolve) => setPermAsk({ ask, resolve })),
    );
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
    if (IN_FEATUREBASE) rememberChat(); // this chat belongs to the open Featurebase conversation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Keep a prewarmed session matching the current settings so the first turn of
  // the next conversation only waits on the API, not cold-start.
  useEffect(() => {
    // The same config a turn sends (buildCfg), or the host's cfgKey never
    // matches and the first turn starts cold.
    bridgeRef.current?.prewarm(buildCfg());
  }, [cli, pageOn, tabsOn, captureOn, repoPath, model, effort, mcpTeam, mcpAllowText, shellOn]);

  // Capture is "AI decides": the CDP debugger attaches on-demand when the
  // assistant first reads console/network, not from this toggle. The toggle is
  // only a permission — turning it off detaches at once. The buffer itself lives
  // in the background worker (so it survives this panel closing), hence the
  // remote control.
  useEffect(() => {
    const b = bridgeRef.current;
    if (!b) return;
    if (!captureOn) b.setCaptureEnabled(false);
  }, [captureOn]);

  // Follow the newest content while the reader is at the bottom; scrolling up
  // to reread stops following until they come back down (or send again).
  // Scrolls the list itself: scrollIntoView would also scroll the Featurebase
  // page around our iframe.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const shownCountRef = useRef(0);
  const onListScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = listRef.current;
    if (messages.length > shownCountRef.current) stickRef.current = true; // a new turn
    shownCountRef.current = messages.length;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // The merchant/shop card needs BOTH the API URL and the admin access key set
  // in Settings — without them the lookup can't run, so the whole block stays
  // hidden until they're provided.
  const merchantConfigured = apiUrl.trim() !== "" && accessKey.trim() !== "";
  merchantConfiguredRef.current = merchantConfigured;

  // Fetch + render the summary for a shop domain. Empty domain → hide the card.
  const applySummary = async (domain: string) => {
    // No config → never show the card, whatever's on the page.
    if (!merchantConfiguredRef.current) domain = "";
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

  // The card is opened on demand (a button), not pinned: detecting the shop is
  // cheap and only decides whether the button shows; the lookup runs when the
  // card is open. `force` re-fetches the same shop (↻, or the card just opened).
  const noteDomain = async (domain: string, force = false) => {
    if (!merchantConfiguredRef.current) domain = "";
    detectedRef.current = domain;
    if (!domain) {
      setMerchantOpen(false);
      return applySummary("");
    }
    setShopDetected(true);
    if (merchantOpenRef.current && (force || domain !== loadedDomainRef.current)) await applySummary(domain);
  };

  // Manual/forced load (first open, ↻): re-detect and reload no matter what.
  const loadSummary = async () => {
    if (IN_FEATUREBASE) return; // the Featurebase tab gets the shop with the conversation
    if (!merchantConfiguredRef.current) return void noteDomain("");
    await noteDomain(await readShopDomain(), true);
  };

  // Auto path. Featurebase is an SPA: switching tickets swaps the shop in place.
  // Poll a few times; reload on a *different* shop, and hide the card once we're
  // confident there's no shop on the page (ordinary tab). A newer signal
  // supersedes an in-flight poll so triggers don't stack.
  const reloadIfShopChanged = async () => {
    if (IN_FEATUREBASE) return; // see the fbCtx effect below
    // No config → the card is disabled; make sure any prior one is cleared.
    if (!merchantConfiguredRef.current) {
      setOnFb(false);
      if (detectedRef.current) await noteDomain("");
      return;
    }
    const gen = ++pollGenRef.current;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? "";
    setOnFb(isFeaturebaseUrl(url));
    // chrome://, the new-tab page, the web store, … can never carry a shop.
    if (!/^https?:/i.test(url)) {
      if (gen === pollGenRef.current && detectedRef.current) await noteDomain("");
      return;
    }
    // Featurebase is an SPA (tickets swap in place) and a storefront's
    // window.Shopify may hydrate a beat after load — poll briefly. A storefront
    // is usually ready at once, so it needs far fewer attempts than the inbox.
    const tries = isFeaturebaseUrl(url) ? 6 : 2;
    for (let i = 0; i < tries; i++) {
      if (gen !== pollGenRef.current) return; // a newer signal took over
      const domain = await readShopDomain();
      if (domain) {
        if (domain !== detectedRef.current) await noteDomain(domain);
        return;
      }
      if (i < tries - 1) await sleep(500);
    }
    // Nothing found → hide the card if one was showing.
    if (gen === pollGenRef.current && detectedRef.current) await noteDomain("");
  };
  reloadRef.current = reloadIfShopChanged;

  // Featurebase tab: the shop comes with the conversation.
  const fbShop = fbCtx?.shop ?? "";
  useEffect(() => {
    if (IN_FEATUREBASE) void noteDomain(fbShop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbShop, merchantConfigured]);

  // Opening the card looks the shop up (unless it already shows that shop).
  useEffect(() => {
    if (merchantOpen && detectedRef.current && detectedRef.current !== loadedDomainRef.current)
      void applySummary(detectedRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantOpen]);

  // Detect whether the active tab is the GemCommerce admin app so the experiment
  // export card follows tab switches / SPA navigation (via gemAdminRef, below).
  const gemAdminRef = useRef<() => Promise<void>>();
  const refreshGemAdmin = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setOnGemAdmin(isGemAdminUrl(tab?.url));
  };
  gemAdminRef.current = refreshGemAdmin;

  // Load once on open.
  useEffect(() => {
    void loadSummary();
    void refreshGemAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to the merchant config being added/removed in Settings: re-detect so
  // the card appears as soon as both fields are filled and disappears when
  // either is cleared. Skips the initial mount (loadSummary already ran).
  const cfgMounted = useRef(false);
  useEffect(() => {
    if (!cfgMounted.current) {
      cfgMounted.current = true;
      return;
    }
    void reloadRef.current?.();
  }, [merchantConfigured]);

  // Re-detect the merchant whenever the open tab may have changed: SPA URL
  // change / full load, tab switch, refocus. (The CDP capture follows the active
  // tab from the background worker, so it needs nothing from us here.)
  useEffect(() => {
    const trigger = () => {
      void reloadRef.current?.();
      void gemAdminRef.current?.();
    };
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (_tabId, changeInfo, tab) => {
      if (tab.active && (changeInfo.url || changeInfo.status === "complete")) trigger();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(trigger);
    window.addEventListener("focus", trigger);
    const onMsg = (msg: unknown) => {
      const m = msg as { __nexlifyDrive?: string } | null;
      // The driving overlay posts this from the page when the user hits Esc to
      // take over — interrupt the turn so the AI stops acting on the tab.
      if (m && m.__nexlifyDrive === "stop") stopRef.current?.();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    // Esc while focus is in the assistant itself also stops the turn. Needed when
    // it's embedded in a page (Featurebase "Claude" tab): keys typed in our iframe
    // never reach the driving overlay's own Esc handler. stop() is a no-op when
    // nothing is running.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(trigger);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("keydown", onKey);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);

  // ---- support mode -----------------------------------------------------------

  // Featurebase hands us the open conversation (and whether our tab is showing).
  useEffect(() => {
    if (!IN_FEATUREBASE) return;
    const off = subscribeFbContext((ctx, visible) => {
      setFbCtx(ctx);
      setFbVisible(visible);
      setNow(Date.now());
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, []);

  // The customer's language (from their recent messages), for the instant
  // templates and as a hint to the model. "" = unclear (English by default).
  const [custLang, setCustLang] = useState("");
  const custSig = fbCtx ? `${fbCtx.conversationId}|${fbCtx.messages.filter((m) => m.who === "customer").at(-1)?.id ?? ""}` : "";
  useEffect(() => {
    let live = true;
    void detectLanguage(fbCtx).then((l) => live && setCustLang(l));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custSig]);

  // The "Nên hỏi gì?" picker above the composer; closes on a ticket switch.
  const [askOpen, setAskOpen] = useState(false);
  useEffect(() => setAskOpen(false), [fbCtx?.conversationId]);

  // One chat per Featurebase conversation: switching tickets saves this chat and
  // brings back the one for the new ticket (or starts fresh).
  const chatMap = (): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem("fb_cs_chats") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const rememberChat = () => {
    if (!fbConvRef.current || !convIdRef.current) return;
    const map = chatMap();
    map[fbConvRef.current] = convIdRef.current;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete map[k]; // keep it bounded
    localStorage.setItem("fb_cs_chats", JSON.stringify(map));
  };
  // Conversations whose chat session the agent ended (conversation id → chat
  // id): reopening the ticket shows "session ended" instead of the old chat.
  const [endedChats, setEndedChats] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("fb_cs_ended") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const endedRef = useRef(endedChats);
  endedRef.current = endedChats;
  useEffect(() => {
    try {
      const keys = Object.keys(endedChats);
      const kept = Object.fromEntries(keys.slice(Math.max(0, keys.length - 200)).map((k) => [k, endedChats[k]]));
      localStorage.setItem("fb_cs_ended", JSON.stringify(kept));
    } catch {
      /* storage blocked */
    }
  }, [endedChats]);
  const unEnd = (convId: string) =>
    setEndedChats((m) => {
      if (!(convId in m)) return m;
      const next = { ...m };
      delete next[convId];
      return next;
    });
  // The agent may keep a closed conversation's chat open ("Giữ phiên"); per iframe load.
  const [keepOpen, setKeepOpen] = useState<Set<string>>(() => new Set());

  const fbConvId = fbCtx?.conversationId ?? "";
  // The ticket name comes in with the real conversation (a switch may start from a placeholder).
  useEffect(() => {
    const t = convTicketRef.current;
    const name = fbCtx?.customer.name || fbCtx?.customer.email;
    if (t && fbCtx && !fbCtx.loading && t.id === fbCtx.conversationId && name && t.name !== name) t.name = name;
  }, [fbCtx]);

  // A closed conversation that is open again (the customer wrote back) gets a new session.
  useEffect(() => {
    if (IN_FEATUREBASE && fbCtx?.state === "open") unEnd(fbCtx.conversationId);
  }, [fbCtx?.conversationId, fbCtx?.state]);

  useEffect(() => {
    if (!IN_FEATUREBASE || !fbConvId || fbConvId === fbConvRef.current) return;
    const first = !fbConvRef.current;
    if (!first) {
      if (activeRef.current !== null) bridgeRef.current?.cancel(activeRef.current);
      saveCurrent();
      rememberChat();
    }
    const prev = fbConvRef.current;
    fbConvRef.current = fbConvId;
    // On the first conversation keep a chat already on screen (the iframe just
    // loaded, or the agent was mid-chat before any context arrived).
    if (first && messagesRef.current.length) return;
    const id = chatMap()[fbConvId];
    // Its session was ended: show that (with "Xem lại"), not the old chat.
    if (id && endedRef.current[fbConvId] === id) {
      if (prev || messagesRef.current.length) newChat();
      return;
    }
    const name = fbCtx?.customer.name || fbCtx?.customer.email || "Khách";
    void loadConversations().then((all) => {
      if (fbConvRef.current !== fbConvId) return; // switched again meanwhile
      const conv = id ? all.find((c) => c.id === id) : undefined;
      if (conv) {
        openConversation(conv);
        convTicketRef.current ??= { id: fbConvId, name };
      } else if (prev || messagesRef.current.length) newChat();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbConvId]);

  // Follow-ups this chat drafted (by the button that asked for them), so a sent
  // one is recognised in any language: no check-in right after a wrap-up.
  const known: KnownFollowUp[] = IN_FEATUREBASE
    ? messages.flatMap((m, i) => {
        if (m.role !== "assistant" || !m.text) return [];
        const reply = parseReplyCached(m.text)?.reply;
        if (!reply) return [];
        // Drafted by a follow-up button, or a real answer (never mistaken for one).
        return [{ kind: (i > 0 && FOLLOW_UP_ASKS[messages[i - 1].text]) || "answer", text: reply }];
      })
    : [];
  const suggestion = IN_FEATUREBASE ? suggest(fbCtx, now, { checkinMin, closeMin, known }) : null;
  const suggestionKey = suggestion && fbCtx ? `${fbCtx.conversationId}:${suggestion.kind}:${suggestion.msgId}` : "";
  const draftKey = suggestion && fbCtx ? `${fbCtx.conversationId}:${suggestion.msgId}` : "";

  const markDrafted = (key: string) => {
    draftedRef.current.add(key);
    try {
      sessionStorage.setItem("fb_cs_drafted", JSON.stringify([...draftedRef.current].slice(-300)));
    } catch {
      /* storage blocked: we may draft the same message twice after a reload */
    }
  };

  const draftReply = () => {
    if (draftKey) markDrafted(draftKey);
    void submit(CS_DRAFT, { shown: "Soạn trả lời" });
  };

  // Proactive: a new customer message that nobody answered gets a draft on its
  // own, while our tab is on screen. Only fresh ones (a months-old unanswered
  // message isn't worth the tokens) and only once per message.
  useEffect(() => {
    if (!IN_FEATUREBASE || !csAuto || !fbVisible || running || !fbCtx) return;
    if (suggestion?.kind !== "awaiting" || fbConvRef.current !== fbCtx.conversationId) return;
    if (draftedRef.current.has(draftKey) || Date.now() - suggestion.since > 24 * 3600_000) return;
    markDrafted(draftKey);
    void submit(CS_DRAFT, { shown: "Tự soạn trả lời (khách vừa nhắn)" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csAuto, fbVisible, running, fbCtx, draftKey]);

  const insertReply = async (text: string, html?: string) => {
    const ok = await insertIntoReply(text, html);
    setStatus(ok ? { label: "đã đưa vào ô Reply", tone: "success" } : { label: "không thấy ô Reply", tone: "warning" });
    return ok;
  };

  // One turn. `seed` is an optional instruction prepended (Draft reply). A
  // reopened conversation replays its transcript as context on the next turn.
  // `opts.text` sends that text instead of the composer's (quick actions);
  // `opts.shown` is the bubble label for a seeded turn.
  const submit = async (seed?: string, opts?: { text?: string; shown?: string }) => {
    if (running) return;
    resetStream();
    const text = (opts?.text ?? input).trim();
    const replay = replayPendingRef.current;
    const first = messages.length === 0;
    if (!text && !seed && !replay) {
      setStatus({ label: "type a message", tone: "warning" });
      return;
    }

    // Support mode: the conversation goes in every turn (unless unchanged), and
    // a fresh session starts with the support skill already loaded.
    const cs = IN_FEATUREBASE ? fbCtx : null;
    if (cs?.loading) {
      // Just switched tickets: the transcript lands in a moment; don't draft blind.
      setStatus({ label: "đang tải hội thoại…", tone: "warning" });
      return;
    }
    if (cs) {
      convTicketRef.current ??= { id: cs.conversationId, name: cs.customer.name || cs.customer.email || "Khách" };
      unEnd(cs.conversationId);
      const ask = [seed, text].filter(Boolean).join("\n\n") || "(continue)";
      let prompt: string;
      if (replay || first) {
        const block = contextBlock(cs, Date.now(), custLang);
        const earlier = replay
          ? "Earlier in this chat with the agent:\n\n" +
            messagesRef.current.map((m) => `${m.role === "user" ? "Agent" : "You"}: ${m.text}`).join("\n\n") +
            "\n\n---\n\n"
          : "";
        prompt = `${CS_SKILL}\n\n${earlier}${block}\n\n${ask}`;
        replayPendingRef.current = false;
      } else {
        prompt = `${contextDelta(cs, seenRef.current, seenStateRef.current, Date.now(), custLang)}\n\n${ask}`;
      }
      seenRef.current = seenOf(cs);
      seenStateRef.current = cs.state;
      const shown = opts?.shown ?? (text || "(continue)");
      setMessages((ms) => [...ms, { role: "user", text: shown }, { role: "assistant", text: "" }]);
      if (opts?.text === undefined) setInput("");
      const id = ++reqIdRef.current;
      activeRef.current = id;
      setRunning(true);
      setStatus({ label: "running…", tone: "info" });
      bridgeRef.current?.send({ id, prompt, ...buildCfg() });
      resumeRef.current = "";
      return;
    }

    // Seed the turn with the tab the user is looking at RIGHT NOW, so the model
    // acts on the current tab and notices a tab switch — otherwise it keeps
    // answering from a get_page it ran earlier on a tab that's no longer active.
    // Injected into the sent prompt only (not the visible bubble).
    let tabCtx = "";
    if (pageOn) {
      const tab = await bridgeRef.current?.activeTabInfo();
      if (tab?.url) {
        tabCtx =
          `[Context: the user is currently viewing this browser tab — ${JSON.stringify(tab.title || "(untitled)")} ` +
          `(${tab.url}). Act on THIS tab; call get_page/query_dom to read it when needed, and don't assume a tab ` +
          `you read earlier is still the active one.]\n\n`;
      }
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
    prompt = tabCtx + prompt;
    const shown = opts?.shown ?? (text || (seed ? "Draft a reply to the open ticket" : "(continue)"));

    setMessages((ms) => [...ms, { role: "user", text: shown }, { role: "assistant", text: "" }]);
    if (opts?.text === undefined) setInput("");

    const id = ++reqIdRef.current;
    activeRef.current = id;
    setRunning(true);
    setStatus({ label: "running…", tone: "info" });
    bridgeRef.current?.send({ id, prompt, ...buildCfg() });
    resumeRef.current = "";
  };

  const stop = () => {
    if (activeRef.current === null) return;
    bridgeRef.current?.cancel(activeRef.current); // interrupt — keeps the conversation
    flushStream(); // show whatever streamed so far
    setStatus({ label: "stopping…", tone: "warning" });
  };
  stopRef.current = stop;

  const newChat = (opts?: { skipSave?: boolean }) => {
    if (!opts?.skipSave) saveCurrent(); // keep the one we're leaving
    convTicketRef.current = null;
    cliSessionRef.current = "";
    resumeRef.current = "";
    resetStream();
    bridgeRef.current?.reset(buildCfg());
    activeRef.current = null;
    convIdRef.current = null;
    replayPendingRef.current = false;
    seenRef.current = new Map();
    seenStateRef.current = "";
    setRunning(false);
    setMessages([]);
    setInput("");
    setStatus({ label: "ready", tone: "idle" });
  };

  // End this conversation's chat session (it was closed in Featurebase): save it
  // as ended, free the CLI session, and show "session ended" for the ticket.
  const endSession = () => {
    const convId = fbConvRef.current;
    if (activeRef.current !== null) bridgeRef.current?.cancel(activeRef.current);
    saveCurrent({ ended: true });
    rememberChat();
    const chatId = convIdRef.current;
    if (convId && chatId) setEndedChats((m) => ({ ...m, [convId]: chatId }));
    newChat({ skipSave: true });
  };

  // Reopen the chat of an ended session (to read it, or carry on).
  const reviewEnded = async (chatId: string) => {
    const conv = (await loadConversations()).find((c) => c.id === chatId);
    if (conv) openConversation(conv);
    else if (fbConvRef.current) unEnd(fbConvRef.current); // gone from history: just start fresh
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
    convTicketRef.current = conv.ticket ? { id: conv.ticket.id, name: conv.ticket.name } : null;
    if (conv.ticket?.ended) unEnd(conv.ticket.id); // reopened to read or continue
    // Continue its CLI session when it's still on disk (the host answers with a
    // "resume" event); until then, and if not, the transcript is replayed as text.
    replayPendingRef.current = true;
    cliSessionRef.current = conv.cliSession ?? "";
    resumeRef.current = conv.cliSession ?? "";
    seenRef.current = new Map((conv.seen ?? []).map(([id, h, at, who]) => [id, { h, at, who }]));
    seenStateRef.current = conv.seenState ?? "";
    bridgeRef.current?.reset(buildCfg());
    activeRef.current = null;
    setRunning(false);
    setInput("");
    setStatus({ label: "resumed", tone: "idle" });
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

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Support actions above the composer. The draft is the main one while the
  // customer is waiting; rewrites only make sense once there is a draft.
  const awaiting = suggestion?.kind === "awaiting";
  const hasDraft = IN_FEATUREBASE && messages.some((m) => m.role === "assistant" && !!m.text && !!parseReplyCached(m.text));
  const nudge =
    suggestion && suggestion.kind !== "awaiting" && !dismissed.has(suggestionKey)
      ? (suggestion as typeof suggestion & { kind: "checkin" | "close" })
      : null;
  const ask = (text: string, shown: string) => () => void submit(undefined, { text, shown });
  const hasAnswered = !!fbCtx?.messages.some((m) => m.who === "agent");
  const ack = fbCtx && awaiting ? acknowledge(fbCtx.customer.name, custLang) : null;
  const actions: QuickAction[] = [
    { label: awaiting && draftedRef.current.has(draftKey) ? "Soạn lại" : "Soạn trả lời", primary: awaiting, run: draftReply },
    // The customer just wrote: tell them we're on it while the answer is drafted.
    ...(ack
      ? [
          {
            label: "Báo đang kiểm tra",
            title: ack.vi ? `${ack.text}\n\n${ack.vi}` : ack.text,
            run: ack.native ? () => insertReply(ack.text, ack.html) : ask(CS_ACK, "Báo khách đang kiểm tra"),
          },
        ]
      : []),
    { label: "Nên hỏi gì?", active: askOpen, run: () => setAskOpen((o) => !o) },
    // A check-in only makes sense when we're the ones waiting (the nudge offers it then).
    ...(nudge || awaiting ? [] : [{ label: "Hỏi thăm", run: ask(CHECK_IN, "Soạn tin hỏi thăm") }]),
    ...(!awaiting && hasAnswered ? [{ label: "Chốt & tóm tắt", run: ask(CS_WRAPUP, "Chốt & tóm tắt") }] : []),
    ...(hasDraft
      ? [
          { label: "Ngắn hơn", run: ask(SHORTER, "Ngắn hơn") },
          { label: "Mềm hơn", run: ask(SOFTER, "Mềm hơn") },
        ]
      : []),
  ];

  // Stable handlers, so a streamed frame re-renders only the message it changes.
  const insertRef = useRef(insertReply);
  insertRef.current = insertReply;
  const stableInsert = useCallback((text: string, html?: string) => insertRef.current(text, html), []);
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const stableCopy = useCallback((i: number, text: string) => void copyRef.current(i, text), []);

  const empty = messages.length === 0;
  const live = messages.length > 0;

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {IN_FEATUREBASE ? (
          // The Featurebase tab is already labelled "Claude": the header is the conversation.
          <ConversationTitle
            ctx={fbCtx}
            now={now}
            lang={custLang}
            waitingSince={suggestion?.kind === "awaiting" ? suggestion.since : undefined}
            busy={running ? busyLabel(status.label) : undefined}
          />
        ) : (
          <>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="shrink-0 text-[13px] font-semibold">{APP_NAME}</span>
            <StatusPill status={status} />
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          {/* merchant summary, on demand */}
          {merchantConfigured && shopDetected && (
            <IconBtn
              label={merchantOpen ? "Ẩn thông tin shop" : "Shop: plan, trial, đơn hàng"}
              onClick={() => setMerchantOpen((o) => !o)}
              className={merchantOpen ? "bg-elevated text-fg" : ""}
            >
              <Store className="h-4 w-4" />
            </IconBtn>
          )}

          {/* history */}
          <div className="relative">
            <IconBtn
              label="History"
              onClick={() => (historyOpen ? setHistoryOpen(false) : void openHistory())}
              className={historyOpen ? "bg-elevated text-fg" : ""}
            >
              <History className="h-4 w-4" />
            </IconBtn>
            {historyOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1.5 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 text-fg shadow-lg">
                  {historyList.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted">No saved conversations yet.</p>
                  ) : (
                    <>
                      {historyList.map((c) => (
                        <div
                          key={c.id}
                          onClick={() => openConversation(c)}
                          className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-elevated"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{c.title}</span>
                            <span className="block text-[10px] text-muted">
                              {relTime(c.updatedAt)} · {c.messages.length} msgs
                              {c.ticket?.ended ? " · đã kết thúc" : ""}
                            </span>
                          </span>
                          <span
                            role="button"
                            aria-label="Delete conversation"
                            onClick={(e) => removeConversation(c.id, e)}
                            className="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-border/60 hover:text-fg group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      ))}
                      <button
                        onClick={clearHistory}
                        className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted hover:bg-elevated"
                      >
                        Clear all
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <IconBtn label="New chat" onClick={() => newChat()} disabled={empty && !running}>
            <Plus className="h-4 w-4" />
          </IconBtn>

          {/* settings */}
          <div className="relative">
            <IconBtn
              label="Settings"
              onClick={() => setSettingsOpen((o) => !o)}
              className={settingsOpen ? "bg-elevated text-fg" : ""}
            >
              <Settings2 className="h-4 w-4" />
            </IconBtn>
            {settingsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSettingsOpen(false)} />
                <div className="scroll-thin absolute right-0 top-full z-50 mt-1.5 max-h-[calc(100vh-56px)] w-72 overflow-y-auto rounded-xl border border-border bg-surface p-3 text-fg shadow-lg">
                  <div className="grid grid-cols-2 gap-2.5">
                    <NativeSelect label="Model" value={model} onChange={setModel} options={MODELS} />
                    <NativeSelect label="Effort" value={effort} onChange={setEffort} options={EFFORTS} />
                  </div>
                  <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={pageOn}
                      onChange={(e) => setPageOn(e.target.checked)}
                    />
                    <Globe className="h-4 w-4 text-muted" />
                    Read &amp; control page
                  </label>
                  {pageOn && (
                    <p className="mt-1 pl-6 text-[10px] leading-tight text-muted">
                      Includes <code>run_js</code> — JavaScript in the tab, like the DevTools console.
                    </p>
                  )}
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={tabsOn}
                      onChange={(e) => setTabsOn(e.target.checked)}
                    />
                    <AppWindow className="h-4 w-4 text-muted" />
                    Control browser tabs
                  </label>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
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
                    <p className="mt-1 pl-6 text-[10px] leading-tight text-muted">
                      {captureStatus?.error
                        ? `⚠️ ${captureStatus.error}`
                        : captureStatus?.attached
                          ? `● capturing tab ${captureStatus.tabId} — Chrome shows a "being debugged" banner.`
                          : 'AI attaches this when it needs console/network (Chrome shows a "being debugged" banner then).'}
                    </p>
                  )}
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={mcpTeam}
                      onChange={(e) => setMcpTeam(e.target.checked)}
                    />
                    <ShieldAlert className="h-4 w-4 text-muted" />
                    Team MCP tools
                  </label>
                  {mcpTeam && (
                    <div className="mt-1 flex flex-col gap-1 pl-6">
                      <p className="text-[10px] leading-tight text-muted">
                        Exposes your own <code>claude</code> MCP servers to the panel. Tools/servers listed
                        below auto-run; anything else asks for approval in a popup.
                      </p>
                      <textarea
                        value={mcpAllowText}
                        onChange={(e) => setMcpAllowText(e.target.value)}
                        placeholder="mcp__postgres_readonly, mcp__clickup_local, mcp__sentry"
                        spellCheck={false}
                        rows={2}
                        className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                    </div>
                  )}
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={shellOn}
                      onChange={(e) => setShellOn(e.target.checked)}
                    />
                    <Terminal className="h-4 w-4 text-muted" />
                    Run shell commands (ask each time)
                  </label>
                  {shellOn && (
                    <p className="mt-1 pl-6 text-[10px] leading-tight text-muted">
                      Lets skills run their scripts. Every command shows an Allow / Deny popup first — nothing
                      runs on its own.
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                      <FolderGit2 className="h-3.5 w-3.5" />
                      Local repo path
                    </span>
                    <div className="flex gap-1.5">
                      <input
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="/Users/you/Workspace/your-repo"
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                      <button
                        type="button"
                        onClick={browseRepo}
                        disabled={browsing}
                        title="Pick a folder"
                        className="shrink-0 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-fg hover:bg-elevated disabled:opacity-50"
                      >
                        {browsing ? "…" : "Browse…"}
                      </button>
                    </div>
                    <span className="text-[10px] leading-tight text-muted">
                      When set, Claude may read &amp; grep files here (no file edits); approved shell commands
                      run in this folder.
                    </span>
                  </div>
                  <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border pt-2.5">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                      <Headset className="h-3.5 w-3.5" />
                      Support (Featurebase tab)
                    </span>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent"
                        checked={csAuto}
                        onChange={(e) => setCsAuto(e.target.checked)}
                      />
                      Tự soạn khi khách nhắn
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      <span className="flex-1">Gợi ý hỏi thăm sau</span>
                      <input
                        type="number"
                        min={1}
                        value={checkinMin}
                        onChange={(e) => setCheckinMin(Math.max(1, Number(e.target.value) || 1))}
                        className="w-14 rounded-lg border border-border bg-bg px-2 py-1 text-right text-sm text-fg outline-none focus-visible:border-accent"
                      />
                      <span className="text-xs text-muted">phút</span>
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      <span className="flex-1">Gợi ý đóng chat sau</span>
                      <input
                        type="number"
                        min={2}
                        value={closeMin}
                        onChange={(e) => setCloseMin(Math.max(2, Number(e.target.value) || 2))}
                        className="w-14 rounded-lg border border-border bg-bg px-2 py-1 text-right text-sm text-fg outline-none focus-visible:border-accent"
                      />
                      <span className="text-xs text-muted">phút</span>
                    </label>
                    <span className="text-[10px] leading-tight text-muted">
                      Tính từ tin nhắn cuối của agent mà khách chưa trả lời. Chỉ gợi ý, không tự gửi.
                    </span>
                  </div>
                  <label className="mt-2.5 flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">
                      Merchant API URL
                    </span>
                    <input
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="http://localhost:3000"
                      spellCheck={false}
                      className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                    />
                  </label>
                  <label className="mt-2.5 flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">
                      Admin access key
                    </span>
                    <input
                      type="password"
                      value={accessKey}
                      onChange={(e) => setAccessKey(e.target.value)}
                      placeholder="customei_ak_…"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                    />
                    <span className="text-[10px] leading-tight text-muted">
                      is_admin key for pod-shopify-backend; stored in this panel.
                    </span>
                  </label>
                  {live && (
                    <p className="mt-2 text-[11px] text-muted">
                      Model, effort, page/capture/repo apply to a new chat.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* merchant summary — only when asked for (Merchant / Shop button), a shop is
          detected AND the merchant API URL + admin access key are set (Settings). */}
      {merchantConfigured && shopDetected && merchantOpen && (
        <MerchantCard
          summary={summary}
          state={summaryState}
          err={summaryErr}
          onRefresh={() => void noteDomain(detectedRef.current, true)}
          onClose={() => setMerchantOpen(false)}
          onDraftReply={() => submit(DRAFT_REPLY_INSTRUCTION)}
          onFeaturebase={onFb && !IN_FEATUREBASE}
          busy={running}
        />
      )}

      {/* experiment CSV export — shown while the active tab is on the
          GemCommerce admin app (admin.gemcommerce.com/admin/*). */}
      {onGemAdmin && <ExperimentExportCard />}

      {permAsk && (
        <PermissionPrompt
          ask={permAsk.ask}
          onDecide={(d) => {
            permAsk.resolve(d);
            setPermAsk(null);
          }}
        />
      )}

      {/* message list */}
      <div ref={listRef} onScroll={onListScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {empty && IN_FEATUREBASE && fbCtx && endedChats[fbCtx.conversationId] ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <p className="text-[13px] font-medium">Đã kết thúc phiên chat của #{fbCtx.conversationId}</p>
            <p className="max-w-64 text-xs leading-relaxed text-muted">
              Hội thoại {fbCtx.state === "open" ? "đang mở" : "đã đóng"}. Bản chat cũ nằm trong lịch sử.
            </p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={() => void reviewEnded(endedChats[fbCtx.conversationId])}
                className="h-7 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated"
              >
                Xem lại chat
              </button>
              <button
                onClick={() => unEnd(fbCtx.conversationId)}
                className="h-7 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-fg hover:opacity-90"
              >
                Phiên mới
              </button>
            </div>
          </div>
        ) : empty && IN_FEATUREBASE && fbCtx ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <p className="text-[13px] font-medium">
              {fbCtx.loading ? `Đang tải hội thoại #${fbCtx.conversationId}…` : `Đã đọc hội thoại #${fbCtx.conversationId}`}
            </p>
            <p className="max-w-64 text-xs leading-relaxed text-muted">
              Chọn một việc bên dưới hoặc hỏi gì cũng được. Bản nháp viết bằng ngôn ngữ của khách
              {custLang && custLang !== "vi" ? `, kèm bản tiếng Việt để đối chiếu` : ""}; mình không tự gửi.
            </p>
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <p className="text-[13px] font-medium">Ask anything, or tell me what to do on this tab</p>
            <p className="max-w-72 text-xs leading-relaxed text-muted">
              I can read and control the page, switch tabs, check its console and network, and read your repo.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => (
              <MessageRow
                key={i}
                index={i}
                role={m.role}
                text={m.text}
                streaming={running && i === messages.length - 1}
                ctx={IN_FEATUREBASE ? fbCtx : null}
                copied={copiedIdx === i}
                onInsert={stableInsert}
                onCopy={stableCopy}
              />
            ))}
          </div>
        )}
      </div>

      {/* composer, with the next step and the support actions right above it */}
      <div className="shrink-0 border-t border-border px-3 pb-3 pt-2" onKeyDown={onKeyDown}>
        {IN_FEATUREBASE && fbCtx?.state === "closed" && !empty && !running && !keepOpen.has(fbCtx.conversationId) && (
          <EndSessionBar
            onEnd={endSession}
            onKeep={() => setKeepOpen((k) => new Set(k).add(fbCtx.conversationId))}
          />
        )}
        {nudge && fbCtx && (
          <NudgeBar
            s={nudge}
            ctx={fbCtx}
            lang={custLang}
            now={now}
            running={running}
            onContextual={(kind) =>
              void submit(kind === "checkin" ? CS_CHECKIN : CS_CLOSE, {
                shown: kind === "checkin" ? "Viết tin hỏi thăm theo ngữ cảnh" : "Viết tin đóng hội thoại theo ngữ cảnh",
              })
            }
            onInsert={insertReply}
            onDismiss={() => setDismissed((d) => new Set(d).add(suggestionKey))}
          />
        )}
        {IN_FEATUREBASE && fbCtx && askOpen && (
          <AskPicker
            key={fbCtx.conversationId}
            ctx={fbCtx}
            lang={custLang}
            running={running}
            onInsert={insertReply}
            onAskClaude={(picked) => {
              setAskOpen(false);
              if (!picked.length) return void submit(undefined, { text: ASK_WHAT, shown: "Nên hỏi khách gì?" });
              const list = picked.map((i) => `- ${i.en}`).join("\n");
              void submit(undefined, {
                text: `Soạn tin nhắn ngắn hỏi khách gửi những thông tin sau, bằng ngôn ngữ của khách:\n${list}`,
                shown: `Hỏi khách: ${picked.map((i) => i.label.toLowerCase()).join(", ")}`,
              });
            }}
            onClose={() => setAskOpen(false)}
          />
        )}
        {IN_FEATUREBASE && fbCtx && <ActionRow actions={actions} disabled={running || !!fbCtx.loading} />}
        <div className="relative rounded-xl border border-border bg-surface transition-colors focus-within:border-accent/60">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              IN_FEATUREBASE && fbCtx ? "Hỏi về hội thoại này… (⌘↵ để gửi)" : "Ask anything… (⌘↵ to send)"
            }
            rows={1}
            // Grows with its text (CSS, not a JS measurement: measuring while the
            // Featurebase iframe was still hidden gave a 0px box after reload).
            className="block max-h-40 min-h-10 w-full resize-none bg-transparent py-2.5 pl-3 pr-11 text-[13px] leading-5 outline-none [field-sizing:content] placeholder:text-muted"
          />
          {running ? (
            <button
              onClick={stop}
              aria-label="Stop"
              title="Stop (Esc)"
              className="absolute bottom-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-fg text-bg hover:opacity-85"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => submit()}
              disabled={!input.trim()}
              aria-label="Send message"
              title="Send (⌘/Ctrl+↵)"
              className="absolute bottom-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-25"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ a message -------------------------------- */

// One chat message, memoized: while a reply streams only the last row changes,
// so older replies (markdown, reply parsing, the sent check) don't re-render
// every frame.
const MessageRow = memo(function MessageRow({
  index,
  role,
  text,
  streaming,
  ctx,
  copied,
  onInsert,
  onCopy,
}: {
  index: number;
  role: Role;
  text: string;
  streaming: boolean;
  ctx: FbContext | null; // the open Featurebase conversation (support mode)
  copied: boolean;
  onInsert: (text: string, html?: string) => Promise<boolean>;
  onCopy: (index: number, text: string) => void;
}) {
  if (role === "user") {
    return (
      <div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-elevated px-3 py-1.5 text-[13px] leading-5">
        {text}
      </div>
    );
  }
  const parsed = IN_FEATUREBASE && text ? parseReplyCached(text) : null;
  return (
    <div className="group min-w-0">
      {parsed ? (
        <ReplyCards r={parsed} streaming={streaming} sent={!streaming && wasSent(parsed.reply, ctx)} onInsert={onInsert} />
      ) : text ? (
        <AssistantText text={text} />
      ) : streaming ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {IN_FEATUREBASE ? "Đang đọc hội thoại…" : "Working…"}
        </p>
      ) : null}
      {text && !parsed && !streaming && (
        <button
          onClick={() => onCopy(index, text)}
          className="-ml-1.5 mt-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted opacity-0 transition-opacity hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
});

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
  onClose,
  onDraftReply,
  onFeaturebase,
  busy,
}: {
  summary: ShopSummary | null;
  state: "loading" | "idle" | "error";
  err?: string;
  onRefresh: () => void;
  onClose: () => void;
  onDraftReply: () => void;
  onFeaturebase: boolean;
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
            {onFeaturebase && (
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
            )}
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
            <button
              aria-label="Hide merchant"
              title="Hide"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-border/40 hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {state === "error" && (
          <p className="pb-2.5 pt-1 text-xs text-muted">
            ⚠️ {err || "lookup failed"}
            {/auth|unauthori[sz]ed|forbidden|401|403/i.test(err ?? "") &&
              " — the backend rejected the Admin access key: it must be an is_admin key minted for the same environment as the Merchant API URL (Settings)."}
          </p>
        )}
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

// Approval popup: the CLI asked to run a tool that isn't auto-allowed (a
// team-MCP write, or any shell command). Allow → run with the shown input;
// Deny → the model is told the user declined.
function PermissionPrompt({ ask, onDecide }: { ask: PermissionAsk; onDecide: (d: PermissionDecision) => void }) {
  const isShell = ask.toolName === "Bash";
  const name = ask.toolName.replace(/^mcp__/, "").replace(/__/g, " · ");
  const command = isShell ? String(ask.input?.command ?? "") : "";
  const why = isShell ? String(ask.input?.description ?? "") : "";
  const pretty = (() => {
    if (isShell) return "";
    try {
      const s = JSON.stringify(ask.input ?? {}, null, 2);
      return s === "{}" ? "" : s;
    } catch {
      return "";
    }
  })();
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30 p-3">
      <div className="w-full max-w-sm rounded-xl border border-border bg-elevated p-3 shadow-xl">
        <div className="flex items-center gap-2">
          {isShell ? <Terminal className="h-4 w-4 text-accent" /> : <ShieldAlert className="h-4 w-4 text-accent" />}
          <span className="text-sm font-semibold">{isShell ? "Run this shell command?" : "Approve tool call?"}</span>
        </div>
        {isShell ? (
          <>
            {why && <p className="mt-1 text-xs text-muted">{why}</p>}
            <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug">
              {command}
            </pre>
          </>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted">The assistant wants to run a tool that isn't on the auto-run list:</p>
            <div className="mt-1.5 break-all rounded-lg bg-surface px-2 py-1 font-mono text-xs">{name}</div>
          </>
        )}
        {pretty && (
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-surface px-2 py-1.5 text-[11px] leading-snug">{pretty}</pre>
        )}
        <div className="mt-2.5 flex justify-end gap-2">
          <button
            onClick={() => onDecide({ behavior: "deny", message: "Denied by user" })}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-border/40"
          >
            Deny
          </button>
          <button
            onClick={() => onDecide({ behavior: "allow", updatedInput: ask.input ?? {} })}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailHead({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-0.5 mt-2.5 text-[11px] font-semibold text-muted first:mt-1">{children}</p>
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
    <div className="flex flex-col items-center rounded-lg bg-elevated px-1 py-1.5">
      <I className="h-3.5 w-3.5 text-muted" />
      <span className="mt-0.5 text-sm font-semibold tabular-nums">{value ?? "—"}</span>
      <span className="text-[10px] leading-tight text-muted">{label}</span>
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function StatusPill({ status }: { status: { label: string; tone: Tone } }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted" title={status.label}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[status.tone])} />
      <span className="truncate">{status.label}</span>
    </span>
  );
}

// What the Featurebase header says while a turn runs.
// The chat bubbles of the buttons that draft a follow-up, and what it is.
const FOLLOW_UP_ASKS: Record<string, FollowUpKind> = {
  "Chốt & tóm tắt": "close",
  "Viết tin đóng hội thoại theo ngữ cảnh": "close",
  "Viết tin hỏi thăm theo ngữ cảnh": "checkin",
  "Soạn tin hỏi thăm": "checkin",
  "Báo khách đang kiểm tra": "ack",
};

function busyLabel(label: string): string {
  if (label.startsWith("→")) return "Đang tra cứu…";
  if (label.startsWith("stopping")) return "Đang dừng…";
  return "Đang soạn…";
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
      <span className="text-xs font-medium text-muted">{label}</span>
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
