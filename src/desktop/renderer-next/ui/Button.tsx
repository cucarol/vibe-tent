import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils.js";

export type ButtonVariant = "secondary" | "primary" | "quiet" | "ghost" | "danger";
export type ButtonSize = "default" | "compact";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
};

/** Native button facade with a stable visual and accessibility contract. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "default", loading = false, disabled, className, children, type = "button", ...rest },
  ref
) {
  const unavailable = Boolean(disabled || loading);
  return (
    <button
      ref={ref}
      type={type}
      className={cx("tn-ui-btn", className)}
      data-variant={variant}
      data-size={size === "compact" ? "compact" : undefined}
      data-loading={loading ? "true" : undefined}
      disabled={unavailable}
      aria-disabled={unavailable || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
    </button>
  );
});
