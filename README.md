# Nexlify FB Assistant

Personal Chrome **side-panel** assistant (React + Shopify Polaris) backed by your
**local** `claude` / `chatgpt` CLI. It can:

- draft a Featurebase support reply for the open ticket, then **refine it in a
  back-and-forth chat** ("make it shorter", "the customer is on Pro", …) — the
  assistant keeps the conversation context;
- show a **pinned merchant card** at the top of the panel: the shop's plan +
  status, how long they've used the app, option-set / design-template / order
  counts, credit balance, and renewal date — auto-loaded from the shop on the
  open ticket (see **Merchant summary** below);
- read the tab you're looking at — **Claude itself calls DOM tools**
  (`get_page`, `query_dom`) to read the conversation while it reasons (agentic).

No API keys and no daemon: Chrome launches the native host on demand and it dies
when the panel closes.

## Architecture

```
Side panel (React/Polaris)
  ├─ chrome.runtime.connectNative ─────────────► host.js  (spawned on demand)
  │                                                 │
  │   chat: {id,cli,prompt,tools}  →  streams text  │ spawn: claude -p --output-format stream-json …
  │                                                 │   (or codex exec …)
  │                                                 │
  │   ◄── tool_request {get_page|query_dom} ────────┤  unix socket
  │   ──► tool_result (DOM data) ───────────────────┤     ▲
  │        (runs chrome.scripting.executeScript)    │     │ JSONL
  └─                                                 └─ mcp-server.js  (spawned by claude)
                                                          exposes get_page / query_dom as MCP tools
```

When "Let Claude read the page" is on, `host.js` starts Claude with an MCP server
(`mcp-server.js`) whose tools tunnel — over a unix socket — back through the
host to the extension, which runs them against the live DOM. Everything is a
child of the on-demand host; nothing persists.

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
For live development use `npm run dev` instead of the build.

## Usage

- Open the ticket in the tab, then hit **Draft reply** (or ⌘/Ctrl+Enter). The
  optional text box is extra guidance for the first turn (tone, facts).
- Then just keep typing to refine — it's a chat; the assistant remembers the
  thread. **＋** starts a new chat (and picks up any changed settings). **Stop**
  interrupts the current reply but keeps the conversation.
- Toggle **Let Claude read the page** (settings) to allow the DOM tools; the
  status pill shows `→ get_page` when Claude is reading the ticket.
- The **merchant card** auto-loads on open / New chat; hit ↻ to re-detect after
  switching tickets. Compact tiles = option sets · designs · orders · shops;
  **click the card** to expand full details (contact + copy email, plan / $ /
  MRR / activated / renewal, usage, credits, shop status = installed-or-not).

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

- CLI flags: `native-host/host.js` → `claudeArgs()` / `CLIS`.
- DOM tools: add/adjust in `native-host/mcp-server.js` (schema) and
  `src/sidepanel/bridge.ts` → `domTool` (the code that runs in the page).
- Tools are read-only by design. Adding write actions (click, type into the
  reply box) is possible but intentionally omitted — that's the auto-reply path.

## Troubleshooting

- **"native host not reachable"** → re-run `install.sh` and fully restart Chrome.
- **Tool call "timed out"** → the side panel must be open (it executes the DOM
  tools); keep it open while Claude works.
- **CLI spawns but errors** → PATH issue; re-run `install.sh` from the shell that
  can run `claude`/`codex`.
