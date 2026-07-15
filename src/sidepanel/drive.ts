// "AI is driving this tab" visual mode, injected into the active tab via
// chrome.scripting. It paints a glowing inner halo + a virtual cursor so the
// user can see the assistant is in control, and lays a blocker over the page so
// the user can't scroll/click mid-action (Esc hands control back).
//
// The assistant's own tools act on elements directly through chrome.scripting
// (synthetic events, isTrusted === false), so they are NOT blocked — the
// blocker only swallows real user input (isTrusted === true). That single
// distinction is what lets the overlay stop the human without stopping the AI.

export interface DriveCmd {
  action: "on" | "off" | "hide" | "show" | "cursor";
  x?: number;
  y?: number;
  selector?: string;
  nth?: number;
  click?: boolean;
}

// Runs INSIDE the page (serialized by chrome.scripting) — must be fully
// self-contained: no references to anything outside this function.
export function nexlifyDrive(cmd: DriveCmd): void {
  const w = window as unknown as { __nexlifyDrive?: any };
  const doc = document;
  const NS = "__nexlify_drive__";

  const teardown = () => {
    const st = w.__nexlifyDrive;
    if (st) {
      try {
        for (const [type, fn, opt] of st.listeners) doc.removeEventListener(type, fn, opt);
        st.root.remove();
      } catch {}
      w.__nexlifyDrive = null;
    }
    // Belt-and-suspenders: drop any orphaned overlay even if the state was lost,
    // so "off" always leaves the page clean.
    doc.getElementById(NS)?.remove();
  };

  if (cmd.action === "off") return teardown();

  let st = w.__nexlifyDrive;
  const detached = !st || !st.root || !doc.documentElement.contains(st.root);
  if (detached) {
    teardown();
    const root = doc.createElement("div");
    root.id = NS;
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
    });

    const glow = doc.createElement("div");
    Object.assign(glow.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      boxShadow:
        "inset 0 0 0 3px rgba(139,92,246,.9), inset 0 0 40px 10px rgba(139,92,246,.4), inset 0 0 130px 26px rgba(56,189,248,.22)",
      animation: "nexlifyGlow 1.8s ease-in-out infinite",
    });

    // Absorbs real user pointer input (topmost hit-test target). The AI's
    // synthetic clicks target elements directly and bypass hit-testing.
    const blocker = doc.createElement("div");
    Object.assign(blocker.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "auto",
      cursor: "not-allowed",
      background: "transparent",
    });

    const hint = doc.createElement("div");
    hint.textContent = "✨ AI is controlling this tab — press Esc to take over";
    Object.assign(hint.style, {
      position: "absolute",
      left: "50%",
      top: "14px",
      transform: "translateX(-50%)",
      pointerEvents: "none",
      font: "600 12px/1.4 -apple-system, system-ui, sans-serif",
      color: "#fff",
      background: "rgba(76,29,149,.92)",
      padding: "6px 12px",
      borderRadius: "999px",
      boxShadow: "0 4px 16px rgba(0,0,0,.3)",
      whiteSpace: "nowrap",
    });

    const cursor = doc.createElement("div");
    Object.assign(cursor.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "24px",
      height: "24px",
      pointerEvents: "none",
      transform: "translate(-3px,-2px)",
      transition: "left .35s cubic-bezier(.22,1,.36,1), top .35s cubic-bezier(.22,1,.36,1)",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))",
      opacity: "0",
      zIndex: "2",
    });
    cursor.innerHTML =
      "<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<path d='M4 2l6 16 2.4-6.4L19 9 4 2z' fill='#fff' stroke='#7c3aed' stroke-width='1.5' stroke-linejoin='round'/></svg>";

    const style = doc.createElement("style");
    style.textContent =
      "@keyframes nexlifyGlow{0%,100%{opacity:.9}50%{opacity:.5}}" +
      "@keyframes nexlifyPing{0%{transform:scale(.4);opacity:.7}100%{transform:scale(2.6);opacity:0}}";

    root.append(style, glow, blocker, hint, cursor);
    doc.documentElement.appendChild(root);

    const listeners: Array<[string, EventListener, any]> = [];
    const add = (type: string, fn: EventListener, opt?: any) => {
      doc.addEventListener(type, fn, opt);
      listeners.push([type, fn, opt]);
    };
    const swallow = (e: Event) => {
      if (e.isTrusted) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!ke.isTrusted) return;
      if (ke.key === "Escape") {
        try {
          chrome.runtime?.sendMessage?.({ __nexlifyDrive: "stop" });
        } catch {}
        teardown();
        return;
      }
      const scrollKeys = [" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      if (scrollKeys.indexOf(ke.key) >= 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    add("wheel", swallow, { capture: true, passive: false });
    add("touchmove", swallow, { capture: true, passive: false });
    add("keydown", onKey, true);

    st = w.__nexlifyDrive = { root, glow, blocker, hint, cursor, listeners };
  }

  if (cmd.action === "hide") {
    st.root.style.display = "none";
    return;
  }
  if (cmd.action === "show") {
    st.root.style.display = "";
    return;
  }

  if (cmd.action === "cursor") {
    let x = cmd.x;
    let y = cmd.y;
    if (cmd.selector) {
      const el = doc.querySelectorAll(cmd.selector)[cmd.nth || 0] as HTMLElement | undefined;
      if (el) {
        const r = el.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
    }
    if (typeof x === "number" && typeof y === "number") {
      st.cursor.style.opacity = "1";
      st.cursor.style.left = x + "px";
      st.cursor.style.top = y + "px";
      if (cmd.click) {
        const ping = doc.createElement("div");
        Object.assign(ping.style, {
          position: "absolute",
          left: x + "px",
          top: y + "px",
          width: "26px",
          height: "26px",
          marginLeft: "-13px",
          marginTop: "-13px",
          borderRadius: "999px",
          border: "2px solid #a855f7",
          pointerEvents: "none",
          animation: "nexlifyPing .6s ease-out forwards",
          zIndex: "1",
        });
        st.root.appendChild(ping);
        setTimeout(() => ping.remove(), 680);
      }
    }
  }
}

// ---- panel-side helpers ---------------------------------------------------

async function inject(tabId: number, cmd: DriveCmd): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: nexlifyDrive, args: [cmd] });
  } catch {
    // Injection is refused on chrome:// / the web store / other privileged pages.
    // The visuals are best-effort — never let them break the actual tool call.
  }
}

export const drive = {
  on: (tabId: number) => inject(tabId, { action: "on" }),
  off: (tabId: number) => inject(tabId, { action: "off" }),
  hide: (tabId: number) => inject(tabId, { action: "hide" }),
  show: (tabId: number) => inject(tabId, { action: "show" }),
  cursor: (tabId: number, c: Omit<DriveCmd, "action">) => inject(tabId, { action: "cursor", ...c }),
};
