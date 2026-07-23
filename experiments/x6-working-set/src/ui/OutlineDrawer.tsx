import type { DomainNode, EntityRef } from "../model/types.js";

type Props = {
  open: boolean;
  nodes: DomainNode[];
  filter: string;
  activeEntityRef: EntityRef | null;
  onFilter: (v: string) => void;
  onClose: () => void;
  onLocate: (entityRef: EntityRef) => void;
};

export function OutlineDrawer(props: Props) {
  if (!props.open) return null;

  const q = props.filter.trim().toLowerCase();
  const list = q
    ? props.nodes.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.entityRef.toLowerCase().includes(q) ||
          n.type.toLowerCase().includes(q)
      )
    : props.nodes;

  return (
    <>
      <div className="outline-backdrop" onClick={props.onClose} />
      <aside className="outline-drawer" aria-label="Outline">
        <div className="outline-head">
          <h2>Outline</h2>
          <span className="meta" style={{ color: "var(--muted)", fontSize: 11 }}>
            {list.length}/{props.nodes.length}
          </span>
          <button type="button" className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <input
          className="outline-filter"
          placeholder="过滤 title / entityRef / type"
          value={props.filter}
          onChange={(e) => props.onFilter(e.target.value)}
        />
        <div className="outline-list">
          {list.map((n) => (
            <button
              key={n.entityRef}
              type="button"
              className={
                "outline-item" +
                (props.activeEntityRef === n.entityRef ? " active" : "")
              }
              onClick={() => props.onLocate(n.entityRef)}
            >
              <span className={"dot " + n.type} />
              <span className="title">{n.title}</span>
              <span className="sub">
                {n.type}
                {n.parentEntityRef ? ` · child of ${n.parentEntityRef}` : " · root"}
              </span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
