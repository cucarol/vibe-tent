// In-process event fan-out for Local Service.

import { randomBytes } from "node:crypto";
import type { EventEnvelope } from "./types.js";

export type EventListener = (event: EventEnvelope) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  private seq = 0;

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit<TType extends string, TPayload>(
    type: TType,
    workspaceId: string,
    payload: TPayload,
    source: "service" | "self" = "service"
  ): EventEnvelope<TType, TPayload> {
    const event: EventEnvelope<TType, TPayload> = {
      id: `ev-${Date.now().toString(36)}-${(++this.seq).toString(36)}-${randomBytes(3).toString("hex")}`,
      type,
      workspaceId,
      ts: new Date().toISOString(),
      source,
      payload,
    };
    for (const listener of this.listeners) {
      try {
        listener(event as EventEnvelope);
      } catch {
        // Client listeners must not break the bus.
      }
    }
    return event;
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
