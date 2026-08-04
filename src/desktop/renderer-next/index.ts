/**
 * Public surface for the next renderer foundation (non-React consumers / tests).
 */
export {
  createEmptyCanvasDocument,
  type CanvasDocument,
  type CanvasPlacement,
  type EntityRef,
  type PlacementId,
} from "./types/identity.js";
export {
  isLifecycleIntent,
  isLayoutIntent,
  isReversibleDomainIntent,
  undoPolicyOf,
  type LifecycleIntent,
  type LayoutIntent,
  type ReversibleDomainIntent,
  type UiIntent,
  type UndoPolicy,
} from "./types/intent.js";
export {
  APP_SURFACE_IDS,
  APP_SURFACES,
  defaultAppSurface,
  isAppSurfaceId,
  type AppSurfaceId,
  type AppSurfaceMeta,
} from "./types/surfaces.js";
export {
  ServiceGateway,
  invalidationFromEvent,
  type InvalidationHint,
  type ProjectionKey,
  type ProjectionSnapshot,
  type ServiceGatewayHandlers,
} from "./gateway/service-gateway.js";
export {
  PlaceholderCanvasEngine,
  listPlacementIds,
  placementEntityRef,
  type CanvasEngine,
  type CanvasEngineEvents,
  type CanvasEngineMount,
  type CanvasViewport,
} from "./canvas/engine.js";
export {
  OUTLINE_PANEL_ID,
  OUTLINE_TOGGLE_ID,
  closeOutline,
  createDefaultOutlineChrome,
  isOutlineOpen,
  locateOutlineEntity,
  openOutline,
  setOutlineExpanded,
  toggleOutline,
  toggleOutlineExpanded,
  type OutlineChromeState,
} from "./types/outline.js";
export { focusWorkbenchNode } from "./shell/workbench-selection.js";
