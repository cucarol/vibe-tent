// Machine-local pending ACP *tool* permission approvals (permissionPolicy=ask).
// Distinct from A2A spawn approvals (a2a-store.ts). Never written into workspace Git / .tent.

import * as fs from "node:fs/promises";
import * as path from "node:path";

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

type Waiter = {
  resolve: (status: "approved" | "denied" | "expired") => void;
};

export class ToolApprovalStore {
  private readonly file: string;
  private items = new Map<string, ToolPendingApproval>();
  private waiters = new Map<string, Waiter[]>();
  private loaded = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "tool-approvals.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { items?: ToolPendingApproval[] };
      for (const item of parsed.items ?? []) {
        if (item?.id) this.items.set(item.id, item);
      }
    } catch {
      // fresh store
    }
  }

  async listPending(workspaceId?: string): Promise<ToolPendingApproval[]> {
    await this.ensureLoaded();
    await this.expireStale();
    return [...this.items.values()].filter(
      (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
    );
  }

  async get(id: string): Promise<ToolPendingApproval | undefined> {
    await this.ensureLoaded();
    await this.expireStale(id);
    return this.items.get(id);
  }

  async add(item: ToolPendingApproval): Promise<ToolPendingApproval> {
    await this.ensureLoaded();
    this.items.set(item.id, item);
    await this.persist();
    return item;
  }

  /**
   * User-only resolve. Agent callers must not reach this via RPC auth (handlers enforce).
   * approve → allow_once at ACP layer; deny → cancelled.
   */
  async resolve(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string
  ): Promise<ToolPendingApproval> {
    await this.ensureLoaded();
    await this.expireStale(id);
    const item = this.items.get(id);
    if (!item) throw new Error(`Tool approval not found: ${id}`);
    if (item.status !== "pending") {
      throw new Error(`Tool approval already ${item.status}: ${id}`);
    }
    item.status = decision;
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = resolvedBy;
    this.items.set(id, item);
    await this.persist();
    this.notifyWaiters(id, decision);
    return item;
  }

  /**
   * Wait until user resolves or expiry. Returns approved | denied | expired.
   * Used by adapter onPermissionAsk bridge (service-owned).
   */
  waitForDecision(
    id: string,
    timeoutMs: number
  ): Promise<"approved" | "denied" | "expired"> {
    return new Promise((resolve) => {
      const finish = (status: "approved" | "denied" | "expired") => {
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

      void this.get(id).then((item) => {
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
        const list = this.waiters.get(id) ?? [];
        list.push({ resolve: finish });
        this.waiters.set(id, list);
      });

      const timer = setTimeout(() => {
        void this.expireOne(id).then((status) => {
          finish(status === "expired" || status === "denied" ? status : "expired");
        });
      }, Math.max(1, timeoutMs));
    });
  }

  /** Cancel all pending for a session (session stop / fail). */
  async cancelSession(
    sessionId: string,
    reason: "denied" | "expired" = "denied"
  ): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const item of this.items.values()) {
      if (item.sessionId !== sessionId || item.status !== "pending") continue;
      item.status = reason;
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = "service";
      this.items.set(item.id, item);
      this.notifyWaiters(item.id, reason === "expired" ? "expired" : "denied");
      changed = true;
    }
    if (changed) await this.persist();
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

  private async expireStale(onlyId?: string): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const item of this.items.values()) {
      if (onlyId && item.id !== onlyId) continue;
      if (item.status !== "pending") continue;
      const exp = Date.parse(item.expiresAt);
      if (!Number.isFinite(exp) || exp > now) continue;
      item.status = "expired";
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = "timeout";
      this.items.set(item.id, item);
      this.notifyWaiters(item.id, "expired");
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async expireOne(id: string): Promise<ToolApprovalStatus> {
    await this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) return "expired";
    if (item.status !== "pending") return item.status;
    item.status = "expired";
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = "timeout";
    this.items.set(id, item);
    await this.persist();
    this.notifyWaiters(id, "expired");
    return "expired";
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const items = [...this.items.values()];
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

export function makeToolApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ta-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
