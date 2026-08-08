import type { PendingInteractionKind } from "../service/types.js";

export type DesktopInboxInteractionKind = PendingInteractionKind;

export type DesktopInboxItem = {
  id: string;
  kind: DesktopInboxInteractionKind;
  createdAt: string;
  summary: string;
  sourceNodeId?: string;
};

export type DesktopInboxSnapshot = {
  workspaceId: string;
  items: DesktopInboxItem[];
  count: number;
};

export type DesktopInboxClient = {
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteractionKind(value: unknown): value is DesktopInboxInteractionKind {
  return value === "decisionRequest" || value === "toolApproval" || value === "delivery";
}

function normalizeItem(
  value: unknown,
  workspaceId: string,
  index: number
): DesktopInboxItem {
  if (!isRecord(value) || value.workspaceId !== workspaceId) {
    throw new Error(`interaction.listPending items[${index}] workspaceId mismatch`);
  }
  if (
    !nonEmptyString(value.id) ||
    !isInteractionKind(value.kind) ||
    !nonEmptyString(value.createdAt)
  ) {
    throw new Error(`interaction.listPending items[${index}] identity is corrupt`);
  }

  let summary: string;
  if (value.kind === "decisionRequest") {
    if (!nonEmptyString(value.question)) {
      throw new Error(`interaction.listPending items[${index}] question is corrupt`);
    }
    summary = value.question;
  } else if (value.kind === "toolApproval") {
    if (!nonEmptyString(value.toolTitle)) {
      throw new Error(`interaction.listPending items[${index}] tool title is corrupt`);
    }
    summary = value.toolTitle;
  } else {
    summary = "Delivery ready for review";
  }

  const sourceNodeId = value.kind === "delivery" ? value.sourceNodeId : undefined;
  if (sourceNodeId !== undefined && !nonEmptyString(sourceNodeId)) {
    throw new Error(`interaction.listPending items[${index}] sourceNodeId is corrupt`);
  }

  return {
    id: value.id,
    kind: value.kind,
    createdAt: value.createdAt,
    summary,
    ...(nonEmptyString(sourceNodeId) ? { sourceNodeId } : {}),
  };
}

export function normalizeDesktopInboxSnapshot(
  value: unknown,
  expectedWorkspaceId: string
): DesktopInboxSnapshot {
  if (!nonEmptyString(expectedWorkspaceId)) {
    throw new Error("workspaceId is required");
  }
  if (!isRecord(value) || value.workspaceId !== expectedWorkspaceId) {
    throw new Error("interaction.listPending workspaceId mismatch or payload is not an object");
  }
  if (!Array.isArray(value.items) || !isRecord(value.counts)) {
    throw new Error("interaction.listPending payload is missing items or counts");
  }

  const items = value.items.map((item, index) =>
    normalizeItem(item, expectedWorkspaceId, index)
  );
  const counts = value.counts;
  const byKind = {
    decisionRequest: items.filter((item) => item.kind === "decisionRequest").length,
    toolApproval: items.filter((item) => item.kind === "toolApproval").length,
    delivery: items.filter((item) => item.kind === "delivery").length,
  };
  if (
    counts.decisionRequest !== byKind.decisionRequest ||
    counts.toolApproval !== byKind.toolApproval ||
    counts.delivery !== byKind.delivery ||
    counts.total !== items.length ||
    Object.values(counts).some(
      (count) => typeof count !== "number" || !Number.isInteger(count) || count < 0
    )
  ) {
    throw new Error("interaction.listPending counts are corrupt");
  }

  return { workspaceId: expectedWorkspaceId, items, count: items.length };
}

export async function handleDesktopInboxRequest(
  client: DesktopInboxClient | null,
  workspaceId: unknown
): Promise<DesktopInboxSnapshot> {
  if (!nonEmptyString(workspaceId)) throw new Error("workspaceId is required");
  if (!client) throw new Error("Service not attached");
  const ws = workspaceId.trim();
  const raw = await client.call("interaction.listPending", { workspaceId: ws });
  return normalizeDesktopInboxSnapshot(raw, ws);
}
