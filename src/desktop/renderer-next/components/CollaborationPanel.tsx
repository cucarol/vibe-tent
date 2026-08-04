import { useMemo, useState } from "react";
import { Button, Checkbox, Radio, Select, StatusBadge, TextField } from "../ui/index.js";
import { nodeTitle, taskStateLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";
import type {
  AcceptMode,
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
  CollaborationTask,
  DecisionRequest,
  ReadyDelivery,
  DecisionResponse,
} from "../model/collaboration-surface-controller.js";

export type CollaborationPanelProps = {
  node: WorkbenchNodeView;
  allNodes: readonly WorkbenchNodeView[];
  view: CollaborationSurfaceView;
  actions: CollaborationSurfaceActions;
};

export function collaborationPanelIdentity(view: CollaborationSurfaceView): string {
  return `${view.workspaceId ?? "none"}:${view.nodeId ?? "none"}`;
}

function acceptModeLabel(mode: AcceptMode): string {
  if (mode === "auto-accept") return "自动接受";
  if (mode === "agent-decide") return "执行者决定";
  return "需要审阅";
}

function acceptModeHelp(mode: AcceptMode): string {
  if (mode === "auto-accept") return "完成后先生成交付；自动集成失败时仍会进入人工审阅。";
  if (mode === "agent-decide") return "执行者选择直接集成或请求人工审阅。";
  return "完成后必须由你接受或驳回。";
}

function sessionSummary(task: CollaborationTask): string {
  if (!task.session) return "尚未绑定运行会话";
  if (task.session.turnBusy) return "会话正在处理";
  if (task.session.alive) return `会话在线 · ${task.session.state}`;
  return `会话离线 · ${task.session.state}`;
}

function formatUpdatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "更新时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function canSubmitDispatchDraft(input: {
  canMutate: boolean;
  busy: boolean;
  targetId: string;
  prompt: string;
  primaryNodeId?: string;
  additionalWorkNodeIds?: readonly string[];
  contextNodeIds?: readonly string[];
}): boolean {
  const work = input.additionalWorkNodeIds ?? [];
  const context = input.contextNodeIds ?? [];
  const primary = input.primaryNodeId;
  const distinct = new Set(work).size === work.length && new Set(context).size === context.length;
  const separated = work.every((id) => id !== primary && !context.includes(id));
  return input.canMutate && !input.busy && distinct && separated &&
    Boolean(input.targetId && input.prompt.trim());
}

export type OrderedDispatchNodeDraft = {
  additionalWorkNodeIds: string[];
  contextNodeIds: string[];
};

export function updateOrderedDispatchNodes(
  draft: OrderedDispatchNodeDraft,
  nodeId: string,
  destination: "work" | "context" | "none"
): OrderedDispatchNodeDraft {
  const additionalWorkNodeIds = draft.additionalWorkNodeIds.filter((id) => id !== nodeId);
  const contextNodeIds = draft.contextNodeIds.filter((id) => id !== nodeId);
  if (destination === "work") additionalWorkNodeIds.push(nodeId);
  if (destination === "context") contextNodeIds.push(nodeId);
  return { additionalWorkNodeIds, contextNodeIds };
}

export function decisionResponseFromDraft(input: {
  customMode: boolean;
  optionId: string;
  custom: string;
}): DecisionResponse | null {
  if (input.customMode) {
    const text = input.custom.trim();
    return text ? { kind: "custom", text } : null;
  }
  return input.optionId ? { kind: "option", optionId: input.optionId } : null;
}

function ResourceNotice({ view }: { view: CollaborationSurfaceView }) {
  if (view.status === "ready") return null;
  if ((view.status === "loading" || view.status === "refreshing") && !view.snapshot) {
    return <div className="tn-collaboration-state" role="status"><strong>正在读取协作状态</strong><span>任务、交付和决策会在权威投影返回后显示。</span></div>;
  }
  const title = view.status === "error" ? "协作数据不可用" : "协作数据正在刷新";
  return (
    <div className="tn-collaboration-state" data-state={view.status} role={view.status === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      <span>{view.issue?.message ?? "保留上次读取结果，但当前不允许提交任何操作。"}</span>
    </div>
  );
}

function ActiveTaskSection({ task }: { task: CollaborationTask }) {
  return (
    <section className="tn-collaboration-section" aria-labelledby="tn-active-task-title">
      <div className="tn-section-heading">
        <h2 id="tn-active-task-title">当前任务</h2>
        <StatusBadge tone="running">{taskStateLabel(task.state)}</StatusBadge>
      </div>
      <div className="tn-active-task">
        <strong>{task.assignee?.label ?? "执行者状态未知"}</strong>
        <span>{acceptModeLabel(task.acceptMode)} · {task.contextNodeIds.length} 个上下文节点</span>
        <span data-session-state={task.session?.state ?? "unbound"}>{sessionSummary(task)}</span>
        <span>{acceptModeHelp(task.acceptMode)}</span>
        {task.updatedAt ? <time dateTime={task.updatedAt}>最近更新 {formatUpdatedAt(task.updatedAt)}</time> : null}
      </div>
    </section>
  );
}

function DispatchSection({ node, allNodes, view, actions, activeTask }: CollaborationPanelProps & { activeTask: CollaborationTask | null }) {
  const [open, setOpen] = useState(false);
  const targets = view.snapshot?.targets ?? [];
  const [targetKind, setTargetKind] = useState<"role" | "connection">("role");
  const availableTargets = targets.filter((target) => target.kind === targetKind);
  const [targetId, setTargetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [acceptMode, setAcceptMode] = useState<AcceptMode>("review-required");
  const [nodeDraft, setNodeDraft] = useState<OrderedDispatchNodeDraft>({
    additionalWorkNodeIds: [],
    contextNodeIds: [],
  });
  const [error, setError] = useState<string | null>(null);
  const resolvedTarget = availableTargets.some((target) => target.id === targetId)
    ? targetId
    : "";
  const busy = view.busyKey === "dispatch";
  const disabled = !canSubmitDispatchDraft({
    canMutate: view.canMutate,
    busy,
    targetId: resolvedTarget,
    prompt,
    primaryNodeId: node.nodeId,
    additionalWorkNodeIds: nodeDraft.additionalWorkNodeIds,
    contextNodeIds: nodeDraft.contextNodeIds,
  });

  const submit = async () => {
    if (disabled) return;
    setError(null);
    const ok = await actions.dispatch({
      workNodeIds: [node.nodeId, ...nodeDraft.additionalWorkNodeIds],
      contextNodeIds: nodeDraft.contextNodeIds,
      prompt: prompt.trim(),
      acceptMode,
      target: { kind: targetKind, id: resolvedTarget },
    });
    if (ok) {
      setPrompt("");
      setNodeDraft({ additionalWorkNodeIds: [], contextNodeIds: [] });
    } else {
      setError("派活未完成；已重新读取权威任务状态。");
    }
  };

  if (activeTask) return null;
  if (!open) {
    return (
      <section className="tn-collaboration-section tn-dispatch-entry" aria-labelledby="tn-dispatch-entry-title">
        <div><h2 id="tn-dispatch-entry-title">协作</h2><p>这个节点目前没有任务。需要时可交给角色或 Agent 连接。</p></div>
        <Button variant="primary" size="compact" disabled={!view.canMutate} onClick={() => setOpen(true)}>派活</Button>
      </section>
    );
  }
  return (
    <section className="tn-collaboration-section tn-dispatch" aria-labelledby="tn-dispatch-title">
      <div className="tn-section-heading"><h2 id="tn-dispatch-title">派活</h2><Button variant="ghost" size="compact" onClick={() => setOpen(false)}>收起</Button></div>
      <div className="tn-control-pair">
        <Select
          label="交给"
          value={targetKind}
          disabled={!view.canMutate}
          onChange={(event) => { setTargetKind(event.target.value as "role" | "connection"); setTargetId(""); }}
          options={[{ value: "role", label: "角色" }, { value: "connection", label: "Agent 连接" }]}
        />
        <Select
          label={targetKind === "role" ? "角色" : "Agent 连接"}
          value={resolvedTarget}
          disabled={!view.canMutate || availableTargets.length === 0}
          onChange={(event) => setTargetId(event.target.value)}
          options={availableTargets.map((target) => ({ value: target.id, label: target.label }))}
          placeholder={availableTargets.length ? "请选择目标" : "暂无可用目标"}
        />
      </div>
      <TextField
        multiline
        label="任务说明"
        value={prompt}
        rows={4}
        disabled={!view.canMutate}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="说明目标、约束与可验证结果"
      />
      <Select
        label="交付方式"
        value={acceptMode}
        disabled={!view.canMutate}
        onChange={(event) => setAcceptMode(event.target.value as AcceptMode)}
        options={[
          { value: "review-required", label: "需要审阅" },
          { value: "auto-accept", label: "自动接受" },
          { value: "agent-decide", label: "执行者决定" },
        ]}
        hint="这是创建时冻结的机制，不是显示偏好。"
      />
      <details className="tn-context-picker">
        <summary>共同工作节点 <span>{nodeDraft.additionalWorkNodeIds.length ? `已选 ${nodeDraft.additionalWorkNodeIds.length}` : "可选"}</span></summary>
        <div>
          {allNodes.filter((item) => item.nodeId !== node.nodeId && item.projectionState === "ready").map((item) => {
            const checked = nodeDraft.additionalWorkNodeIds.includes(item.nodeId);
            return (
              <Checkbox
                  key={item.nodeId}
                  checked={checked}
                  disabled={!view.canMutate}
                  onChange={() => setNodeDraft((current) => updateOrderedDispatchNodes(
                    current,
                    item.nodeId,
                    checked ? "none" : "work"
                  ))}
                  label={nodeTitle(item)}
                />
            );
          })}
        </div>
      </details>
      <details className="tn-context-picker">
        <summary>参考上下文 <span>{nodeDraft.contextNodeIds.length ? `已选 ${nodeDraft.contextNodeIds.length}` : "可选"}</span></summary>
        <div>
          {allNodes.filter((item) => item.nodeId !== node.nodeId && item.projectionState === "ready").map((item) => {
            const checked = nodeDraft.contextNodeIds.includes(item.nodeId);
            return (
              <Checkbox
                key={item.nodeId}
                checked={checked}
                disabled={!view.canMutate}
                onChange={() => setNodeDraft((current) => updateOrderedDispatchNodes(
                  current,
                  item.nodeId,
                  checked ? "none" : "context"
                ))}
                label={nodeTitle(item)}
              />
            );
          })}
        </div>
      </details>
      {error || view.actionIssue ? <p className="tn-action-error" role="alert">{error ?? view.actionIssue?.message}</p> : null}
      <Button variant="primary" loading={busy} disabled={disabled} onClick={() => void submit()}>派发任务</Button>
    </section>
  );
}

function DeliveryItem({ delivery, task, view, actions }: { delivery: ReadyDelivery; task: CollaborationTask | null; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = view.busyKey === `delivery:${delivery.id}`;
  const accept = async () => {
    setError(null);
    if (!await actions.acceptDelivery(delivery.taskPath, delivery.id)) setError("接受未完成；已重新读取交付状态。");
  };
  const reject = async () => {
    if (!note.trim()) { setError("请说明驳回原因。"); return; }
    setError(null);
    if (await actions.rejectDelivery(delivery.taskPath, delivery.id, note.trim())) {
      setRejecting(false);
      setNote("");
    } else setError("驳回未完成；已重新读取交付状态。");
  };
  return (
    <article className="tn-inbox-item" data-kind="delivery" aria-busy={busy || undefined}>
      <div className="tn-inbox-item-heading"><strong>待审交付</strong><StatusBadge tone="warning">待确认</StatusBadge></div>
      <p>{delivery.summary || "交付者没有提供摘要。"}</p>
      {task ? <p className="tn-secondary-notice">这份候选来自“{acceptModeLabel(task.acceptMode)}”机制；当前已进入正式人工审阅。</p> : null}
      {rejecting ? (
        <div className="tn-inline-form">
          <TextField multiline label="驳回原因" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} error={error ?? undefined} />
          <div><Button size="compact" variant="quiet" disabled={busy} onClick={() => { setRejecting(false); setError(null); }}>取消</Button><Button size="compact" variant="danger" loading={busy} onClick={() => void reject()}>确认驳回</Button></div>
        </div>
      ) : (
        <div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate} onClick={() => setRejecting(true)}>驳回</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate} onClick={() => void accept()}>接受</Button></div>
      )}
      {error && !rejecting ? <p className="tn-action-error" role="alert">{error}</p> : null}
    </article>
  );
}

function DecisionItem({ request, view, actions }: { request: DecisionRequest; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [optionId, setOptionId] = useState("");
  const [custom, setCustom] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = view.busyKey === `decision:${request.id}`;
  const response = decisionResponseFromDraft({ customMode, optionId, custom });
  const respond = async () => {
    if (!response) {
      setError("请选择一个选项，或填写自定义回复。");
      return;
    }
    setError(null);
    if (!await actions.respondDecision(request.taskPath, request.id, response)) setError("回复未完成；已重新读取决策请求。");
  };
  const deny = async () => {
    setError(null);
    if (!await actions.respondDecision(request.taskPath, request.id, { kind: "deny" })) setError("拒绝未完成；已重新读取决策请求。");
  };
  return (
    <article className="tn-inbox-item" data-kind="decision" aria-busy={busy || undefined}>
      <div className="tn-inbox-item-heading"><strong>需要你的决定</strong><StatusBadge tone="warning">待回复</StatusBadge></div>
      <p>{request.question}</p>
      <fieldset className="tn-decision-options" disabled={!view.canMutate || busy}>
          <legend>选择回复</legend>
          {request.options.map((option) => (
            <Radio
              key={option.id}
              name={`decision-${request.id}`}
              value={option.id}
              checked={!customMode && optionId === option.id}
              onChange={() => { setCustomMode(false); setOptionId(option.id); }}
              label={option.label}
            />
          ))}
          <Radio
            name={`decision-${request.id}`}
            checked={customMode}
            onChange={() => setCustomMode(true)}
            label="自定义回复"
          />
      </fieldset>
      {customMode ? <TextField multiline label="自定义回复" rows={3} value={custom} disabled={!view.canMutate || busy} onChange={(event) => setCustom(event.target.value)} /> : null}
      {error ? <p className="tn-action-error" role="alert">{error}</p> : null}
      <div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate || busy} onClick={() => void deny()}>拒绝此次请求</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate || busy || !response} onClick={() => void respond()}>提交回复</Button></div>
    </article>
  );
}

function InboxSection({ view, actions }: Pick<CollaborationPanelProps, "view" | "actions">) {
  if (!view.snapshot) return null;
  const delivery = view.snapshot?.delivery ?? null;
  const decisions = view.snapshot?.decisions ?? [];
  const total = (delivery ? 1 : 0) + decisions.length;
  if (!total) return null;
  return (
    <section className="tn-collaboration-section tn-inbox" aria-labelledby="tn-inbox-title">
      <div className="tn-section-heading"><h2 id="tn-inbox-title">待我处理</h2>{total ? <StatusBadge tone="warning">{total}</StatusBadge> : null}</div>
      {decisions.map((request) => <DecisionItem key={request.id} request={request} view={view} actions={actions} />)}
      {delivery ? <DeliveryItem key={delivery.id} delivery={delivery} task={view.snapshot?.task ?? null} view={view} actions={actions} /> : null}
    </section>
  );
}

export function CollaborationPanel(props: CollaborationPanelProps) {
  const task = useMemo(() => props.view.snapshot?.task ?? null, [props.view.snapshot]);
  return (
    <div
      className="tn-collaboration-panel"
      data-collaboration-status={props.view.status}
      data-collaboration-identity={collaborationPanelIdentity(props.view)}
    >
      <ResourceNotice view={props.view} />
      {task ? <ActiveTaskSection task={task} /> : null}
      <InboxSection view={props.view} actions={props.actions} />
      {props.view.snapshot ? <DispatchSection {...props} activeTask={task} /> : null}
      {props.view.status === "error" || props.view.status === "stale" ? (
        <Button variant="quiet" size="compact" onClick={() => void props.actions.retry()}>重新读取协作状态</Button>
      ) : null}
    </div>
  );
}
