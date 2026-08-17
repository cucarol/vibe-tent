import { useState, type DragEvent } from "react";
import type { TaskPackageDraft } from "../../task-package-draft.js";
import {
  TENT_NODE_IDS_DRAG_TYPE,
  addTaskPackageNodes,
  decodeNodeIdsDrag,
  removeTaskPackageNode,
} from "../../task-package-draft.js";
import type { CollaborationSurfaceActions, CollaborationSurfaceView } from "../model/collaboration-surface-controller.js";
import { canonicalPresentationRootNodeIds } from "../shell/workbench-presentation.js";
import { nodeTitle, type WorkbenchNodeView } from "../shell/workbench-types.js";
import { Button, Select, TextField } from "../ui/index.js";

export type TaskPackageComposerProps = {
  draft: TaskPackageDraft;
  nodes: readonly WorkbenchNodeView[];
  selectedNodeIds: readonly string[];
  view: CollaborationSurfaceView;
  actions: CollaborationSurfaceActions;
  onChange: (draft: TaskPackageDraft) => void;
};

export function resolveTaskPackageNodes(
  nodes: readonly WorkbenchNodeView[],
  nodeIds: readonly string[]
): Array<{ nodeId: string; label: string }> | null {
  const rootIds = canonicalPresentationRootNodeIds(nodes, nodeIds);
  if (nodeIds.length > 0 && rootIds.length === 0) return null;
  const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const resolved = rootIds.flatMap((nodeId) => {
    const node = byId.get(nodeId);
    return node && (!node.projectionState || node.projectionState === "ready")
      ? [{ nodeId, label: nodeTitle(node) }]
      : [];
  });
  return resolved.length === rootIds.length ? resolved : null;
}

export function TaskPackageComposer({
  draft,
  nodes,
  selectedNodeIds,
  view,
  actions,
  onChange,
}: TaskPackageComposerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const targetKind = draft.targetKind;
  const targets = view.targets.filter((target) => target.kind === targetKind);
  const targetId = targets.some((target) => target.id === draft.target?.id)
    ? draft.target!.id
    : "";
  const busy = view.busyKey === "dispatch";
  const canSubmit = view.canMutate && view.targetsReady && !busy &&
    Boolean(targetId && draft.prompt.trim());
  const addNodes = (nodeIds: readonly string[]) => {
    const ready = resolveTaskPackageNodes(nodes, nodeIds);
    if (!ready) {
      setError("部分所选节点暂不可用，未加入任务包。");
      return;
    }
    setError(null);
    if (ready.length) onChange(addTaskPackageNodes(draft, ready));
  };
  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    const ok = await actions.dispatch({
      nodeIds: [...draft.nodeIds],
      prompt: draft.prompt.trim(),
      acceptMode: draft.acceptMode,
      target: { kind: targetKind, id: targetId },
    });
    if (ok) onChange({ ...draft, nodeIds: [], nodeLabels: {}, prompt: "" });
    else setError("委托未完成；已重新读取当前状态。");
  };

  if (!open) {
    return <section className="tn-collaboration-section tn-dispatch-entry">
      <div><h2>任务包</h2><p>选择节点、说明目标，再交给负责角色或执行连接。</p></div>
      <Button size="compact" variant="primary" disabled={!view.canMutate} onClick={() => {
        addNodes(selectedNodeIds);
        setOpen(true);
      }}>开始委托</Button>
    </section>;
  }

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const nodeIds = decodeNodeIdsDrag(event.dataTransfer.getData(TENT_NODE_IDS_DRAG_TYPE));
    if (!nodeIds.length) return;
    event.preventDefault();
    addNodes(nodeIds);
  };

  return <section
    className="tn-collaboration-section tn-dispatch tn-task-package-composer"
    aria-label="任务包"
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes(TENT_NODE_IDS_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }}
    onDrop={onDrop}
  >
    <div className="tn-section-heading">
      <h2>任务包</h2>
      <Button size="compact" variant="ghost" onClick={() => setOpen(false)}>收起</Button>
    </div>
    <div className="tn-task-package-nodes" data-empty={draft.nodeIds.length === 0 || undefined}>
      {draft.nodeIds.length ? draft.nodeIds.map((nodeId) => (
        <span key={nodeId} data-node-id={nodeId}>
          {draft.nodeLabels[nodeId] ?? (byId.get(nodeId) ? nodeTitle(byId.get(nodeId)!) : nodeId)}
          <button type="button" aria-label={`从任务包移除 ${draft.nodeLabels[nodeId] ?? nodeId}`} onClick={() => onChange(removeTaskPackageNode(draft, nodeId))}>×</button>
        </span>
      )) : <p>未附带节点；可直接提交仅含说明的任务。</p>}
    </div>
    <Button size="compact" variant="quiet" disabled={!selectedNodeIds.length} onClick={() => addNodes(selectedNodeIds)}>加入当前选择</Button>
    <TextField multiline label="要做什么" value={draft.prompt} rows={4} disabled={!view.canMutate} onChange={(event) => onChange({ ...draft, prompt: event.target.value })} placeholder="说明目标、约束与完成标准" />
    <div className="tn-control-pair">
      <Select label="交给谁" value={targetKind} disabled={!view.canMutate} onChange={(event) => onChange({ ...draft, targetKind: event.target.value as TaskPackageDraft["targetKind"], target: null })} options={[{ value: "role", label: "责任角色" }, { value: "connection", label: "执行连接" }]} />
      <Select label={targetKind === "role" ? "责任角色" : "执行连接"} value={targetId} disabled={!view.canMutate || !view.targetsReady || targets.length === 0} onChange={(event) => onChange({ ...draft, target: { kind: targetKind, id: event.target.value } })} options={targets.map((target) => ({ value: target.id, label: target.label }))} placeholder={view.targetsReady ? "请选择" : "正在读取"} />
    </div>
    <Select label="完成后" value={draft.acceptMode} disabled={!view.canMutate} onChange={(event) => onChange({ ...draft, acceptMode: event.target.value as TaskPackageDraft["acceptMode"] })} options={[{ value: "review-required", label: "由我接纳" }, { value: "auto-accept", label: "符合条件时自动接纳" }, { value: "agent-decide", label: "由负责角色判断" }]} />
    {error || view.actionIssue || view.targetIssue ? <p className="tn-action-error" role="alert">{error ?? view.actionIssue?.message ?? view.targetIssue?.message}</p> : null}
    <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>交给对方</Button>
  </section>;
}
