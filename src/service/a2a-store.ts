// Machine-local pending A2A approvals (ask path). Not collaboration facts on the task.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import type { A2APolicy } from "./types.js";

export type A2AApprovalStatus = "pending" | "approved" | "denied";

export interface A2APendingApproval {
  id: string;
  workspaceId: string;
  taskPath: string;
  taskId?: string;
  role: string;
  profileId: string;
  policy: A2APolicy;
  callerKind: "user" | "role";
  bootstrapPrompt?: string;
  status: A2AApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type A2AApprovalStoreOptions = {
  /** Injectable atomic writer for deterministic persistence-failure tests. */
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

const A2A_POLICIES = new Set<A2APolicy>(["allow", "ask", "deny"]);
const A2A_CALLER_KINDS = new Set<"user" | "role">(["user", "role"]);
const A2A_APPROVAL_STATUSES = new Set<A2AApprovalStatus>([
  "pending",
  "approved",
  "denied",
]);

function cloneApproval(item: A2APendingApproval): A2APendingApproval {
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

/** Parse untrusted machine state before any clone/projection touches it. */
function parseA2AApproval(value: unknown): A2APendingApproval | null {
  if (!isRecord(value)) return null;
  const {
    id,
    workspaceId,
    taskPath,
    taskId,
    role,
    profileId,
    policy,
    callerKind,
    bootstrapPrompt,
    status,
    createdAt,
    resolvedAt,
    resolvedBy,
  } = value;
  if (
    !isRequiredString(id) ||
    !isRequiredString(workspaceId) ||
    !isRequiredString(taskPath) ||
    !isRequiredString(role) ||
    !isRequiredString(profileId) ||
    !isRequiredString(createdAt) ||
    !isValidDate(createdAt) ||
    typeof policy !== "string" ||
    !A2A_POLICIES.has(policy as A2APolicy) ||
    typeof callerKind !== "string" ||
    !A2A_CALLER_KINDS.has(callerKind as "user" | "role") ||
    typeof status !== "string" ||
    !A2A_APPROVAL_STATUSES.has(status as A2AApprovalStatus) ||
    !isOptionalString(taskId) ||
    !isOptionalString(bootstrapPrompt) ||
    !isOptionalString(resolvedAt) ||
    !isOptionalString(resolvedBy) ||
    (resolvedAt !== undefined && !isValidDate(resolvedAt))
  ) {
    return null;
  }
  return {
    id,
    workspaceId,
    taskPath,
    ...(taskId !== undefined ? { taskId } : {}),
    role,
    profileId,
    policy: policy as A2APolicy,
    callerKind: callerKind as "user" | "role",
    ...(bootstrapPrompt !== undefined ? { bootstrapPrompt } : {}),
    status: status as A2AApprovalStatus,
    createdAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
  };
}

/**
 * Single-process store for A2A spawn approvals.
 * Mutations + disk persistence are serialized so concurrent add/resolve
 * cannot interleave writes or resurrect terminal rows as pending.
 */
export class A2AApprovalStore {
  private readonly file: string;
  private items = new Map<string, A2APendingApproval>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private loaded = false;
  /** Serialize load + mutations + persist (same pattern as ToolApprovalStore). */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: A2AApprovalStoreOptions) {
    this.file = path.join(dataDir, "a2a-approvals.json");
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
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        const items = (parsed as { items?: unknown }).items;
        if (items !== undefined && !Array.isArray(items)) {
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        const loaded = new Map<string, A2APendingApproval>();
        for (const item of items ?? []) {
          const restored = parseA2AApproval(item);
          if (!restored) {
            // One bad row poisons the whole machine-state file — never skip.
            await this.quarantineCorrupt("reset");
            this.loaded = true;
            return;
          }
          // Unlike tool approvals, A2A pending rows are durable across restarts:
          // the ask path is service-owned and can be resolved after reload.
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

  async listPending(workspaceId?: string): Promise<A2APendingApproval[]> {
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter(
        (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
      )
      .map(cloneApproval);
  }

  async get(id: string): Promise<A2APendingApproval | undefined> {
    await this.ensureLoaded();
    const item = this.items.get(id);
    return item ? cloneApproval(item) : undefined;
  }

  async add(item: A2APendingApproval): Promise<A2APendingApproval> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const stored = cloneApproval(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval(stored);
    });
  }

  async resolve(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string
  ): Promise<A2APendingApproval> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item) throw new Error(`A2A approval not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`A2A approval already ${item.status}: ${id}`);
      }
      const resolved: A2APendingApproval = {
        ...item,
        status: decision,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval(resolved);
    });
  }

  private async quarantineCorrupt(action: "reset"): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, action);
    this.items.clear();
  }

  /** Persist a candidate snapshot before making it visible in memory. */
  private async persistSnapshot(snapshot: Map<string, A2APendingApproval>): Promise<void> {
    const items = [...snapshot.values()];
    // Keep only recent terminal + all pending (cap history lightly).
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 50);
    await this.writeState(this.file, { items: [...pending, ...terminal] });
  }
}

export function makeApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ap-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
