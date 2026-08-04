import type { SVGProps } from "react";

export type ShellIconName =
  | "canvas"
  | "chevron-left"
  | "chevron-right"
  | "command"
  | "focus"
  | "outline"
  | "panel-left"
  | "panel-right"
  | "plus";

export function ShellIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: ShellIconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" {...props}>
      {name === "canvas" ? <><path {...common} d="M3.5 4.5h13v11h-13z"/><path {...common} d="M7 4.5v11M13 4.5v11"/></> : null}
      {name === "outline" ? <><path {...common} d="M4 5h2M8 5h8M4 10h2M8 10h8M4 15h2M8 15h8"/></> : null}
      {name === "focus" ? <><circle {...common} cx="10" cy="10" r="5.5"/><path {...common} d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2"/></> : null}
      {name === "panel-left" ? <><rect {...common} x="3" y="4" width="14" height="12" rx="1.5"/><path {...common} d="M7 4v12"/></> : null}
      {name === "panel-right" ? <><rect {...common} x="3" y="4" width="14" height="12" rx="1.5"/><path {...common} d="M13 4v12"/></> : null}
      {name === "plus" ? <path {...common} d="M10 4v12M4 10h12"/> : null}
      {name === "command" ? <><path {...common} d="M7.5 6.5V5a2 2 0 1 0-2 2H14.5a2 2 0 1 0-2-2v10a2 2 0 1 0 2-2H5.5a2 2 0 1 0 2 2z"/></> : null}
      {name === "chevron-left" ? <path {...common} d="m12 5-5 5 5 5"/> : null}
      {name === "chevron-right" ? <path {...common} d="m8 5 5 5-5 5"/> : null}
    </svg>
  );
}
