# Nexlify Assistant

Personal Chrome **side-panel** assistant (React + Tailwind) backed by your
**local** `claude` CLI. It's a general-purpose, agentic helper for whatever page
you're on — it can:

- **read and drive the current tab** — Claude calls browser tools itself
  (`get_page` / `query_dom` to read; `click` / `type_text` / `press_key` /
  `scroll_to` / `wait_for` to act), e.g. translate something on the page and type
  it into a field;
- **run JavaScript in the tab** (`run_js`) — a DevTools console for the
  assistant, for whatever the fixed tools can't express: bulk-extract a table in
  one call, read the site's own globals, poke localStorage, `fetch()` a
  same-origin API with your cookies. See **[run_js](#run_js-javascript-in-the-page)**;
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

No API keys and no daemon: Chrome launches the native host on demand, and it dies
with the Chrome context that spawned it.

The browser tools are also usable from **your own terminal** — and for that the
side panel doesn't have to be open at all: the extension's background service
worker runs every tool. See
*[Drive the browser from your own terminal](#drive-the-browser-from-your-own-terminal-external-mcp)*.

## Architecture

```
Side panel (React/Tailwind)                     — chat UI + its own CLI session
  ├─ chrome.runtime.connectNative ─────────────────► host.js  (spawned on demand)
  │                                                     │
  │   chat: {id,prompt,page,capture,repo}  → streams    │ spawn: claude -p --output-format stream-json …
  │                                                     │
  │   ◄── tool_request {get_page|click|type_text|…} ────┤  private per-pid socket
  │   ──► tool_result ──────────────────────────────────┤     ▲
  │        (pageTools + tabTools; debug tools           │     │ JSONL
  │         delegated to the worker)                    │     │
  └─                                                     └─ mcp-server.js  (spawned by claude)
                                                              exposes the enabled tools (FB_TOOLS)

Background service worker                       — always on; needs no panel
  ├─ chrome.runtime.connectNative ─────────────────► host.js
  │                                                     │
  │   ◄── tool_request  (ALL 20 tools) ────────────────┤  ~/.nexlify-assistant/bridge.sock
  │   ──► tool_result ──────────────────────────────────┤     ▲   (public)
  │        pageTools + tabTools + capture (CDP)         │     │ JSONL
  └─                                                     └─ mcp-server.js  (spawned by YOUR claude)
```

When **Read & control page** is on, `host.js` starts Claude with an MCP server
(`mcp-server.js`) whose tools tunnel — over a unix socket — back through the host
to the extension, which runs them against the live DOM (reads *and* writes).
**Capture console & network** additionally attaches Chrome's debugger (CDP) to
the tab and buffers console + network events for the debug tools. A **Local repo
path** launches Claude with its cwd there and read-only `Read`/`Grep`/`Glob`
allowed. The host advertises only the tool groups you enabled (via `FB_TOOLS`).
Everything is a child of the on-demand host; nothing persists.

The **background service worker** keeps its own native-host connection (kept alive
by a host heartbeat + a `chrome.alarms` tick) and can run **every** browser tool
itself — page, tabs, screenshot and the console/network capture. So the whole
toolset is reachable by external CLIs over the public bridge socket **with the
panel closed**; the panel is UI, not a dependency. See *Drive the browser from
your own terminal* below.

The tool implementations therefore live outside the panel, in modules both sides
import: `src/pageTools.ts` (DOM read/control + screenshot), `src/tabTools.ts`
(`chrome.tabs.*`) and `src/capture.ts` (CDP buffer). Capture is the one group the
panel does *not* run itself — a tab allows a single debugger client, so the worker
owns it and the panel asks the worker to read the buffer.

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
the **`debugger`** (console/network capture), **`storage`** (conversation
history) and **`userScripts`** (`run_js` in the page's own world) permissions —
after building, hit **Reload** on the extension in `chrome://extensions` so
Chrome grants them, and while you're there open **Details** and switch on
**Allow user scripts** (that's the one-time opt-in `run_js` wants — see
*[run_js](#run_js--javascript-in-the-page)*). Edits to `host.js` /
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
    `click`, `type_text`, `press_key`, `scroll_to`, `wait_for`) **and `run_js`**.
    The status pill shows `→ click` etc. while Claude acts. Write actions run
    **automatically** (no confirmation), so watch it on live tickets.
  - **Capture console & network** — attaches Chrome's debugger to the active tab
    (you'll see a yellow "being debugged" banner) and buffers console + network
    so Claude can debug why something didn't fire. Off by default.
  - **Local repo path** — an absolute path; when set Claude may read & grep
    files there (no file edits) to cross-reference code.
  - **Run shell commands (ask each time)** — on by default. Claude may use
    `Bash` (e.g. to run a skill's scripts, like `customei-admin`), but **every**
    command, read-only ones included, first shows a *Run this shell command?*
    popup with the exact command; Deny and it isn't run. Applies to a new chat.
- On a **Featurebase** ticket a **merchant card** appears (auto-detected from the
  `*.myshopify.com` on the page); hit **Draft reply** on it to draft a support
  reply into the chat, or ↻ to re-detect. Compact tiles = option sets · designs ·
  orders · shops; **click the card** to expand full details (contact + copy
  email, plan / $ / MRR / activated / renewal, usage, credits, shop status).
  On ordinary pages the card stays hidden.

## `run_js` — JavaScript in the page

The escape hatch: whatever the fixed tools can't express, the assistant writes as
code. It's the DevTools console, called by the model — bulk-extract a table in one
call instead of ten `query_dom`s, read the site's own globals
(`window.__NEXT_DATA__`, `window.Shopify`, a Redux store), read/write
`localStorage`, `fetch()` a same-origin API with your cookies, compute styles,
drive a widget a plain click can't.

- **Semantics** — the code runs as a function body: `return` the value you want
  (a bare one-line expression is returned for you), top-level `await` is allowed.
  `console.*` output during the run comes back in `logs`; a throw comes back as
  `{ ok: false, error, stack }` with stack lines mapped onto *your* snippet.
- **Results are serialized** — DOM elements become `{ el, id, class, text, href }`,
  `Error`/`Map`/`Set`/`Date` get readable stand-ins, and depth/size caps
  (`maxChars`, `maxItems`, `maxDepth`, `maxTotalChars`) keep a stray `document`
  from flooding the context. `timeoutMs` (default 8s, cap 25s) bounds async code.
- **Which JS world** — `world: "main"` (default) is the page's own context, so the
  site's globals and libraries are visible. `world: "isolated"` runs in the
  extension's world: the DOM, cookies, storage and `fetch` are still the page's,
  but the site's `window` globals are not.
- **Engines** (`engine` in the reply says which ran) — first choice is Chrome's
  **userScripts** API: the code is *injected*, never `eval`'d, so a strict page CSP
  can't block it. That API needs a one-time opt-in: open `chrome://extensions` →
  **Nexlify Assistant** → **Details** → turn on **Allow user scripts**. Without it
  we fall back to `chrome.scripting` + `new Function`, which pages whose CSP omits
  `'unsafe-eval'` refuse — then the call degrades to the isolated world and says so
  in `note`. **Turn the toggle on** and the page world always works.
- **Gating** — it rides the **Read & control page** setting for the in-panel chat
  (external CLIs get the full toolset either way). It is as powerful as your own
  console on a logged-in tab: it can read anything the page can and act as you.
  Turn that setting off for a session where you don't want that.

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

## "Claude" tab in the Featurebase inbox

On a Featurebase conversation (`https://*.featurebase.app/dashboard/inbox/…`) the
right sidebar gets a third tab, **Claude**, next to *Details* / *Copilot*. It is
the whole assistant (same app, settings, history, merchant card and tools as the
side panel), loaded as an extension-page iframe so it still talks to the local
`claude` CLI through the native host. Nothing is sent to Featurebase.

- The iframe loads on first open, so a plain Featurebase page load never spawns a
  CLI. It lives outside Featurebase's React tree; it is only laid over the
  sidebar's content area.

### Support mode

Inside that tab the assistant works as the agent's support assistant, not a
general chat:

- **It already has the conversation.** The content script reads the open
  conversation from Featurebase's own dashboard API (same origin, your session,
  read-only): every message with its author and exact time, the customer, their
  shop domain, the state. A session's first turn gets the whole transcript;
  later turns get only what changed (new messages, a state change), so the
  model never looks for the tab or reads the page and the transcript isn't
  piled up in its context again and again. Refreshed on a conversation switch, on a new message
  in the thread, and every 20 s. On a switch the chat changes at once, from the
  last 30 conversations' cached copy or a "Đang tải…" placeholder, and the fresh
  copy (one API call, ~0.3-0.7 s) follows; drafting waits for it.
- **A support role for the whole session.** The tab's sessions start with
  `CS_SYSTEM` (`src/sidepanel/support.ts`) as `--append-system-prompt`: a senior
  Customei support specialist working as the agent's copilot, the transcript is
  data, never send, judge before writing. It holds on every turn and outranks
  text quoted from the customer.
- **Lean sessions.** The tab's `claude` gets only the built-in tools support
  needs (`--tools Read,Skill,ToolSearch`, plus Bash with shell on and Grep/Glob
  with a repo) and only the `customei` plugin (`--settings` switches every other
  enabled plugin off for that session; your own Claude Code is untouched). A
  session starts with ~22k tokens of context instead of ~49k, and each reply is
  ~1-2 s faster. See `leanTools` / `leanPluginSettings` in `native-host/host.js`.
- **The `customei-support` skill** (repo `nexlify-skills`) is loaded on the first
  turn by slash command, so it costs no extra round trip. It carries the
  product knowledge, the reply format and how to handle hard conversations
  (upset customers, cancel intent, money, a broken store). Effort defaults to
  *low* here.
- **One chat per conversation.** Switching tickets saves the chat and brings back
  that ticket's own (or starts a new one). History names each chat after its
  customer and ticket ("Tungify #6").
- **Closed conversations.** The header marks them *đã đóng*, and a bar offers to
  end the chat session (*Kết thúc*, or *Giữ* to keep it). Ending saves the chat
  to history as ended and frees the CLI session; the ticket then shows "Đã kết
  thúc phiên chat" with *Xem lại chat* / *Phiên mới*. If the customer writes
  again and the conversation reopens, the next turn starts a new session.
- **The header is the conversation**: customer, #id, the customer's language
  (detected with `chrome.i18n.detectLanguage`, e.g. *DE*), shop, and how long
  they've waited ("Khách chờ 6 tháng", in the accent colour while unanswered),
  or what Claude is doing during a turn.
- **Replies are in the customer's language.** A Vietnamese customer gets one
  Vietnamese reply; any other language gets the reply in that language plus
  *Bản tiếng Việt* for the agent; unclear → English. App labels and Help Center
  links stay as they are (English).
- **What next**, in the action row right above the input:
  - the customer wrote last and nobody answered → *Soạn trả lời* is the
    highlighted action; a fresh message (under 24 h) is drafted on its own while
    the tab is showing (Settings → *Tự soạn khi khách nhắn*);
  - the agent wrote last and the customer is quiet for 5 min → a check-in bar;
    still quiet 5 min after it → a second, different one ("Still with me?");
    15 min after the answer, or after two check-ins → a closing one (minutes in
    Settings). A check-in or closing already sent is recognised (our templates,
    or a short message that reads like one), so the same line is never
    suggested twice. Ready-made text in English or Vietnamese (hover for the
    agent's copy); for other languages *Viết bằng tiếng …* writes one, with
    the English text as a fallback. *Viết theo ngữ cảnh* writes one from the
    conversation.
  - *Nên hỏi gì?* opens a picker of what support usually needs (product link
    and store password, screenshot or recording, order number, theme, device and
    browser, reference code; the store link only when Featurebase doesn't have
    it). Ticking items builds the message at once in English or Vietnamese, no
    model call (other languages: *Viết bằng tiếng …*); *Để Claude chọn* asks the
    model to pick from the conversation instead.
  - *Báo đang kiểm tra* while the customer waits: puts an instant "thanks, I'm
    looking into this now" into the reply box (English, Vietnamese, German,
    French, Spanish, Italian, Dutch, Portuguese; other languages are written by
    the model). After it the customer still counts as waiting, so *Soạn trả lời*
    stays the main action and no check-in is suggested.
  - *Chốt & tóm tắt* once there's been an exchange: asks if they need anything
    else and sums up what was done and what happens next (the Shopify Support
    close). A wrap-up or closing message ends the follow-up nudges. Follow-ups
    drafted by these buttons are remembered, so a sent one is recognised in any
    language (a German wrap-up doesn't trigger a check-in).
  - also *Hỏi thăm* (when we're the ones waiting), and once there is a draft
    *Ngắn hơn* / *Mềm hơn*.
- **The reply.** *Phân tích* folded to one line, the reply in the one framed
  block, tagged with its language (*Đưa vào ô Reply*, Copy), *Bản tiếng Việt*
  when the reply isn't Vietnamese (folds; the choice is remembered), and the
  sources as links. *Đưa vào ô Reply*
  pastes it into Featurebase's composer with formatting (bold, lists, links); it
  replaces its own earlier insert but keeps anything you typed. It never presses
  Send. Once an agent message in the conversation carries the draft (80% of its
  words, 90% for short ones, so small edits still count), the card turns grey,
  says *Đã gửi*, and drops the insert button.
- Every link opens in a new tab (a link followed inside the iframe would replace
  the chat with no way back).
- Clicking *Details* / *Copilot* hands the sidebar back. The open/closed choice is
  remembered for the browser tab (sessionStorage).
- **Esc** inside the chat stops a running turn (keys typed in the iframe don't
  reach the driving overlay's own Esc handler).
- After rebuilding: reload the extension, then reload the Featurebase tab
  (content scripts only reach pages loaded after the reload).

Code: `src/content/featurebaseTab.ts` (tab, iframe, conversation feed, composer
insert; + `web_accessible_resources` in the manifest, limited to
`*.featurebase.app`), `src/sidepanel/support.ts` (prompt block, next-step logic,
reply parsing), `src/sidepanel/SupportUI.tsx` (header line, nudge, reply, action row),
`src/sidepanel/Md.tsx` (markdown, links in a new tab).

With *Team MCP tools* on, the host hides any server in your claude config that
points at this repo's `mcp-server.js` (e.g. `nexlify-browser`): it duplicates the
panel's own browser tools, isn't on the auto-run list, and may be bound to
another Chrome profile.

## Merchant summary

The card is shown on demand: a shop button (store icon) in the header appears
when a shop is detected, and the lookup only runs while the card is open. It calls
**pod-shopify-backend**'s admin GraphQL (`POST /api/admin/graphql`). It scrapes the shop's `*.myshopify.com` domain off
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
can't be recovered — mint a new one. Without a URL + key the button doesn't
show; the chat still works. **"admin authentication required"** means the
backend rejected the key: it isn't an is_admin key, or it was minted for another
environment than the URL (an api-dev key against api.customei.com).

## Drive the browser from your own terminal (external MCP)

The same browser tools can be used from a **`claude` (Claude Code) CLI you run
yourself** — not just the side-panel chat. `host.js` also listens on a well-known
socket (`~/.nexlify-assistant/bridge.sock`), and `mcp-server.js` connects there
by default, so any local CLI can tunnel tool calls through the running extension.

**Requirement: just Chrome running** with the extension loaded. The **side panel
does not need to be open** — the background service worker executes the full
toolset (page reads/clicks, screenshots, tab control, console/network capture).
See *Working with the panel closed* below.

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

Then in that CLI you'll have all 20 tools (`get_page`, `click`, `list_tabs`,
`open_tab`, `navigate`, `get_console_logs`, …). Notes:

- The external CLI gets the **full toolset** regardless of the panel's
  page/tabs/capture checkboxes (those only gate the *in-panel* chat). Tools act
  on the **active tab** of the **last-focused window**.
- Whichever host is alive **owns the public socket** (ownership is decided by a
  live probe, re-checked every ~10s), so it doesn't matter whether the worker's
  host or a panel's host answers your terminal — both run the same tools.
- **No "AI is driving" overlay** on this path: the golden aura + input blocker
  advertise *Esc to take over*, and there's no turn to interrupt in an external
  CLI. Actions land silently instead of promising something we can't do.
- **Security:** any local process that can read that socket can drive your
  browser. The socket lives under your home dir (`0700`); fine for a personal
  machine. Override the path with `NEXLIFY_BRIDGE_SOCK` if you want.

### Working with the panel closed (background worker)

The background **service worker** holds its own native-host connection and runs
**every** browser tool, so all 20 work from an external CLI with **no side panel
open** — page reads/clicks (`chrome.scripting`), screenshots
(`captureVisibleTab`), tab control (`chrome.tabs.*`) and the console/network
capture (`chrome.debugger`).

How it holds up under MV3 (which idle-suspends workers after ~30s):

- **Heartbeat** — `host.js` pings the worker every 20s; each inbound message
  resets the suspend timer, keeping the worker (and its host, the public socket
  and the capture buffer) alive while Chrome is running.
- **Recovery** — a `chrome.alarms` tick (~every 30s) reconnects the worker if
  Chrome recycles it anyway. Whichever host is still alive reclaims the public
  socket within ~10s of the previous owner dying (verified: kill the owner, a
  second host takes over and external clients reconnect). A recycled worker also
  loses the buffered console/network history and its record of the debugger
  attachment — the next debug-tool call detaches that orphan and re-attaches, so
  it recovers with an empty buffer instead of erroring.
- **The gap** — if the worker is suspended, there's a short window (up to the
  alarm period) where external calls return "bridge not connected" until the
  worker wakes. Chrome itself must be running.

**Capture lifetime:** the debugger attaches on the first `get_console_logs` /
`get_network_requests` call and then follows the active tab. It is *not* detached
when the panel closes (an external CLI may still be mid-debug). To stop it: turn
off **Allow console & network capture** in the panel, or click **Cancel** on
Chrome's "being debugged" banner.

## Knobs

- CLI flags & tool gating: `native-host/host.js` → `PROVIDERS.claude.buildArgs`
  and the `PAGE_TOOLS` / `TAB_TOOLS` / `DEBUG_TOOLS` / `REPO_TOOLS` groups.
- Browser tools: add/adjust the schema in `native-host/mcp-server.js`; in-page
  tools go in `src/pageTools.ts` → `domTool` (and its `PAGE_TOOLS` set) — except
  `run_js`, which needs its own worlds/engines and lives in `runJs`/`nxRunner` in
  the same file — tab/navigation tools in `src/tabTools.ts` → `runTabTool`. Then list the new name
  in the right group in `host.js` so it's advertised + allowed. Both the side
  panel and the background worker import these, so one edit covers both.
- Console/network capture (Chrome DevTools Protocol) lives in `src/capture.ts`,
  instantiated once in `src/background.ts`.
- Write actions run **without confirmation** (agentic, by design). `Edit` /
  `Write` stay disabled in `host.js` (`NO_WRITE_TOOLS`). `Bash` is disabled too
  unless *Run shell commands* is on; then `host.js` routes every command through
  the approval popup: `--permission-prompt-tool` → `permission_request`, plus
  `--permission-mode default` (the user's own default may be `auto`, which
  approves tools itself and never asks) and a `PreToolUse` hook answering `ask`
  for Bash (otherwise Claude Code auto-runs commands it deems read-only). The
  popup waits up to 10 minutes for an answer.

## Troubleshooting

- **"native host not reachable" / "Native host has exited"** (and the merchant
  card says "timed out") → the host can't start. Usual cause: `host.sh` pointed
  at a node that nvm since removed. `host.sh` now falls back to any `node` on
  PATH / the newest nvm one; if it still fails, re-run `install.sh` and reload
  the extension. Fully restart Chrome only when the manifest path changed.
- **Tool call "timed out"** → the target tab is stuck loading, or it's a page no
  extension may touch (`chrome://`, the Web Store, other extensions' pages) —
  switch to a normal `http(s)` tab. The side panel does **not** need to be open.
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
- **External CLI: "bridge not connected"** → Chrome must be running with the
  extension loaded; the background worker owns the socket. Check
  `chrome://extensions` → **service worker** (Inspect) for a `[host] started`
  line, hit **Reload** on the extension, and retry — a suspended worker
  reconnects within ~30s. If it persists, set `NEXLIFY_BRIDGE_SOCK` to a
  dedicated path on both host and CLI.
