import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

/**
 * Focus Workspace: Markdown body + collaboration context for the focused entity.
 * Not a second source of truth — projections come from ServiceGateway.
 */
export function FocusWorkspaceSurface() {
  return (
    <SurfacePlaceholder
      surfaceId="focus-workspace"
      title="Focus Workspace"
      description="Focused Markdown editing and collaboration context for the current entity. Outline opens as shell drawer chrome; Service projections own status, assignee, and task facts."
    />
  );
}
