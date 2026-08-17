// src/desktop/renderer/float-ui.ts
var healthEl = document.getElementById("health-pill");
var pendingEl = document.getElementById("n-pending");
var takenEl = document.getElementById("n-taken");
var foregroundEl = document.getElementById("fg-root");
var refreshInFlight = null;
function workspaceLabel(root) {
  if (!root) return "\u65E0\u524D\u53F0\u5DE5\u4F5C\u533A";
  return root.split(/[\\/]+/).filter(Boolean).at(-1) ?? root;
}
async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = window.tentDesktop.getFloatingStatus().then((status) => {
    const online = status.health.status === "ok";
    healthEl.className = `pill ${online ? "ok" : "off"}`;
    healthEl.textContent = online ? "\u670D\u52A1\u6B63\u5E38" : "\u670D\u52A1\u79BB\u7EBF";
    pendingEl.textContent = String(status.pendingTasks);
    takenEl.textContent = String(status.takenTasks);
    foregroundEl.textContent = workspaceLabel(status.foregroundRoot);
  }).catch(() => {
    healthEl.className = "pill off";
    healthEl.textContent = "\u72B6\u6001\u4E0D\u53EF\u7528";
    pendingEl.textContent = "\u2014";
    takenEl.textContent = "\u2014";
    foregroundEl.textContent = "\u65E0\u6CD5\u8BFB\u53D6\u5DE5\u4F5C\u533A";
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
document.getElementById("btn-open-main").addEventListener("click", () => {
  void window.tentDesktop.openMain();
});
document.getElementById("btn-hide-float").addEventListener("click", () => {
  void window.tentDesktop.hideFloat();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void window.tentDesktop.hideFloat();
});
window.tentDesktop.onStateChanged(() => void refresh());
void refresh();
setInterval(() => void refresh(), 4e3);
//# sourceMappingURL=float-ui.js.map
