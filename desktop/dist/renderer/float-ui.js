// src/markdown/render.ts
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// src/desktop/renderer/context-card-drag.ts
function applyContextCardDragStart(dataTransfer, text) {
  if (!dataTransfer) return;
  dataTransfer.clearData();
  dataTransfer.setData("text/plain", text);
  dataTransfer.effectAllowed = "copy";
}
function bindContextCardDrag(node, text, options = {}) {
  node.draggable = true;
  node.setAttribute("title", "\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846 \xB7 \u5355\u51FB\u590D\u5236");
  node.addEventListener("dragstart", (ev) => {
    applyContextCardDragStart(ev.dataTransfer, text);
    node.classList.add("is-dragging");
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
  });
  node.addEventListener("click", () => {
    void copyContextCardText(text, options);
  });
}
async function copyContextCardText(text, options = {}) {
  const write = options.writeClipboard ?? (async (value) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Clipboard API unavailable");
  });
  try {
    await write(text);
    options.onCopied?.(text);
  } catch (err) {
    options.onCopyError?.(err);
  }
}

// src/desktop/renderer/float-ui.ts
var healthEl = document.getElementById("health-pill");
var pendingEl = document.getElementById("n-pending");
var takenEl = document.getElementById("n-taken");
var cardsEl = document.getElementById("cards");
var fgEl = document.getElementById("fg-root");
var headHint = document.querySelector(".float-shell .panel-head");
async function refresh() {
  const s = await window.tentDesktop.getFloatingStatus();
  const ok = s.health.status === "ok";
  healthEl.className = `pill ${ok ? "ok" : "off"}`;
  healthEl.textContent = ok ? `\u6B63\u5E38 \xB7 ${s.health.pid ?? ""}` : "\u79BB\u7EBF";
  pendingEl.textContent = String(s.pendingTasks);
  takenEl.textContent = String(s.takenTasks);
  fgEl.textContent = s.foregroundRoot || "\u65E0\u524D\u53F0\u5DE5\u4F5C\u533A";
  if (!s.recentCards.length) {
    cardsEl.innerHTML = `<li class="muted">\u6682\u65E0\u4E0A\u4E0B\u6587\u5361</li>`;
    return;
  }
  cardsEl.innerHTML = s.recentCards.map(
    (c, i) => `<li class="card-item" draggable="true" data-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
        <div class="card-hint muted">\u62D6\u51FA \xB7 \u5355\u51FB\u590D\u5236</div>
      </li>`
  ).join("");
  cardsEl.querySelectorAll("[data-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-idx"));
    const card = s.recentCards[idx];
    if (!card?.text) return;
    bindContextCardDrag(node, card.text, {
      onCopied: () => {
        if (headHint) headHint.textContent = "\u4E0A\u4E0B\u6587\u5361 \xB7 \u5DF2\u590D\u5236";
      }
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
