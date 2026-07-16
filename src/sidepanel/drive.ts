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
        if (st.moteTimer) clearInterval(st.moteTimer);
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
      // Layered golden aura: bright warm-white rim → gold inner glow → amber mid
      // aura → wide amber bloom. Reads as light, not a hard border.
      boxShadow:
        "inset 0 0 3px 1px rgba(255,244,204,.9), inset 0 0 34px 6px rgba(252,211,77,.6), inset 0 0 92px 22px rgba(245,158,11,.32), inset 0 0 200px 60px rgba(245,158,11,.2)",
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
      background: "rgba(120,53,15,.92)",
      padding: "6px 12px",
      borderRadius: "999px",
      boxShadow: "0 4px 16px rgba(0,0,0,.3)",
      whiteSpace: "nowrap",
      zIndex: "3",
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
      "<path d='M4 2l6 16 2.4-6.4L19 9 4 2z' fill='#fff' stroke='#b45309' stroke-width='1.5' stroke-linejoin='round'/></svg>";

    const style = doc.createElement("style");
    style.textContent =
      "@keyframes nexlifyGlow{0%,100%{opacity:.95}50%{opacity:.6}}" +
      "@keyframes nexlifyPing{0%{transform:scale(.4);opacity:.7}100%{transform:scale(2.6);opacity:0}}" +
      "@keyframes nexlifyMote{0%{opacity:0;transform:translate(var(--sx),var(--sy)) scale(.4)}" +
      "12%{opacity:1}78%{opacity:1}100%{opacity:0;transform:translate(var(--ex),var(--ey)) scale(1.2)}}";

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

    // Light motes: glowing specks drift in from a random edge, cross the aura
    // band a short way, then fade — the "hào quang" shimmer. Tune these with
    // dev/drive-preview.html, then copy the values back here.
    const MOTE_RATE = 150; // ms between spawns
    const MOTE_REACH = 200; // max px travelled inward
    const MOTE_SIZE = 7; // max mote diameter (px)
    const MOTE_SPEED = 2.2; // base seconds to cross + fade
    const MOTE_A = "255,236,170"; // pale gold
    const MOTE_B = "251,191,36"; // amber
    const spawnMote = () => {
      if (!doc.documentElement.contains(root) || root.style.display === "none") return;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const edge = Math.floor(Math.random() * 4);
      const dist = MOTE_REACH * (0.5 + Math.random() * 0.5);
      const drift = (Math.random() - 0.5) * 80;
      let sx: number, sy: number, ex: number, ey: number;
      if (edge === 0) { sx = Math.random() * W; sy = -20; ex = sx + drift; ey = sy + dist; }
      else if (edge === 1) { sx = Math.random() * W; sy = H + 20; ex = sx + drift; ey = sy - dist; }
      else if (edge === 2) { sx = -20; sy = Math.random() * H; ex = sx + dist; ey = sy + drift; }
      else { sx = W + 20; sy = Math.random() * H; ex = sx - dist; ey = sy + drift; }
      const size = 2 + Math.random() * (MOTE_SIZE - 2);
      const dur = MOTE_SPEED * (0.7 + Math.random() * 0.7);
      const hue = Math.random() < 0.5 ? MOTE_A : MOTE_B;
      const m = doc.createElement("div");
      Object.assign(m.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: size + "px",
        height: size + "px",
        borderRadius: "999px",
        pointerEvents: "none",
        opacity: "0",
        zIndex: "1",
        background: `radial-gradient(circle, #fff 0%, rgba(${hue},.95) 45%, rgba(${hue},0) 72%)`,
        boxShadow: `0 0 ${8 + size * 1.5}px ${size}px rgba(${hue},.9)`,
      });
      m.style.setProperty("--sx", sx + "px");
      m.style.setProperty("--sy", sy + "px");
      m.style.setProperty("--ex", ex + "px");
      m.style.setProperty("--ey", ey + "px");
      m.style.animation = `nexlifyMote ${dur}s ease-out forwards`;
      root.appendChild(m);
      setTimeout(() => m.remove(), dur * 1000 + 120);
    };
    const moteTimer = setInterval(() => {
      spawnMote();
      spawnMote();
      if (Math.random() < 0.5) spawnMote(); // denser field so the motes read clearly
    }, MOTE_RATE);

    st = w.__nexlifyDrive = { root, glow, blocker, hint, cursor, listeners, moteTimer };
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
          border: "2px solid #fbbf24",
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
