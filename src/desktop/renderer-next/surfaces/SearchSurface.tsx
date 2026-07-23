import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

export function SearchSurface() {
  return (
    <SurfacePlaceholder
      surfaceId="search"
      title="Search"
      description="Workspace search surface placeholder. Results will query Service projections; no direct .tent filesystem reads from the renderer."
    />
  );
}
