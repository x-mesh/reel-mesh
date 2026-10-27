const tabParam = new URLSearchParams(location.search).get("tab");
const tabId = tabParam === null ? null : Number(tabParam);

// Pin contract read by reel-mesh before a recording starts: the tab id this panel is bound to.
window.__reelPinnedTabId = tabId;

const showDock = (value) => {
  document.body.dataset.dock = String(value);
  document.getElementById("dock-value").textContent = String(value);
};

// Only the pinned tab's title is shown; the panel never lists other tabs (RM-12).
if (tabId !== null) {
  const showTitle = (tab) => {
    document.getElementById("tab-title").textContent = tab.title ?? "";
  };
  chrome.tabs.get(tabId).then(showTitle);
  chrome.tabs.onUpdated.addListener((id, _change, tab) => {
    if (id === tabId) showTitle(tab);
  });
}

chrome.storage.local.get("dockHeight").then((stored) => showDock(stored.dockHeight ?? "none"));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.dockHeight) showDock(changes.dockHeight.newValue ?? "none");
});

document.getElementById("dock-button").addEventListener("click", () => {
  chrome.storage.local.set({ dockHeight: 210 });
});
