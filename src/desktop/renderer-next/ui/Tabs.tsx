import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils.js";

export type TabItem = { id: string; label: ReactNode; disabled?: boolean };
export type TabsProps = HTMLAttributes<HTMLDivElement> & {
  items: TabItem[];
  value: string;
  onValueChange?: (id: string) => void;
  idBase?: string;
  "aria-label"?: string;
};

/** Arrow/Home/End move focus and activate the next enabled tab. */
export function Tabs({ items, value, onValueChange, className, "aria-label": ariaLabel, idBase, ...rest }: TabsProps) {
  const generatedId = useId();
  const tabsId = idBase ?? generatedId;
  return (
    <div
      role="tablist"
      className={cx("tn-ui-tabs", className)}
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
        if (!tabs.length) return;
        const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
        event.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
      {...rest}
    >
      {items.map((item) => {
        const active = item.id === value;
        return <button key={item.id} type="button" role="tab" className="tn-ui-tab" id={`${tabsId}-tab-${item.id}`} data-active={active || undefined} aria-selected={active} aria-controls={`${tabsId}-tabpanel-${item.id}`} tabIndex={active ? 0 : -1} disabled={item.disabled} aria-disabled={item.disabled || undefined} onClick={() => !item.disabled && onValueChange?.(item.id)}>{item.label}</button>;
      })}
    </div>
  );
}

export function TabPanel({ id, tabsId, active, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { id: string; tabsId: string; active: boolean }) {
  if (!active) return null;
  return <div role="tabpanel" id={`${tabsId}-tabpanel-${id}`} aria-labelledby={`${tabsId}-tab-${id}`} className={className} {...rest}>{children}</div>;
}
