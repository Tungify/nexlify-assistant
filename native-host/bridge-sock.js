"use strict";

// Well-known unix socket where host.js exposes the browser-tool bridge to
// EXTERNAL clients — e.g. a `claude` (Claude Code) CLI you run in your own
// terminal, so it can drive the browser through this extension's tools too.
//
// host.js listens here IN ADDITION to its private per-pid socket (which stays
// reserved for the CLI the host itself spawns). A standalone mcp-server.js
// connects here whenever FB_BRIDGE_SOCK isn't set. Kept in one place so the two
// processes can never disagree on the path. Override with NEXLIFY_BRIDGE_SOCK.

const os = require("os");
const path = require("path");

module.exports =
  process.env.NEXLIFY_BRIDGE_SOCK || path.join(os.homedir(), ".nexlify-assistant", "bridge.sock");
