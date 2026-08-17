import "./api-types.js";

const healthEl = document.getElementById("health-pill")!;
const pendingEl = document.getElementById("n-pending")!;
const takenEl = document.getElementById("n-taken")!;
const foregroundEl = document.getElementById("fg-root")!;
let refreshInFlight: Promise<void> | null = null;

function workspaceLabel(root: string | null | undefined): string {
  if (!root) return "无前台工作区";
  return root.split(/[\\/]+/).filter(Boolean).at(-1) ?? root;
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = window.tentDesktop.getFloatingStatus().then((status) => {
    const online = status.health.status === "ok";
    healthEl.className = `pill ${online ? "ok" : "off"}`;
    healthEl.textContent = online ? "服务正常" : "服务离线";
    pendingEl.textContent = String(status.pendingTasks);
    takenEl.textContent = String(status.takenTasks);
    foregroundEl.textContent = workspaceLabel(status.foregroundRoot);
  }).catch(() => {
    healthEl.className = "pill off";
    healthEl.textContent = "状态不可用";
    pendingEl.textContent = "—";
    takenEl.textContent = "—";
    foregroundEl.textContent = "无法读取工作区";
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

document.getElementById("btn-open-main")!.addEventListener("click", () => {
  void window.tentDesktop.openMain();
});
document.getElementById("btn-hide-float")!.addEventListener("click", () => {
  void window.tentDesktop.hideFloat();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void window.tentDesktop.hideFloat();
});
window.tentDesktop.onStateChanged(() => void refresh());
void refresh();
setInterval(() => void refresh(), 4000);
