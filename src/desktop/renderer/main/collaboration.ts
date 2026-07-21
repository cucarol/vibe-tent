// Collaboration inspector: pending A2U/A2A/tool, task list, U2A, sessions, cards.

import { escapeHtml } from "../../../markdown/render.js";
import {
  buildAcceptPayload,
  buildRejectPayload,
  buildStartSessionPayload,
  sessionStateLabel,
  taskStateLabel,
} from "../../workbench/collaboration-ui.js";
import { bindContextCardDrag } from "../context-card-drag.js";
import { el, setError } from "./elements.js";
import { syncInspectorSections } from "./inspector.js";
import { btnClass } from "./ui.js";
import {
  a2aApprovals,
  actionableTasks,
  activeCx,
  localTabs,
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
  tasksForActiveNode,
  toolApprovals,
  userAsks,
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
  const asks = userAsks
    .map((ask) => {
      const choices = (ask.choices || [])
        .map(
          (choice) => `<label class="choice-row">
      <input type="radio" name="ask-choice-${escapeHtml(ask.id)}" value="${escapeHtml(choice.id)}" />
      <span>${escapeHtml(choice.label)}</span></label>`
        )
        .join("");
      return `<article class="interaction-item" data-ask-item="${escapeHtml(ask.id)}">
      <div class="interaction-kicker">AGENT QUESTION · ${escapeHtml(ask.role || "Agent")}</div>
      <div class="interaction-title">${escapeHtml(ask.question)}</div>
      ${choices ? `<div class="choice-list">${choices}</div>` : ""}
      <textarea class="line-input" data-ask-answer="${escapeHtml(ask.id)}" rows="2" placeholder="补充说明（可选）"></textarea>
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-ask-reply="${escapeHtml(ask.id)}">回复</button>
      <button type="button" class="btn btn-ghost" data-ask-deny="${escapeHtml(ask.id)}">拒绝提问</button>
      <button type="button" class="btn btn-ghost" data-task-stop="${escapeHtml(ask.taskPath)}">中断任务</button></div>
    </article>`;
    })
    .join("");
  const a2a = a2aApprovals
    .map(
      (item) => `<article class="interaction-item">
    <div class="interaction-kicker">A2A APPROVAL</div>
    <div class="interaction-title">${escapeHtml(item.role)} 请求启动 ${escapeHtml(item.profileId)}</div>
    <div class="muted interaction-note">${escapeHtml(item.taskPath)}</div>
    <div class="interaction-actions"><button type="button" class="btn btn-primary" data-a2a-allow="${escapeHtml(item.id)}">允许一次</button>
    <button type="button" class="btn btn-ghost" data-a2a-deny="${escapeHtml(item.id)}">拒绝</button></div>
  </article>`
    )
    .join("");
  const tools = toolApprovals
    .map((item) => {
      const summary = (item.options || [])
        .map((option) => option.name || option.kind || option.optionId)
        .filter(Boolean)
        .join(" · ");
      return `<article class="interaction-item">
      <div class="interaction-kicker">TOOL PERMISSION</div><div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
      <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} · ${escapeHtml(item.sessionId)}</div>
      ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-tool-allow="${escapeHtml(item.id)}">允许一次</button>
      <button type="button" class="btn btn-ghost" data-tool-deny="${escapeHtml(item.id)}">拒绝</button></div>
    </article>`;
    })
    .join("");
  const proposalItems = proposals
    .map((p) => {
      const body = (p.body || "").trim();
      const preview = body.length > 160 ? body.slice(0, 157) + "…" : body;
      return `<article class="interaction-item" data-proposal-path="${escapeHtml(p.path)}">
      <div class="interaction-kicker">PROPOSAL · ${escapeHtml(p.role || "Agent")}</div>
      <div class="interaction-title">${escapeHtml(preview || p.path)}</div>
      <div class="muted interaction-note">${escapeHtml(p.boxId || "")} · ${escapeHtml(p.path)}</div>
      <div class="interaction-actions">
        <button type="button" class="btn btn-primary" data-proposal-accept="${escapeHtml(p.path)}">采纳</button>
        <button type="button" class="btn btn-ghost" data-proposal-reject="${escapeHtml(p.path)}">驳回</button>
      </div>
    </article>`;
    })
    .join("");
  el.a2u.innerHTML = asks + a2a + tools + proposalItems;
  el.a2u
    .querySelectorAll<HTMLElement>("[data-ask-reply]")
    .forEach((button) =>
      button.addEventListener("click", () => void onReplyUserAsk(button.getAttribute("data-ask-reply")!))
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-ask-deny]")
    .forEach((button) =>
      button.addEventListener("click", () => void onDenyUserAsk(button.getAttribute("data-ask-deny")!))
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
    .querySelectorAll<HTMLElement>("[data-a2a-allow]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        void onResolveA2A(button.getAttribute("data-a2a-allow")!, "approve")
      )
    );
  el.a2u
    .querySelectorAll<HTMLElement>("[data-a2a-deny]")
    .forEach((button) =>
      button.addEventListener("click", () => void onResolveA2A(button.getAttribute("data-a2a-deny")!, "deny"))
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

async function onReplyUserAsk(askId: string): Promise<void> {
  const item = el.a2u.querySelector<HTMLElement>(`[data-ask-item="${CSS.escape(askId)}"]`);
  const answer = item?.querySelector<HTMLTextAreaElement>("[data-ask-answer]")?.value.trim() || "";
  const choiceId = item?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value || "";
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
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onDenyUserAsk(askId: string): Promise<void> {
  try {
    await window.tentDesktop.rpc("userAsk.deny", { askId, actor: "user" });
    el.status.textContent = "已拒绝 Agent 提问。";
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

async function onResolveA2A(approvalId: string, decision: "approve" | "deny"): Promise<void> {
  try {
    await window.tentDesktop.rpc("a2a.resolve", { approvalId, decision, actor: "user" });
    el.status.textContent = decision === "approve" ? "已允许启动 Agent。" : "已拒绝启动 Agent。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onResolveTool(approvalId: string, allow: boolean): Promise<void> {
  try {
    await window.tentDesktop.rpc(allow ? "toolApproval.approveOnce" : "toolApproval.deny", {
      approvalId,
      actor: "user",
    });
    el.status.textContent = allow ? "已允许本次工具调用。" : "已拒绝工具调用。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

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
        `<option value="${escapeHtml(task.path)}">${escapeHtml(task.role)} · ${escapeHtml(taskStateLabel(task.state, task.status))}</option>`
    )
    .join("");
  el.u2a.innerHTML = `<article class="interaction-item u2a-item"><div class="interaction-kicker">追加任务输入</div>
    ${candidates.length > 1 ? `<select id="u2a-task" class="field">${options}</select>` : ""}
    <textarea id="u2a-text" class="line-input" rows="2" placeholder="发送一次性补充指令"></textarea>
    <div class="interaction-actions"><button type="button" id="btn-send-task-input" class="btn btn-secondary">发送</button></div></article>`;
  document.getElementById("btn-send-task-input")?.addEventListener("click", async () => {
    const text = (document.getElementById("u2a-text") as HTMLTextAreaElement | null)?.value.trim() || "";
    const taskPath =
      (document.getElementById("u2a-task") as HTMLSelectElement | null)?.value || candidates[0]!.path;
    if (!text) {
      el.status.textContent = "请填写补充指令。";
      return;
    }
    try {
      await window.tentDesktop.rpc("task.sendInput", {
        workspaceId,
        taskPath,
        text,
        actor: "user",
      });
      el.status.textContent = "补充指令已发送。";
      await reloadTasks();
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
    <span>${escapeHtml(session.roleName || session.profileId)}</span><span class="muted">${escapeHtml(sessionStateLabel(session.state) || session.state)}</span></div>`
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

  const profileOpts =
    profiles.length > 0
      ? profiles
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}"${p.id === selectedProfileId ? " selected" : ""}>${escapeHtml(p.label)}</option>`
          )
          .join("")
      : `<option value="">（无 profile）</option>`;

  const anyStartable = visibleTasks.some((t) => t.canStartAgent);
  const profileBar = anyStartable
    ? `<li class="task-profile-bar">
        <label class="sr-only" for="agent-profile">profile</label>
        <select id="agent-profile" title="profile"${profiles.length ? "" : " disabled"}>${profileOpts}</select>
      </li>`
    : "";

  el.tasks.innerHTML =
    profileBar +
    visibleTasks
      .map((t) => {
        // 谁 / 在做什么 / 一句摘要 / 动作；id/path/状态字收进详情
        const who = escapeHtml(t.role);
        // 主行不裸露 cx-/rl-/tk- 等技术 id
        const claims = (t.claims || []).filter(
          (c) => c !== "root" && !/^(cx|rl|tk|ss|dl|ti)-/i.test(c)
        );
        const claimBit = claims.length
          ? `<span class="task-claims muted">${claims.map((c) => escapeHtml(c)).join(" · ")}</span>`
          : "";
        const blurbRaw = t.deliverySummary || t.prompt || "";
        const blurb = blurbRaw
          ? `<div class="task-summary">${escapeHtml(blurbRaw.length > 120 ? blurbRaw.slice(0, 117) + "…" : blurbRaw)}</div>`
          : "";
        const stateLabel = taskStateLabel(t.state, t.status);
        const sessLabel = t.sessionState ? sessionStateLabel(t.sessionState) : "";
        const rejectDraft = rejectDrafts.get(t.path) || "";

        const startBtn = t.canStartAgent
          ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}"${
              profiles.length && selectedProfileId ? "" : " disabled"
            } title="启动 agent">启动</button>`
          : "";
        const interruptBtn = t.canInterrupt
          ? `<button type="button" class="btn btn-ghost" data-interrupt="${escapeHtml(t.path)}" title="中断">中断</button>`
          : "";
        const cancelBtn = t.canCancel
          ? `<button type="button" class="btn btn-ghost" data-cancel="${escapeHtml(t.path)}" title="取消任务">取消</button>`
          : "";
        const reviewActions = t.canAcceptOrReject
          ? `<div class="task-primary-row">
              <button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}">确认</button>
              <button type="button" class="btn btn-ghost" data-reject-toggle="${escapeHtml(t.path)}" aria-expanded="false">驳回</button>
            </div>
            <div class="reject-panel" data-reject-panel="${escapeHtml(t.path)}" hidden>
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="驳回原因" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="${btnClass("danger")}" data-reject="${escapeHtml(t.path)}">确认驳回</button>
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

  const profileSel = document.getElementById("agent-profile") as HTMLSelectElement | null;
  profileSel?.addEventListener("change", () => {
    setSelectedProfileId(profileSel.value || null);
    renderTasks();
  });

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
    btn.addEventListener("click", () => void onAccept(btn.getAttribute("data-accept")!));
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
    btn.addEventListener("click", () => void onReject(btn.getAttribute("data-reject")!));
  });
}

/**
 * User-clicked start: task.startSession with callerKind=user.
 * Dispatch remains a separate action — never auto-spends tokens.
 */
async function onStartAgent(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath, selectedProfileId || "");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
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
    kind: "box",
    id: tab.cx,
    path: tab.path,
    label: tab.name,
  });
  await loadCards();
  el.status.textContent = "上下文卡已就绪 — 左键拖到外部输入框（text/plain）。";
}
