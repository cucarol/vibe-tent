// Machine-local user→agent one-shot task input (U2A append-input).
// Companion to A2U UserAsk — not chat, not a message bus, not profile mutation.
// Never written into workspace Git / .tent.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

/**
 * pending    — accepted/enqueued; waiting for managed inject and/or external poll
 * processing — background managed inject in flight (per-task FIFO worker)
 * delivered  — injected into a managed session (same-session follow-up); already processed
 * failed     — managed inject failed before provider accept; retained for retry / diagnostics
 * uncertain  — provider inject succeeded but durable delivered mark failed (at-most-once).
 *              Must NOT auto/manual-retry inject; may ack for cleanup / diagnostics only.
 * consumed   — external agent formally acked (poll+ack path)
 * cancelled  — interrupt / fail / session cleanup of still-open inputs only
 *
 * Managed inject race: sendFollowUpPrompt awaits the full turn, so session.prompt_complete
 * can auto-deliver and run cancelSession/cancelTask while the row is still open and
 * markDelivered has not run yet. Inputs in the managed-inject in-flight set (and
 * status=processing) are treated as non-cancelable until markDelivered/endManagedInject.
 *
 * Restart: persisted `processing` rows are reloaded as `uncertain`. The process may
 * have died after the provider accepted the prompt but before the delivered mark, so
 * reopening them as retryable would violate at-most-once delivery. `failed` /
 * `uncertain` survive restart as-is.
 */
export type TaskInputStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "failed"
  | "uncertain"
  | "consumed"
  | "cancelled";

/**
 * user-input      — task.sendInput one-shot append (## User Input)
 * review-feedback — lifecycle-generated task.reject --resume note (## Review Feedback)
 *
 * Both reuse the same persistence, delivery, state, and external poll/ack path.
 * Not chat; not a second prompt channel.
 */
export type TaskInputKind = "user-input" | "review-feedback";

export interface TaskInputRecord {
  id: string;
  workspaceId: string;
  taskPath: string;
  taskId?: string;
  sessionId?: string;
  role?: string;
  /**
   * Payload kind. Omitted / user-input = sendInput; review-feedback = reject-resume.
   * Defaults to user-input when missing (legacy rows + restart).
   */
  kind?: TaskInputKind;
  /** Optional free-text one-shot append, or exact review note for review-feedback. */
  text?: string;
  /** Optional stable entity ids (concept/box/task pointers) — not free text. */
  contextRefs?: string[];
  status: TaskInputStatus;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  consumedAt?: string;
  cancelledAt?: string;
  /** Present when status=failed|uncertain (or last managed inject diagnostic). */
  lastError?: string;
  failedAt?: string;
  /**
   * When status=uncertain: wall time of the at-most-once / unconfirmed delivery mark.
   * Distinct from failedAt so diagnostics do not conflate true inject failure with
   * "sent but confirmation disk write failed".
   */
  uncertainAt?: string;
  resolvedBy?: string;
}

export type TaskInputStoreOptions = {
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

function cloneInput(item: TaskInputRecord): TaskInputRecord {
  return {
    ...item,
    ...(item.contextRefs ? { contextRefs: [...item.contextRefs] } : {}),
  };
}

const TASK_INPUT_STATUSES = new Set<TaskInputStatus>([
  "pending",
  "processing",
  "delivered",
  "failed",
  "uncertain",
  "consumed",
  "cancelled",
]);

/**
 * Open rows: still eligible for managed inject / external poll (not terminal).
 * `uncertain` is intentionally excluded — at-most-once; no automatic re-inject.
 */
export function isTaskInputOpenStatus(status: TaskInputStatus): boolean {
  return (
    status === "pending" || status === "processing" || status === "failed"
  );
}

/**
 * Delivery-blocking rows for a task: must be consumed (managed inject/ack or
 * legitimate terminal) before a ready Delivery may publish.
 * - pending / processing / failed (retryable) → block
 * - uncertain → does **not** block (at-most-once; store safety, no re-inject)
 * - delivered / consumed / cancelled → do not block
 */
export function isTaskInputDeliveryBlockingStatus(
  status: TaskInputStatus
): boolean {
  return isTaskInputOpenStatus(status);
}

/**
 * Cancel-eligible: not yet delivered/consumed/uncertain and not mid-inject.
 * Uncertain is terminal for inject (already sent); cancel must not rewrite it.
 */
export function isTaskInputCancelEligibleStatus(
  status: TaskInputStatus
): boolean {
  return status === "pending" || status === "failed";
}

const TASK_INPUT_KINDS = new Set<TaskInputKind>([
  "user-input",
  "review-feedback",
]);

export function normalizeTaskInputKind(
  kind: TaskInputKind | string | undefined | null
): TaskInputKind {
  if (kind === "review-feedback") return "review-feedback";
  return "user-input";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** Parse untrusted machine state before any clone/projection touches it. */
function parseInput(value: unknown): TaskInputRecord | null {
  if (!isRecord(value)) return null;
  const {
    id,
    workspaceId,
    taskPath,
    taskId,
    sessionId,
    role,
    kind,
    text,
    contextRefs,
    status,
    createdAt,
    updatedAt,
    deliveredAt,
    consumedAt,
    cancelledAt,
    lastError,
    failedAt,
    uncertainAt,
    resolvedBy,
  } = value;
  if (
    !isRequiredString(id) ||
    !isRequiredString(workspaceId) ||
    !isRequiredString(taskPath) ||
    !isRequiredString(createdAt) ||
    !isRequiredString(updatedAt) ||
    !isValidDate(createdAt) ||
    !isValidDate(updatedAt) ||
    typeof status !== "string" ||
    !TASK_INPUT_STATUSES.has(status as TaskInputStatus) ||
    !isOptionalString(taskId) ||
    !isOptionalString(sessionId) ||
    !isOptionalString(role) ||
    !isOptionalString(text) ||
    !isOptionalString(deliveredAt) ||
    !isOptionalString(consumedAt) ||
    !isOptionalString(cancelledAt) ||
    !isOptionalString(lastError) ||
    !isOptionalString(failedAt) ||
    !isOptionalString(uncertainAt) ||
    !isOptionalString(resolvedBy) ||
    (deliveredAt !== undefined && !isValidDate(deliveredAt)) ||
    (consumedAt !== undefined && !isValidDate(consumedAt)) ||
    (cancelledAt !== undefined && !isValidDate(cancelledAt)) ||
    (failedAt !== undefined && !isValidDate(failedAt)) ||
    (uncertainAt !== undefined && !isValidDate(uncertainAt))
  ) {
    return null;
  }
  let parsedKind: TaskInputKind | undefined;
  if (kind !== undefined) {
    if (typeof kind !== "string" || !TASK_INPUT_KINDS.has(kind as TaskInputKind)) {
      return null;
    }
    parsedKind = kind as TaskInputKind;
  }
  let parsedRefs: string[] | undefined;
  if (contextRefs !== undefined) {
    if (!Array.isArray(contextRefs)) return null;
    parsedRefs = [];
    for (const r of contextRefs) {
      if (!isRequiredString(r)) return null;
      parsedRefs.push(r.trim());
    }
  }
  const resolvedKind = normalizeTaskInputKind(parsedKind);
  // user-input: at least one of text / contextRefs.
  // review-feedback: text may be empty (exact empty note); kind alone is enough.
  const hasText =
    typeof text === "string" &&
    (resolvedKind === "review-feedback" || text.trim().length > 0);
  const hasRefs = (parsedRefs?.length ?? 0) > 0;
  if (resolvedKind === "user-input" && !hasText && !hasRefs) return null;
  if (
    resolvedKind === "review-feedback" &&
    text !== undefined &&
    typeof text !== "string"
  ) {
    return null;
  }

  const persistedStatus = status as TaskInputStatus;
  const restoredUncertain = persistedStatus === "processing";
  return {
    id,
    workspaceId,
    taskPath,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(parsedKind !== undefined ? { kind: parsedKind } : {}),
    // review-feedback: preserve note exactly (no trim); user-input trims.
    ...(typeof text === "string"
      ? {
          text:
            resolvedKind === "review-feedback" ? text : text.trim(),
        }
      : {}),
    ...(parsedRefs !== undefined && parsedRefs.length > 0
      ? { contextRefs: parsedRefs }
      : {}),
    // A crashed processing turn has an unknowable provider boundary. Preserve
    // at-most-once semantics by requiring review instead of silently re-injecting.
    status: restoredUncertain ? "uncertain" : persistedStatus,
    createdAt,
    updatedAt,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(consumedAt !== undefined ? { consumedAt } : {}),
    ...(cancelledAt !== undefined ? { cancelledAt } : {}),
    ...(typeof lastError === "string"
      ? { lastError }
      : restoredUncertain
        ? { lastError: "service restarted while managed inject was processing" }
        : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(uncertainAt !== undefined
      ? { uncertainAt }
      : restoredUncertain
        ? { uncertainAt: updatedAt }
        : {}),
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
  };
}

/**
 * Single-process store for U2A one-shot task inputs.
 * Mutations + disk persistence are serialized.
 * Pending/delivered rows survive restart so external agents can still poll+ack.
 * Delivered means managed inject already processed — cancel must not rewrite it.
 */
export class TaskInputStore {
  private readonly file: string;
  private items = new Map<string, TaskInputRecord>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /**
   * Input ids currently in managed inject → markDelivered. Cancel must not rewrite
   * these rows to cancelled or markDelivered loses the race with delivery cleanup.
   */
  private readonly managedInjectInFlight = new Set<string>();

  constructor(dataDir: string, options?: TaskInputStoreOptions) {
    this.file = path.join(dataDir, "task-inputs.json");
    this.writeState = options?.writeState ?? writeJsonAtomic;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Pin a pending input across managed inject + markDelivered so concurrent
   * cancelTask/cancelSession (delivery/session cleanup) cannot rewrite it.
   * Process-local only; not persisted.
   */
  beginManagedInject(id: string): void {
    if (!id?.trim()) return;
    this.managedInjectInFlight.add(id);
  }

  /** Clear pin after markDelivered succeeds or continue path finishes. */
  endManagedInject(id: string): void {
    if (!id?.trim()) return;
    this.managedInjectInFlight.delete(id);
  }

  /** Test/diagnostics: whether cancel is currently blocked for this id. */
  isManagedInjectInFlight(id: string): boolean {
    return this.managedInjectInFlight.has(id);
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      try {
        const raw = await fs.readFile(this.file, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        const items = (parsed as { items?: unknown }).items;
        if (items !== undefined && !Array.isArray(items)) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        const loaded = new Map<string, TaskInputRecord>();
        for (const item of items ?? []) {
          const restored = parseInput(item);
          if (!restored) {
            await this.quarantineCorrupt();
            this.loaded = true;
            return;
          }
          loaded.set(restored.id, restored);
        }
        this.items = loaded;
        this.loaded = true;
      } catch (err) {
        if (isNotFoundError(err)) {
          this.loaded = true;
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Open inputs for external poll (pending + failed; not mid-inject processing).
   * Always scoped by workspaceId + taskPath — no machine-global inbox.
   * `failed` remains visible so agents can ack/retry and nothing is dropped.
   */
  async listPending(
    workspaceId: string,
    taskPath: string
  ): Promise<TaskInputRecord[]> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.listPending requires workspaceId and taskPath (no global inbox)"
      );
    }
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter(
        (i) =>
          (i.status === "pending" || i.status === "failed") &&
          i.workspaceId === workspaceId &&
          i.taskPath === taskPath
      )
      .map(cloneInput);
  }

  /**
   * All TaskInput rows for one (workspaceId, taskPath), any status.
   * Used by Delivery gate authority (not a global inbox).
   */
  async listForTask(
    workspaceId: string,
    taskPath: string
  ): Promise<TaskInputRecord[]> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.listForTask requires workspaceId and taskPath (no global inbox)"
      );
    }
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter(
        (i) => i.workspaceId === workspaceId && i.taskPath === taskPath
      )
      .map(cloneInput)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * Rows that must block a ready Delivery for this task (pending/processing/failed).
   * Uncertain and terminal statuses are excluded.
   */
  async listBlockingForDeliver(
    workspaceId: string,
    taskPath: string
  ): Promise<TaskInputRecord[]> {
    const all = await this.listForTask(workspaceId, taskPath);
    return all.filter((i) => isTaskInputDeliveryBlockingStatus(i.status));
  }

  /**
   * Scoped get: id alone is insufficient; workspaceId+taskPath must match.
   * Cross-workspace or wrong-task lookups return undefined (no leak).
   */
  async get(
    id: string,
    workspaceId: string,
    taskPath: string
  ): Promise<TaskInputRecord | undefined> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.get requires workspaceId and taskPath (no id-only lookup)"
      );
    }
    await this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) return undefined;
    if (item.workspaceId !== workspaceId || item.taskPath !== taskPath) {
      return undefined;
    }
    return cloneInput(item);
  }

  async add(item: TaskInputRecord): Promise<TaskInputRecord> {
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      if (this.items.has(item.id)) {
        throw new Error(`TaskInput already exists: ${item.id}`);
      }
      const stored = cloneInput(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(stored);
    });
  }

  /**
   * Rebind a still-pending input to the session that will inject/consume it.
   * Used after reject-resume creates a new ss- so review-feedback is not left
   * keyed to a dead prior session (cancelSession / projection / poll honesty).
   * Idempotent when sessionId already matches. Fail-loud on missing/scope/terminal.
   */
  async rebindSession(
    id: string,
    workspaceId: string,
    taskPath: string,
    sessionId: string
  ): Promise<TaskInputRecord> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.rebindSession requires workspaceId and taskPath"
      );
    }
    const nextSession = sessionId?.trim();
    if (!nextSession) {
      throw new Error("TaskInput.rebindSession requires non-empty sessionId");
    }
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.workspaceId !== workspaceId || item.taskPath !== taskPath) {
        throw new Error(`TaskInput not found: ${id}`);
      }
      // Allow rebind on open rows that are not mid-inject (pending/failed).
      if (item.status !== "pending" && item.status !== "failed") {
        throw new Error(
          `TaskInput.rebindSession requires pending or failed status; got ${item.status}: ${id}`
        );
      }
      if (item.sessionId === nextSession) {
        return cloneInput(item);
      }
      const now = new Date().toISOString();
      const rebound: TaskInputRecord = {
        ...item,
        sessionId: nextSession,
        updatedAt: now,
      };
      const next = new Map(this.items);
      next.set(id, rebound);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(rebound);
    });
  }

  /**
   * Claim a pending/failed row for background managed inject: → processing.
   * Clears prior lastError/failedAt. Fail-loud if missing or not open for claim.
   */
  async markProcessing(id: string): Promise<TaskInputRecord> {
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.status !== "pending" && item.status !== "failed") {
        throw new Error(
          `TaskInput.markProcessing requires pending or failed; got ${item.status}: ${id}`
        );
      }
      const now = new Date().toISOString();
      const nextRow: TaskInputRecord = {
        ...item,
        status: "processing",
        updatedAt: now,
      };
      delete nextRow.lastError;
      delete nextRow.failedAt;
      delete nextRow.uncertainAt;
      const next = new Map(this.items);
      next.set(id, nextRow);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(nextRow);
    });
  }

  /**
   * Mark managed inject success: pending|processing → delivered.
   * Optional sessionId persists the session that actually received the inject
   * (e.g. reject-resume new ss- after sessionIdOverride).
   */
  async markDelivered(
    id: string,
    resolvedBy = "service",
    opts?: { sessionId?: string }
  ): Promise<TaskInputRecord> {
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.status !== "pending" && item.status !== "processing") {
        throw new Error(`TaskInput already ${item.status}: ${id}`);
      }
      const now = new Date().toISOString();
      const injectSession = opts?.sessionId?.trim();
      const resolved: TaskInputRecord = {
        ...item,
        ...(injectSession ? { sessionId: injectSession } : {}),
        status: "delivered",
        updatedAt: now,
        deliveredAt: now,
        resolvedBy,
      };
      delete resolved.lastError;
      delete resolved.failedAt;
      delete resolved.uncertainAt;
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(resolved);
    });
  }

  /**
   * Mark managed inject failure: processing|pending → failed (never drop).
   * Retained for poll visibility, diagnostics, and later retry enqueue.
   * Do not use when the provider already accepted the inject — use markUncertain.
   */
  async markFailed(
    id: string,
    error: string,
    resolvedBy = "service"
  ): Promise<TaskInputRecord> {
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (
        item.status !== "pending" &&
        item.status !== "processing" &&
        item.status !== "failed"
      ) {
        throw new Error(
          `TaskInput.markFailed requires open status; got ${item.status}: ${id}`
        );
      }
      const now = new Date().toISOString();
      const message = (error || "managed inject failed").trim() || "managed inject failed";
      const resolved: TaskInputRecord = {
        ...item,
        status: "failed",
        updatedAt: now,
        failedAt: now,
        lastError: message,
        resolvedBy,
      };
      delete resolved.uncertainAt;
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(resolved);
    });
  }

  /**
   * At-most-once uncertain delivery: provider inject already succeeded, but durable
   * markDelivered failed. Terminal for re-inject — not listPending, not cancel-eligible,
   * not markPendingForRetry. Survives restart as uncertain (never reloads as pending).
   */
  async markUncertain(
    id: string,
    error: string,
    resolvedBy = "service",
    opts?: { sessionId?: string }
  ): Promise<TaskInputRecord> {
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.status !== "pending" && item.status !== "processing") {
        throw new Error(
          `TaskInput.markUncertain requires pending or processing; got ${item.status}: ${id}`
        );
      }
      const now = new Date().toISOString();
      const message =
        (error || "managed inject ok but delivery confirmation failed")
          .trim() || "managed inject ok but delivery confirmation failed";
      const injectSession = opts?.sessionId?.trim();
      const resolved: TaskInputRecord = {
        ...item,
        ...(injectSession ? { sessionId: injectSession } : {}),
        status: "uncertain",
        updatedAt: now,
        uncertainAt: now,
        lastError: message,
        resolvedBy,
      };
      delete resolved.failedAt;
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(resolved);
    });
  }

  /**
   * Re-open a failed (or stuck) row as pending for retry. Does not re-inject.
   * Uncertain is refused — already-sent rows must not re-enter the inject path.
   */
  async markPendingForRetry(
    id: string,
    workspaceId: string,
    taskPath: string
  ): Promise<TaskInputRecord> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.markPendingForRetry requires workspaceId and taskPath"
      );
    }
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.workspaceId !== workspaceId || item.taskPath !== taskPath) {
        throw new Error(`TaskInput not found: ${id}`);
      }
      if (item.status === "uncertain") {
        throw new Error(
          `TaskInput.markPendingForRetry refuses uncertain (at-most-once; already sent): ${id}`
        );
      }
      if (item.status !== "failed" && item.status !== "pending") {
        throw new Error(
          `TaskInput.markPendingForRetry requires failed or pending; got ${item.status}: ${id}`
        );
      }
      if (item.status === "pending") return cloneInput(item);
      const now = new Date().toISOString();
      const nextRow: TaskInputRecord = {
        ...item,
        status: "pending",
        updatedAt: now,
      };
      // Keep lastError for diagnostics until a successful deliver clears it.
      const next = new Map(this.items);
      next.set(id, nextRow);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(nextRow);
    });
  }

  /**
   * External agent formal ack: pending|failed|delivered|uncertain → consumed.
   * Scoped by workspaceId+taskPath; fail-loud on unknown id, scope mismatch, or terminal.
   * Mid-inject processing cannot be acked (wait for deliver/fail/uncertain).
   * Ack of uncertain is cleanup only — it does not re-inject.
   */
  async ack(
    id: string,
    workspaceId: string,
    taskPath: string,
    resolvedBy: string
  ): Promise<TaskInputRecord> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "TaskInput.ack requires workspaceId and taskPath (no id-only ack)"
      );
    }
    if (this.closed) throw new Error("TaskInput store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("TaskInput store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`TaskInput not found: ${id}`);
      if (item.workspaceId !== workspaceId || item.taskPath !== taskPath) {
        throw new Error(`TaskInput not found: ${id}`);
      }
      if (
        item.status !== "pending" &&
        item.status !== "failed" &&
        item.status !== "delivered" &&
        item.status !== "uncertain"
      ) {
        throw new Error(`TaskInput already ${item.status}: ${id}`);
      }
      const now = new Date().toISOString();
      const resolved: TaskInputRecord = {
        ...item,
        status: "consumed",
        updatedAt: now,
        consumedAt: now,
        resolvedBy,
        ...(item.deliveredAt ? { deliveredAt: item.deliveredAt } : {}),
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneInput(resolved);
    });
  }

  /**
   * Cancel open (pending/failed) inputs for one (workspace, task).
   * Delivered/processing stay: delivered already processed; processing is in-flight.
   * Rows pinned by beginManagedInject are skipped (inject→markDelivered window).
   */
  async cancelTask(
    workspaceId: string,
    taskPath: string,
    resolvedBy = "service"
  ): Promise<TaskInputRecord[]> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const cancelled: TaskInputRecord[] = [];
      const now = new Date().toISOString();
      for (const item of this.items.values()) {
        if (
          item.workspaceId !== workspaceId ||
          item.taskPath !== taskPath ||
          !isTaskInputCancelEligibleStatus(item.status) ||
          this.managedInjectInFlight.has(item.id)
        ) {
          continue;
        }
        const row: TaskInputRecord = {
          ...item,
          status: "cancelled",
          updatedAt: now,
          cancelledAt: now,
          resolvedBy,
        };
        next.set(item.id, row);
        cancelled.push(cloneInput(row));
      }
      if (cancelled.length > 0) {
        await this.persistSnapshot(next);
        this.items = next;
      }
      return cancelled;
    });
  }

  /**
   * Cancel open (pending/failed) inputs bound to a session.
   * Never rewrites delivered/consumed/processing rows.
   * Rows pinned by beginManagedInject are skipped (same race as cancelTask).
   */
  async cancelSession(
    sessionId: string,
    resolvedBy = "service"
  ): Promise<TaskInputRecord[]> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const cancelled: TaskInputRecord[] = [];
      const now = new Date().toISOString();
      for (const item of this.items.values()) {
        if (
          item.sessionId !== sessionId ||
          !isTaskInputCancelEligibleStatus(item.status) ||
          this.managedInjectInFlight.has(item.id)
        ) {
          continue;
        }
        const row: TaskInputRecord = {
          ...item,
          status: "cancelled",
          updatedAt: now,
          cancelledAt: now,
          resolvedBy,
        };
        next.set(item.id, row);
        cancelled.push(cloneInput(row));
      }
      if (cancelled.length > 0) {
        await this.persistSnapshot(next);
        this.items = next;
      }
      return cancelled;
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.ensureLoaded().then(() => undefined);
    return this.shutdownPromise;
  }

  private async persistSnapshot(
    snapshot: Map<string, TaskInputRecord>
  ): Promise<void> {
    const items = [...snapshot.values()];
    // Keep open + delivered + uncertain + a bounded tail of terminal rows.
    // processing/failed/pending/uncertain survive restart; processing reloads as uncertain.
    // uncertain must remain durable (at-most-once evidence after process death).
    const open = items.filter(
      (i) =>
        i.status === "pending" ||
        i.status === "processing" ||
        i.status === "failed" ||
        i.status === "uncertain" ||
        i.status === "delivered"
    );
    const terminal = items
      .filter((i) => i.status === "consumed" || i.status === "cancelled")
      .sort((a, b) =>
        (b.consumedAt || b.cancelledAt || b.updatedAt || "").localeCompare(
          a.consumedAt || a.cancelledAt || a.updatedAt || ""
        )
      )
      .slice(0, 100);
    await this.writeState(this.file, { items: [...open, ...terminal] });
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }
}

export function makeTaskInputId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ti-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/**
 * Fixed-format U2A payload for managed ACP follow-up session/prompt.
 * user-input → ## User Input; review-feedback → ## Review Feedback.
 * Not a chat transcript — a single structured input block.
 */
export function formatTaskInputPrompt(input: TaskInputRecord): string {
  const kind = normalizeTaskInputKind(input.kind);
  if (kind === "review-feedback") {
    const lines = [
      "## Review Feedback",
      `inputId: ${input.id}`,
      `taskPath: ${input.taskPath}`,
      `kind: review-feedback`,
    ];
    // Preserve the review note exactly (including empty / whitespace-only).
    lines.push(
      `text: ${typeof input.text === "string" ? input.text : ""}`
    );
    if (input.createdAt) lines.push(`createdAt: ${input.createdAt}`);
    lines.push(
      "",
      "Lifecycle-generated review feedback for the same task after reject-resume. Not chat history. Do not invent prior messages. Final report still goes through Delivery only."
    );
    return lines.join("\n");
  }

  const lines = [
    "## User Input",
    `inputId: ${input.id}`,
    `taskPath: ${input.taskPath}`,
  ];
  if (input.text) lines.push(`text: ${input.text}`);
  if (input.contextRefs?.length) {
    lines.push(`contextRefs: ${input.contextRefs.join(", ")}`);
  }
  if (input.createdAt) lines.push(`createdAt: ${input.createdAt}`);
  lines.push(
    "",
    "One-shot user append to the running task. Not chat history. Do not invent prior messages. Final report still goes through Delivery only."
  );
  return lines.join("\n");
}
