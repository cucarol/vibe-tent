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
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  node.setAttribute("aria-label", "\u4E0A\u4E0B\u6587\u5361\uFF1A\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846\uFF0C\u6216\u6309\u56DE\u8F66\u590D\u5236");
  node.setAttribute("title", "\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846 \xB7 \u5355\u51FB\u590D\u5236");
  const copy = () => {
    void copyContextCardText(text, options);
  };
  node.addEventListener("dragstart", (ev) => {
    applyContextCardDragStart(ev.dataTransfer, text);
    node.classList.add("is-dragging");
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
  });
  node.addEventListener("click", () => {
    copy();
  });
  node.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    copy();
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
var headHint = document.getElementById("context-hint");
var refreshInFlight = null;
var hintResetTimer = null;
var cardKindLabels = {
  node: "\u8282\u70B9",
  task: "\u4EFB\u52A1",
  delivery: "\u4EA4\u4ED8",
  handoff: "\u4EA4\u63A5",
  selection: "\u9009\u533A",
  role: "\u89D2\u8272"
};
function workspaceLabel(root) {
  if (!root) return "\u65E0\u524D\u53F0\u5DE5\u4F5C\u533A";
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? root;
}
function setHint(text, reset = false) {
  if (hintResetTimer) clearTimeout(hintResetTimer);
  headHint.textContent = text;
  if (!reset) return;
  hintResetTimer = setTimeout(() => {
    hintResetTimer = null;
    headHint.textContent = "\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846";
  }, 1800);
}
function renderUnavailable() {
  healthEl.className = "pill off";
  healthEl.textContent = "\u72B6\u6001\u4E0D\u53EF\u7528";
  pendingEl.textContent = "\u2014";
  takenEl.textContent = "\u2014";
  fgEl.textContent = "\u65E0\u6CD5\u8BFB\u53D6\u5DE5\u4F5C\u533A";
  fgEl.removeAttribute("title");
  cardsEl.setAttribute("aria-busy", "false");
  cardsEl.innerHTML = `<li class="float-state error" role="alert">\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5</li>`;
}
async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const s = await window.tentDesktop.getFloatingStatus();
      const ok = s.health.status === "ok";
      healthEl.className = `pill ${ok ? "ok" : "off"}`;
      healthEl.textContent = ok ? "\u670D\u52A1\u6B63\u5E38" : "\u670D\u52A1\u79BB\u7EBF";
      pendingEl.textContent = String(s.pendingTasks);
      takenEl.textContent = String(s.takenTasks);
      fgEl.textContent = workspaceLabel(s.foregroundRoot);
      if (s.foregroundRoot) fgEl.setAttribute("title", s.foregroundRoot);
      else fgEl.removeAttribute("title");
      cardsEl.setAttribute("aria-busy", "false");
      if (!s.recentCards.length) {
        cardsEl.innerHTML = `<li class="float-state" role="status">\u6682\u65E0\u4E0A\u4E0B\u6587\u5361</li>`;
        return;
      }
      cardsEl.innerHTML = s.recentCards.map((card, index) => {
        const kind = cardKindLabels[card.kind] ?? "\u4E0A\u4E0B\u6587";
        const path = card.path?.split(/[\\/]+/).filter(Boolean).at(-1);
        return `<li class="card-item" draggable="true" data-idx="${index}">
            <strong>${escapeHtml(card.label)}</strong>
            <div class="card-meta">${escapeHtml(path ? `${kind} \xB7 ${path}` : kind)}</div>
            <div class="card-hint">\u62D6\u51FA \xB7 \u5355\u51FB\u6216\u56DE\u8F66\u590D\u5236</div>
          </li>`;
      }).join("");
      cardsEl.querySelectorAll("[data-idx]").forEach((node) => {
        const index = Number(node.getAttribute("data-idx"));
        const card = s.recentCards[index];
        if (!card?.text) return;
        bindContextCardDrag(node, card.text, {
          onCopied: () => setHint("\u5DF2\u590D\u5236", true),
          onCopyError: () => setHint("\u590D\u5236\u5931\u8D25", true)
        });
      });
    } catch {
      renderUnavailable();
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
document.getElementById("btn-open-main").addEventListener("click", () => {
  void window.tentDesktop.openMain().catch(() => {
    setHint("\u65E0\u6CD5\u6253\u5F00\u4E3B\u754C\u9762", true);
  });
});
document.getElementById("btn-hide-float").addEventListener("click", () => {
  void window.tentDesktop.hideFloat();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void window.tentDesktop.hideFloat();
});
window.tentDesktop.onStateChanged(() => {
  void refresh();
});
void refresh();
setInterval(() => {
  void refresh();
}, 4e3);
//# sourceMappingURL=float-ui.js.map
