// Content script on X / Instagram / Facebook. Passive: it only records WHERE the
// user last right-clicked and where the pointer is, on the isolated-world window.
// The downloader (injected later via chrome.scripting into this same isolated
// world) reads those coords and uses document.elementsFromPoint to pick the exact
// video under that point — so it works through overlay divs and picks the right
// one in a multi-video feed. It never reads the page's content or mutates its DOM.

interface NexlifyPoint {
  x: number;
  y: number;
  t: number; // Date.now() when recorded
}
declare global {
  interface Window {
    __nexlifyRightClick?: NexlifyPoint;
    __nexlifyPointer?: NexlifyPoint;
  }
}

// Capture phase + last arg true so we see the event even when the page stops
// propagation or preventDefaults it (e.g. Facebook's custom right-click menu).
window.addEventListener(
  "contextmenu",
  (e) => {
    window.__nexlifyRightClick = { x: e.clientX, y: e.clientY, t: Date.now() };
  },
  true,
);

// Throttled cursor tracking — the keyboard-shortcut trigger uses "video under the
// cursor", so we keep a recent pointer position without spamming on every move.
let lastMove = 0;
window.addEventListener(
  "pointermove",
  (e) => {
    const now = Date.now();
    if (now - lastMove < 200) return;
    lastMove = now;
    window.__nexlifyPointer = { x: e.clientX, y: e.clientY, t: now };
  },
  { capture: true, passive: true },
);

export {};
