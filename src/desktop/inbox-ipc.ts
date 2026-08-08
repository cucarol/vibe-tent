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

export type DesktopInboxClientGetter = () => DesktopInboxClient | null;

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

function normalizeServiceItem(
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

export function normalizeServiceInboxResponse(
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
    normalizeServiceItem(item, expectedWorkspaceId, index)
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

const DESKTOP_INBOX_SNAPSHOT_KEYS = new Set(["workspaceId", "items", "count"]);
const DESKTOP_INBOX_ITEM_KEYS = new Set(["id", "kind", "createdAt", "summary", "sourceNodeId"]);

function hasOnlyKeys(value: RecordValue, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateDesktopInboxItem(
  value: unknown,
  index: number
): DesktopInboxItem {
  if (!isRecord(value) || !hasOnlyKeys(value, DESKTOP_INBOX_ITEM_KEYS)) {
    throw new Error(`Desktop Inbox item[${index}] is corrupt`);
  }
  if (
    !nonEmptyString(value.id) ||
    !isInteractionKind(value.kind) ||
    !nonEmptyString(value.createdAt) ||
    !nonEmptyString(value.summary)
  ) {
    throw new Error(`Desktop Inbox item[${index}] identity is corrupt`);
  }
  if (value.sourceNodeId !== undefined && !nonEmptyString(value.sourceNodeId)) {
    throw new Error(`Desktop Inbox item[${index}] sourceNodeId is corrupt`);
  }
  return {
    id: value.id,
    kind: value.kind,
    createdAt: value.createdAt,
    summary: value.summary,
    ...(nonEmptyString(value.sourceNodeId) ? { sourceNodeId: value.sourceNodeId } : {}),
  };
}

export function validateDesktopInboxSnapshot(
  value: unknown,
  expectedWorkspaceId: string
): DesktopInboxSnapshot {
  if (!nonEmptyString(expectedWorkspaceId)) {
    throw new Error("workspaceId is required");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, DESKTOP_INBOX_SNAPSHOT_KEYS) ||
    value.workspaceId !== expectedWorkspaceId ||
    !Array.isArray(value.items) ||
    typeof value.count !== "number" ||
    !Number.isInteger(value.count) ||
    value.count < 0 ||
    value.count !== value.items.length
  ) {
    throw new Error("Desktop Inbox DTO is corrupt or workspace-scoped incorrectly");
  }
  const items = value.items.map((item, index) => validateDesktopInboxItem(item, index));
  return { workspaceId: expectedWorkspaceId, items, count: items.length };
}

export async function handleDesktopInboxRequest(
  getClient: DesktopInboxClientGetter,
  workspaceId: unknown
): Promise<DesktopInboxSnapshot> {
  if (!nonEmptyString(workspaceId)) throw new Error("workspaceId is required");
  const client = getClient();
  if (!client) throw new Error("Service not attached");
  const ws = workspaceId.trim();
  const raw = await client.call("interaction.listPending", { workspaceId: ws });
  return normalizeServiceInboxResponse(raw, ws);
}
