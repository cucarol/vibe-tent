import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils.js";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
};

/** Native checkbox with one Tent-owned label, focus, and disabled contract. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, disabled, ...rest },
  ref
) {
  return (
    <label className={cx("tn-ui-checkbox", className)} data-disabled={disabled || undefined}>
      <input ref={ref} type="checkbox" disabled={disabled} {...rest} />
      <span>{label}</span>
    </label>
  );
});
