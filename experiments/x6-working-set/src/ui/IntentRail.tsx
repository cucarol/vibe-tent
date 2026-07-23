import type { IntentRecord } from "../model/types.js";

type Props = {
  intents: IntentRecord[];
};

export function IntentRail(props: Props) {
  return (
    <div className="intent-rail" aria-label="Intent log">
      <h3>Intent 分类（layout 可撤销；domain/lifecycle 仅展示）</h3>
      {props.intents.length === 0 ? (
        <div style={{ color: "var(--muted)" }}>尚无操作</div>
      ) : (
        props.intents.map((i) => (
          <div key={i.id} className="intent-row">
            <span className={"cat " + i.category}>
              {i.category}
              {i.undoable ? "*" : ""}
            </span>
            <span>{i.label}</span>
          </div>
        ))
      )}
    </div>
  );
}
