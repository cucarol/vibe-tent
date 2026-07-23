import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

export function ActivitySurface() {
  return (
    <SurfacePlaceholder
      surfaceId="activity"
      title="Activity"
      description="Session and task activity feed. Events only invalidate projections; this surface re-fetches rather than treating SSE payloads as truth."
    />
  );
}
