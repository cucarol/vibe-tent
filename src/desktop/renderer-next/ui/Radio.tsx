import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils.js";

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
};

/** Native radio semantics with Tent-owned label, focus, and disabled styling. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, className, disabled, ...rest },
  ref
) {
  return (
    <label className={cx("tn-ui-radio", className)} data-disabled={disabled || undefined}>
      <input ref={ref} type="radio" disabled={disabled} {...rest} />
      <span>{label}</span>
    </label>
  );
});
