/**
 * Focus Workspace drafts: one draft per entityRef.
 * Closing focus restores viewport/selection outside this module.
 */

import type { DomainNode, EntityRef, FocusDraft } from "../model/types.js";

export type FocusDraftStore = {
  /** entityRef → draft */
  byEntity: Map<EntityRef, FocusDraft>;
  activeEntityRef: EntityRef | null;
  /** narrow sheet vs wide markdown */
  expanded: boolean;
};

export function createFocusDraftStore(): FocusDraftStore {
  return {
    byEntity: new Map(),
    activeEntityRef: null,
    expanded: false,
  };
}

export function openFocus(
  store: FocusDraftStore,
  node: DomainNode,
  opts?: { expand?: boolean }
): FocusDraftStore {
  const existing = store.byEntity.get(node.entityRef);
  const draft: FocusDraft = existing ?? {
    entityRef: node.entityRef,
    title: node.title,
    markdown: node.bodyPreview,
    dirty: false,
  };
  const byEntity = new Map(store.byEntity);
  byEntity.set(node.entityRef, draft);
  return {
    byEntity,
    activeEntityRef: node.entityRef,
    expanded: opts?.expand ?? store.expanded,
  };
}

export function closeFocus(store: FocusDraftStore): FocusDraftStore {
  return {
    ...store,
    activeEntityRef: null,
    expanded: false,
  };
}

export function setFocusExpanded(
  store: FocusDraftStore,
  expanded: boolean
): FocusDraftStore {
  if (!store.activeEntityRef) return store;
  return { ...store, expanded };
}

export function updateActiveDraft(
  store: FocusDraftStore,
  patch: Partial<Pick<FocusDraft, "title" | "markdown">>
): FocusDraftStore {
  if (!store.activeEntityRef) return store;
  const cur = store.byEntity.get(store.activeEntityRef);
  if (!cur) return store;
  const next: FocusDraft = {
    ...cur,
    ...patch,
    dirty: true,
  };
  const byEntity = new Map(store.byEntity);
  byEntity.set(store.activeEntityRef, next);
  return { ...store, byEntity };
}

export function getActiveDraft(store: FocusDraftStore): FocusDraft | null {
  if (!store.activeEntityRef) return null;
  return store.byEntity.get(store.activeEntityRef) ?? null;
}

/** Invariant: at most one draft record per entityRef (Map key). */
export function draftCountForEntity(
  store: FocusDraftStore,
  entityRef: EntityRef
): number {
  return store.byEntity.has(entityRef) ? 1 : 0;
}
