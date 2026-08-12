import { useState } from "react";
import { Button, Checkbox, Radio, Select, StatusBadge, TextField } from "../ui/index.js";
import { nodeTitle, type WorkbenchNodeView } from "../shell/workbench-types.js";
import type {
  AcceptMode,
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
  DecisionResponse,
} from "../model/collaboration-surface-controller.js";
import type {
  CollaborationActiveTask,
  CollaborationDecision,
  CollaborationDelivery,
} from "../model/workspace-collaboration-view.js";

export type CollaborationPanelProps = {
  node: WorkbenchNodeView;
  allNodes: readonly WorkbenchNodeView[];
  view: CollaborationSurfaceView;
  actions: CollaborationSurfaceActions;
};

export function collaborationPanelIdentity(view: CollaborationSurfaceView): string {
  return `${view.workspaceId ?? "none"}:${view.nodeId ?? "none"}`;
}

function progressLabel(state: string): string {
  if (state === "delivered") return "已返回";
  if (state === "waiting") return "等待决定";
  if (state === "failed" || state === "interrupted" || state === "rejected") return "未完成";
  if (state === "accepted") return "已接纳";
  return "处理中";
}

export function canSubmitDispatchDraft(input: {
  canMutate: boolean; busy: boolean; targetId: string; prompt: string;
  primaryNodeId?: string; additionalWorkNodeIds?: readonly string[]; contextNodeIds?: readonly string[];
}): boolean {
  const work = input.additionalWorkNodeIds ?? [];
  const context = input.contextNodeIds ?? [];
  const primary = input.primaryNodeId;
  return input.canMutate && !input.busy && Boolean(input.targetId && input.prompt.trim()) &&
    new Set(work).size === work.length && new Set(context).size === context.length &&
    work.every((id) => id !== primary && !context.includes(id));
}

export type OrderedDispatchNodeDraft = { additionalWorkNodeIds: string[]; contextNodeIds: string[] };
export function updateOrderedDispatchNodes(draft: OrderedDispatchNodeDraft, nodeId: string, destination: "work" | "context" | "none"): OrderedDispatchNodeDraft {
  const additionalWorkNodeIds = draft.additionalWorkNodeIds.filter((id) => id !== nodeId);
  const contextNodeIds = draft.contextNodeIds.filter((id) => id !== nodeId);
  if (destination === "work") additionalWorkNodeIds.push(nodeId);
  if (destination === "context") contextNodeIds.push(nodeId);
  return { additionalWorkNodeIds, contextNodeIds };
}

export function decisionResponseFromDraft(input: { customMode: boolean; optionId: string; custom: string }): DecisionResponse | null {
  if (input.customMode) return input.custom.trim() ? { kind: "custom", text: input.custom.trim() } : null;
  return input.optionId ? { kind: "option", optionId: input.optionId } : null;
}

function ResourceNotice({ view }: { view: CollaborationSurfaceView }) {
  if (view.status === "ready") return null;
  const noSnapshot = !view.snapshot;
  const title = noSnapshot ? (view.status === "error" ? "协作内容不可用" : "正在读取协作内容") : "协作内容正在刷新";
  return <div className="tn-collaboration-state" data-state={view.status} role={view.status === "error" ? "alert" : "status"}>
    <strong>{title}</strong><span>{view.issue?.message ?? (noSnapshot ? "返回后会显示可执行操作。" : "保留已知内容，当前操作已暂停。")}</span>
  </div>;
}

function ActiveTaskSection({ task }: { task: CollaborationActiveTask }) {
  const owner = task.responsibility.kind === "role" ? task.responsibility.label : "由我负责";
  const execution = task.execution?.label;
  const progress = task.pendingDecision
    ? "等待你的决定"
    : task.readyDelivery
      ? task.responsibility.kind === "user"
        ? "内容已返回，等待接纳"
        : `内容已返回，等待${owner}接纳`
      : "工作正在推进";
  return <section className="tn-collaboration-section" aria-labelledby="tn-active-task-title">
    <div className="tn-section-heading"><h2 id="tn-active-task-title">委托进展</h2><StatusBadge tone="running">{progressLabel(task.state)}</StatusBadge></div>
    <div className="tn-active-task"><strong>{owner}</strong>{execution ? <span>执行：{execution}</span> : null}<span>{progress}</span></div>
  </section>;
}

function DispatchSection({ node, allNodes, view, actions }: CollaborationPanelProps) {
  const [open, setOpen] = useState(false);
  const [targetKind, setTargetKind] = useState<"role" | "connection">("role");
  const [targetId, setTargetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [acceptMode, setAcceptMode] = useState<AcceptMode>("review-required");
  const [nodeDraft, setNodeDraft] = useState<OrderedDispatchNodeDraft>({ additionalWorkNodeIds: [], contextNodeIds: [] });
  const [error, setError] = useState<string | null>(null);
  const targets = view.targets.filter((target) => target.kind === targetKind);
  const exactTargetId = targets.some((target) => target.id === targetId) ? targetId : "";
  const busy = view.busyKey === "dispatch";
  const disabled = !view.targetsReady || !canSubmitDispatchDraft({ canMutate: view.canMutate, busy, targetId: exactTargetId, prompt, primaryNodeId: node.nodeId, ...nodeDraft });
  const submit = async () => {
    if (disabled) return;
    setError(null);
    const ok = await actions.dispatch({ workNodeIds: [node.nodeId, ...nodeDraft.additionalWorkNodeIds], contextNodeIds: nodeDraft.contextNodeIds, prompt: prompt.trim(), acceptMode, target: { kind: targetKind, id: exactTargetId } });
    if (ok) { setPrompt(""); setNodeDraft({ additionalWorkNodeIds: [], contextNodeIds: [] }); }
    else setError("委托未完成；已重新读取当前状态。");
  };
  if (!open) return <section className="tn-collaboration-section tn-dispatch-entry"><div><h2>委托</h2><p>告诉 Tent 要做什么，再选择负责角色。</p></div><Button variant="primary" size="compact" disabled={!view.canMutate} onClick={() => setOpen(true)}>开始委托</Button></section>;
  const readyNodes = allNodes.filter((item) => item.nodeId !== node.nodeId && item.projectionState === "ready");
  return <section className="tn-collaboration-section tn-dispatch">
    <div className="tn-section-heading"><h2>委托</h2><Button variant="ghost" size="compact" onClick={() => setOpen(false)}>收起</Button></div>
    <TextField multiline label="要做什么" value={prompt} rows={4} disabled={!view.canMutate} onChange={(event) => setPrompt(event.target.value)} placeholder="说明目标、约束与完成标准" />
    <div className="tn-control-pair">
      <Select label="交给谁" value={targetKind} disabled={!view.canMutate} onChange={(event) => { setTargetKind(event.target.value as "role" | "connection"); setTargetId(""); }} options={[{ value: "role", label: "角色" }, { value: "connection", label: "直接使用连接" }]} />
      <Select label={targetKind === "role" ? "责任角色" : "执行连接"} value={exactTargetId} disabled={!view.canMutate || !view.targetsReady || targets.length === 0} onChange={(event) => setTargetId(event.target.value)} options={targets.map((target) => ({ value: target.id, label: target.label }))} placeholder={view.targetsReady ? "请选择" : "正在读取"} />
    </div>
    <Select label="完成后" value={acceptMode} disabled={!view.canMutate} onChange={(event) => setAcceptMode(event.target.value as AcceptMode)} options={[{ value: "review-required", label: "由我接纳" }, { value: "auto-accept", label: "符合条件时自动接纳" }, { value: "agent-decide", label: "由负责角色判断" }]} />
    {(["work", "context"] as const).map((kind) => <details className="tn-context-picker" key={kind}><summary>{kind === "work" ? "共同工作节点" : "参考上下文"}</summary><div>{readyNodes.map((item) => {
      const checked = (kind === "work" ? nodeDraft.additionalWorkNodeIds : nodeDraft.contextNodeIds).includes(item.nodeId);
      return <Checkbox key={item.nodeId} checked={checked} disabled={!view.canMutate} label={nodeTitle(item)} onChange={() => setNodeDraft((current) => updateOrderedDispatchNodes(current, item.nodeId, checked ? "none" : kind))} />;
    })}</div></details>)}
    {error || view.actionIssue || view.targetIssue ? <p className="tn-action-error" role="alert">{error ?? view.actionIssue?.message ?? view.targetIssue?.message}</p> : null}
    <Button variant="primary" loading={busy} disabled={disabled} onClick={() => void submit()}>交给对方</Button>
  </section>;
}

function DeliveryItem({ delivery, view, actions }: { delivery: CollaborationDelivery; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [rejecting, setRejecting] = useState(false); const [note, setNote] = useState(""); const [error, setError] = useState<string | null>(null);
  const busy = view.busyKey === `delivery:${delivery.deliveryId}`;
  return <article className="tn-inbox-item" data-kind="delivery"><div className="tn-inbox-item-heading"><strong>返回内容</strong><StatusBadge tone="warning">待接纳</StatusBadge></div><p>{delivery.summary || "对方没有提供摘要。"}</p>
    {rejecting ? <div className="tn-inline-form"><TextField multiline label="退回说明" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /><div><Button size="compact" variant="quiet" onClick={() => setRejecting(false)}>取消</Button><Button size="compact" variant="danger" disabled={!note.trim()} loading={busy} onClick={() => void actions.rejectDelivery(delivery.deliveryId, note.trim()).then((ok) => { if (!ok) setError("退回未完成。"); })}>退回修改</Button></div></div>
    : <div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate} onClick={() => setRejecting(true)}>退回</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate} onClick={() => void actions.acceptDelivery(delivery.deliveryId).then((ok) => { if (!ok) setError("接纳未完成。"); })}>接纳</Button></div>}
    {error ? <p className="tn-action-error" role="alert">{error}</p> : null}</article>;
}

function RoleDeliveryNotice({ delivery, owner }: { delivery: CollaborationDelivery; owner: string }) {
  return <article className="tn-inbox-item" data-kind="delivery" data-actionable="false">
    <div className="tn-inbox-item-heading"><strong>返回内容</strong><StatusBadge tone="neutral">等待负责角色</StatusBadge></div>
    <p>{delivery.summary || "对方没有提供摘要。"}</p>
    <p>由 {owner} 继续审阅；这里仅展示结果。</p>
  </article>;
}

function DecisionItem({ request, view, actions }: { request: CollaborationDecision; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [optionId, setOptionId] = useState(""); const [custom, setCustom] = useState(""); const [customMode, setCustomMode] = useState(false); const [error, setError] = useState<string | null>(null);
  const response = decisionResponseFromDraft({ customMode, optionId, custom }); const busy = view.busyKey === `decision:${request.requestId}`;
  const respond = (value: DecisionResponse | null) => { if (!value) return; setError(null); void actions.respondDecision(request.requestId, value).then((ok) => { if (!ok) setError("回复未完成。"); }); };
  return <article className="tn-inbox-item" data-kind="decision"><div className="tn-inbox-item-heading"><strong>需要你的决定</strong><StatusBadge tone="warning">待回复</StatusBadge></div><p>{request.question}</p>
    <fieldset className="tn-decision-options" disabled={!view.canMutate || busy}><legend>选择回复</legend>{request.options.map((option) => <Radio key={option.id} name={`decision-${request.requestId}`} value={option.id} checked={!customMode && optionId === option.id} onChange={() => { setCustomMode(false); setOptionId(option.id); }} label={option.label} />)}<Radio name={`decision-${request.requestId}`} checked={customMode} onChange={() => setCustomMode(true)} label="自定义回复" /></fieldset>
    {customMode ? <TextField multiline label="自定义回复" rows={3} value={custom} disabled={!view.canMutate || busy} onChange={(event) => setCustom(event.target.value)} /> : null}
    {error ? <p className="tn-action-error" role="alert">{error}</p> : null}<div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate || busy} onClick={() => respond({ kind: "deny" })}>拒绝此次请求</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate || busy || !response} onClick={() => respond(response)}>提交回复</Button></div>
  </article>;
}

export function CollaborationPanel(props: CollaborationPanelProps) {
  const selected = props.view.snapshot?.selectedNode;
  const exactSelected = selected?.nodeId === props.node.nodeId ? selected : null;
  const task = exactSelected?.activeTask ?? null;
  return <div className="tn-collaboration-panel" data-collaboration-status={props.view.status} data-collaboration-identity={collaborationPanelIdentity(props.view)}>
    <ResourceNotice view={props.view} />
    {exactSelected ? <>{task ? <ActiveTaskSection task={task} /> : <DispatchSection {...props} />}{task?.pendingDecision ? <section className="tn-collaboration-section tn-inbox"><DecisionItem request={task.pendingDecision} view={props.view} actions={props.actions} /></section> : null}{task?.readyDelivery ? <section className="tn-collaboration-section tn-inbox">{task.responsibility.kind === "user" ? <DeliveryItem delivery={task.readyDelivery} view={props.view} actions={props.actions} /> : <RoleDeliveryNotice delivery={task.readyDelivery} owner={task.responsibility.label} />}</section> : null}</> : null}
    {(props.view.status === "error" || props.view.status === "stale") ? <Button variant="quiet" size="compact" onClick={() => void props.actions.retry()}>重新读取</Button> : null}
  </div>;
}
