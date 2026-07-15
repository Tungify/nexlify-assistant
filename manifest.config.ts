import { defineManifest } from "@crxjs/vite-plugin";

const icons = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

export default defineManifest({
  manifest_version: 3,
  name: "Nexlify Assistant",
  version: "0.2.0",
  description:
    "Personal side-panel assistant: a local Claude CLI that can read & control the page, debug its console/network, and read a local repo.",
  icons,
  action: { default_title: "Open Assistant", default_icon: icons },
  // "debugger" powers the console/network capture (CDP), gated behind the
  // "Capture console & network" setting (off by default) since attaching shows
  // Chrome's "being debugged" banner. "storage" persists conversation history.
  permissions: ["sidePanel", "nativeMessaging", "scripting", "tabs", "debugger", "storage"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "src/background.ts", type: "module" },
  side_panel: { default_path: "src/sidepanel/index.html" },
});
