import { defineManifest } from "@crxjs/vite-plugin";

const icons = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

export default defineManifest({
  manifest_version: 3,
  name: "Nexlify FB Assistant",
  version: "0.2.0",
  description:
    "Personal side-panel assistant: a local Claude/ChatGPT CLI that can read the page DOM to translate, research, and draft replies.",
  icons,
  action: { default_title: "Open Assistant", default_icon: icons },
  permissions: ["sidePanel", "nativeMessaging", "scripting", "tabs"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "src/background.ts", type: "module" },
  side_panel: { default_path: "src/sidepanel/index.html" },
});
