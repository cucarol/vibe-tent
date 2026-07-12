// Floating control renderer — status + draggable Context Cards.

import "./api-types.js";
import { escapeHtml } from "../../markdown/render.js";

type FloatingStatus = Awaited<ReturnType<Window["tentDesktop"]["getFloatingStatus"]>>;

const healthEl = document.getElementById("health-pill")!;
const pendingEl = document.getElementById("n-pending")!;
const takenEl = document.getElementById("n-taken")!;
const cardsEl = document.getElementById("cards")!;
const fgEl = document.getElementById("fg-root")!;

async function refresh(): Promise<void> {
  const s = await window.tentDesktop.getFloatingStatus();
  const ok = s.health.status === "ok";
  healthEl.className = `pill ${ok ? "ok" : "off"}`;
  healthEl.textContent = ok ? `正常 · ${s.health.pid ?? ""}` : "离线";
  pendingEl.textContent = String(s.pendingTasks);
  takenEl.textContent = String(s.takenTasks);
  fgEl.textContent = s.foregroundRoot || "无前台工作区";

  if (!s.recentCards.length) {
    cardsEl.innerHTML = `<li class="muted">暂无上下文卡</li>`;
    return;
  }
  cardsEl.innerHTML = s.recentCards
    .map(
      (c, i) => `<li class="card-item" draggable="true" data-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
      </li>`
    )
    .join("");

  cardsEl.querySelectorAll<HTMLElement>("[data-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-idx"));
    const card = s.recentCards[idx];
    node.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", card.text);
      ev.dataTransfer!.effectAllowed = "copy";
      void window.tentDesktop.startDrag(card.text);
    });
  });
}

document.getElementById("btn-open-main")!.addEventListener("click", () => {
  void window.tentDesktop.openMain();
});

window.tentDesktop.onStateChanged(() => {
  void refresh();
});

void refresh();
setInterval(() => void refresh(), 4000);
