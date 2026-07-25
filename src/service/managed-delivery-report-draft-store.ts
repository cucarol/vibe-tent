// Machine-local managed Delivery *report draft* preservation.
//
// Scope: only the final assistantText that managed auto-deliver will publish as
// Delivery.summary. Not chat history, not a sixth pending-interaction surface,
// not a ready Delivery / draft Delivery record under temp/*/deliveries.
//
// Survives service restart so seal / dirty-worktree / collect / integrate /
// task.deliver failures can retry without re-prompting the Agent.
// Cleared only after a successful Delivery publish.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

export interface ManagedDeliveryReportDraft {
  id: string;
  workspaceId: string;
  taskPath: string;
  taskId?: string;
  sessionId: string;
  /** Final assistant report body (trimmed non-empty). */
  assistantText: string;
  createdAt: string;
  updatedAt: string;
  /** Last publish attempt diagnostic; never a terminal task failure. */
  lastError?: string;
  /** How many publish attempts have been recorded for this draft. */
  attemptCount: number;
}

export type ManagedDeliveryReportDraftStoreOptions = {
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

function cloneDraft(item: ManagedDeliveryReportDraft): ManagedDeliveryReportDraft {
  return { ...item };
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

function draftKey(workspaceId: string, taskPath: string): string {
  return `${workspaceId}::${taskPath}`;
}

/** Parse untrusted machine state before any clone/projection touches it. */
function parseDraft(value: unknown): ManagedDeliveryReportDraft | null {
  if (!isRecord(value)) return null;
  const {
    id,
    workspaceId,
    taskPath,
    taskId,
    sessionId,
    assistantText,
    createdAt,
    updatedAt,
    lastError,
    attemptCount,
  } = value;
  if (
    !isRequiredString(id) ||
    !isRequiredString(workspaceId) ||
    !isRequiredString(taskPath) ||
    !isRequiredString(sessionId) ||
    !isRequiredString(assistantText) ||
    !isRequiredString(createdAt) ||
    !isRequiredString(updatedAt) ||
    !isValidDate(createdAt) ||
    !isValidDate(updatedAt) ||
    !isOptionalString(taskId) ||
    !isOptionalString(lastError)
  ) {
    return null;
  }
  const text = assistantText.trim();
  if (!text) return null;
  let attempts = 0;
  if (attemptCount !== undefined) {
    if (typeof attemptCount !== "number" || !Number.isFinite(attemptCount) || attemptCount < 0) {
      return null;
    }
    attempts = Math.floor(attemptCount);
  }
  return {
    id,
    workspaceId,
    taskPath,
    ...(taskId !== undefined && taskId.trim() ? { taskId: taskId.trim() } : {}),
    sessionId,
    assistantText: text,
    createdAt,
    updatedAt,
    ...(typeof lastError === "string" && lastError.trim()
      ? { lastError: lastError.trim() }
      : {}),
    attemptCount: attempts,
  };
}

export function makeManagedDeliveryReportDraftId(
  rand: () => number = Math.random
): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "mrd-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/**
 * Single-process store for managed auto-deliver report drafts.
 * One open draft per workspaceId+taskPath. Mutations + disk are serialized.
 */
export class ManagedDeliveryReportDraftStore {
  private readonly file: string;
  /** Key = workspaceId::taskPath */
  private items = new Map<string, ManagedDeliveryReportDraft>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: ManagedDeliveryReportDraftStoreOptions) {
    this.file = path.join(dataDir, "managed-delivery-report-drafts.json");
    this.writeState = options?.writeState ?? writeJsonAtomic;
  }

  /** Absolute path of the durable JSON file (tests / diagnostics). */
  get filePath(): string {
    return this.file;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
        const loaded = new Map<string, ManagedDeliveryReportDraft>();
        for (const item of items ?? []) {
          const restored = parseDraft(item);
          if (!restored) {
            await this.quarantineCorrupt();
            this.loaded = true;
            return;
          }
          loaded.set(draftKey(restored.workspaceId, restored.taskPath), restored);
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
   * Lookup open draft for a task. Survives restart; never invents content.
   */
  async get(
    workspaceId: string,
    taskPath: string
  ): Promise<ManagedDeliveryReportDraft | undefined> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedDeliveryReportDraft.get requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    const item = this.items.get(draftKey(workspaceId, taskPath));
    return item ? cloneDraft(item) : undefined;
  }

  /**
   * List open drafts (optional workspace filter). Operational diagnostics only.
   */
  async list(workspaceId?: string): Promise<ManagedDeliveryReportDraft[]> {
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter((i) => !workspaceId || i.workspaceId === workspaceId)
      .map(cloneDraft);
  }

  /**
   * Preserve / refresh the final report before publish.
   * Idempotent for the same task: replaces assistantText, bumps attemptCount,
   * keeps createdAt on first write.
   */
  async preserve(input: {
    workspaceId: string;
    taskPath: string;
    taskId?: string;
    sessionId: string;
    assistantText: string;
  }): Promise<ManagedDeliveryReportDraft> {
    if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
    const workspaceId = input.workspaceId?.trim();
    const taskPath = input.taskPath?.trim();
    const sessionId = input.sessionId?.trim();
    const assistantText = input.assistantText?.trim();
    if (!workspaceId || !taskPath || !sessionId || !assistantText) {
      throw new Error(
        "ManagedDeliveryReportDraft.preserve requires workspaceId, taskPath, sessionId, and non-empty assistantText"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
      const key = draftKey(workspaceId, taskPath);
      const now = new Date().toISOString();
      const existing = this.items.get(key);
      const taskId = input.taskId?.trim();
      const nextRow: ManagedDeliveryReportDraft = existing
        ? {
            ...existing,
            sessionId,
            assistantText,
            updatedAt: now,
            attemptCount: existing.attemptCount + 1,
            ...(taskId ? { taskId } : existing.taskId ? { taskId: existing.taskId } : {}),
          }
        : {
            id: makeManagedDeliveryReportDraftId(),
            workspaceId,
            taskPath,
            ...(taskId ? { taskId } : {}),
            sessionId,
            assistantText,
            createdAt: now,
            updatedAt: now,
            attemptCount: 1,
          };
      // Fresh preserve clears prior lastError; markFailed re-annotates on failure.
      delete nextRow.lastError;
      const next = new Map(this.items);
      next.set(key, nextRow);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneDraft(nextRow);
    });
  }

  /**
   * Annotate last publish failure without dropping the report body.
   * No-op (returns undefined) when no draft exists for the task.
   */
  async markFailed(
    workspaceId: string,
    taskPath: string,
    error: string
  ): Promise<ManagedDeliveryReportDraft | undefined> {
    if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedDeliveryReportDraft.markFailed requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
      const key = draftKey(workspaceId, taskPath);
      const item = this.items.get(key);
      if (!item) return undefined;
      const now = new Date().toISOString();
      const message =
        (error || "managed auto-deliver failed").trim() || "managed auto-deliver failed";
      const nextRow: ManagedDeliveryReportDraft = {
        ...item,
        updatedAt: now,
        lastError: message,
      };
      const next = new Map(this.items);
      next.set(key, nextRow);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneDraft(nextRow);
    });
  }

  /**
   * Remove draft after successful Delivery (or when no longer needed).
   * Idempotent when already absent.
   */
  async clear(workspaceId: string, taskPath: string): Promise<boolean> {
    if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedDeliveryReportDraft.clear requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedDeliveryReportDraft store is closed");
      const key = draftKey(workspaceId, taskPath);
      if (!this.items.has(key)) return false;
      const next = new Map(this.items);
      next.delete(key);
      await this.persistSnapshot(next);
      this.items = next;
      return true;
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.ensureLoaded().then(() => undefined);
    return this.shutdownPromise;
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }

  private async persistSnapshot(
    snapshot: Map<string, ManagedDeliveryReportDraft>
  ): Promise<void> {
    // Only open drafts are retained; published rows are deleted via clear().
    const items = [...snapshot.values()];
    await this.writeState(this.file, { items });
  }
}
