/**
 * Canvas tabs — each tab is an independent local CanvasDocument.
 * Closing a tab never mutates domain state.
 */

import type { CanvasDocument } from "../types/identity.js";
import { emptyCanvasTabDocument } from "./canvas-document.js";

const DEFAULT_CANVAS_TITLE = "画布";

export type CanvasTabId = string;

export type CanvasTab = {
  id: CanvasTabId;
  title: string;
  document: CanvasDocument;
  /** Optional seed entity that opened this tab. */
  seedEntityRef?: string;
};

export type CanvasTabSession = {
  order: CanvasTabId[];
  activeId: CanvasTabId | null;
  byId: Readonly<Record<CanvasTabId, CanvasTab>>;
};

export function createEmptyTabSession(): CanvasTabSession {
  const tab = createTab(DEFAULT_CANVAS_TITLE);
  return {
    order: [tab.id],
    activeId: tab.id,
    byId: { [tab.id]: tab },
  };
}

export function createTab(
  title: string,
  document?: CanvasDocument,
  seedEntityRef?: string
): CanvasTab {
  return {
    id: `tab-${Math.random().toString(36).slice(2, 10)}`,
    title,
    document: document ?? emptyCanvasTabDocument(),
    seedEntityRef,
  };
}

export function activeTab(session: CanvasTabSession): CanvasTab | null {
  if (!session.activeId) return null;
  return session.byId[session.activeId] ?? null;
}

export function addTab(
  session: CanvasTabSession,
  tab: CanvasTab,
  activate = true
): CanvasTabSession {
  return {
    order: [...session.order, tab.id],
    activeId: activate ? tab.id : session.activeId,
    byId: { ...session.byId, [tab.id]: tab },
  };
}

export function switchTab(
  session: CanvasTabSession,
  tabId: CanvasTabId
): CanvasTabSession {
  if (!session.byId[tabId]) return session;
  return { ...session, activeId: tabId };
}

export function closeTab(
  session: CanvasTabSession,
  tabId: CanvasTabId
): CanvasTabSession {
  if (!session.byId[tabId]) return session;
  const order = session.order.filter((id) => id !== tabId);
  const byId = { ...session.byId };
  delete byId[tabId];

  let activeId = session.activeId;
  if (activeId === tabId) {
    const idx = session.order.indexOf(tabId);
    if (order.length === 0) {
      activeId = null;
    } else if (idx > 0) {
      activeId = session.order[idx - 1]!;
    } else {
      activeId = order[0]!;
    }
  }

  // Always keep at least one empty canvas tab for MVP operability.
  if (order.length === 0) {
    const fresh = createTab(DEFAULT_CANVAS_TITLE);
    return {
      order: [fresh.id],
      activeId: fresh.id,
      byId: { [fresh.id]: fresh },
    };
  }

  return { order, activeId, byId };
}

export function updateTabDocument(
  session: CanvasTabSession,
  tabId: CanvasTabId,
  document: CanvasDocument
): CanvasTabSession {
  const tab = session.byId[tabId];
  if (!tab) return session;
  return {
    ...session,
    byId: {
      ...session.byId,
      [tabId]: { ...tab, document },
    },
  };
}

export function renameTab(
  session: CanvasTabSession,
  tabId: CanvasTabId,
  title: string
): CanvasTabSession {
  const tab = session.byId[tabId];
  if (!tab) return session;
  return {
    ...session,
    byId: {
      ...session.byId,
      [tabId]: { ...tab, title },
    },
  };
}

export function nextCanvasTitle(session: CanvasTabSession): string {
  const n = session.order.length + 1;
  return `画布 ${n}`;
}
