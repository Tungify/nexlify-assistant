// Tab / navigation tools (chrome.tabs.*), shared by the side-panel bridge AND
// the background service worker so both run identical logic. These act on the
// whole window (not the page DOM) and need no content-script injection, which is
// why the SW can run them even when the side panel is closed.

export const TAB_TOOLS = new Set([
  "list_tabs",
  "open_tab",
  "close_tab",
  "switch_tab",
  "navigate",
  "reload_tab",
  "go_back",
  "go_forward",
]);

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Poll until a tab reports status "complete" so navigate/open_tab/reload can hand
// back a loaded page the next tool can read. Resolves false on timeout or if the
// tab vanishes (closed mid-load). Capped well under the mcp-server's 30s call
// timeout.
export async function waitForTabComplete(tabId: number, timeoutMs = 12000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false; // tab was closed
    }
    if (tab.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Run one tab/navigation tool. Most default to the active tab; open_tab and
// switch_tab change which tab is active, so the page + capture tools follow.
export async function runTabTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const wait = args.waitForLoad !== false; // default: wait for the load to settle
  const brief = (t: chrome.tabs.Tab) => ({
    id: t.id,
    url: t.url || t.pendingUrl,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    status: t.status,
    index: t.index,
  });
  // Latest snapshot of a tab after an action (it may have navigated/closed).
  const fresh = async (id: number, fallback?: chrome.tabs.Tab) => {
    try {
      return brief(await chrome.tabs.get(id));
    } catch {
      return fallback ? brief(fallback) : { id };
    }
  };
  // Resolve the tool's target: an explicit tabId, else the active tab.
  const targetId = async (): Promise<number> => {
    const id = num(args.tabId);
    if (id != null) return id;
    const t = await activeTab();
    if (t?.id == null) throw new Error("no active tab");
    return t.id;
  };

  if (tool === "list_tabs") {
    const tabs = await chrome.tabs.query(args.allWindows === true ? {} : { currentWindow: true });
    return { count: tabs.length, tabs: tabs.map(brief) };
  }

  if (tool === "open_tab") {
    const url = str(args.url);
    const active = args.active !== false; // default: focus the new tab
    const tab = await chrome.tabs.create({ url: url || undefined, active });
    if (url && wait && tab.id != null) await waitForTabComplete(tab.id);
    return { ok: true, tab: tab.id != null ? await fresh(tab.id, tab) : brief(tab) };
  }

  if (tool === "close_tab") {
    const id = num(args.tabId) ?? (await activeTab())?.id;
    if (id == null) throw new Error("no tab to close");
    await chrome.tabs.remove(id);
    return { ok: true, closed: id };
  }

  if (tool === "switch_tab") {
    const id = num(args.tabId);
    if (id == null) throw new Error("tabId required (get it from list_tabs)");
    const tab = await chrome.tabs.update(id, { active: true });
    // Bring the tab's window forward too, so it's actually the one on screen.
    if (tab?.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* window may not be focusable */
      }
    }
    return { ok: true, tab: await fresh(id, tab ?? undefined) };
  }

  if (tool === "navigate") {
    const url = str(args.url);
    if (!url) throw new Error("url required");
    const id = await targetId();
    const tab = await chrome.tabs.update(id, { url });
    if (wait) await waitForTabComplete(id);
    return { ok: true, tab: await fresh(id, tab ?? undefined) };
  }

  if (tool === "reload_tab") {
    const id = await targetId();
    await chrome.tabs.reload(id, { bypassCache: args.bypassCache === true });
    if (wait) await waitForTabComplete(id);
    return { ok: true, tab: await fresh(id) };
  }

  if (tool === "go_back" || tool === "go_forward") {
    const id = await targetId();
    try {
      if (tool === "go_back") await chrome.tabs.goBack(id);
      else await chrome.tabs.goForward(id);
    } catch (e) {
      // No entry in that direction — report it rather than throwing.
      return { ok: false, error: `${(e instanceof Error ? e.message : String(e)) || "no history entry"}` };
    }
    if (wait) await waitForTabComplete(id);
    return { ok: true, tab: await fresh(id) };
  }

  return { error: "unknown tab tool: " + tool };
}
