// Collaboration inspector: pending A2U/tool/taskInput, task list, U2A, sessions, cards.
// Resolve actions go through workbench pending-interactions adapters (no field guesses in templates).

import { escapeHtml } from "../../../markdown/render.js";
import {
  buildAcceptPayload,
  buildRejectPayload,
  buildStartSessionPayload,
  sessionStateLabel,
  taskStateLabel,
} from "../../workbench/collaboration-ui.js";
import {
  buildTaskSendInputPayload,
  buildToolApprovalResolvePayload,
  buildDecisionDenyPayload,
  buildDecisionResponsePayload,
  taskInputKindLabel,
} from "../../workbench/pending-interactions.js";
import { bindContextCardDrag } from "../context-card-drag.js";
import { el, setError } from "./elements.js";
import { syncInspectorSections } from "./inspector.js";
import { btnClass } from "./ui.js";
import {
  actionableTasks,
  activeCx,
  localTabs,
  pendingInteractionCount,
  proposals,
  rejectDrafts,
  reloadPendingInteractions,
  reloadTasks,
  reloadTree,
  sessions,
  taskInputs,
  tasksForActiveNode,
  toolApprovals,
  decisionRequests,
  workspaceId,
} from "./state.js";

export function renderPendingInteractions(): void {
  const hasPending = pendingInteractionCount() > 0;
  el.a2u.hidden = !hasPending;
  if (!hasPending) {
    el.a2u.innerHTML = "";
    renderTasks();
    return;
  }
  // Independent types in one region — never merge Decision Requests with TaskInput.
  const requests = decisionRequests
    .map((request) => {
      const options = request.options
        .map(
          (option) => `<label class="choice-row">
      <input type="radio" name="decision-option-${escapeHtml(request.id)}" value="${escapeHtml(option.id)}" />
      <span>${escapeHtml(option.label)}</span></label>`
        )
        .join("");
      return `<article class="interaction-item" data-decision-item="${escapeHtml(request.id)}" data-task-path="${escapeHtml(request.taskPath)}" data-pending-kind="decisionRequest">
      <div class="interaction-kicker">DECISION REQUEST</div>
      <div class="interaction-title">${escapeHtml(request.question)}</div>
      <div class="muted interaction-note">${escapeHtml(request.taskPath)}</div>
      ${options ? `<div class="choice-list">${options}</div>` : ""}
      <textarea class="line-input" data-decision-answer="${escapeHtml(request.id)}" rows="2" placeholder="自定义回答（可选）"></textarea>
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-decision-respond="${escapeHtml(request.id)}">回复</button>
      <button type="button" class="btn btn-ghost" data-decision-deny="${escapeHtml(request.id)}">拒绝</button>
      <button type="button" class="btn btn-ghost" data-task-stop="${escapeHtml(request.taskPath)}">中断任务</button></div>
    </article>`;
    })
    .join("");
  const tools = toolApprovals
    .map((item) => {
      // paramsSummary from options only — service does not project tool args.
      const summary = item.paramsSummary || "";
      return `<article class="interaction-item" data-pending-kind="toolApproval">
      <div class="interaction-kicker">TOOL · ${escapeHtml(item.toolTitle)}</div>
      <div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
      <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} · session ${escapeHtml(item.sessionId)}</div>
      ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-tool-allow="${escapeHtml(item.id)}">允许一次</button>
      <button type="button" class="btn btn-ghost" data-tool-deny="${escapeHtml(item.id)}">拒绝</button></div>
    </article>`;
    })
    .join("");
  // TaskInput is a distinct type (U2A one-shot), not a Decision Request.
  const inputs = taskInputs
    .map((item) => {
      const text = (item.text || "").trim();
      const preview = text.length > 160 ? text.slice(0, 157) + "…" : text;
      const refs =
        item.contextRefs.length > 0
          ? `<div class="muted interaction-note">refs · ${escapeHtml(item.contextRefs.join(" · "))}</div>`
          : "";
      return `<article class="interaction-item" data-pending-kind="taskInput" data-task-input="${escapeHtml(item.id)}">
      <div class="interaction-kicker">${escapeHtml(taskInputKindLabel(item.inputKind))} · ${escapeHtml(item.role || "—")}</div>
      <div class="interaction-title">${escapeHtml(preview || "（无正文）")}</div>
      <div class="muted interaction-note">${escapeHtml(item.taskPath)}${item.sessionId ? ` · ${escapeHtml(item.sessionId)}` : ""}</div>
      ${refs}
      <div class="muted interaction-note">待 agent 消费（taskInput.ack）</div>
    </article>`;
    })
    .join("");
  const proposalItems = proposals
    .map((p) => {
      const body = (p.body || "").trim();
      const preview = body.length > 160 ? body.slice(0, 157) + "…" : body;
      return `<article class="interaction-item" data-proposal-path="${escapeHtml(p.path)}" data-pending-kind="proposal">
      <div class="interaction-kicker">PROPOSAL · ${escapeHtml(p.role || "Agent")}</div>
      <div class="interaction-title">${escapeHtml(preview || p.path)}</div>
      <div class="muted interaction-note">${escapeHtml(p.nodeId || "")} · ${escapeHtml(p.path)}</div>
      <div class="interaction-actions">
        <button type="button" class="btn btn-primary" data-proposal-accept="${escapeHtml(p.path)}">采纳</button>
        <button type="button" class="btn btn-ghost" data-proposal-reject="${escapeHtml(p.path)}">驳回</button>
      </div>
    </article>`;
    })
    .join("");
  el.a2u.innerHTML = requests + tools + inputs + proposalItems;
  el.a2u
    .querySelectorAll<HTMLElement>("[data-decision-respond]")
    .forEach((button) =>
      button.addEventListener("click", () => void onRespondDecision(button.getAttribute("data-decision-respond")!))
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-decision-deny]")
    .forEach((button) =>
      button.addEventListener("click", () => void onDenyDecision(button.getAttribute("data-decision-deny")!))
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-task-stop]")
    .forEach((button) =>
      button.addEventListener("click", () => void onInterrupt(button.getAttribute("data-task-stop")!))
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-proposal-accept]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        void onResolveProposal(button.getAttribute("data-proposal-accept")!, "accept")
      )
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-proposal-reject]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        void onResolveProposal(button.getAttribute("data-proposal-reject")!, "reject")
      )
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-tool-allow]")
    .forEach((button) =>
      button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-allow")!, true))
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-tool-deny]")
    .forEach((button) =>
      button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-deny")!, false))
    );
  renderTasks();
  syncInspectorSections();
}

async function onRespondDecision(requestId: string): Promise<void> {
  if (!workspaceId) return;
  const item = el.a2u.querySelector<HTMLElement>(`[data-decision-item="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  const answer = item?.querySelector<HTMLTextAreaElement>("[data-decision-answer]")?.value.trim() || "";
  const optionId = item?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value || "";
  const built = buildDecisionResponsePayload(workspaceId, taskPath, requestId, {
    text: answer,
    optionId,
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("decisionRequest.respond", built.payload);
    el.status.textContent = "已提交决定。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onDenyDecision(requestId: string): Promise<void> {
  if (!workspaceId) return;
  const item = el.a2u.querySelector<HTMLElement>(`[data-decision-item="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  try {
    await window.tentDesktop.rpc(
      "decisionRequest.respond",
      buildDecisionDenyPayload(workspaceId, taskPath, requestId)
    );
    el.status.textContent = "已拒绝该请求。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onResolveProposal(path: string, decision: "accept" | "reject"): Promise<void> {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("proposal.resolve", {
      workspaceId,
      path,
      decision,
      actor: "user",
    });
    el.status.textContent = decision === "accept" ? "已采纳提案。" : "已驳回提案。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onResolveTool(approvalId: string, allow: boolean): Promise<void> {
  try {
    const built = buildToolApprovalResolvePayload(approvalId, allow, "user");
    await window.tentDesktop.rpc(built.method, built.params);
    el.status.textContent = allow ? "已允许本次工具调用。" : "已拒绝工具调用。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

/** User compose surface for task.sendInput (U2A). Distinct from pending TaskInput list. */
export function renderTaskInput(): void {
  const candidates = tasksForActiveNode(["running", "taken", "waiting"]);
  el.u2a.hidden = candidates.length === 0;
  if (!candidates.length) {
    el.u2a.innerHTML = "";
    return;
  }
  const options = candidates
    .map(
      (task) =>
        `<option value="${escapeHtml(task.path)}">${escapeHtml(taskExecutionLabel(task))} · ${escapeHtml(taskStateLabel(task.state))}</option>`
    )
    .join("");
  el.u2a.innerHTML = `<article class="interaction-item u2a-item" data-pending-kind="taskSendInput"><div class="interaction-kicker">U2A · 追加任务输入</div>
    ${candidates.length > 1 ? `<select id="u2a-task" class="field">${options}</select>` : ""}
    <textarea id="u2a-text" class="line-input" rows="2" placeholder="发送一次性补充指令（task.sendInput）"></textarea>
    <div class="interaction-actions"><button type="button" id="btn-send-task-input" class="btn btn-secondary">发送</button></div></article>`;
  document.getElementById("btn-send-task-input")?.addEventListener("click", async () => {
    const text = (document.getElementById("u2a-text") as HTMLTextAreaElement | null)?.value.trim() || "";
    const taskPath =
      (document.getElementById("u2a-task") as HTMLSelectElement | null)?.value || candidates[0]!.path;
    if (!workspaceId) return;
    const built = buildTaskSendInputPayload(workspaceId, taskPath, text, "user");
    if (!built.ok) {
      el.status.textContent = built.reason;
      return;
    }
    try {
      await window.tentDesktop.rpc("task.sendInput", built.payload);
      el.status.textContent = "补充指令已发送。";
      await Promise.all([reloadTasks(), reloadPendingInteractions()]);
    } catch (err) {
      setError(err);
    }
  });
}

export function renderSessions(): void {
  const relatedTasks = tasksForActiveNode();
  const taskIds = new Set(relatedTasks.map((task) => task.id).filter(Boolean));
  const sessionIds = new Set(relatedTasks.map((task) => task.sessionId).filter(Boolean));
  const related = sessions.filter(
    (session) =>
      sessionIds.has(session.sessionId) || (!!session.lastTaskId && taskIds.has(session.lastTaskId))
  );
  el.session.hidden = related.length === 0;
  el.session.innerHTML = related
    .map(
      (session) => `<div class="session-row"><span class="session-dot ${session.alive ? "is-live" : ""}" aria-hidden="true"></span>
    <span>${escapeHtml(session.roleId || session.connectionId || session.sessionId)}</span><span class="muted">${escapeHtml(sessionStateLabel(session.state) || session.state)}</span></div>`
    )
    .join("");
}

export function renderTasks(): void {
  const visibleTasks = actionableTasks();
  if (el.taskCount) {
    const n = visibleTasks.length + pendingInteractionCount();
    el.taskCount.hidden = n === 0;
    el.taskCount.textContent = String(n);
  }
  // 有任务时确保待处理展开；空则收起
  if (el.secPending) {
    if (visibleTasks.length > 0 || pendingInteractionCount() > 0) {
      el.secPending.open = true;
      if (el.secDispatch) el.secDispatch.open = false;
      if (el.secCards) el.secCards.open = false;
    } else if (!el.secDispatch?.open && !el.secCards?.open) {
      el.secPending.open = false;
    }
  }
  if (!visibleTasks.length) {
    el.tasks.innerHTML = "";
    return;
  }

  el.tasks.innerHTML =
    visibleTasks
      .map((t) => {
        // 谁 / 在做什么 / 一句摘要 / 动作；id/path/状态字收进详情
        const who = escapeHtml(taskExecutionLabel(t));
        // 主行不裸露 cx-/rl-/tk- 等技术 id
        const nodeIds = [...(t.workNodeIds || []), ...(t.contextNodeIds || [])].filter(
          (c) => c !== "root" && !/^(cx|rl|tk|ss|dl|ti)-/i.test(c)
        );
        const claimBit = nodeIds.length
          ? `<span class="task-claims muted">${nodeIds.map((c) => escapeHtml(c)).join(" · ")}</span>`
          : "";
        const blurbRaw = t.deliverySummary || t.prompt || "";
        const blurb = blurbRaw
          ? `<div class="task-summary">${escapeHtml(blurbRaw.length > 120 ? blurbRaw.slice(0, 117) + "…" : blurbRaw)}</div>`
          : "";
        const stateLabel = taskStateLabel(t.state);
        const sessLabel = t.sessionState ? sessionStateLabel(t.sessionState) : "";
        const rejectDraft = rejectDrafts.get(t.path) || "";

        const startBtn = t.canStartAgent
          ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}" title="启动 agent">启动</button>`
          : "";
        const interruptBtn = t.canInterrupt
          ? `<button type="button" class="btn btn-ghost" data-interrupt="${escapeHtml(t.path)}" title="中断">中断</button>`
          : "";
        const cancelBtn = t.canCancel
          ? `<button type="button" class="btn btn-ghost" data-cancel="${escapeHtml(t.path)}" title="取消任务">取消</button>`
          : "";
        const reviewActions = t.canAcceptOrReject
          ? `<div class="task-primary-row">
              <button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}" data-delivery="${escapeHtml(t.activeDeliveryId || "")}">确认</button>
              <button type="button" class="btn btn-ghost" data-reject-toggle="${escapeHtml(t.path)}" aria-expanded="false">驳回</button>
            </div>
            <div class="reject-panel" data-reject-panel="${escapeHtml(t.path)}" hidden>
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="驳回原因" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="${btnClass("danger")}" data-reject="${escapeHtml(t.path)}" data-delivery="${escapeHtml(t.activeDeliveryId || "")}">确认驳回</button>
            </div>`
          : "";
        const actions =
          startBtn || interruptBtn || cancelBtn || reviewActions
            ? `<div class="task-actions">${startBtn}${interruptBtn}${cancelBtn}${reviewActions}</div>`
            : "";

        return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div class="task-head">
          <strong>${who}</strong>
          ${claimBit}
        </div>
        ${blurb}
        ${actions}
        <details class="task-details">
          <summary>详情</summary>
          <div class="task-detail-body muted">
            <div>${escapeHtml(stateLabel)}${sessLabel ? ` · ${escapeHtml(sessLabel)}` : ""}</div>
            <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
            ${
              t.commits.length > 0
                ? `<div>${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>`
                : ""
            }
          </div>
        </details>
      </li>`;
      })
      .join("");

  el.tasks.querySelectorAll<HTMLElement>("[data-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStartAgent(btn.getAttribute("data-start")!));
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt(btn.getAttribute("data-interrupt")!));
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => void onCancelTask(btn.getAttribute("data-cancel")!));
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-accept]").forEach((btn) => {
    btn.addEventListener("click", () =>
      void onAccept(btn.getAttribute("data-accept")!, btn.getAttribute("data-delivery")!)
    );
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-reject-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-reject-toggle")!;
      const item = btn.closest(".task-item");
      const panel = item?.querySelector("[data-reject-panel]");
      if (!(panel instanceof HTMLElement)) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        const reason = panel.querySelector("[data-reject-reason]");
        if (reason instanceof HTMLInputElement) reason.focus();
      }
    });
  });
  el.tasks.querySelectorAll<HTMLInputElement>("[data-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-reject-reason")!, input.value);
    });
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () =>
      void onReject(btn.getAttribute("data-reject")!, btn.getAttribute("data-delivery")!)
    );
  });
}

function taskExecutionLabel(task: {
  roleId?: string;
  sessionId?: string;
  sessionConnectionId?: string;
}): string {
  return task.roleId || task.sessionConnectionId || task.sessionId || "Session";
}

/**
 * User-clicked start: task.startSession with callerKind=user.
 * Dispatch remains a separate action — never auto-spends tokens.
 */
async function onStartAgent(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath);
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      callerKind: built.payload.callerKind,
    })) as {
      session?: { sessionId?: string; state?: string };
      task?: { state?: string };
    };
    const sid = result.session?.sessionId;
    const st = result.session?.state || result.task?.state || "";
    el.status.textContent = sid
      ? `已启动 agent · ${sid}${st ? `（${sessionStateLabel(st) || st}）` : ""}`
      : `已启动 agent · ${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
    await reloadTasks().catch(() => undefined);
  }
}

async function onInterrupt(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", {
      workspaceId,
      taskPath,
    });
    el.status.textContent = `已中断：${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}

async function onCancelTask(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  if (!window.confirm("取消该任务？未交付的进度将终止。")) return;
  try {
    await window.tentDesktop.rpc("task.cancel", {
      workspaceId,
      taskPath,
    });
    el.status.textContent = `已取消：${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}

async function onAccept(taskPath: string, deliveryId: string): Promise<void> {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, deliveryId, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      deliveryId: payload.deliveryId,
      actor: payload.actor,
    });
    el.status.textContent = `已确认交付：${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}

async function onReject(taskPath: string, deliveryId: string): Promise<void> {
  if (!workspaceId) return;
  const reason = rejectDrafts.get(taskPath) || "";
  const built = buildRejectPayload(taskPath, deliveryId, reason, "user");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.reject", {
      workspaceId,
      taskPath: built.payload.taskPath,
      deliveryId: built.payload.deliveryId,
      actor: built.payload.actor,
      note: built.payload.note,
      resume: built.payload.resume,
    });
    el.status.textContent = `已驳回：${taskPath}`;
    rejectDrafts.delete(taskPath);
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}

export async function loadCards(): Promise<void> {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = "";
    return;
  }
  el.cards.innerHTML = cards
    .map(
      (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}" title="${escapeHtml(c.kind)}/${escapeHtml(c.refId)}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
      </li>`
    )
    .join("");
  el.cards.querySelectorAll<HTMLElement>("[data-card-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-card-idx"));
    const card = cards[idx];
    if (!card?.text) return;
    // HTML5 text/plain only — no clipboard IPC on dragstart.
    bindContextCardDrag(node, card.text, {
      onCopied: () => {
        el.status.textContent = "已复制";
      },
      onCopyError: (err) => setError(err),
    });
  });
}

export async function onEmitCard(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "请先打开一个概念。";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "node",
    id: tab.nodeId,
    path: tab.path,
    label: tab.name,
  });
  await loadCards();
  el.status.textContent = "上下文卡已就绪 — 左键拖到外部输入框（text/plain）。";
}
