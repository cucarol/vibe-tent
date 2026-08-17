import { useState } from "react";
import { Button, Radio, StatusBadge, TextField } from "../ui/index.js";
import { MarkdownReader } from "../integrations/markdown/MarkdownReader.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";
import type {
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
  DecisionResponse,
} from "../model/collaboration-surface-controller.js";
import type {
  CollaborationActiveTask,
  CollaborationDecision,
  CollaborationInboxItem,
  CollaborationTaskResult,
} from "../model/workspace-collaboration-view.js";

export type CollaborationPanelProps = {
  node: WorkbenchNodeView;
  view: CollaborationSurfaceView;
  actions: CollaborationSurfaceActions;
};

export function collaborationPanelIdentity(view: CollaborationSurfaceView): string {
  return `${view.workspaceId ?? "none"}:${view.nodeId ?? "none"}`;
}

function progressLabel(state: string): string {
  if (state === "submitted") return "已返回";
  if (state === "waiting") return "等待决定";
  if (state === "failed" || state === "interrupted" || state === "rejected") return "未完成";
  if (state === "accepted") return "已接纳";
  return "处理中";
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
    : task.readyResult
      ? task.responsibility.kind === "user"
        ? "内容已返回，等待接纳"
        : `内容已返回，等待${owner}接纳`
      : "工作正在推进";
  const titleId = `tn-active-task-title-${task.taskId}`;
  return <section className="tn-collaboration-section" aria-labelledby={titleId}>
    <div className="tn-section-heading"><h2 id={titleId}>委托进展</h2><StatusBadge tone="running">{progressLabel(task.state)}</StatusBadge></div>
    <div className="tn-active-task"><strong>{owner}</strong>{execution ? <span>执行：{execution}</span> : null}<span>{progress}</span></div>
  </section>;
}

function TaskResultItem({ result, view, actions }: { result: CollaborationTaskResult; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [rejecting, setRejecting] = useState(false); const [note, setNote] = useState(""); const [error, setError] = useState<string | null>(null);
  const busy = view.busyKey === `result:${result.resultId}`;
  return <article className="tn-inbox-item" data-kind="result" data-result-id={result.resultId}><div className="tn-inbox-item-heading"><strong>返回内容</strong><StatusBadge tone="warning">待接纳</StatusBadge></div><div className="tn-result-report"><MarkdownReader body={result.summary} /></div>
    {rejecting ? <div className="tn-inline-form"><TextField multiline label="退回说明" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /><div><Button size="compact" variant="quiet" onClick={() => setRejecting(false)}>取消</Button><Button size="compact" variant="danger" disabled={!note.trim()} loading={busy} onClick={() => void actions.rejectTaskResult(result.resultId, note.trim()).then((ok) => { if (!ok) setError("退回未完成。"); })}>退回修改</Button></div></div>
    : <div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate} onClick={() => setRejecting(true)}>退回</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate} onClick={() => void actions.acceptTaskResult(result.resultId).then((ok) => { if (!ok) setError("接纳未完成。"); })}>接纳</Button></div>}
    {error ? <p className="tn-action-error" role="alert">{error}</p> : null}</article>;
}

function RoleTaskResultNotice({ result, owner }: { result: CollaborationTaskResult; owner: string }) {
  return <article className="tn-inbox-item" data-kind="result" data-result-id={result.resultId} data-actionable="false">
    <div className="tn-inbox-item-heading"><strong>返回内容</strong><StatusBadge tone="neutral">等待负责角色</StatusBadge></div>
    <div className="tn-result-report"><MarkdownReader body={result.summary} /></div>
    <p>由 {owner} 继续审阅；这里仅展示结果。</p>
  </article>;
}

function DecisionItem({ request, view, actions }: { request: CollaborationDecision; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const [optionId, setOptionId] = useState(""); const [custom, setCustom] = useState(""); const [customMode, setCustomMode] = useState(false); const [error, setError] = useState<string | null>(null);
  const response = decisionResponseFromDraft({ customMode, optionId, custom }); const busy = view.busyKey === `decision:${request.requestId}`;
  const respond = (value: DecisionResponse | null) => { if (!value) return; setError(null); void actions.respondDecision(request.requestId, value).then((ok) => { if (!ok) setError("回复未完成。"); }); };
  return <article className="tn-inbox-item" data-kind="decision" data-request-id={request.requestId}><div className="tn-inbox-item-heading"><strong>需要你的决定</strong><StatusBadge tone="warning">待回复</StatusBadge></div><p>{request.question}</p>
    <fieldset className="tn-decision-options" disabled={!view.canMutate || busy}><legend>选择回复</legend>{request.options.map((option) => <Radio key={option.id} name={`decision-${request.requestId}`} value={option.id} checked={!customMode && optionId === option.id} onChange={() => { setCustomMode(false); setOptionId(option.id); }} label={option.label} />)}<Radio name={`decision-${request.requestId}`} checked={customMode} onChange={() => setCustomMode(true)} label="自定义回复" /></fieldset>
    {customMode ? <TextField multiline label="自定义回复" rows={3} value={custom} disabled={!view.canMutate || busy} onChange={(event) => setCustom(event.target.value)} /> : null}
    {error ? <p className="tn-action-error" role="alert">{error}</p> : null}<div className="tn-inbox-actions"><Button size="compact" variant="quiet" disabled={!view.canMutate || busy} onClick={() => respond({ kind: "deny" })}>拒绝此次请求</Button><Button size="compact" variant="primary" loading={busy} disabled={!view.canMutate || busy || !response} onClick={() => respond(response)}>提交回复</Button></div>
  </article>;
}

export function CollaborationInboxDetail({ item, view, actions }: { item: CollaborationInboxItem; view: CollaborationSurfaceView; actions: CollaborationSurfaceActions }) {
  const identity = item.kind === "result" ? item.resultId : item.requestId;
  return <div className="tn-collaboration-panel" data-collaboration-status={view.status} data-inbox-detail={identity}>
    <ResourceNotice view={view} />
    <section className="tn-collaboration-section tn-inbox">
      {item.kind === "result"
        ? <TaskResultItem key={item.resultId} result={item} view={view} actions={actions} />
        : <DecisionItem key={item.requestId} request={item} view={view} actions={actions} />}
    </section>
    {(view.status === "error" || view.status === "stale") ? <Button variant="quiet" size="compact" onClick={() => void actions.retry()}>重新读取</Button> : null}
  </div>;
}

export function CollaborationPanel(props: CollaborationPanelProps) {
  const selected = props.view.snapshot?.selectedNode;
  const exactSelected = selected?.nodeId === props.node.nodeId ? selected : null;
  const tasks = exactSelected?.activeTasks ?? [];
  return <div className="tn-collaboration-panel" data-collaboration-status={props.view.status} data-collaboration-identity={collaborationPanelIdentity(props.view)}>
    <ResourceNotice view={props.view} />
    {exactSelected ? <>{tasks.map((task) => <div key={task.taskId}><ActiveTaskSection task={task} />{task.pendingDecision ? <section className="tn-collaboration-section tn-inbox"><DecisionItem request={task.pendingDecision} view={props.view} actions={props.actions} /></section> : null}{task.readyResult ? <section className="tn-collaboration-section tn-inbox">{task.responsibility.kind === "user" ? <TaskResultItem result={task.readyResult} view={props.view} actions={props.actions} /> : <RoleTaskResultNotice result={task.readyResult} owner={task.responsibility.label} />}</section> : null}</div>)}</> : null}
    {(props.view.status === "error" || props.view.status === "stale") ? <Button variant="quiet" size="compact" onClick={() => void props.actions.retry()}>重新读取</Button> : null}
  </div>;
}
