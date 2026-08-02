// Dispatch panel: role + prompt form → task.dispatch.

import { escapeHtml } from "../../../markdown/render.js";
import { validateDispatchForm } from "../../workbench/collaboration-ui.js";
import { el, setError } from "./elements.js";
import {
  activeCx,
  dispatchPrompt,
  dispatchRole,
  localTabs,
  reloadPendingInteractions,
  reloadTasks,
  reloadTree,
  roles,
  setDispatchPrompt,
  setDispatchRole,
  workspaceId,
} from "./state.js";
import { btnHtml } from "./ui.js";

export type DispatchHost = {
  renderDispatchPanel: () => void;
};

let host: DispatchHost | null = null;

export function bindDispatchHost(h: DispatchHost): void {
  host = h;
}

export function renderDispatchPanel(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">选中节点后可派活</div>`;
    return;
  }
  if (!tab.coordination) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">「${escapeHtml(tab.name)}」不可用（无效或已封存），无法派活。</div>`;
    return;
  }

  const roleOpts =
    roles.length > 0
      ? roles
          .map(
            (r) =>
              `<option value="${escapeHtml(r.name)}"${r.name === dispatchRole ? " selected" : ""}>${escapeHtml(r.name)}</option>`
          )
          .join("")
      : `<option value="">（无 role）</option>`;

  const validation = validateDispatchForm({
    nodeId: tab.nodeId,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles,
  });

  el.dispatch.innerHTML = `
    <div class="dispatch-form">
      <div class="field-row">
        <label for="dispatch-role">目标 role</label>
        <select id="dispatch-role"${roles.length ? "" : " disabled"}>${roleOpts}</select>
      </div>
      <div class="field-row">
        <label for="dispatch-prompt">user prompt</label>
        <textarea id="dispatch-prompt" rows="3" placeholder="写给目标 role 的任务说明…">${escapeHtml(dispatchPrompt)}</textarea>
      </div>
      <div class="row dispatch-actions">
        ${btnHtml({
          label: "派活",
          variant: "primary",
          id: "btn-dispatch",
          disabled: !validation.ok,
        })}
        ${
          validation.ok
            ? ""
            : `<span class="faint">${escapeHtml(validation.reason || "")}</span>`
        }
      </div>
    </div>
  `;

  const roleSel = document.getElementById("dispatch-role") as HTMLSelectElement | null;
  const promptTa = document.getElementById("dispatch-prompt") as HTMLTextAreaElement | null;
  const btn = document.getElementById("btn-dispatch") as HTMLButtonElement | null;

  roleSel?.addEventListener("change", () => {
    setDispatchRole(roleSel.value);
    host?.renderDispatchPanel();
  });
  promptTa?.addEventListener("input", () => {
    const nextPrompt = promptTa.value;
    setDispatchPrompt(nextPrompt);
    // Lightweight re-validate without full rebuild of textarea focus:
    if (btn) {
      const v = validateDispatchForm({
        nodeId: tab.nodeId,
        coordination: tab.coordination,
        role: roleSel?.value || dispatchRole,
        prompt: nextPrompt,
        roles,
      });
      btn.disabled = !v.ok;
      const hint = el.dispatch.querySelector(".dispatch-actions .faint");
      if (hint) hint.textContent = v.ok ? "" : v.reason || "";
      else if (!v.ok) {
        const span = document.createElement("span");
        span.className = "faint";
        span.textContent = v.reason || "";
        el.dispatch.querySelector(".dispatch-actions")?.appendChild(span);
      }
    }
  });
  btn?.addEventListener("click", () => void onDispatch());
}

async function onDispatch(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab || !workspaceId) return;
  const validation = validateDispatchForm({
    nodeId: tab.nodeId,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles,
  });
  if (!validation.ok || !validation.payload) {
    el.status.textContent = validation.reason || "无法派活";
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("task.dispatch", {
      workspaceId,
      nodeIds: validation.payload.nodeIds,
      roleId: validation.payload.roleId,
      prompt: validation.payload.prompt,
      parentActor: validation.payload.parentActor,
      reviewer: validation.payload.reviewer,
      deliveryPolicy: "review",
    })) as { taskPath: string; state: string };
    el.status.textContent = `已派活 → ${result.taskPath}（${result.state}）`;
    setDispatchPrompt("");
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
    host?.renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}
