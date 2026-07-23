import type { ReactNode } from "react";

export type SurfacePlaceholderProps = {
  title: string;
  description: string;
  children?: ReactNode;
  /** data-surface id for tests / a11y. */
  surfaceId: string;
};

/** Shared structured placeholder for unfinished surfaces. */
export function SurfacePlaceholder(props: SurfacePlaceholderProps) {
  const { title, description, children, surfaceId } = props;
  return (
    <section
      className="tn-surface-placeholder"
      data-surface={surfaceId}
      aria-label={title}
    >
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  );
}
