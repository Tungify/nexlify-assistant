// The support-mode pieces of the panel: the conversation line in the header,
// the reply (in the customer's language, with a Vietnamese copy when that isn't
// Vietnamese), the check-in / close nudge
// and the action row above the composer. See support.ts for the logic.
import { useRef, useState } from "react";
import { Archive, Check, CheckCheck, History, ChevronRight, CircleCheck, ClipboardPaste, Copy, ExternalLink, Hourglass, LoaderCircle, MessageCircleQuestion, WandSparkles, X } from "lucide-react";
import { Md } from "./Md";
import {
  ASK_ITEMS,
  ago,
  askMessage,
  copyRich,
  followUp,
  langName,
  langTag,
  lastHuman,
  mdToPlain,
  type AskItem,
  type FbContext,
  type ParsedReply,
  type Suggestion,
  type Template,
} from "./support";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const pref = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const setPref = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
};

// Copy / insert buttons share one look and a short "done" state.
export function ActionBtn({
  icon,
  label,
  doneLabel,
  onClick,
  primary,
  disabled,
  iconOnly,
}: {
  icon: React.ReactNode;
  label: string;
  doneLabel?: string;
  onClick: () => Promise<boolean | void> | boolean | void;
  primary?: boolean;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const run = async () => {
    const ok = await onClick();
    setState(ok === false ? "fail" : "done");
    setTimeout(() => setState("idle"), 1600);
  };
  const text = state === "done" ? doneLabel ?? "Xong" : state === "fail" ? "Không thấy ô Reply" : label;
  return (
    <button
      onClick={run}
      disabled={disabled}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cx(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40",
        iconOnly ? "w-7" : "px-2.5",
        primary ? "bg-accent text-accent-fg hover:opacity-90" : "text-muted hover:bg-elevated hover:text-fg",
      )}
    >
      {state === "done" ? <Check className="h-3.5 w-3.5" /> : icon}
      {(!iconOnly || state === "fail") && text}
    </button>
  );
}

/* ---------------------------- header: conversation --------------------------- */

function sinceText(ctx: FbContext, now: number): { text: string; waiting: boolean } {
  const last = lastHuman(ctx);
  if (!last) return { text: "Chưa có tin nhắn", waiting: false };
  const t = ago(now - Date.parse(last.at));
  const fresh = t === "vừa xong";
  if (last.who === "customer") {
    const waiting = ctx.state === "open";
    if (waiting) return { text: fresh ? "Khách vừa nhắn" : `Khách chờ ${t}`, waiting };
    return { text: fresh ? "Khách vừa nhắn" : `Khách nhắn ${t} trước`, waiting };
  }
  return { text: fresh ? "Agent vừa trả lời" : `Agent trả lời ${t} trước`, waiting: false };
}

// Who this is, which shop, and how long they've waited: two short lines that
// replace the old strip + "waiting" card.
export function ConversationTitle({
  ctx,
  now,
  busy,
  lang = "",
  waitingSince,
}: {
  ctx: FbContext | null;
  now: number;
  busy?: string;
  lang?: string; // the customer's language, when known
  waitingSince?: number; // still owed an answer (also after an "I'm on it")
}) {
  if (!ctx) {
    return (
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-5">Claude</p>
        <p className="truncate text-xs leading-4 text-muted">Mở một hội thoại trong inbox để bắt đầu</p>
      </div>
    );
  }
  const { text, waiting } =
    waitingSince != null
      ? { text: ago(now - waitingSince) === "vừa xong" ? "Khách vừa nhắn" : `Khách chờ ${ago(now - waitingSince)}`, waiting: true }
      : sinceText(ctx, now);
  const name = ctx.customer.name || ctx.customer.email;
  // Featurebase may name the customer after the shop: then the shop line would repeat it.
  const where = [ctx.shop, ctx.company, ctx.customer.email].find((w) => w && w !== name) ?? "";
  // Just switched with nothing cached yet: only the id is known.
  const bare = ctx.loading && !ctx.fetchedAt;
  if (bare) busy ??= "Đang tải…";
  return (
    <div className="min-w-0 flex-1">
      <p className="flex items-baseline gap-1.5 leading-5">
        <span className="truncate text-[13px] font-semibold">
          {name || (bare ? "Hội thoại" : "Khách")}
        </span>
        <span className="shrink-0 text-xs text-muted">#{ctx.conversationId}</span>
        {lang && (
          <span className="shrink-0 rounded bg-elevated px-1 text-[10px] font-medium text-muted" title={`Khách viết ${langName(lang)}`}>
            {lang.toUpperCase()}
          </span>
        )}
        {ctx.state && ctx.state !== "open" && (
          <span className="shrink-0 rounded bg-elevated px-1 text-[11px] text-muted">{stateLabel(ctx.state)}</span>
        )}
      </p>
      <p className="flex items-center gap-2 text-xs leading-4 text-muted">
        {where && <span className="min-w-0 truncate">{where}</span>}
        {busy ? (
          <span className={cx("inline-flex shrink-0 items-center gap-1 text-fg", where && "ml-auto")}>
            <LoaderCircle className="h-3 w-3 animate-spin" />
            {busy}
          </span>
        ) : (
          <span className={cx("shrink-0", where && "ml-auto", waiting && "font-medium text-accent")}>{text}</span>
        )}
      </p>
    </div>
  );
}

const STATE_VI: Record<string, string> = { closed: "đã đóng", snoozed: "tạm hoãn" };
export const stateLabel = (state: string) => STATE_VI[state] ?? state;

/* ------------------------ closed: end the chat session ----------------------- */

// The conversation was closed in Featurebase: offer to end this chat session
// (saved to history, CLI session freed). The agent decides; nothing ends alone.
export function EndSessionBar({ onEnd, onKeep }: { onEnd: () => void; onKeep: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl bg-elevated px-3 py-2">
      <CircleCheck className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-xs leading-snug">
        Hội thoại đã đóng. <span className="text-muted">Kết thúc phiên chat này? Bản chat vẫn lưu trong lịch sử.</span>
      </span>
      <button
        onClick={onKeep}
        className="h-7 shrink-0 rounded-lg px-2 text-xs font-medium text-muted hover:bg-border/60 hover:text-fg"
      >
        Giữ
      </button>
      <button
        onClick={onEnd}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-fg hover:opacity-90"
      >
        <Archive className="h-3.5 w-3.5" />
        Kết thúc
      </button>
    </div>
  );
}

/* ------------------------- nudge: check in / close -------------------------- */

// Insert / Copy for a ready-made template. With no template in the customer's
// language, writing one (the model) comes first and English is the fallback.
function TemplateActions({
  tpl,
  lang,
  running,
  writeLabel,
  onWrite,
  onInsert,
  onInserted,
}: {
  tpl: Template;
  lang: string;
  running: boolean;
  writeLabel: string;
  onWrite: () => void;
  onInsert: (text: string, html?: string) => Promise<boolean>;
  onInserted?: () => void;
}) {
  const insert = async () => {
    const ok = await onInsert(tpl.text, tpl.html);
    if (ok) onInserted?.();
    return ok;
  };
  const write = (
    <ActionBtn
      primary={!tpl.native}
      icon={<WandSparkles className="h-3.5 w-3.5" />}
      label={tpl.native ? writeLabel : `Viết bằng ${langName(lang)}`}
      onClick={onWrite}
      disabled={running}
    />
  );
  return (
    <div className="-ml-1 mt-1.5 flex flex-wrap items-center gap-1">
      {!tpl.native && write}
      <ActionBtn
        primary={tpl.native}
        icon={<ClipboardPaste className="h-3.5 w-3.5" />}
        label={tpl.native ? "Đưa vào ô Reply" : "Dùng bản tiếng Anh"}
        doneLabel="Đã đưa vào"
        disabled={!tpl.text}
        onClick={insert}
      />
      <ActionBtn
        iconOnly={!tpl.native}
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Copy"
        doneLabel="Đã copy"
        disabled={!tpl.text}
        onClick={() => copyRich(tpl.text, tpl.html)}
      />
      {tpl.native && write}
    </div>
  );
}

export function NudgeBar({
  s,
  ctx,
  lang,
  now,
  running,
  onContextual,
  onInsert,
  onDismiss,
}: {
  s: Suggestion & { kind: "checkin" | "close" };
  ctx: FbContext;
  lang: string;
  now: number;
  running: boolean;
  onContextual: (kind: "checkin" | "close") => void;
  onInsert: (text: string, html?: string) => Promise<boolean>;
  onDismiss: () => void;
}) {
  const second = s.kind === "checkin" && s.round === 2;
  const tpl = followUp(second ? "checkin2" : s.kind, ctx.customer.name, lang);
  const quiet = ago(now - s.since);
  return (
    <div className="mb-2 rounded-xl bg-elevated px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Hourglass className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          Khách im lặng {quiet}. {s.kind === "close" ? "Đóng hội thoại?" : second ? "Hỏi thăm lần nữa?" : "Hỏi thăm?"}
        </span>
        <button
          onClick={onDismiss}
          aria-label="Ẩn gợi ý"
          className="-mr-1 ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-border/60 hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className={cx("mt-1 text-[13px] leading-snug", !tpl.native && "text-muted")} title={tpl.vi || undefined}>
        {tpl.text}
      </p>
      <TemplateActions
        tpl={tpl}
        lang={lang}
        running={running}
        writeLabel="Viết theo ngữ cảnh"
        onWrite={() => onContextual(s.kind)}
        onInsert={onInsert}
      />
    </div>
  );
}

/* ---------------------- "Nên hỏi gì?": ask for details ----------------------- */

// Tick what you need from the merchant and get the message at once (no model
// call). "Để Claude chọn" still asks the model to pick from the conversation.
export function AskPicker({
  ctx,
  lang,
  running,
  onInsert,
  onAskClaude,
  onClose,
}: {
  ctx: FbContext;
  lang: string;
  running: boolean;
  onInsert: (text: string, html?: string) => Promise<boolean>;
  onAskClaude: (picked: AskItem[]) => void; // none picked: Claude chooses what to ask
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  // The store is already known when Featurebase has it: don't ask again.
  const items = ASK_ITEMS.filter((i) => !(i.key === "shop" && /\.myshopify\.com$/.test(ctx.shop)));
  const msg = askMessage(picked, ctx.customer.name, lang);
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  return (
    <div className="mb-2 rounded-xl bg-elevated px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Cần khách gửi gì?</span>
        <button
          onClick={onClose}
          aria-label="Đóng"
          className="-mr-1 ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-border/60 hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {items.map((i) => {
          const on = picked.includes(i.key);
          return (
            <button
              key={i.key}
              onClick={() => toggle(i.key)}
              aria-pressed={on}
              title={i.vi}
              className={cx(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
                on ? "border-accent bg-accent-soft font-medium text-accent" : "border-border bg-surface text-fg hover:border-fg/30",
              )}
            >
              {on && <Check className="h-3 w-3" />}
              {i.label}
            </button>
          );
        })}
      </div>
      {msg.text && (
        <p
          className={cx("mt-2 whitespace-pre-line text-[13px] leading-snug", !msg.native && "text-muted")}
          title={msg.vi || undefined}
        >
          {msg.text}
        </p>
      )}
      <TemplateActions
        tpl={msg}
        lang={lang}
        running={running}
        writeLabel="Để Claude chọn"
        onWrite={() => onAskClaude(ASK_ITEMS.filter((i) => picked.includes(i.key)))}
        onInsert={onInsert}
        onInserted={() => setTimeout(onClose, 900)}
      />
    </div>
  );
}

/* ------------------------------- the reply ---------------------------------- */

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
function links(md: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const m of md.matchAll(LINK)) {
    const href = m[2] ?? m[3];
    if (out.some((l) => l.href === href)) continue;
    out.push({ text: m[1] ?? href.replace(/^https?:\/\/(www\.)?/, ""), href });
  }
  return out;
}

function Disclosure({
  label,
  preview,
  open,
  onToggle,
  children,
}: {
  label: string;
  preview?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-xs text-muted hover:text-fg"
      >
        <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 font-medium">{label}</span>
        {!open && preview && <span className="min-w-0 truncate opacity-80">{preview}</span>}
      </button>
      {open && <div className="mt-1 pl-[18px]">{children}</div>}
    </div>
  );
}

export function ReplyCards({
  r,
  streaming,
  sent,
  stale,
  onInsert,
}: {
  r: ParsedReply;
  streaming: boolean;
  sent?: boolean; // the agent already sent this reply in the conversation
  stale?: boolean; // written before the conversation's latest message: out of date
  onInsert: (text: string, html?: string) => Promise<boolean>;
}) {
  // Sent or out of date: shown for reference, grey, with no way to insert it.
  const done = sent || stale;
  const [showAnalysis, setShowAnalysis] = useState(() => pref("fb_cs_analysis", false));
  const [showVi, setShowVi] = useState(() => pref("fb_cs_vi", true));
  // The reply as rendered (bold, lists, links), for a formatted insert/copy.
  const enRef = useRef<HTMLDivElement>(null);
  const enHtml = () => enRef.current?.querySelector(".md")?.innerHTML || undefined;
  const src = r.sources ? links(r.sources) : [];
  const firstLine = (md: string) => mdToPlain(md).split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="flex flex-col gap-2">
      {r.preface && <Md text={r.preface} />}
      {r.analysis && (
        <Disclosure
          label="Phân tích"
          preview={firstLine(r.analysis)}
          open={showAnalysis}
          onToggle={() => {
            setShowAnalysis((v) => !v);
            setPref("fb_cs_analysis", !showAnalysis);
          }}
        >
          <Md text={r.analysis} className="text-muted" />
        </Disclosure>
      )}
      {r.reply && (
        <section className={cx("rounded-xl border bg-surface", done ? "border-border" : "border-accent/30")}>
          <p className={cx("flex items-center gap-1.5 px-3 pt-2 text-[11px] font-medium", done ? "text-muted" : "text-accent")}>
            <span className={cx("rounded px-1 py-px font-semibold", done ? "bg-elevated" : "bg-accent-soft")} title={r.lang}>
              {langTag(r.lang)}
            </span>
            {sent ? "Đã gửi cho khách" : stale ? "Bản cũ: hội thoại đã có tin mới hơn" : "Gửi khách"}
          </p>
          <div ref={enRef} className={cx("px-3 pb-1 pt-1", stale && !sent && "text-muted")}>
            <Md text={r.reply} />
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            {sent ? (
              <span className="inline-flex h-7 items-center gap-1.5 px-1.5 text-xs font-medium text-muted">
                <CheckCheck className="h-3.5 w-3.5" />
                Đã gửi
              </span>
            ) : stale ? (
              <span className="inline-flex h-7 items-center gap-1.5 px-1.5 text-xs text-muted">
                <History className="h-3.5 w-3.5" />
                Soạn lại để trả lời tin mới
              </span>
            ) : (
              <ActionBtn
                primary
                icon={<ClipboardPaste className="h-3.5 w-3.5" />}
                label="Đưa vào ô Reply"
                doneLabel="Đã đưa vào"
                onClick={() => onInsert(mdToPlain(r.reply), enHtml())}
                disabled={streaming}
              />
            )}
            <ActionBtn
              icon={<Copy className="h-3.5 w-3.5" />}
              label="Copy"
              doneLabel="Đã copy"
              onClick={() => copyRich(mdToPlain(r.reply), enHtml())}
              disabled={streaming}
            />
          </div>
        </section>
      )}
      {r.vi && (
        <Disclosure
          label="Bản tiếng Việt"
          preview={firstLine(r.vi)}
          open={showVi}
          onToggle={() => {
            setShowVi((v) => !v);
            setPref("fb_cs_vi", !showVi);
          }}
        >
          <Md text={r.vi} className="text-muted" />
        </Disclosure>
      )}
      {r.sources &&
        (src.length ? (
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="mr-0.5 text-muted">Nguồn</span>
            {src.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                title={l.href}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-fg hover:bg-border/70"
              >
                <span className="truncate">{l.text}</span>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted" />
              </a>
            ))}
          </div>
        ) : (
          <Md text={r.sources} className="text-xs text-muted" />
        ))}
    </div>
  );
}

/* ------------------------------ action row --------------------------------- */

export interface QuickAction {
  label: string;
  primary?: boolean;
  active?: boolean; // its panel is open
  title?: string; // what it will put in (instant templates)
  // An instant insert resolves true/false (shown as done / no reply box);
  // anything else just runs.
  run: () => Promise<boolean> | void;
}

export const ASK_WHAT = "Nên hỏi khách thêm gì để xử lý được vấn đề? Soạn sẵn tin nhắn hỏi.";
export const CHECK_IN = "Soạn một tin hỏi thăm ngắn: khách còn ở đó không, có cần hỗ trợ thêm gì không.";
export const SHORTER = "Viết lại bản trả lời ngắn hơn.";
export const SOFTER = "Viết lại bản trả lời mềm mỏng, ấm áp hơn.";

function Chip({ a, disabled }: { a: QuickAction; disabled: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const click = async () => {
    const r = a.run();
    if (!(r instanceof Promise)) return;
    setState((await r) ? "done" : "fail");
    setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      onClick={click}
      disabled={disabled}
      title={a.title}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:opacity-40",
        a.primary
          ? "bg-accent text-accent-fg hover:opacity-90"
          : a.active
            ? "border border-fg/25 bg-elevated text-fg"
            : "border border-border text-fg hover:bg-elevated",
      )}
    >
      {state === "done" ? <Check className="h-3.5 w-3.5" /> : a.primary && <WandSparkles className="h-3.5 w-3.5" />}
      {state === "done" ? "Đã đưa vào ô Reply" : state === "fail" ? "Không thấy ô Reply" : a.label}
    </button>
  );
}

// One row of actions right above the composer; scrolls sideways when narrow.
export function ActionRow({ actions, disabled }: { actions: QuickAction[]; disabled: boolean }) {
  return (
    <div className="no-scrollbar -mx-3 mb-2 flex gap-1 overflow-x-auto px-3">
      {actions.map((a) => (
        <Chip key={a.label} a={a} disabled={disabled} />
      ))}
    </div>
  );
}
