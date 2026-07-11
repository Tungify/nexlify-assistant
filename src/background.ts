// Open the side panel when the toolbar icon is clicked. All real work happens
// inside the side panel page (native bridge + DOM tool execution).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));
});
