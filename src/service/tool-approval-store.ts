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

/**
 * Single-process store for tool permission approvals.
 * All mutations + disk persistence are serialized so concurrent
 * resolve/cancel/expire cannot interleave writes and resurrect pending rows.
 */
export class ToolApprovalStore {
  private readonly file: string;
  private items = new Map<string, ToolPendingApproval>();
  private waiters = new Map<string, Waiter[]>();
  private loaded = false;
  /** Serialize mutations + persist (same pattern as SessionRegistry write chain). */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "tool-approvals.json");
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
    });
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
    return this.enqueue(async () => {
      this.items.set(item.id, { ...item });
      await this.persistUnlocked();
      return this.items.get(item.id)!;
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
    await this.ensureLoaded();
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(id);
      const item = this.items.get(id);
      if (!item) throw new Error(`Tool approval not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`Tool approval already ${item.status}: ${id}`);
      }
      item.status = decision;
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = resolvedBy;
      this.items.set(id, item);
      await this.persistUnlocked();
      this.notifyWaiters(id, decision);
      return item;
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
    return new Promise((resolve) => {
      let settled = false;
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

      void this.get(id).then((item) => {
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
        const list = this.waiters.get(id) ?? [];
        list.push({ resolve: finish });
        this.waiters.set(id, list);
      });

      // Bound wait; expireOne is serialized so concurrent approve cannot resurrect pending.
      const timer = setTimeout(() => {
        void this.expireOne(id).then((status) => {
          if (status === "approved" || status === "denied") {
            finish(status);
            return;
          }
          finish("expired");
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
    return this.enqueue(async () => {
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
      if (changed) await this.persistUnlocked();
    });
  }

  /**
   * Force-expire one pending item (timeout authority / fail-safe).
   * Idempotent: returns current terminal status if already resolved.
   */
  async expireOne(id: string): Promise<ToolApprovalStatus> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item) return "expired";
      if (item.status !== "pending") return item.status;
      item.status = "expired";
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = "timeout";
      this.items.set(id, item);
      await this.persistUnlocked();
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

  private async expireStale(onlyId?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(onlyId);
    });
  }

  private async expireStaleUnlocked(onlyId?: string): Promise<void> {
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
    if (changed) await this.persistUnlocked();
  }

  /**
   * Atomic temp-file + rename so a crashed mid-write cannot leave a partial file,
   * and concurrent readers never observe a torn document. Call only under enqueue.
   */
  private async persistUnlocked(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const items = [...this.items.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 50);
    const body = JSON.stringify({ items: [...pending, ...terminal] }, null, 2) + "\n";
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, this.file);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore cleanup
      }
      throw err;
    }
  }
}

export function makeToolApprovalId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ta-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
