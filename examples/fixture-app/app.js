window.__clickDetails = [];
window.__mutationCount = 0;

new MutationObserver((records) => {
  window.__mutationCount += records.length;
}).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

document.addEventListener("click", (event) => {
  window.__clickDetails.push(event.detail);
});

const shadow = document.getElementById("shadow-host").attachShadow({ mode: "open" });
shadow.innerHTML = '<button id="shadow-button">In shadow</button>';

const scroller = document.getElementById("scroller");
for (let i = 1; i <= 20; i++) {
  const item = document.createElement("li");
  item.textContent = `item ${i}`;
  scroller.append(item);
}

const DOCK_KEY = "fixture:dockHeight";
const LOG_KEY = `fixture:log:${new URLSearchParams(location.search).get("variant") ?? "a"}`;

if (localStorage.getItem(DOCK_KEY) === null) localStorage.setItem(DOCK_KEY, "365");

const logEntries = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
const logList = document.getElementById("log");
function renderLog() {
  logList.dataset.logCount = String(logEntries.length);
  logList.replaceChildren(...logEntries.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
}
renderLog();

document.getElementById("dock-button").addEventListener("click", () => localStorage.setItem(DOCK_KEY, "210"));
document.getElementById("log-button").addEventListener("click", () => {
  logEntries.push(`entry ${logEntries.length + 1}`);
  renderLog();
});

setInterval(() => {
  if (logEntries.length > 0) localStorage.setItem(LOG_KEY, JSON.stringify(logEntries));
}, 100);
