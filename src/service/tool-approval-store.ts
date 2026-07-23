// Machine-local pending ACP *tool* permission approvals (permissionPolicy=ask).
// Distinct from A2A spawn approvals (a2a-store.ts). Never written into workspace Git / .tent.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

/**
 * Resolve workspace binding for an ACP tool approval.
 * Fail closed: only the session row's workspace is authoritative.
 * Never fall back to Desktop foreground workspace (wrong-mount risk).
 */
export function resolveToolApprovalWorkspaceId(
  sessionWorkspace: string | null | undefined
): string | null {
  if (typeof sessionWorkspace !== "string") return null;
  const workspaceId = sessionWorkspace.trim();
  return workspaceId || null;
}

export type ToolApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** Safe option projection for UI — no secrets, no stdout tails. */
export type ToolPermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export interface ToolPendingApproval {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  taskPath?: string;
  role?: string;
  /** Human-readable tool title from ACP (e.g. read_file). */
  toolTitle: string;
  toolCallId?: string;
  options: ToolPermissionOption[];
  status: ToolApprovalStatus;
  createdAt: string;
  /** ISO expiry; after this, resolve as deny/expired. */
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type ToolApprovalStoreOptions = {
  /** Injectable atomic writer for deterministic persistence-failure tests. */
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

function cloneApproval(item: ToolPendingApproval): ToolPendingApproval {
  return {
    ...item,
    options: item.options.map((option) => ({ ...option })),
  };
}

const TOOL_APPROVAL_STATUSES = new Set<ToolApprovalStatus>([
  "pending",
  "approved",
  "denied",
  "expired",
]);

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
function parseApproval(value: unknown): ToolPendingApproval | null {
  if (!isRecord(value)) return null;
  const {
    id,
    workspaceId,
    sessionId,
    taskId,
    taskPath,
    role,
    toolTitle,
    toolCallId,
    options,
    status,
    createdAt,
    expiresAt,
    resolvedAt,
    resolvedBy,
  } = value;
  if (
    !isRequiredString(id) ||
    !isRequiredString(workspaceId) ||
    !isRequiredString(sessionId) ||
    !isRequiredString(toolTitle) ||
    !isRequiredString(createdAt) ||
    !isRequiredString(expiresAt) ||
    !isValidDate(createdAt) ||
    !isValidDate(expiresAt) ||
    typeof status !== "string" ||
    !TOOL_APPROVAL_STATUSES.has(status as ToolApprovalStatus) ||
    !Array.isArray(options) ||
    !isOptionalString(taskId) ||
    !isOptionalString(taskPath) ||
    !isOptionalString(role) ||
    !isOptionalString(toolCallId) ||
    !isOptionalString(resolvedAt) ||
    !isOptionalString(resolvedBy) ||
    (resolvedAt !== undefined && !isValidDate(resolvedAt))
  ) {
    return null;
  }
  const parsedOptions: ToolPermissionOption[] = [];
  for (const option of options) {
    if (
      !isRecord(option) ||
      !isRequiredString(option.optionId) ||
      !isOptionalString(option.kind) ||
      !isOptionalString(option.name)
    ) {
      return null;
    }
    parsedOptions.push({
      optionId: option.optionId,
      ...(option.kind !== undefined ? { kind: option.kind } : {}),
      ...(option.name !== undefined ? { name: option.name } : {}),
    });
  }
  return {
    id,
    workspaceId,
    sessionId,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(taskPath !== undefined ? { taskPath } : {}),
    ...(role !== undefined ? { role } : {}),
    toolTitle,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    options: parsedOptions,
    status: status as ToolApprovalStatus,
    createdAt,
    expiresAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
  };
}

type Waiter = {
  resolve: (status: "approved" | "denied" | "expired") => void;
};

/**
 * Single-process store for tool permission approvals.
 * All mutations + disk persistence are serialized so concurrent
 * resolve/cancel/expire cannot interleave writes and resurrect pending rows.
 */
export class ToolApprovalStore {
  private readonly file: string;
  private items = new Map<string, ToolPendingApproval>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private waiters = new Map<string, Waiter[]>();
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  /** Serialize mutations + persist (same pattern as SessionRegistry write chain). */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: ToolApprovalStoreOptions) {
    this.file = path.join(dataDir, "tool-approvals.json");
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
        const loaded = new Map<string, ToolPendingApproval>();
        const recoveredAt = new Date().toISOString();
        let recoveredPending = false;
        for (const item of items ?? []) {
          const restored = parseApproval(item);
          if (!restored) {
            await this.quarantineCorrupt();
            this.loaded = true;
            return;
          }
          if (restored.status === "pending") {
            // A pending row represents one live ACP request and its in-memory
            // waiter. Neither survives a service restart, so approving a
            // restored row could resume a task with no provider behind it.
            restored.status = "expired";
            restored.resolvedAt = recoveredAt;
            restored.resolvedBy = "service-restart";
            recoveredPending = true;
          }
          loaded.set(restored.id, restored);
        }
        if (recoveredPending) await this.persistSnapshot(loaded);
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

  async listPending(workspaceId?: string): Promise<ToolPendingApproval[]> {
    await this.ensureLoaded();
    await this.expireStale();
    return [...this.items.values()]
      .filter(
        (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
      )
      .map(cloneApproval);
  }

  async get(id: string): Promise<ToolPendingApproval | undefined> {
    await this.ensureLoaded();
    await this.expireStale(id);
    const item = this.items.get(id);
    return item ? cloneApproval(item) : undefined;
  }

  /**
   * Session-level wait barrier for concurrent ACP permission requests.
   * Serialized with add/resolve/expire so callers never resume a session from
   * a stale snapshot while another request for that session is still pending.
   */
  async hasPendingForSession(sessionId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      await this.expireStaleUnlocked();
      return [...this.items.values()].some(
        (item) => item.sessionId === sessionId && item.status === "pending"
      );
    });
  }

  async add(item: ToolPendingApproval): Promise<ToolPendingApproval> {
    if (this.closed) throw new Error("Tool approval store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("Tool approval store is closed");
      const stored = cloneApproval(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval(stored);
    });
  }

  /**
   * User-only resolve. Agent callers must not reach this via RPC auth (handlers enforce).
   * approve → allow_once at ACP layer; deny → cancelled.
   * Late approve after expire/deny/cancel fails (status !== pending).
   */
  async resolve(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string
  ): Promise<ToolPendingApproval> {
    if (this.closed) throw new Error("Tool approval store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("Tool approval store is closed");
      await this.expireStaleUnlocked(id);
      const item = this.items.get(id);
      if (!item) throw new Error(`Tool approval not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`Tool approval already ${item.status}: ${id}`);
      }
      const resolved: ToolPendingApproval = {
        ...item,
        status: decision,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      this.notifyWaiters(id, decision);
      return cloneApproval(resolved);
    });
  }

  /**
   * Wait until user resolves or store-authoritative expiry. Returns approved | denied | expired.
   * Used by adapter onPermissionAsk bridge (service-owned).
   * timeoutMs bounds the wait; expireOne mutates the same record so late approve fails.
   */
  waitForDecision(
    id: string,
    timeoutMs: number
  ): Promise<"approved" | "denied" | "expired"> {
    if (this.closed) return Promise.resolve("denied");
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (status: "approved" | "denied" | "expired") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const list = this.waiters.get(id);
        if (list) {
          this.waiters.set(
            id,
            list.filter((w) => w.resolve !== finish)
          );
          if ((this.waiters.get(id) ?? []).length === 0) this.waiters.delete(id);
        }
        resolve(status);
      };

      // Register before the async state read so shutdown/resolve cannot pass
      // between observing pending and installing the waiter.
      const list = this.waiters.get(id) ?? [];
      list.push({ resolve: finish });
      this.waiters.set(id, list);

      void this.get(id)
        .then((item) => {
          if (settled) return;
          if (!item) {
            finish("expired");
            return;
          }
          if (item.status === "approved" || item.status === "denied") {
            finish(item.status);
            return;
          }
          if (item.status === "expired") {
            finish("expired");
            return;
          }
        })
        .catch(() => {
          // The timeout path below remains authoritative and fail-closed.
        });

      // Bound wait; expireOne is serialized so concurrent approve cannot resurrect pending.
      timer = setTimeout(() => {
        void this.expireOne(id)
          .then((status) => {
            if (status === "approved" || status === "denied") {
              finish(status);
              return;
            }
            finish("expired");
          })
          .catch(() => {
            // Persistence failure must never leave an ACP permission request
            // hanging. Deny the live request without pretending the row committed.
            finish("expired");
          });
      }, Math.max(1, timeoutMs));
    });
  }

  /**
   * Stop accepting new tool asks and fail-close every live waiter.
   * Persistence is attempted first; if it fails, waiters are still denied so
   * service shutdown cannot be held open by permission deadlines. The next
   * service boot expires any orphaned pending disk rows.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    try {
      await this.ensureLoaded();
      await this.enqueue(async () => {
        const next = new Map(this.items);
        const deniedIds: string[] = [];
        const resolvedAt = new Date().toISOString();
        for (const item of this.items.values()) {
          if (item.status !== "pending") continue;
          next.set(item.id, {
            ...item,
            status: "denied",
            resolvedAt,
            resolvedBy: "service-shutdown",
          });
          deniedIds.push(item.id);
        }
        if (deniedIds.length > 0) {
          await this.persistSnapshot(next);
          this.items = next;
          for (const id of deniedIds) this.notifyWaiters(id, "denied");
        }
      });
    } finally {
      // Includes waiters whose item read/add raced shutdown and the
      // persistence-failure path. Denial is the only safe live outcome.
      this.notifyAllWaiters("denied");
    }
  }

  /** Cancel all pending for a session (session stop / fail). */
  async cancelSession(
    sessionId: string,
    reason: "denied" | "expired" = "denied"
  ): Promise<void> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const resolvedIds: string[] = [];
      for (const item of this.items.values()) {
        if (item.sessionId !== sessionId || item.status !== "pending") continue;
        next.set(item.id, {
          ...item,
          status: reason,
          resolvedAt: new Date().toISOString(),
          resolvedBy: "service",
        });
        resolvedIds.push(item.id);
      }
      if (resolvedIds.length > 0) {
        await this.persistSnapshot(next);
        this.items = next;
        for (const id of resolvedIds) {
          this.notifyWaiters(id, reason === "expired" ? "expired" : "denied");
        }
      }
    });
  }

  /**
   * Force-expire one pending item (store timeout authority).
   * Idempotent: returns current terminal status if already resolved.
   */
  async expireOne(id: string): Promise<ToolApprovalStatus> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item) return "expired";
      if (item.status !== "pending") return item.status;
      const expired: ToolPendingApproval = {
        ...item,
        status: "expired",
        resolvedAt: new Date().toISOString(),
        resolvedBy: "timeout",
      };
      const next = new Map(this.items);
      next.set(id, expired);
      await this.persistSnapshot(next);
      this.items = next;
      this.notifyWaiters(id, "expired");
      return "expired";
    });
  }

  private notifyWaiters(
    id: string,
    status: "approved" | "denied" | "expired"
  ): void {
    const list = this.waiters.get(id);
    if (!list?.length) return;
    this.waiters.delete(id);
    for (const w of list) w.resolve(status);
  }

  private notifyAllWaiters(status: "denied" | "expired"): void {
    const ids = [...this.waiters.keys()];
    for (const id of ids) this.notifyWaiters(id, status);
  }

  private async expireStale(onlyId?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(onlyId);
    });
  }

  private async expireStaleUnlocked(onlyId?: string): Promise<void> {
    const now = Date.now();
    const next = new Map(this.items);
    const expiredIds: string[] = [];
    for (const item of this.items.values()) {
      if (onlyId && item.id !== onlyId) continue;
      if (item.status !== "pending") continue;
      const exp = Date.parse(item.expiresAt);
      if (!Number.isFinite(exp) || exp > now) continue;
      next.set(item.id, {
        ...item,
        status: "expired",
        resolvedAt: new Date().toISOString(),
        resolvedBy: "timeout",
      });
      expiredIds.push(item.id);
    }
    if (expiredIds.length > 0) {
      await this.persistSnapshot(next);
      this.items = next;
      for (const id of expiredIds) this.notifyWaiters(id, "expired");
    }
  }

  /**
   * Atomic temp-file + rename so a crashed mid-write cannot leave a partial file,
   * and concurrent readers never observe a torn document. Call only under enqueue.
   */
  private async persistSnapshot(snapshot: Map<string, ToolPendingApproval>): Promise<void> {
    const items = [...snapshot.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 50);
    await this.writeState(this.file, { items: [...pending, ...terminal] });
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }
}

export function makeToolApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ta-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
