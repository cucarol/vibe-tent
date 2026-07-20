// Activity secondary surface: unified inbox of pending interactions + tasks/sessions.
// Reuses the same RPC actions as the workbench inspector (no parallel state machines).

import { escapeHtml } from "../../../markdown/render.js";
import {
  buildAcceptPayload,
  buildRejectPayload,
  buildStartSessionPayload,
  sessionStateLabel,
  taskStateLabel,
} from "../../workbench/collaboration-ui.js";
import { el, setError } from "./elements.js";
import {
  a2aApprovals,
  actionableTasks,
  pendingInteractionCount,
  profiles,
  proposals,
  rejectDrafts,
  reloadPendingInteractions,
  reloadTasks,
  reloadTree,
  selectedProfileId,
  sessions,
  setSelectedProfileId,
  toolApprovals,
  userAsks,
  workspaceId,
} from "./state.js";

export type ActivityHost = {
  goWorkbench: () => void;
};

export function bindActivityHost(_h: ActivityHost): void {
  // Host reserved for future deep-link back to workbench from activity rows.
}

export function renderActivity(): void {
  const hostEl = el.activityHost;
  if (!hostEl) return;

  if (!workspaceId) {
    hostEl.innerHTML = `<div class="empty empty-cta"><p class="empty-title">打开工作区</p></div>`;
    return;
  }

  const pendingN = pendingInteractionCount();
  const tasks = actionableTasks();
  const liveSessions = sessions.filter((s) => s.alive || s.state === "running" || s.state === "waiting");

  const asksHtml = userAsks
    .map((ask) => {
      const choices = (ask.choices || [])
        .map(
          (choice) => `<label class="choice-row">
        <input type="radio" name="act-ask-${escapeHtml(ask.id)}" value="${escapeHtml(choice.id)}" />
        <span>${escapeHtml(choice.label)}</span></label>`
        )
        .join("");
      return `<article class="interaction-item" data-act-ask="${escapeHtml(ask.id)}">
        <div class="interaction-kicker">AGENT QUESTION · ${escapeHtml(ask.role || "Agent")}</div>
        <div class="interaction-title">${escapeHtml(ask.question)}</div>
        ${choices ? `<div class="choice-list">${choices}</div>` : ""}
        <textarea class="line-input" data-act-answer="${escapeHtml(ask.id)}" rows="2" placeholder="补充说明（可选）"></textarea>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-reply="${escapeHtml(ask.id)}">回复</button>
          <button type="button" class="btn btn-ghost" data-act-ask-deny="${escapeHtml(ask.id)}">拒绝提问</button>
          <button type="button" class="btn btn-ghost" data-act-interrupt="${escapeHtml(ask.taskPath)}">中断</button>
        </div>
      </article>`;
    })
    .join("");

  const a2aHtml = a2aApprovals
    .map(
      (item) => `<article class="interaction-item">
      <div class="interaction-kicker">A2A</div>
      <div class="interaction-title">${escapeHtml(item.role)} → ${escapeHtml(item.profileId)}</div>
      <div class="muted interaction-note">${escapeHtml(item.taskPath)}</div>
      <div class="interaction-actions">
        <button type="button" class="btn btn-primary" data-act-a2a-allow="${escapeHtml(item.id)}">允许一次</button>
        <button type="button" class="btn btn-ghost" data-act-a2a-deny="${escapeHtml(item.id)}">拒绝</button>
      </div>
    </article>`
    )
    .join("");

  const toolsHtml = toolApprovals
    .map((item) => {
      const summary = (item.options || [])
        .map((o) => o.name || o.kind || o.optionId)
        .filter(Boolean)
        .join(" · ");
      return `<article class="interaction-item">
        <div class="interaction-kicker">TOOL</div>
        <div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
        <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} · ${escapeHtml(item.sessionId)}</div>
        ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-tool-allow="${escapeHtml(item.id)}">允许一次</button>
          <button type="button" class="btn btn-ghost" data-act-tool-deny="${escapeHtml(item.id)}">拒绝</button>
        </div>
      </article>`;
    })
    .join("");

  const reviewTasks = tasks.filter((t) => t.canAcceptOrReject);
  const reviewHtml = reviewTasks
    .map((t) => {
      const draft = rejectDrafts.get(t.path) || "";
      return `<article class="interaction-item">
        <div class="interaction-kicker">DELIVERY REVIEW</div>
        <div class="interaction-title">${escapeHtml(t.role)}</div>
        <div class="muted interaction-note">${escapeHtml(t.deliverySummary || t.prompt || t.path)}</div>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-accept="${escapeHtml(t.path)}">确认</button>
          <button type="button" class="btn btn-ghost" data-act-reject-toggle="${escapeHtml(t.path)}">驳回</button>
        </div>
        <div class="reject-panel" data-act-reject-panel="${escapeHtml(t.path)}" hidden>
          <input type="text" class="field" data-act-reject-reason="${escapeHtml(t.path)}" placeholder="驳回原因" value="${escapeHtml(draft)}" />
          <button type="button" class="btn btn-secondary" data-act-reject="${escapeHtml(t.path)}">确认驳回</button>
        </div>
      </article>`;
    })
    .join("");

  const proposalHtml = proposals
    .map((p) => {
      const body = (p.body || "").trim();
      const preview = body.length > 160 ? body.slice(0, 157) + "…" : body;
      return `<article class="interaction-item">
        <div class="interaction-kicker">PROPOSAL · ${escapeHtml(p.role || "Agent")}</div>
        <div class="interaction-title">${escapeHtml(preview || p.path)}</div>
        <div class="muted interaction-note">${escapeHtml(p.boxId || "")}</div>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-proposal-accept="${escapeHtml(p.path)}">采纳</button>
          <button type="button" class="btn btn-ghost" data-act-proposal-reject="${escapeHtml(p.path)}">驳回</button>
        </div>
      </article>`;
    })
    .join("");

  const pendingBlock =
    pendingN + reviewTasks.length === 0
      ? `<p class="muted">暂无待处理</p>`
      : asksHtml + a2aHtml + toolsHtml + proposalHtml + reviewHtml;

  const profileOpts =
    profiles.length > 0
      ? profiles
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}"${p.id === selectedProfileId ? " selected" : ""}>${escapeHtml(p.label)}</option>`
          )
          .join("")
      : `<option value="">（无 profile）</option>`;

  const taskRows = tasks
    .map((t) => {
      const startBtn = t.canStartAgent
        ? `<button type="button" class="btn btn-primary" data-act-start="${escapeHtml(t.path)}"${
            profiles.length && selectedProfileId ? "" : " disabled"
          }>启动</button>`
        : "";
      const interruptBtn = t.canInterrupt
        ? `<button type="button" class="btn btn-ghost" data-act-interrupt="${escapeHtml(t.path)}">中断</button>`
        : "";
      const cancelBtn = t.canCancel
        ? `<button type="button" class="btn btn-ghost" data-act-cancel="${escapeHtml(t.path)}">取消</button>`
        : "";
      return `<li class="task-item">
        <div class="task-head"><strong>${escapeHtml(t.role)}</strong>
          <span class="muted">${escapeHtml(taskStateLabel(t.state, t.status))}</span></div>
        ${t.prompt ? `<div class="task-summary">${escapeHtml(t.prompt.length > 100 ? t.prompt.slice(0, 97) + "…" : t.prompt)}</div>` : ""}
        <div class="task-actions">${startBtn}${interruptBtn}${cancelBtn}</div>
        <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
      </li>`;
    })
    .join("");

  const sessionRows = liveSessions.length
    ? liveSessions
        .map(
          (s) => `<li class="session-row">
          <span class="session-dot ${s.alive ? "is-live" : ""}" aria-hidden="true"></span>
          <span>${escapeHtml(s.roleName || s.profileId)}</span>
          <span class="muted">${escapeHtml(sessionStateLabel(s.state) || s.state)}</span>
        </li>`
        )
        .join("")
    : `<li class="muted">无活跃会话</li>`;

  const anyStartable = tasks.some((t) => t.canStartAgent);

  hostEl.innerHTML = `
    <div class="activity-layout">
      <section class="activity-col">
        <div class="surface-section-head">待我处理 <span class="count-badge"${pendingN + reviewTasks.length ? "" : " hidden"}>${pendingN + reviewTasks.length}</span></div>
        <div class="activity-stack">${pendingBlock}</div>
      </section>
      <section class="activity-col">
        <div class="surface-section-head">任务
          ${
            anyStartable
              ? `<select id="act-profile" class="field field-compact" title="profile"${profiles.length ? "" : " disabled"}>${profileOpts}</select>`
              : ""
          }
        </div>
        <ul class="task-list activity-task-list">${taskRows || `<li class="muted">无进行中任务</li>`}</ul>
        <div class="surface-section-head">会话</div>
        <ul class="activity-session-list">${sessionRows}</ul>
      </section>
    </div>`;

  wireActivity(hostEl);
}

function wireActivity(root: HTMLElement): void {
  const profileSel = document.getElementById("act-profile") as HTMLSelectElement | null;
  profileSel?.addEventListener("change", () => {
    setSelectedProfileId(profileSel.value || null);
    renderActivity();
  });

  root.querySelectorAll<HTMLElement>("[data-act-reply]").forEach((btn) => {
    btn.addEventListener("click", () => void onReply(btn.getAttribute("data-act-reply")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-ask-deny]").forEach((btn) => {
    btn.addEventListener("click", () => void onDenyAsk(btn.getAttribute("data-act-ask-deny")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-a2a-allow]").forEach((btn) => {
    btn.addEventListener("click", () => void onA2A(btn.getAttribute("data-act-a2a-allow")!, "approve"));
  });
  root.querySelectorAll<HTMLElement>("[data-act-a2a-deny]").forEach((btn) => {
    btn.addEventListener("click", () => void onA2A(btn.getAttribute("data-act-a2a-deny")!, "deny"));
  });
  root.querySelectorAll<HTMLElement>("[data-act-tool-allow]").forEach((btn) => {
    btn.addEventListener("click", () => void onTool(btn.getAttribute("data-act-tool-allow")!, true));
  });
  root.querySelectorAll<HTMLElement>("[data-act-tool-deny]").forEach((btn) => {
    btn.addEventListener("click", () => void onTool(btn.getAttribute("data-act-tool-deny")!, false));
  });
  root.querySelectorAll<HTMLElement>("[data-act-proposal-accept]").forEach((btn) => {
    btn.addEventListener("click", () =>
      void onProposal(btn.getAttribute("data-act-proposal-accept")!, "accept")
    );
  });
  root.querySelectorAll<HTMLElement>("[data-act-proposal-reject]").forEach((btn) => {
    btn.addEventListener("click", () =>
      void onProposal(btn.getAttribute("data-act-proposal-reject")!, "reject")
    );
  });
  root.querySelectorAll<HTMLElement>("[data-act-accept]").forEach((btn) => {
    btn.addEventListener("click", () => void onAccept(btn.getAttribute("data-act-accept")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-reject-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-act-reject-toggle")!;
      const panel = root.querySelector(`[data-act-reject-panel="${CSS.escape(path)}"]`);
      if (!(panel instanceof HTMLElement)) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
  });
  root.querySelectorAll<HTMLInputElement>("[data-act-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-act-reject-reason")!, input.value);
    });
  });
  root.querySelectorAll<HTMLElement>("[data-act-reject]").forEach((btn) => {
    btn.addEventListener("click", () => void onReject(btn.getAttribute("data-act-reject")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStart(btn.getAttribute("data-act-start")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt(btn.getAttribute("data-act-interrupt")!));
  });
  root.querySelectorAll<HTMLElement>("[data-act-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => void onCancel(btn.getAttribute("data-act-cancel")!));
  });
}

async function refreshAfter(): Promise<void> {
  await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  renderActivity();
}

async function onReply(askId: string): Promise<void> {
  const item = el.activityHost?.querySelector(`[data-act-ask="${CSS.escape(askId)}"]`);
  const answer =
    item?.querySelector<HTMLTextAreaElement>("[data-act-answer]")?.value.trim() || "";
  const choiceId =
    item?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value || "";
  if (!answer && !choiceId) {
    el.status.textContent = "请选择一个选项或填写回复。";
    return;
  }
  try {
    await window.tentDesktop.rpc("userAsk.reply", {
      askId,
      actor: "user",
      ...(answer ? { answer } : {}),
      ...(choiceId ? { choiceId } : {}),
    });
    el.status.textContent = "已回复 Agent。";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onDenyAsk(askId: string): Promise<void> {
  try {
    await window.tentDesktop.rpc("userAsk.deny", { askId, actor: "user" });
    el.status.textContent = "已拒绝 Agent 提问。";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onProposal(path: string, decision: "accept" | "reject"): Promise<void> {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("proposal.resolve", {
      workspaceId,
      path,
      decision,
      actor: "user",
    });
    el.status.textContent = decision === "accept" ? "已采纳提案。" : "已驳回提案。";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onA2A(id: string, decision: "approve" | "deny"): Promise<void> {
  try {
    await window.tentDesktop.rpc("a2a.resolve", { approvalId: id, decision, actor: "user" });
    el.status.textContent = decision === "approve" ? "已允许启动 Agent。" : "已拒绝启动 Agent。";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onTool(id: string, allow: boolean): Promise<void> {
  try {
    await window.tentDesktop.rpc(allow ? "toolApproval.approveOnce" : "toolApproval.deny", {
      approvalId: id,
      actor: "user",
    });
    el.status.textContent = allow ? "已允许本次工具调用。" : "已拒绝工具调用。";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onAccept(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      actor: payload.actor,
    });
    el.status.textContent = `已确认交付：${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onReject(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const reason = rejectDrafts.get(taskPath) || "";
  const built = buildRejectPayload(taskPath, reason, "user");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.reject", {
      workspaceId,
      taskPath: built.payload.taskPath,
      actor: built.payload.actor,
      note: built.payload.note,
      resume: built.payload.resume,
    });
    rejectDrafts.delete(taskPath);
    el.status.textContent = `已驳回：${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onStart(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath, selectedProfileId || "");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
      callerKind: built.payload.callerKind,
    });
    el.status.textContent = `已启动 agent · ${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onInterrupt(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", { workspaceId, taskPath });
    el.status.textContent = `已中断：${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

async function onCancel(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  if (!window.confirm("取消该任务？未交付的进度将终止。")) return;
  try {
    await window.tentDesktop.rpc("task.cancel", { workspaceId, taskPath });
    el.status.textContent = `已取消：${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}


