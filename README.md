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

## Knobs

- CLI flags & tool gating: `native-host/host.js` → `PROVIDERS.claude.buildArgs`
  and the `PAGE_TOOLS` / `DEBUG_TOOLS` / `REPO_TOOLS` groups.
- Browser tools: add/adjust the schema in `native-host/mcp-server.js` and the
  page-side code in `src/sidepanel/bridge.ts` → `domTool`; then list the new
  name in the right group in `host.js` so it's advertised + allowed.
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
