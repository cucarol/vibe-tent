// Ephemeral recent Context Cards for floating control (not durable entities).

import {
  boxContextCard,
  contextCardToDragText,
  taskContextCard,
  type ContextCard,
  type ContextRef,
  buildContextCard,
} from "../../core/context-card.js";
import type { RecentContextCard } from "../types.js";

export class ContextCardStore {
  private cards: RecentContextCard[] = [];
  private readonly max: number;
  private listeners = new Set<() => void>();

  constructor(max = 12) {
    this.max = max;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): RecentContextCard[] {
    return [...this.cards];
  }

  clear(): void {
    this.cards = [];
    this.emit();
  }

  pushFromCard(card: ContextCard): RecentContextCard {
    const entry: RecentContextCard = {
      id: `${card.contextRef.kind}:${card.contextRef.id}:${Date.now()}`,
      label: card.label,
      kind: card.contextRef.kind,
      refId: card.contextRef.id,
      path: card.contextRef.path,
      text: contextCardToDragText(card),
      createdAt: new Date().toISOString(),
    };
    this.cards = [entry, ...this.cards.filter((c) => !(c.kind === entry.kind && c.refId === entry.refId))].slice(
      0,
      this.max
    );
    this.emit();
    return entry;
  }

  pushBox(boxId: string, path?: string, label?: string, tentRootHint?: string): RecentContextCard {
    return this.pushFromCard(boxContextCard(boxId, path, { label, tentRootHint }));
  }

  pushTask(taskId: string, path?: string, label?: string): RecentContextCard {
    return this.pushFromCard(taskContextCard(taskId, { path, label }));
  }

  pushRef(ref: ContextRef, opts?: { label?: string; tentRootHint?: string }): RecentContextCard {
    return this.pushFromCard(buildContextCard(ref, opts));
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
