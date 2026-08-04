import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { cx } from "./utils.js";

export type SelectOption = { value: string; label: string; disabled?: boolean };
export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  fieldClassName?: string;
};

/** Native select facade: rich listboxes can replace it without changing callers. */
export function Select({ label, hint, error, options, placeholder, className, fieldClassName, id, disabled, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);
  return (
    <div className={cx("tn-ui-field", className)} data-error={invalid || undefined} data-disabled={disabled || undefined}>
      {label != null ? <label className="tn-ui-field-label" htmlFor={selectId}>{label}</label> : null}
      <select id={selectId} className={cx("tn-ui-select", fieldClassName)} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} {...rest}>
        {placeholder != null ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {error != null ? <div className="tn-ui-field-error" id={errorId} role="alert">{error}</div> : null}
      {hint != null && error == null ? <div className="tn-ui-field-hint" id={hintId}>{hint}</div> : null}
    </div>
  );
}
