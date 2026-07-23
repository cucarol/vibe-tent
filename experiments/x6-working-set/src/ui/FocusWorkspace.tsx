import type { FocusDraft } from "../model/types.js";

type Props = {
  draft: FocusDraft | null;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  onChange: (patch: Partial<Pick<FocusDraft, "title" | "markdown">>) => void;
  onClose: () => void;
  /** Domain / lifecycle intents are display-only in this spike. */
  onDomainIntent: (label: string) => void;
  onLifecycleIntent: (label: string) => void;
};

export function FocusWorkspace(props: Props) {
  if (!props.draft) return null;
  const d = props.draft;

  return (
    <section
      className={"focus-sheet" + (props.expanded ? " wide" : "")}
      aria-label="Focus Workspace"
    >
      <div className="focus-head">
        <h2>Focus · {d.entityRef}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => props.onExpand(!props.expanded)}
        >
          {props.expanded ? "收窄" : "展开 Markdown"}
        </button>
        <button type="button" className="btn" onClick={props.onClose}>
          关闭
        </button>
      </div>
      <div className="focus-body">
        <div className="focus-meta">
          同一 entity 仅一份 draft{d.dirty ? " · 未提交本地草稿" : ""}
          {props.expanded ? " · 宽 Markdown 区" : " · 窄 sheet"}
        </div>
        <input
          value={d.title}
          onChange={(e) => props.onChange({ title: e.target.value })}
          aria-label="title draft"
        />
        <textarea
          value={d.markdown}
          onChange={(e) => props.onChange({ markdown: e.target.value })}
          aria-label="markdown draft"
          spellCheck={false}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => props.onDomainIntent("docs.write (intent only)")}
          >
            Domain intent
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              props.onLifecycleIntent("task.claim (intent only, not executed)")
            }
          >
            Lifecycle intent
          </button>
        </div>
      </div>
    </section>
  );
}
