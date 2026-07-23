/**
 * Experiment-only types for Working-set Canvas spike.
 *
 * NOT Core formal schema. Domain projection shapes mirror Service intent
 * (entity identity, parent links, resolved/unresolved wiki links) but live
 * only inside experiments/x6-working-set.
 *
 * Hard rule: entityRef (concept/box handle) ≠ placementId (canvas instance).
 * CanvasDocument holds only viewport + placements + visual groups/annotations.
 */

/** Stable concept handle, e.g. cx-… — domain identity, not canvas geometry. */
export type EntityRef = string;

/** Unique id of a node instance on the canvas surface. */
export type PlacementId = string;

/** Experiment domain node (Service graph projection stand-in). */
export type DomainNode = {
  entityRef: EntityRef;
  title: string;
  type: string;
  /** Domain parent (folder/concept tree). Drag on canvas must NOT mutate this. */
  parentEntityRef: EntityRef | null;
  coordination: boolean;
  status?: "todo" | "doing" | "done";
  assignee?: string;
  tags: string[];
  /** Short body for Focus Workspace draft seed. */
  bodyPreview: string;
};

/**
 * Four edge kinds required by the spike.
 * Explicitly NOT Core formal schema — overlay for canvas verification only.
 */
export type ExperimentEdgeKind =
  | "parent"
  | "resolved-link"
  | "unresolved-link"
  | "visual-annotation";

export type ExperimentEdge = {
  id: string;
  kind: ExperimentEdgeKind;
  /** entityRef for domain edges; placementId for pure visual annotation edges. */
  source: string;
  target: string;
  label?: string;
};

/** Geometry of one entity on the canvas. */
export type Placement = {
  placementId: PlacementId;
  entityRef: EntityRef;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional visual group membership — not domain parent. */
  visualGroupId?: string;
};

/** Pure visual group rectangle (CanvasDocument only). */
export type VisualGroup = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Pure visual annotation (sticky / callout) — not a concept. */
export type VisualAnnotation = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Viewport = {
  x: number;
  y: number;
  zoom: number;
};

/**
 * Persistable canvas view document.
 * Only viewport, placements, visual groups, visual annotations.
 * No domain parent tree, no lifecycle, no Markdown body.
 */
export type CanvasDocument = {
  version: 1;
  viewport: Viewport;
  placements: Placement[];
  visualGroups: VisualGroup[];
  annotations: VisualAnnotation[];
};

/** Full experiment snapshot: domain projection + canvas document + overlay edges. */
export type WorkingSetSnapshot = {
  domainNodes: DomainNode[];
  /** Edges for rendering; not part of CanvasDocument. */
  edges: ExperimentEdge[];
  document: CanvasDocument;
};

export type IntentCategory =
  | "layout"
  | "domain"
  | "lifecycle"
  | "navigation"
  | "focus";

export type IntentRecord = {
  id: string;
  category: IntentCategory;
  label: string;
  at: number;
  /** True when this intent is locally undoable (layout only in this spike). */
  undoable: boolean;
};

export type FocusDraft = {
  entityRef: EntityRef;
  title: string;
  markdown: string;
  dirty: boolean;
};

export type LayoutCommand =
  | {
      type: "move";
      placementId: PlacementId;
      before: { x: number; y: number };
      after: { x: number; y: number };
    }
  | {
      type: "resize";
      placementId: PlacementId;
      before: { x: number; y: number; width: number; height: number };
      after: { x: number; y: number; width: number; height: number };
    }
  | {
      type: "viewport";
      before: Viewport;
      after: Viewport;
    }
  | {
      type: "group-assign";
      placementIds: PlacementId[];
      beforeGroupId: string | undefined;
      afterGroupId: string | undefined;
    }
  | {
      type: "batch";
      steps: LayoutCommand[];
    };

export const EDGE_KIND_NOTE =
  "Experiment edges (parent / resolved-link / unresolved-link / visual-annotation) are NOT Core formal schema.";
