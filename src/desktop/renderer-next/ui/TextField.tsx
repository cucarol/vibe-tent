import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx } from "./utils.js";

type SharedFieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  fieldClassName?: string;
};

export type TextFieldProps = SharedFieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size"> & { multiline?: false };
export type TextAreaFieldProps = SharedFieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { multiline: true };
export type TextFieldComponentProps = TextFieldProps | TextAreaFieldProps;

/** Labeled native input/textarea. Error copy always wins over a generic hint. */
export function TextField(props: TextFieldComponentProps) {
  const generatedId = useId();
  const { label, hint, error, className, fieldClassName, id, disabled, multiline, ...rest } =
    props as TextFieldComponentProps & { multiline?: boolean };
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);
  const fieldClass = cx("tn-ui-text-field", fieldClassName);

  return (
    <div className={cx("tn-ui-field", className)} data-error={invalid || undefined} data-disabled={disabled || undefined}>
      {label != null ? <label className="tn-ui-field-label" htmlFor={inputId}>{label}</label> : null}
      {multiline ? (
        <textarea id={inputId} className={fieldClass} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} rows={(rest as TextareaHTMLAttributes<HTMLTextAreaElement>).rows ?? 3} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
      ) : (
        <input id={inputId} className={fieldClass} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
      )}
      {error != null ? <div className="tn-ui-field-error" id={errorId} role="alert">{error}</div> : null}
      {hint != null && error == null ? <div className="tn-ui-field-hint" id={hintId}>{hint}</div> : null}
    </div>
  );
}
