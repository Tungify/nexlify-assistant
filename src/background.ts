// Background service worker.
//
// 1. Opens the side panel on toolbar click.
// 2. Holds a persistent native-host connection so the browser tools keep working
//    when the side panel is CLOSED. For now the worker runs the tab/navigation
//    tools (chrome.tabs.*); page + debug tools still need the panel open. host.js
//    pings us every ~20s so MV3 doesn't idle-suspend the worker, and an alarm
//    reconnects it if Chrome recycles it anyway.
// 3. Right-click "Download video" on X / Instagram / Facebook posts: extracts the
//    post's media in-page and hands it to the host, which saves it (via yt-dlp if
//    installed, else a direct fetch of the best MP4 URL we found).

import { TAB_TOOLS, runTabTool } from "./tabTools";
import { extractVideoInPage, type ExtractResult } from "./videoExtract";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));
  setupMenus();
  connectHost();
});

const HOST_NAME = "com.nexlify.assistant";
let port: chrome.runtime.Port | null = null;

// Connect to the native host (idempotent). connectNative spawns host.js, which
// owns the public bridge socket external CLIs use — so an outside `claude` can
// reach us even with no panel open.
function connectHost() {
  if (port) return;
  try {
    const p = chrome.runtime.connectNative(HOST_NAME);
    p.onMessage.addListener(onHostMessage);
    p.onDisconnect.addListener(() => {
      port = null; // reconnected by the keepalive alarm below
    });
    port = p;
  } catch (e) {
    port = null;
    console.error("connectNative failed:", e);
  }
}

function onHostMessage(m: unknown) {
  const msg = m as { type?: string };
  if (!msg) return;
  if (msg.type === "tool_request") {
    void handleToolRequest(m as { callId: string; tool: string; args?: Record<string, unknown> });
  } else if (msg.type === "download_progress") {
    onDownloadProgress(m as { id: string; pct?: number; line?: string });
  } else if (msg.type === "download_result") {
    onDownloadResult(m as { id: string; ok: boolean; path?: string; error?: string; engine?: string });
  }
  // "__ping" (host heartbeat) keeps this worker awake; nothing else to do.
}

async function handleToolRequest(req: { callId: string; tool: string; args?: Record<string, unknown> }) {
  let result: Record<string, unknown>;
  try {
    if (!TAB_TOOLS.has(req.tool)) {
      // Page/debug tools live in the panel for now — say so instead of hanging.
      throw new Error(`"${req.tool}" needs the side panel open (only tab tools run in the background so far)`);
    }
    const data = await runTabTool(req.tool, req.args ?? {});
    result = { type: "tool_result", callId: req.callId, ok: true, data };
  } catch (e) {
    result = { type: "tool_result", callId: req.callId, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  port?.postMessage(result);
}

// ==== Right-click "Download video" ========================================

const MENU_DOWNLOAD = "nexlify-download-video";
// Posts we support (no YouTube by design). Suffix-matched hosts.
const VIDEO_SITE_PATTERNS = [
  "*://*.x.com/*",
  "*://x.com/*",
  "*://*.twitter.com/*",
  "*://*.instagram.com/*",
  "*://*.facebook.com/*",
  "*://*.fb.watch/*",
];

function setupMenus() {
  // "all" so the item shows even when the click lands on an overlay div covering
  // the <video> (which reports as the "page" context) — common on IG reels / FB.
  // We keep it ALWAYS visible on these sites: an earlier "hide it when the page
  // has no video" scheme kept vanishing on IG reels (the SPA loads the video
  // after our check), and a menu that disappears is far worse than one that also
  // shows on empty space. So: reliable over tidy.
  const contexts: chrome.contextMenus.CreateProperties["contexts"] = ["all"];
  // removeAll first so re-registration on update/startup doesn't duplicate.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "nexlify-root",
      title: "Nexlify Assistant",
      contexts,
      documentUrlPatterns: VIDEO_SITE_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD,
      parentId: "nexlify-root",
      title: "Download video (best quality)",
      contexts,
      documentUrlPatterns: VIDEO_SITE_PATTERNS,
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_DOWNLOAD && tab?.id != null) {
    void startDownload(tab.id, { frameId: info.frameId, source: "menu", srcUrl: info.srcUrl });
  }
});

// Page-proof trigger: Ctrl/Cmd+Shift+Y downloads the video under the cursor, even
// when the site overlays it or hijacks the right-click menu.
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== "download-video") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await startDownload(tab.id, { source: "shortcut" });
  })();
});

let downloadSeq = 0;

// Extract the pointed-at video (menu → right-click point; shortcut → cursor
// point; both read the coords the videoPick content script left on the page) and
// hand it to the host to save. For the shortcut we inject into every frame and
// keep the result from the frame whose pointer is freshest — that's where the
// cursor is — so a video inside an iframe still works.
async function startDownload(
  tabId: number,
  o: { frameId?: number; source: "menu" | "shortcut"; srcUrl?: string },
) {
  const id = `dl-${++downloadSeq}`;
  notify(id, "Nexlify — download", "Looking for the video…", 0);

  let results: ExtractResult[] = [];
  try {
    const target: chrome.scripting.InjectionTarget =
      o.frameId != null ? { tabId, frameIds: [o.frameId] } : { tabId, allFrames: true };
    const injected = await chrome.scripting.executeScript({
      target,
      func: extractVideoInPage,
      args: [{ source: o.source }],
    });
    results = injected.map((r) => r.result as ExtractResult).filter(Boolean);
  } catch (e) {
    notifyDone(id, false, `Couldn't read the page: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Prefer frames that actually found a video; among those the freshest pointer
  // (the frame the cursor / right-click was in) wins.
  const withVideo = results.filter((r) => r.hasVideo || r.directUrls.length);
  const pool = withVideo.length ? withVideo : results;
  const chosen = pool.sort((a, b) => (b.pointerTs || 0) - (a.pointerTs || 0))[0];
  const srcUrl = o.srcUrl && /^https?:/i.test(o.srcUrl) ? o.srcUrl : "";

  if (!chosen || (!chosen.hasVideo && !chosen.directUrls.length && !srcUrl)) {
    notifyDone(id, false, "No video found — point at a video (or start it playing) and try again.");
    return;
  }

  connectHost();
  if (!port) {
    notifyDone(id, false, "Native host not reachable — is the extension installed via install.sh?");
    return;
  }

  port.postMessage({
    type: "download_video",
    id,
    platform: chosen.platform,
    permalink: chosen.permalink,
    pageUrl: chosen.pageUrl,
    title: chosen.title,
    directUrls: chosen.directUrls,
    blobOnly: chosen.blobOnly,
    srcUrl, // a signed CDN URL only works with the right Referer, sent below
    referer: chosen.pageUrl,
  });
  notify(id, "Nexlify — download", "Downloading…", 0);
}

function onDownloadProgress(m: { id: string; pct?: number; line?: string }) {
  const pct = typeof m.pct === "number" ? Math.max(0, Math.min(100, Math.round(m.pct))) : undefined;
  notify(m.id, "Nexlify — downloading", m.line || (pct != null ? `${pct}%` : "Downloading…"), pct);
}

function onDownloadResult(m: { id: string; ok: boolean; path?: string; error?: string; engine?: string }) {
  if (m.ok) {
    const where = m.path ? m.path.replace(/^.*\//, "") : "your Downloads folder";
    notifyDone(m.id, true, `Saved ${where}${m.engine ? ` (via ${m.engine})` : ""}`);
  } else {
    notifyDone(m.id, false, m.error || "Download failed");
  }
}

// ---- notifications -------------------------------------------------------

function iconUrl() {
  return chrome.runtime.getURL("icons/icon-128.png");
}

// A toolbar-icon badge backs up the notification — it's always visible even when
// macOS/Chrome notifications are turned off, so a download is never a black box.
function setBadge(text: string, color: string) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function notify(id: string, title: string, message: string, pct?: number) {
  setBadge(pct != null && pct > 0 ? `${Math.round(pct)}` : "…", "#6b7280");
  const type: "basic" | "progress" = pct != null ? "progress" : "basic";
  const opts: chrome.notifications.NotificationCreateOptions = {
    type,
    iconUrl: iconUrl(),
    title,
    message,
    ...(pct != null ? { progress: pct } : {}),
  };
  // create() with an existing id replaces it, so progress updates in place.
  chrome.notifications.create(id, opts, () => void chrome.runtime.lastError);
}

function notifyDone(id: string, ok: boolean, message: string) {
  setBadge(ok ? "✓" : "✗", ok ? "#16a34a" : "#dc2626");
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), ok ? 5000 : 9000);
  const opts: chrome.notifications.NotificationCreateOptions = {
    type: "basic",
    iconUrl: iconUrl(),
    title: ok ? "Nexlify — done ✓" : "Nexlify — failed",
    message,
  };
  chrome.notifications.create(id, opts, () => void chrome.runtime.lastError);
}

// Keepalive + recovery: reconnect on startup, and on a recurring alarm that
// fires even if the worker was suspended (min period 0.5 min). connectHost() is
// a no-op while the port is alive.
chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  connectHost();
});
chrome.alarms.create("nexlify-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "nexlify-keepalive") connectHost();
});

// Connect as soon as this worker script is (re)evaluated.
connectHost();
