// Machine-local pending A2A approvals (ask path). Not collaboration facts on the task.

import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export class A2AApprovalStore {
  private readonly file: string;
  private items = new Map<string, A2APendingApproval>();
  private loaded = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "a2a-approvals.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { items?: A2APendingApproval[] };
      for (const item of parsed.items ?? []) {
        if (item?.id) this.items.set(item.id, item);
      }
    } catch {
      // fresh store
    }
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
    this.items.set(item.id, item);
    await this.persist();
    return item;
  }

  async resolve(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string
  ): Promise<A2APendingApproval> {
    await this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) throw new Error(`A2A approval not found: ${id}`);
    if (item.status !== "pending") {
      throw new Error(`A2A approval already ${item.status}: ${id}`);
    }
    item.status = decision;
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = resolvedBy;
    this.items.set(id, item);
    await this.persist();
    return item;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const items = [...this.items.values()];
    // Keep only recent terminal + all pending (cap history lightly).
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 50);
    await fs.writeFile(
      this.file,
      JSON.stringify({ items: [...pending, ...terminal] }, null, 2) + "\n",
      "utf8"
    );
  }
}

export function makeApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ap-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
