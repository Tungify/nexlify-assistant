# Nexlify Assistant

Personal Chrome **side-panel** assistant (React + Tailwind) backed by your
**local** `claude` CLI. It's a general-purpose, agentic helper for whatever page
you're on — it can:

- **read and drive the current tab** — Claude calls browser tools itself
  (`get_page` / `query_dom` to read; `click` / `type_text` / `press_key` /
  `scroll_to` / `wait_for` to act), e.g. translate something on the page and type
  it into a field;
- **debug the page** — with capture on it collects console output and network
  requests (`get_console_logs`, `get_network_requests`, `get_network_request`)
  so it can tell you why an event/request didn't fire;
- **read a local repo** you point it at (`Read` / `Grep` / `Glob`, read-only) to
  cross-reference the code behind a bug;
- **keep a conversation history** — every chat is saved locally; reopen one from
  the ⏱ menu and keep going (the transcript is replayed as context).

It's **context-aware**: open a **Featurebase** ticket and it surfaces a pinned
**merchant card** (the shop's plan/status, usage counts, credit balance, renewal
— see **Merchant summary**) plus a one-tap **Draft reply**; on any other page the
card stays hidden and it's just a clean chat. Everything Claude produces stays
**in the chat** (copy/paste) — it never submits anything to Featurebase.

No API keys and no daemon: Chrome launches the native host on demand and it dies
when the panel closes.

## Architecture

```
Side panel (React/Tailwind)
  ├─ chrome.runtime.connectNative ─────────────────► host.js  (spawned on demand)
  │                                                     │
  │   chat: {id,prompt,page,capture,repo}  → streams    │ spawn: claude -p --output-format stream-json …
  │                                                     │
  │   ◄── tool_request {get_page|click|type_text|…} ────┤  unix socket
  │   ──► tool_result ──────────────────────────────────┤     ▲
  │        (chrome.scripting for page tools;            │     │ JSONL
  │         CDP capture buffer for debug tools)         │     │
  └─                                                     └─ mcp-server.js  (spawned by claude)
                                                              exposes the enabled tools (FB_TOOLS)
```

When **Read & control page** is on, `host.js` starts Claude with an MCP server
(`mcp-server.js`) whose tools tunnel — over a unix socket — back through the host
to the extension, which runs them against the live DOM (reads *and* writes).
**Capture console & network** additionally attaches Chrome's debugger (CDP) to
the tab and buffers console + network events for the debug tools. A **Local repo
path** launches Claude with its cwd there and read-only `Read`/`Grep`/`Glob`
allowed. The host advertises only the tool groups you enabled (via `FB_TOOLS`).
Everything is a child of the on-demand host; nothing persists.

The **background service worker** also keeps a native-host connection (kept alive
by a host heartbeat + a `chrome.alarms` tick) and runs the tab/navigation tools,
so those work with the panel closed and are reachable by external CLIs over the
public bridge socket — see *Drive the browser from your own terminal* below.

## Prerequisites

- Node (this repo was set up with v22 via nvm) and the `claude` CLI on `PATH`.
- Optional: a `chatgpt`/`codex` CLI for the ChatGPT option (edit `CLIS.chatgpt`
  in `native-host/host.js` to match its flags).

## Setup (macOS, Chrome)

```sh
npm install
npm run build          # outputs dist/
```

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the
   **`dist/`** folder. Copy the **Extension ID**.
2. Register the native host (run from a shell where `node` + `claude` are on PATH):
   ```sh
   ./install.sh <extension-id>
   ```
3. **Fully quit and reopen Chrome.**
4. Click the toolbar icon → the side panel opens.

Re-run `npm run build` after code changes (the unpacked ID stays the same as
long as `dist/` keeps its path, so you don't need to re-run `install.sh`).
For live development use `npm run dev` instead of the build. This version adds
the **`debugger`** (console/network capture) and **`storage`** (conversation
history) permissions — after building, hit **Reload** on the extension in
`chrome://extensions` so Chrome grants them. Edits to `host.js` /
`mcp-server.js` take effect on the next panel open (they run from the repo, not
`dist/`), no reinstall needed.

## Usage

- **Type any task** and hit ⌘/Ctrl+Enter (or the ▲ button) — "translate this page
  into English", "why didn't the save button fire?", "read `foo.ts` and explain
  X", etc. It's a chat: keep typing to refine; the assistant remembers the thread.
  **＋** saves the current chat to history and starts a fresh one; **Stop**
  interrupts the current reply but keeps the conversation.
- **History (⏱)** lists saved conversations; reopen one to view it and keep
  chatting (the transcript is replayed as context into a fresh session). Delete
  individually or **Clear all**.
- **Settings** (⚙) gate what Claude may do; they apply to the next chat:
  - **Read & control page** — the browser tools (`get_page`, `query_dom`,
    `click`, `type_text`, `press_key`, `scroll_to`, `wait_for`). The status pill
    shows `→ click` etc. while Claude acts. Write actions run **automatically**
    (no confirmation), so watch it on live tickets.
  - **Capture console & network** — attaches Chrome's debugger to the active tab
    (you'll see a yellow "being debugged" banner) and buffers console + network
    so Claude can debug why something didn't fire. Off by default.
  - **Local repo path** — an absolute path; when set Claude may read & grep
    files there (no writes, no shell) to cross-reference code.
- On a **Featurebase** ticket a **merchant card** appears (auto-detected from the
  `*.myshopify.com` on the page); hit **Draft reply** on it to draft a support
  reply into the chat, or ↻ to re-detect. Compact tiles = option sets · designs ·
  orders · shops; **click the card** to expand full details (contact + copy
  email, plan / $ / MRR / activated / renewal, usage, credits, shop status).
  On ordinary pages the card stays hidden.

## Download video (right-click on X / Instagram / Facebook)

Right-click on an **X**, **Instagram**, or **Facebook** post → **Nexlify Assistant
→ Download video (best quality)**. The menu lives in the background service
worker, so it works whether or not the side panel is open. Files land in
`~/Downloads` (override with `NEXLIFY_DOWNLOAD_DIR` on the host).

Two engines, picked automatically:

- **yt-dlp (if installed)** — the host hands yt-dlp the post's permalink; it
  selects the best video+audio, merges to mp4 (needs **ffmpeg**), and uses your
  logged-in **Chrome cookies** (`--cookies-from-browser chrome`, so it can grab
  content that needs login). This is the robust path and the only one that
  guarantees "best quality" on DASH/HLS posts (most Facebook HD).

  ```sh
  brew install yt-dlp ffmpeg
  ```

  (yt-dlp updates often as sites change — `yt-dlp -U` when a site breaks. Reading
  the Chrome cookie store may trigger a one-time macOS keychain prompt.)

- **No install (fallback)** — if yt-dlp isn't found, the extension scrapes the
  post for a **direct MP4 URL** (the `<video>`'s real source, `<source>` tags,
  or the `og:video` meta) and the host fetches it. This covers most **Instagram**
  and **X** videos (they're progressive MP4). A **DASH/HLS-only** post (segmented
  — common for Facebook HD) can't be merged without yt-dlp, so the notification
  says so and points you at the install command.

**Two triggers:**

- **Right-click** a video (or its thumbnail/link) → the menu. It appears on
  `video`/`image`/`link` — **not** empty space or plain text.
- **Keyboard shortcut** `Ctrl/Cmd+Shift+Y` → downloads the video **under the
  cursor**. This is page-proof: it works even when a site overlays the `<video>`
  or hijacks the right-click menu (Facebook does this). Rebind at
  `chrome://extensions/shortcuts`.

**Which video?** A tiny content script (on x/instagram/facebook) records where you
right-clicked / where the cursor is, and the extractor uses
`document.elementsFromPoint` to grab the exact video **at that spot** — so it picks
the right one in a multi-video **feed** and sees the `<video>` **through an overlay
div**. If it can't tell (no pointer info), it falls back to the playing / largest
video. Progress and result show as a **notification** (no panel needed).

> The coordinate tracker only runs on tabs opened/navigated **after** you reload
> the extension — reload an already-open X/IG/FB tab once so it takes effect.

> Only download content you have the right to. This targets ordinary, non-DRM
> posts (it's yt-dlp-style); it does not defeat DRM (paid films/courses, etc.).

## Merchant summary

The pinned card calls **pod-shopify-backend**'s admin GraphQL
(`POST /api/admin/graphql`). It scrapes the shop's `*.myshopify.com` domain off
the open ticket (the app signs it into the Featurebase identity as the company
`website`), resolves `accounts(where:{hasShopsWith:{domain}})` for plan + counts,
then reads the account's current `subscriptions` for the renewal date. (An
account can own several shops but only one carries the subscription — the lookup
is account-scoped, so it finds it regardless of which shop the ticket is about.)

Set the **API URL and access key in Settings** (the ⚙ popover → *Merchant API
URL* / *Admin access key*, stored in the panel via localStorage), and/or in
`native-host/.env.local`. The panel values override the env per request; if a
field is blank the host falls back to `.env.local`:

```
POD_ADMIN_API_URL=https://api-dev.customei.com   # the GO backend, or set it in Settings
POD_ADMIN_ACCESS_KEY=customei_ak_xxxxxxxx         # or set it in Settings
# POD_ADMIN_ACCESS_KEY_HEADER=X-Access-Key        # only if the backend overrides it
```

Point the URL at the **Go backend** (`https://api-dev.customei.com`, or `https://
api.customei.com`) — NOT `localhost:3000`, which is the Remix FE. The key must be
an **is_admin** access key. Mint one with the backend's
`scripts/accesskey-seed` (`MCP_TOKEN_PEPPER=… go run ./scripts/accesskey-seed
-name fb-assistant -admin` → prints the plaintext once); the DB stores only
`token_hash = HMAC-SHA256(plaintext, MCP_TOKEN_PEPPER)` + last4, so a lost key
can't be recovered — mint a new one. Without a URL + key the card shows a lookup
error; the chat still works.

## Drive the browser from your own terminal (external MCP)

The same browser tools can be used from a **`claude` (Claude Code) CLI you run
yourself** — not just the side-panel chat. `host.js` also listens on a well-known
socket (`~/.nexlify-assistant/bridge.sock`), and `mcp-server.js` connects there
by default, so any local CLI can tunnel tool calls through the running extension.

**Requirement:** for **page & debug tools** (`get_page`, `click`, screenshot,
console/network) the **side panel must be open** — it's what injects into the
page and owns the CDP capture. **Tab/navigation tools** (`list_tabs`, `open_tab`,
`switch_tab`, `navigate`, `reload_tab`, `go_back`/`go_forward`) also run from the
**background service worker**, so those keep working **with the panel closed**
(Chrome must be running). See *Working with the panel closed* below.

Add it to your CLI (once; `-s user` makes it available in every project):

```sh
claude mcp add -s user nexlify-browser -- \
  node /Users/tungngo/Workspace/Nexlify/fb-assistant/native-host/mcp-server.js
```

…or drop an `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "nexlify-browser": {
      "command": "node",
      "args": ["/Users/tungngo/Workspace/Nexlify/fb-assistant/native-host/mcp-server.js"]
    }
  }
}
```

Then in that CLI you'll have all 19 tools (`get_page`, `click`, `list_tabs`,
`open_tab`, `navigate`, `get_console_logs`, …). Notes:

- The external CLI gets the **full toolset** regardless of the panel's
  page/tabs/capture checkboxes (those only gate the *in-panel* chat). Tools act
  on the **active tab** of the window whose panel owns the socket.
- **Last panel opened wins** the public socket, so with multiple windows the
  most-recently-opened panel is the one your terminal drives.
- **Security:** any local process that can read that socket can drive your
  browser. The socket lives under your home dir (`0700`); fine for a personal
  machine. Override the path with `NEXLIFY_BRIDGE_SOCK` if you want.

### Working with the panel closed (background worker)

The background **service worker** also holds a native-host connection and can run
the **tab/navigation tools** on its own — so `list_tabs` / `open_tab` /
`switch_tab` / `navigate` / `reload_tab` / `go_back` / `go_forward` work from an
external CLI even with **no side panel open**. Page reads/clicks and
console/network capture still need the panel (they inject into the page / attach
the debugger).

How it holds up under MV3 (which idle-suspends workers after ~30s):

- **Heartbeat** — `host.js` pings the worker every 20s; each inbound message
  resets the suspend timer, keeping the worker (and its host + the public socket)
  alive while Chrome is running.
- **Recovery** — a `chrome.alarms` tick (~every 30s) reconnects the worker if
  Chrome recycles it anyway. Whichever host is still alive reclaims the public
  socket within ~10s of the previous owner dying (verified: kill the owner, a
  second host takes over and external clients reconnect).
- **The gap** — if the worker is suspended *and* no panel is open, there's a
  short window (up to the alarm period) where external calls return "bridge not
  connected" until the worker wakes. Chrome itself must be running.

This is a **proof of concept**: only tab tools run in the worker so far. If it's
stable in daily use, the plan is to move the whole bridge (page tools, capture,
chat) into the worker and make the panel optional UI.

## Knobs

- CLI flags & tool gating: `native-host/host.js` → `PROVIDERS.claude.buildArgs`
  and the `PAGE_TOOLS` / `TAB_TOOLS` / `DEBUG_TOOLS` / `REPO_TOOLS` groups.
- Browser tools: add/adjust the schema in `native-host/mcp-server.js`; in-page
  tools go in `src/sidepanel/bridge.ts` → `domTool`, tab/navigation tools in
  `bridge.tabTool` (chrome.tabs.*). Then list the new name in the right group in
  `host.js` so it's advertised + allowed.
- Console/network capture (Chrome DevTools Protocol) lives in
  `src/sidepanel/capture.ts`.
- Write actions run **without confirmation** (agentic, by design). `Bash` /
  `Edit` / `Write` stay disabled in `host.js` (`NO_BUILTIN_TOOLS`), so Claude
  never mutates files or runs a shell — even with a repo path set.

## Troubleshooting

- **"native host not reachable"** → re-run `install.sh` and fully restart Chrome.
- **Tool call "timed out"** → the side panel must be open (it executes the
  browser tools); keep it open while Claude works.
- **Capture says "close DevTools on this tab"** → a tab allows only one debugger
  client; close DevTools (or another debugging extension) on that tab. The
  yellow "being debugged" banner is normal while capture is on; dismissing it
  turns capture off.
- **CLI spawns but errors** → PATH issue; re-run `install.sh` from the shell that
  can run `claude`/`codex`.
- **Download says "install yt-dlp"** → the post is DASH/HLS (segmented) and the
  no-install fallback can't merge it; `brew install yt-dlp ffmpeg`. Note the host
  finds `yt-dlp` on its own PATH — if you use nvm/a custom PATH, set `YT_DLP_BIN`
  to the absolute path (or re-run `install.sh` from a shell that has it).
- **Download context menu missing** → after building, hit **Reload** on the
  extension (it needs the new `contextMenus`/`notifications` permissions), and
  you must be on an x.com / instagram.com / facebook.com page.
- **External CLI: "bridge not connected"** → open the side panel (it runs the
  tools and owns the socket). If it persists, another host took the public
  socket over — reopen the panel in the window you want to drive, or set
  `NEXLIFY_BRIDGE_SOCK` to a dedicated path on both host and CLI.
