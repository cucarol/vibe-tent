/**
 * Outline chrome — always reachable in the single-window shell.
 * Not a navigable "surface" you leave the app for; it coexists with stage.
 */

export type OutlineProps = {
  /** Optional status line under the title. */
  subtitle?: string;
};

export function Outline(props: OutlineProps) {
  const { subtitle = "Always reachable · concept / box tree placeholder" } =
    props;
  return (
    <aside className="tn-outline" data-region="outline" aria-label="Outline">
      <div className="tn-outline-head">Outline</div>
      <div className="tn-outline-body">
        <p>{subtitle}</p>
        <p>
          Tree projection will bind to ServiceGateway (docs.tree +
          box.projection). Outline stays mounted while stage surfaces change.
        </p>
      </div>
    </aside>
  );
}
