// src/markdown/render.ts
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// src/desktop/renderer/float-ui.ts
var healthEl = document.getElementById("health-pill");
var pendingEl = document.getElementById("n-pending");
var takenEl = document.getElementById("n-taken");
var cardsEl = document.getElementById("cards");
var fgEl = document.getElementById("fg-root");
async function refresh() {
  const s = await window.tentDesktop.getFloatingStatus();
  const ok = s.health.status === "ok";
  healthEl.className = `pill ${ok ? "ok" : "off"}`;
  healthEl.textContent = ok ? `ok \xB7 ${s.health.pid ?? ""}` : "offline";
  pendingEl.textContent = String(s.pendingTasks);
  takenEl.textContent = String(s.takenTasks);
  fgEl.textContent = s.foregroundRoot || "No foreground workspace";
  if (!s.recentCards.length) {
    cardsEl.innerHTML = `<li class="muted">No cards yet</li>`;
    return;
  }
  cardsEl.innerHTML = s.recentCards.map(
    (c, i) => `<li class="card-item" draggable="true" data-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
      </li>`
  ).join("");
  cardsEl.querySelectorAll("[data-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-idx"));
    const card = s.recentCards[idx];
    node.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", card.text);
      ev.dataTransfer.effectAllowed = "copy";
      void window.tentDesktop.startDrag(card.text);
    });
  });
}
document.getElementById("btn-open-main").addEventListener("click", () => {
  void window.tentDesktop.openMain();
});
window.tentDesktop.onStateChanged(() => {
  void refresh();
});
void refresh();
setInterval(() => void refresh(), 4e3);
//# sourceMappingURL=float-ui.js.map
