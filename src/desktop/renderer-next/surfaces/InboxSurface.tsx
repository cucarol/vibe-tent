import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

/** Inbox: pending A2U / deliveries / task inputs — projections only. */
export function InboxSurface() {
  return (
    <SurfacePlaceholder
      surfaceId="inbox"
      title="Inbox"
      description="Pending interactions and review items. Lists are Service projections; accept/reject/reply go through lifecycle intents, not local state machines."
    />
  );
}
