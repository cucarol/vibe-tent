import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./utils.js";

export type IconButtonVariant = "secondary" | "ghost" | "quiet";
export type IconButtonSize = "default" | "compact";
export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  tooltip?: string;
  children?: ReactNode;
};

/** Icon-only control. A spoken label is required; a native tooltip is optional. */
export function IconButton({
  variant = "secondary", size = "default", className, children, tooltip, title, type = "button", ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx("tn-ui-icon-btn", className)}
      data-variant={variant}
      data-size={size}
      title={tooltip ?? title}
      {...rest}
    >
      {children}
    </button>
  );
}
