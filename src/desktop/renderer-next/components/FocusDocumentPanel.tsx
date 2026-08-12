import { lazy, Suspense } from "react";
import { Button, StatusBadge } from "../ui/index.js";
import { MarkdownReader } from "../integrations/markdown/MarkdownReader.js";
import type {
  FocusDocumentActions,
  FocusDocumentView,
} from "../model/focus-document-controller.js";

const MarkdownEditor = lazy(async () => {
  const module = await import("../integrations/markdown/MarkdownEditor.js");
  return { default: module.MarkdownEditor };
});

const STATUS_LABEL: Record<FocusDocumentView["status"], string> = {
  idle: "尚未读取",
  loading: "正在读取",
  read: "已读取",
  edit: "编辑中",
  dirty: "有未保存修改",
  saving: "正在保存",
  saved: "已保存",
  conflict: "发生版本冲突",
  stale: "内容已过期",
  error: "正文读取失败",
  archived: "已归档 · 只读",
};

function statusTone(status: FocusDocumentView["status"]): "neutral" | "running" | "warning" | "danger" | "success" {
  if (status === "saving" || status === "loading") return "running";
  if (status === "dirty" || status === "stale" || status === "conflict") return "warning";
  if (status === "error") return "danger";
  if (status === "saved") return "success";
  return "neutral";
}

export function FocusDocumentPanel(props: {
  document: FocusDocumentView;
  actions: FocusDocumentActions;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { document, actions, expanded, onExpandedChange } = props;
  const hasSnapshot = Boolean(document.etag);
  const editing = document.mode === "edit" && hasSnapshot && !document.archived;
  return (
    <section className="tn-focus-document" aria-labelledby="tn-focus-document-title" data-document-status={document.status}>
      <header className="tn-focus-document-toolbar">
        <div>
          <h2 id="tn-focus-document-title">正文</h2>
          <StatusBadge tone={statusTone(document.status)}>{STATUS_LABEL[document.status]}</StatusBadge>
        </div>
        <div className="tn-focus-document-actions">
          <Button variant="ghost" size="compact" onClick={() => onExpandedChange(!expanded)} aria-pressed={expanded}>
            {expanded ? "恢复详情栏" : "展开详情"}
          </Button>
          {editing && document.status !== "conflict" ? (
            <>
              <Button variant="quiet" size="compact" disabled={document.status === "saving"} onClick={actions.discard}>放弃</Button>
              <Button variant="primary" size="compact" loading={document.status === "saving"} disabled={!document.canSave} onClick={() => void actions.save()}>保存</Button>
            </>
          ) : hasSnapshot && !document.archived ? (
            <Button variant="secondary" size="compact" onClick={actions.beginEdit}>编辑</Button>
          ) : null}
        </div>
      </header>

      {document.status === "loading" && !hasSnapshot ? (
        <div className="tn-document-message" role="status">正在读取权威正文…</div>
      ) : document.status === "error" && !hasSnapshot ? (
        <div className="tn-document-message" role="alert">
          <strong>正文暂时不可用</strong>
          <span>{document.message ?? "无法读取权威正文。"}</span>
          <Button variant="secondary" size="compact" onClick={() => void actions.retry()}>重试</Button>
        </div>
      ) : (
        <>
          {document.status === "stale" ? (
            <div className="tn-document-notice" role="status">
              当前显示的是已读取版本；重新连接并复核前不能保存。
            </div>
          ) : null}
          {document.status === "conflict" ? (
            <div className="tn-document-conflict" role="alert">
              <strong>磁盘版本已变化，本地草稿仍被保留。</strong>
              <p>选择载入磁盘版本会放弃本地草稿；选择保留本地会基于最新 etag 再保存。</p>
              <div>
                <Button variant="quiet" size="compact" onClick={actions.loadDisk}>载入磁盘版本</Button>
                <Button variant="primary" size="compact" onClick={() => void actions.overwriteWithLocal()}>保留本地并保存</Button>
              </div>
            </div>
          ) : null}
          <div className="tn-focus-document-body">
            {editing ? (
              <Suspense fallback={(
                <div className="tn-document-editor-fallback" role="status">
                  <span className="tn-document-message">正在载入编辑器…</span>
                  <MarkdownReader body={document.body} />
                </div>
              )}>
                <MarkdownEditor value={document.body} disabled={document.status === "stale" || document.status === "conflict"} onChange={actions.updateBody} onSave={() => void actions.save()} />
              </Suspense>
            ) : (
              <MarkdownReader body={document.body} />
            )}
          </div>
        </>
      )}

      {document.backlinksState !== "idle" ? (
        <details className="tn-focus-document-links">
          <summary>反向链接 · {document.backlinks.length}</summary>
          {document.backlinksState === "loading" ? <p>正在读取…</p> : null}
          {document.backlinksState === "error" ? <p>反向链接不可用</p> : null}
          {document.backlinks.length ? (
            <ul>{document.backlinks.map((link) => <li key={`${link.fromNodeId}:${link.raw}`}><strong>{link.fromName}</strong><span>{link.fromPath}</span></li>)}</ul>
          ) : document.backlinksState === "ready" ? <p>暂无反向链接</p> : null}
        </details>
      ) : null}

    </section>
  );
}
