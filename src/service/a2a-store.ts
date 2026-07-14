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

/**
 * Single-process store for A2A spawn approvals.
 * Mutations + disk persistence are serialized so concurrent add/resolve
 * cannot interleave writes or resurrect terminal rows as pending.
 */
export class A2AApprovalStore {
  private readonly file: string;
  private items = new Map<string, A2APendingApproval>();
  private loaded = false;
  /** Serialize load + mutations + persist (same pattern as ToolApprovalStore). */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "a2a-approvals.json");
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
        for (const item of (items as A2APendingApproval[] | undefined) ?? []) {
          if (item?.id) this.items.set(item.id, item);
        }
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
    return [...this.items.values()].filter(
      (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
    );
  }

  async get(id: string): Promise<A2APendingApproval | undefined> {
    await this.ensureLoaded();
    return this.items.get(id);
  }

  async add(item: A2APendingApproval): Promise<A2APendingApproval> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      this.items.set(item.id, { ...item });
      await this.persistUnlocked();
      return this.items.get(item.id)!;
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
      item.status = decision;
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = resolvedBy;
      this.items.set(id, item);
      await this.persistUnlocked();
      return item;
    });
  }

  private async quarantineCorrupt(action: "reset"): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, action);
    this.items.clear();
  }

  /** Call only under enqueue after ensureLoaded. */
  private async persistUnlocked(): Promise<void> {
    const items = [...this.items.values()];
    // Keep only recent terminal + all pending (cap history lightly).
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 50);
    await writeJsonAtomic(this.file, { items: [...pending, ...terminal] });
  }
}

export function makeApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ap-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
