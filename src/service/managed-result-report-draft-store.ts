// Machine-local managed TaskResult *report draft* preservation.
//
// Scope: the complete bounded final assistantText for one managed turn, including
// blocked/needs-input control reports. Not chat history, not a sixth pending-
// interaction surface, and not a ready TaskResult under temp/*/results.
//
// Survives service restart so seal / dirty-worktree / collect / integrate /
// task.submit failures can retry without re-prompting the Agent.
// Cleared only after a successful TaskResult publish or after the full return is
// durably projected into Task.statusDetail (including terminal promotion).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isNotFoundError,
  writeJsonAtomic,
} from "../machine-state.js";

export interface ManagedTaskResultReportDraft {
  workspaceId: string;
  taskPath: string;
  taskId?: string;
  sessionId: string;
  /** Complete final assistant report/control wire (trimmed non-empty). */
  assistantText: string;
  createdAt: string;
  updatedAt: string;
  /** Last publish attempt diagnostic; never a terminal task failure. */
  lastError?: string;
}

export type ManagedTaskResultReportDraftStoreOptions = {
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

function cloneDraft(item: ManagedTaskResultReportDraft): ManagedTaskResultReportDraft {
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
function parseDraft(value: unknown): ManagedTaskResultReportDraft {
  if (!isRecord(value)) throw invalidDraftState();
  const keys = Object.keys(value);
  const allowed = new Set([
    "workspaceId",
    "taskPath",
    "taskId",
    "sessionId",
    "assistantText",
    "createdAt",
    "updatedAt",
    "lastError",
  ]);
  if (keys.some((key) => !allowed.has(key))) throw invalidDraftState();
  const {
    workspaceId,
    taskPath,
    taskId,
    sessionId,
    assistantText,
    createdAt,
    updatedAt,
    lastError,
  } = value;
  if (
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
    throw invalidDraftState();
  }
  const text = assistantText.trim();
  if (!text) throw invalidDraftState();
  return {
    workspaceId: workspaceId.trim(),
    taskPath: taskPath.trim(),
    ...(taskId !== undefined && taskId.trim() ? { taskId: taskId.trim() } : {}),
    sessionId: sessionId.trim(),
    assistantText: text,
    createdAt,
    updatedAt,
    ...(typeof lastError === "string" && lastError.trim()
      ? { lastError: lastError.trim() }
      : {}),
  };
}

function invalidDraftState(): Error {
  return new Error("Managed TaskResult report draft state is malformed");
}

/**
 * Single-process store for managed auto-deliver report drafts.
 * One open draft per workspaceId+taskPath. Mutations + disk are serialized.
 */
export class ManagedTaskResultReportDraftStore {
  private readonly file: string;
  /** Key = workspaceId::taskPath */
  private items = new Map<string, ManagedTaskResultReportDraft>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: ManagedTaskResultReportDraftStoreOptions) {
    this.file = path.join(dataDir, "managed-result-report-drafts.json");
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
          throw invalidDraftState();
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw invalidDraftState();
        }
        if (Object.keys(parsed as Record<string, unknown>).some((key) => key !== "items")) {
          throw invalidDraftState();
        }
        const items = (parsed as { items?: unknown }).items;
        if (!Array.isArray(items)) {
          throw invalidDraftState();
        }
        const loaded = new Map<string, ManagedTaskResultReportDraft>();
        for (const item of items) {
          const restored = parseDraft(item);
          const key = draftKey(restored.workspaceId, restored.taskPath);
          if (loaded.has(key)) throw invalidDraftState();
          loaded.set(key, restored);
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
  ): Promise<ManagedTaskResultReportDraft | undefined> {
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedTaskResultReportDraft.get requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    const item = this.items.get(draftKey(workspaceId, taskPath));
    return item ? cloneDraft(item) : undefined;
  }

  /**
   * List open drafts (optional workspace filter). Operational diagnostics only.
   */
  async list(workspaceId?: string): Promise<ManagedTaskResultReportDraft[]> {
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter((i) => !workspaceId || i.workspaceId === workspaceId)
      .map(cloneDraft);
  }

  /**
   * Preserve / refresh the final report before publish.
   * Idempotent for the same task: replaces assistantText/Session, clears the
   * prior diagnostic, and keeps createdAt on first write.
   */
  async preserve(input: {
    workspaceId: string;
    taskPath: string;
    taskId?: string;
    sessionId: string;
    assistantText: string;
  }): Promise<ManagedTaskResultReportDraft> {
    if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
    const workspaceId = input.workspaceId?.trim();
    const taskPath = input.taskPath?.trim();
    const sessionId = input.sessionId?.trim();
    const assistantText = input.assistantText?.trim();
    if (!workspaceId || !taskPath || !sessionId || !assistantText) {
      throw new Error(
        "ManagedTaskResultReportDraft.preserve requires workspaceId, taskPath, sessionId, and non-empty assistantText"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
      const key = draftKey(workspaceId, taskPath);
      const now = new Date().toISOString();
      const existing = this.items.get(key);
      const taskId = input.taskId?.trim();
      const nextRow: ManagedTaskResultReportDraft = existing
        ? {
            ...existing,
            sessionId,
            assistantText,
            updatedAt: now,
            ...(taskId ? { taskId } : existing.taskId ? { taskId: existing.taskId } : {}),
          }
        : {
            workspaceId,
            taskPath,
            ...(taskId ? { taskId } : {}),
            sessionId,
            assistantText,
            createdAt: now,
            updatedAt: now,
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
  ): Promise<ManagedTaskResultReportDraft | undefined> {
    if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedTaskResultReportDraft.markFailed requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
      const key = draftKey(workspaceId, taskPath);
      const item = this.items.get(key);
      if (!item) return undefined;
      const now = new Date().toISOString();
      const message =
        (error || "managed auto-submit failed").trim() || "managed auto-submit failed";
      const nextRow: ManagedTaskResultReportDraft = {
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
   * Remove draft after successful TaskResult or durable Task return projection.
   * Idempotent when already absent.
   */
  async clear(workspaceId: string, taskPath: string): Promise<boolean> {
    if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
    if (!workspaceId?.trim() || !taskPath?.trim()) {
      throw new Error(
        "ManagedTaskResultReportDraft.clear requires workspaceId and taskPath"
      );
    }
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("ManagedTaskResultReportDraft store is closed");
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

  private async persistSnapshot(
    snapshot: Map<string, ManagedTaskResultReportDraft>
  ): Promise<void> {
    // Only open drafts are retained; published rows are deleted via clear().
    const items = [...snapshot.values()];
    await this.writeState(this.file, { items });
  }
}
