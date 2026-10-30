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
  // "alarms" keeps the background service worker's native-host connection alive
  // (and reconnects it) so the browser tools work with the side panel closed.
  // "contextMenus" adds the right-click "Download video" entry on social posts;
  // "notifications" reports download progress/result without needing the panel.
  // "userScripts" is how run_js executes arbitrary JS in the page's OWN world
  // without eval, so a strict page CSP can't block it. It needs a one-time opt-in
  // per extension ("Allow user scripts" on the chrome://extensions details page);
  // until then run_js falls back to chrome.scripting + new Function. Harmless
  // when off — the API namespace simply isn't there.
  permissions: [
    "sidePanel",
    "nativeMessaging",
    "scripting",
    "userScripts",
    "tabs",
    "debugger",
    "storage",
    "alarms",
    "contextMenus",
    "notifications",
  ],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "src/background.ts", type: "module" },
  side_panel: { default_path: "src/sidepanel/index.html" },
  // Passive coordinate tracker so "Download video" can target the exact video the
  // user pointed at (through overlays, in a multi-video feed). See videoPick.ts.
  content_scripts: [
    {
      matches: [
        "*://*.x.com/*",
        "*://*.twitter.com/*",
        "*://*.instagram.com/*",
        "*://*.facebook.com/*",
        "*://*.fb.watch/*",
      ],
      js: ["src/content/videoPick.ts"],
      run_at: "document_start",
      all_frames: true,
    },
    // A "Claude" tab beside Copilot in the Featurebase inbox sidebar that embeds
    // the assistant. Inert on pages without that sidebar. See featurebaseTab.ts.
    {
      matches: ["https://*.featurebase.app/*"],
      js: ["src/content/featurebaseTab.ts"],
      run_at: "document_idle",
    },
  ],
  // Lets that tab load the assistant page in an iframe — Featurebase only.
  web_accessible_resources: [
    {
      resources: ["src/sidepanel/index.html"],
      matches: ["https://*.featurebase.app/*"],
    },
  ],
  // Page-proof trigger: works even when a site overlays the video or hijacks the
  // right-click menu (e.g. Facebook). Rebindable at chrome://extensions/shortcuts.
  commands: {
    "download-video": {
      suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
      description: "Download the video under the cursor (X / Instagram / Facebook)",
    },
  },
});
