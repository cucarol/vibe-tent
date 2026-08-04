import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./utils.js";

export type StatusTone = "success" | "warning" | "danger" | "info" | "running" | "neutral" | "pending" | "ghost";
export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone; children: ReactNode };

/** Status always includes text; the dot is a secondary visual cue. */
export function StatusBadge({ tone = "neutral", className, children, ...rest }: StatusBadgeProps) {
  return <span className={cx("tn-ui-status-badge", className)} data-tone={tone} {...rest}>{children}</span>;
}
