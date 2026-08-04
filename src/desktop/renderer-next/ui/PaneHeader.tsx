import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./utils.js";

export type PaneHeaderProps = HTMLAttributes<HTMLDivElement> & { title: ReactNode; meta?: ReactNode; actions?: ReactNode };

/** Compact chrome header that separates a pane by typography, not a card. */
export function PaneHeader({ title, meta, actions, className, ...rest }: PaneHeaderProps) {
  return <div className={cx("tn-ui-pane-header", className)} {...rest}><div className="tn-ui-pane-header-title">{title}{meta != null ? <span className="tn-ui-pane-header-meta"> {meta}</span> : null}</div>{actions != null ? <div className="tn-ui-pane-header-actions">{actions}</div> : null}</div>;
}
