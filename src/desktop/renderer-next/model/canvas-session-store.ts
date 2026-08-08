/**
 * Per-workspace local persistence for Canvas tabs, placements, viewport,
 * placements, viewport and edge-layer visibility. Machine-local only — never Service.
 * Parse failure always falls back to empty session (never pollutes domain).
 */

import type {
  CanvasBackgroundMode,
  CanvasDocument,
  CanvasPlacement,
} from "../types/identity.js";
import {
  DEFAULT_VIEWPORT,
  NODE_CARD,
  emptyCanvasTabDocument,
  withViewport,
} from "./canvas-document.js";
import {
  DEFAULT_EDGE_LAYERS,
  normalizeEdgeLayers,
  type CanvasEdgeLayerVisibility,
} from "./canvas-edges.js";
import {
  createEmptyTabSession,
  createTab,
  type CanvasTab,
  type CanvasTabSession,
} from "./tabs.js";

export const CANVAS_SESSION_STORAGE_PREFIX = "tent.desktop.canvasSession.v1";

export type CanvasWorkspaceSession = {
  version: 1;
  workspaceId: string;
  tabs: CanvasTabSession;
  edgeLayers: CanvasEdgeLayerVisibility;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function canvasSessionStorageKey(workspaceId: string): string {
  return `${CANVAS_SESSION_STORAGE_PREFIX}:${workspaceId}`;
}

export function emptyCanvasWorkspaceSession(
  workspaceId: string
): CanvasWorkspaceSession {
  return {
    version: 1,
    workspaceId,
    tabs: createEmptyTabSession(),
    edgeLayers: { ...DEFAULT_EDGE_LAYERS },
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeBackgroundMode(_raw: unknown): CanvasBackgroundMode {
  // Product hard-cut: persisted legacy grid preferences must not keep the
  // current Canvas gridded after the default direction moved to pure white.
  return "blank";
}

function normalizePlacement(raw: unknown): CanvasPlacement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.placementId !== "string" || !p.placementId) return null;
  if (typeof p.kind !== "string" || !p.kind) return null;
  const meta =
    p.meta && typeof p.meta === "object"
      ? (p.meta as Record<string, unknown>)
      : undefined;
  const normalizedMeta = meta
    ? Object.fromEntries(Object.entries(meta).filter(([key]) => key !== "presentation"))
    : undefined;
  const isNode = p.kind === "node";
  return {
    placementId: p.placementId,
    entityRef: typeof p.entityRef === "string" ? p.entityRef : undefined,
    kind: p.kind,
    x: isFiniteNumber(p.x) ? p.x : undefined,
    y: isFiniteNumber(p.y) ? p.y : undefined,
    width: isNode ? NODE_CARD.width : isFiniteNumber(p.width) ? p.width : undefined,
    height: isNode ? NODE_CARD.height : isFiniteNumber(p.height) ? p.height : undefined,
    zIndex: isFiniteNumber(p.zIndex) ? p.zIndex : undefined,
    meta: normalizedMeta && Object.keys(normalizedMeta).length > 0
      ? normalizedMeta
      : undefined,
  };
}

function normalizeDocument(raw: unknown): CanvasDocument {
  if (!raw || typeof raw !== "object") return emptyCanvasTabDocument();
  const d = raw as Record<string, unknown>;
  const placementsRaw = Array.isArray(d.placements) ? d.placements : [];
  const placements: CanvasPlacement[] = [];
  for (const item of placementsRaw) {
    const p = normalizePlacement(item);
    if (p) placements.push(p);
  }
  const focused =
    typeof d.focusedPlacementId === "string" ? d.focusedPlacementId : null;
  const vpRaw =
    d.viewport && typeof d.viewport === "object"
      ? (d.viewport as Record<string, unknown>)
      : null;
  const viewport = {
    x: isFiniteNumber(vpRaw?.x) ? vpRaw!.x : DEFAULT_VIEWPORT.x,
    y: isFiniteNumber(vpRaw?.y) ? vpRaw!.y : DEFAULT_VIEWPORT.y,
    zoom: isFiniteNumber(vpRaw?.zoom)
      ? Math.min(2.5, Math.max(0.25, vpRaw!.zoom))
      : DEFAULT_VIEWPORT.zoom,
  };
  return withViewport(
    {
      version: 1,
      placements,
      backgroundMode: normalizeBackgroundMode(d.backgroundMode),
      focusedPlacementId: focused,
    },
    viewport
  );
}

function normalizeTab(raw: unknown): CanvasTab | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return null;
  const rawTitle = typeof t.title === "string" && t.title ? t.title : "Canvas";
  const legacyCanvas = /^Canvas(?:\s+(\d+))?$/.exec(rawTitle);
  const title = legacyCanvas
    ? legacyCanvas[1]
      ? `画布 ${Number(legacyCanvas[1])}`
      : "画布"
    : rawTitle;
  return {
    id: t.id,
    title,
    document: normalizeDocument(t.document),
    seedEntityRef:
      typeof t.seedEntityRef === "string" ? t.seedEntityRef : undefined,
  };
}

/**
 * Parse persisted session. Any structural failure → empty session for that
 * workspaceId (does not throw into domain / Service).
 */
export function normalizeCanvasWorkspaceSession(
  workspaceId: string,
  raw: unknown
): CanvasWorkspaceSession {
  const empty = emptyCanvasWorkspaceSession(workspaceId);
  if (!raw || typeof raw !== "object") return empty;
  const bag = raw as Record<string, unknown>;
  // Wrong workspace key must not leak into current workspace.
  if (typeof bag.workspaceId === "string" && bag.workspaceId !== workspaceId) {
    return empty;
  }

  const tabsRaw = bag.tabs;
  if (!tabsRaw || typeof tabsRaw !== "object") {
    return {
      ...empty,
      edgeLayers: normalizeEdgeLayers(
        bag.edgeLayers as Partial<CanvasEdgeLayerVisibility> | undefined
      ),
    };
  }
  const t = tabsRaw as Record<string, unknown>;
  const order = Array.isArray(t.order)
    ? t.order.filter((id): id is string => typeof id === "string")
    : [];
  const byIdRaw =
    t.byId && typeof t.byId === "object"
      ? (t.byId as Record<string, unknown>)
      : {};
  const byId: Record<string, CanvasTab> = {};
  for (const id of order) {
    const tab = normalizeTab(byIdRaw[id] ?? { id, title: "Canvas" });
    if (tab) byId[id] = tab;
  }
  // Include any byId entries missing from order
  for (const [id, rawTab] of Object.entries(byIdRaw)) {
    if (byId[id]) continue;
    const tab = normalizeTab(rawTab);
    if (tab) {
      byId[id] = tab;
      order.push(id);
    }
  }

  let activeId =
    typeof t.activeId === "string" && byId[t.activeId] ? t.activeId : null;
  if (!activeId && order.length > 0) activeId = order[0]!;

  if (order.length === 0) {
    return {
      version: 1,
      workspaceId,
      tabs: createEmptyTabSession(),
      edgeLayers: normalizeEdgeLayers(
        bag.edgeLayers as Partial<CanvasEdgeLayerVisibility> | undefined
      ),
    };
  }

  return {
    version: 1,
    workspaceId,
    tabs: { order, activeId, byId },
    edgeLayers: normalizeEdgeLayers(
      bag.edgeLayers as Partial<CanvasEdgeLayerVisibility> | undefined
    ),
  };
}

export function loadCanvasWorkspaceSession(
  storage: StorageLike | null | undefined,
  workspaceId: string | null | undefined
): CanvasWorkspaceSession | null {
  if (!storage || !workspaceId) return null;
  try {
    const raw = storage.getItem(canvasSessionStorageKey(workspaceId));
    if (!raw) return emptyCanvasWorkspaceSession(workspaceId);
    return normalizeCanvasWorkspaceSession(workspaceId, JSON.parse(raw));
  } catch {
    return emptyCanvasWorkspaceSession(workspaceId);
  }
}

export function saveCanvasWorkspaceSession(
  storage: StorageLike | null | undefined,
  session: CanvasWorkspaceSession
): void {
  if (!storage || !session.workspaceId) return;
  try {
    const payload: CanvasWorkspaceSession = {
      version: 1,
      workspaceId: session.workspaceId,
      tabs: session.tabs,
      edgeLayers: normalizeEdgeLayers(session.edgeLayers),
    };
    storage.setItem(
      canvasSessionStorageKey(session.workspaceId),
      JSON.stringify(payload)
    );
  } catch {
    // private mode / quota — ignore
  }
}

/** Convert a screen pointer into the top-left origin of a centered Tent Node. */
export function clientPointToCanvasNodeOrigin(
  client: { x: number; y: number },
  hostRect: { left: number; top: number },
  viewport: { x: number; y: number; zoom: number } = DEFAULT_VIEWPORT
): { x: number; y: number } {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const localX = client.x - hostRect.left;
  const localY = client.y - hostRect.top;
  return {
    x: (localX - viewport.x) / zoom - NODE_CARD.width / 2,
    y: (localY - viewport.y) / zoom - NODE_CARD.height / 2,
  };
}

/** Ensure at least one tab exists after restore/switch. */
export function ensureTabSession(session: CanvasTabSession): CanvasTabSession {
  if (session.order.length > 0 && session.activeId && session.byId[session.activeId]) {
    return session;
  }
  if (session.order.length > 0) {
    const first = session.order[0]!;
    if (session.byId[first]) return { ...session, activeId: first };
  }
  const fresh = createTab("画布");
  return {
    order: [fresh.id],
    activeId: fresh.id,
    byId: { [fresh.id]: fresh },
  };
}
