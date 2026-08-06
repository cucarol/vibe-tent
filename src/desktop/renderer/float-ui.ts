// Floating control renderer — status + draggable Context Cards.

import "./api-types.js";
import { escapeHtml } from "../../markdown/render.js";
import { bindContextCardDrag } from "./context-card-drag.js";

const healthEl = document.getElementById("health-pill")!;
const pendingEl = document.getElementById("n-pending")!;
const takenEl = document.getElementById("n-taken")!;
const cardsEl = document.getElementById("cards")!;
const fgEl = document.getElementById("fg-root")!;
const headHint = document.getElementById("context-hint")!;
let refreshInFlight: Promise<void> | null = null;
let hintResetTimer: ReturnType<typeof setTimeout> | null = null;

const cardKindLabels: Record<string, string> = {
  node: "节点",
  task: "任务",
  delivery: "交付",
  handoff: "交接",
  selection: "选区",
  role: "角色",
};

function workspaceLabel(root: string | null | undefined): string {
  if (!root) return "无前台工作区";
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? root;
}

function setHint(text: string, reset = false): void {
  if (hintResetTimer) clearTimeout(hintResetTimer);
  headHint.textContent = text;
  if (!reset) return;
  hintResetTimer = setTimeout(() => {
    hintResetTimer = null;
    headHint.textContent = "拖到外部输入框";
  }, 1800);
}

function renderUnavailable(): void {
  healthEl.className = "pill off";
  healthEl.textContent = "状态不可用";
  pendingEl.textContent = "—";
  takenEl.textContent = "—";
  fgEl.textContent = "无法读取工作区";
  fgEl.removeAttribute("title");
  cardsEl.setAttribute("aria-busy", "false");
  cardsEl.innerHTML = `<li class="float-state error" role="alert">暂时无法读取，稍后自动重试</li>`;
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const s = await window.tentDesktop.getFloatingStatus();
      const ok = s.health.status === "ok";
      healthEl.className = `pill ${ok ? "ok" : "off"}`;
      healthEl.textContent = ok ? "服务正常" : "服务离线";
      pendingEl.textContent = String(s.pendingTasks);
      takenEl.textContent = String(s.takenTasks);
      fgEl.textContent = workspaceLabel(s.foregroundRoot);
      if (s.foregroundRoot) fgEl.setAttribute("title", s.foregroundRoot);
      else fgEl.removeAttribute("title");

      cardsEl.setAttribute("aria-busy", "false");
      if (!s.recentCards.length) {
        cardsEl.innerHTML = `<li class="float-state" role="status">暂无上下文卡</li>`;
        return;
      }
      cardsEl.innerHTML = s.recentCards
        .map((card, index) => {
          const kind = cardKindLabels[card.kind] ?? "上下文";
          const path = card.path?.split(/[\\/]+/).filter(Boolean).at(-1);
          return `<li class="card-item" draggable="true" data-idx="${index}">
            <strong>${escapeHtml(card.label)}</strong>
            <div class="card-meta">${escapeHtml(path ? `${kind} · ${path}` : kind)}</div>
            <div class="card-hint">拖出 · 单击或回车复制</div>
          </li>`;
        })
        .join("");

      cardsEl.querySelectorAll<HTMLElement>("[data-idx]").forEach((node) => {
        const index = Number(node.getAttribute("data-idx"));
        const card = s.recentCards[index];
        if (!card?.text) return;
        // HTML5 text/plain only — no clipboard IPC on dragstart.
        bindContextCardDrag(node, card.text, {
          onCopied: () => setHint("已复制", true),
          onCopyError: () => setHint("复制失败", true),
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

document.getElementById("btn-open-main")!.addEventListener("click", () => {
  void window.tentDesktop.openMain().catch(() => {
    setHint("无法打开主界面", true);
  });
});

document.getElementById("btn-hide-float")!.addEventListener("click", () => {
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
}, 4000);
