// Machine-local agent→user business asks (A2U UserAsk).
// Distinct from toolApproval (ACP tool permission) and a2a (spawn gate).
// Never written into workspace Git / .tent. Not a chat bus.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

export type UserAskStatus = "pending" | "answered" | "denied" | "cancelled";

export type UserAskChoice = {
  id: string;
  label: string;
};

export interface UserAskRecord {
  id: string;
  workspaceId: string;
  taskPath: string;
  taskId?: string;
  sessionId?: string;
  role?: string;
  question: string;
  choices?: UserAskChoice[];
  status: UserAskStatus;
  /** Free-text answer when status=answered. */
  answer?: string;
  /** Selected choice id when status=answered. */
  choiceId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type UserAskStoreOptions = {
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

function cloneAsk(item: UserAskRecord): UserAskRecord {
  return {
    ...item,
    ...(item.choices
      ? { choices: item.choices.map((c) => ({ ...c })) }
      : {}),
  };
}

const USER_ASK_STATUSES = new Set<UserAskStatus>([
  "pending",
  "answered",
  "denied",
  "cancelled",
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

function parseChoice(value: unknown): UserAskChoice | null {
  if (!isRecord(value) || !isRequiredString(value.id) || !isRequiredString(value.label)) {
    return null;
  }
  return { id: value.id, label: value.label };
}

/** Parse untrusted machine state before any clone/projection touches it. */
function parseAsk(value: unknown): UserAskRecord | null {
  if (!isRecord(value)) return null;
  const {
    id,
    workspaceId,
    taskPath,
    taskId,
    sessionId,
    role,
    question,
    choices,
    status,
    answer,
    choiceId,
    createdAt,
    updatedAt,
    resolvedAt,
    resolvedBy,
  } = value;
  if (
    !isRequiredString(id) ||
    !isRequiredString(workspaceId) ||
    !isRequiredString(taskPath) ||
    !isRequiredString(question) ||
    !isRequiredString(createdAt) ||
    !isRequiredString(updatedAt) ||
    !isValidDate(createdAt) ||
    !isValidDate(updatedAt) ||
    typeof status !== "string" ||
    !USER_ASK_STATUSES.has(status as UserAskStatus) ||
    !isOptionalString(taskId) ||
    !isOptionalString(sessionId) ||
    !isOptionalString(role) ||
    !isOptionalString(answer) ||
    !isOptionalString(choiceId) ||
    !isOptionalString(resolvedAt) ||
    !isOptionalString(resolvedBy) ||
    (resolvedAt !== undefined && !isValidDate(resolvedAt))
  ) {
    return null;
  }
  let parsedChoices: UserAskChoice[] | undefined;
  if (choices !== undefined) {
    if (!Array.isArray(choices)) return null;
    parsedChoices = [];
    for (const c of choices) {
      const parsed = parseChoice(c);
      if (!parsed) return null;
      parsedChoices.push(parsed);
    }
  }
  return {
    id,
    workspaceId,
    taskPath,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(role !== undefined ? { role } : {}),
    question,
    ...(parsedChoices !== undefined ? { choices: parsedChoices } : {}),
    status: status as UserAskStatus,
    ...(answer !== undefined ? { answer } : {}),
    ...(choiceId !== undefined ? { choiceId } : {}),
    createdAt,
    updatedAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
  };
}

/**
 * Single-process store for business UserAsk rows.
 * Mutations + disk persistence are serialized so concurrent reply/deny/cancel
 * cannot interleave writes and resurrect pending rows.
 */
export class UserAskStore {
  private readonly file: string;
  private items = new Map<string, UserAskRecord>();
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: UserAskStoreOptions) {
    this.file = path.join(dataDir, "user-asks.json");
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
        const loaded = new Map<string, UserAskRecord>();
        // Unlike tool approvals, pending business asks survive restart:
        // they are not bound to a live ACP waiter. User can still reply.
        for (const item of items ?? []) {
          const restored = parseAsk(item);
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

  async listPending(workspaceId?: string): Promise<UserAskRecord[]> {
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter(
        (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
      )
      .map(cloneAsk);
  }

  async get(id: string): Promise<UserAskRecord | undefined> {
    await this.ensureLoaded();
    const item = this.items.get(id);
    return item ? cloneAsk(item) : undefined;
  }

  /**
   * Machine-global store: relative task paths collide across workspaces.
   * Pending lookup must always scope by (workspaceId, taskPath).
   */
  async getPendingForTask(
    workspaceId: string,
    taskPath: string
  ): Promise<UserAskRecord | undefined> {
    await this.ensureLoaded();
    for (const item of this.items.values()) {
      if (
        item.status === "pending" &&
        item.workspaceId === workspaceId &&
        item.taskPath === taskPath
      ) {
        return cloneAsk(item);
      }
    }
    return undefined;
  }

  async hasPendingForTask(
    workspaceId: string,
    taskPath: string
  ): Promise<boolean> {
    return (await this.getPendingForTask(workspaceId, taskPath)) !== undefined;
  }

  async add(item: UserAskRecord): Promise<UserAskRecord> {
    if (this.closed) throw new Error("UserAsk store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("UserAsk store is closed");
      // One pending business ask per (workspace, task) — never taskPath alone.
      for (const existing of this.items.values()) {
        if (
          existing.status === "pending" &&
          existing.workspaceId === item.workspaceId &&
          existing.taskPath === item.taskPath
        ) {
          throw new Error(
            `Task already has a pending UserAsk (${existing.id}): ${item.workspaceId} ${item.taskPath}`
          );
        }
      }
      const stored = cloneAsk(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneAsk(stored);
    });
  }

  /**
   * User-only reply. Agent callers must not reach this via RPC auth (handlers enforce).
   * Late reply after deny/cancel fails (status !== pending).
   */
  async reply(
    id: string,
    input: { answer?: string; choiceId?: string; resolvedBy: string }
  ): Promise<UserAskRecord> {
    if (this.closed) throw new Error("UserAsk store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("UserAsk store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`UserAsk not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`UserAsk already ${item.status}: ${id}`);
      }
      const answer = input.answer?.trim() ?? "";
      const choiceId = input.choiceId?.trim() ?? "";
      if (!answer && !choiceId) {
        throw new Error("UserAsk reply requires answer and/or choiceId");
      }
      if (choiceId && item.choices?.length) {
        const ok = item.choices.some((c) => c.id === choiceId);
        if (!ok) {
          throw new Error(`Unknown choiceId for UserAsk ${id}: ${choiceId}`);
        }
      }
      const now = new Date().toISOString();
      const resolved: UserAskRecord = {
        ...item,
        status: "answered",
        ...(answer ? { answer } : {}),
        ...(choiceId ? { choiceId } : {}),
        updatedAt: now,
        resolvedAt: now,
        resolvedBy: input.resolvedBy,
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneAsk(resolved);
    });
  }

  async deny(id: string, resolvedBy: string): Promise<UserAskRecord> {
    if (this.closed) throw new Error("UserAsk store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("UserAsk store is closed");
      const item = this.items.get(id);
      if (!item) throw new Error(`UserAsk not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`UserAsk already ${item.status}: ${id}`);
      }
      const now = new Date().toISOString();
      const resolved: UserAskRecord = {
        ...item,
        status: "denied",
        updatedAt: now,
        resolvedAt: now,
        resolvedBy,
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneAsk(resolved);
    });
  }

  /** Cancel pending asks for one (workspace, task) only (interrupt / fail). */
  async cancelTask(
    workspaceId: string,
    taskPath: string,
    resolvedBy = "service"
  ): Promise<UserAskRecord[]> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const cancelled: UserAskRecord[] = [];
      const now = new Date().toISOString();
      for (const item of this.items.values()) {
        if (
          item.workspaceId !== workspaceId ||
          item.taskPath !== taskPath ||
          item.status !== "pending"
        ) {
          continue;
        }
        const row: UserAskRecord = {
          ...item,
          status: "cancelled",
          updatedAt: now,
          resolvedAt: now,
          resolvedBy,
        };
        next.set(item.id, row);
        cancelled.push(cloneAsk(row));
      }
      if (cancelled.length > 0) {
        await this.persistSnapshot(next);
        this.items = next;
      }
      return cancelled;
    });
  }

  /** Cancel all pending asks bound to a session (session stop / fail). */
  async cancelSession(
    sessionId: string,
    resolvedBy = "service"
  ): Promise<UserAskRecord[]> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const cancelled: UserAskRecord[] = [];
      const now = new Date().toISOString();
      for (const item of this.items.values()) {
        if (item.sessionId !== sessionId || item.status !== "pending") continue;
        const row: UserAskRecord = {
          ...item,
          status: "cancelled",
          updatedAt: now,
          resolvedAt: now,
          resolvedBy,
        };
        next.set(item.id, row);
        cancelled.push(cloneAsk(row));
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

  private async persistSnapshot(snapshot: Map<string, UserAskRecord>): Promise<void> {
    const items = [...snapshot.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items
      .filter((i) => i.status !== "pending")
      .sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""))
      .slice(0, 100);
    await this.writeState(this.file, { items: [...pending, ...terminal] });
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }
}

export function makeUserAskId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ua-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/**
 * Fixed-format user answer for managed ACP follow-up session/prompt.
 * Not a chat transcript — a single structured business answer block.
 */
export function formatUserAskAnswerPrompt(ask: UserAskRecord): string {
  const lines = [
    "## User Answer",
    `askId: ${ask.id}`,
    `decision: ${ask.status === "answered" ? "reply" : ask.status}`,
    `question: ${ask.question}`,
  ];
  if (ask.choiceId) lines.push(`choiceId: ${ask.choiceId}`);
  if (ask.answer) lines.push(`answer: ${ask.answer}`);
  if (ask.resolvedAt) lines.push(`resolvedAt: ${ask.resolvedAt}`);
  lines.push(
    "",
    "Continue the same task with this answer. Do not invent chat history. Final report still goes through Delivery only."
  );
  return lines.join("\n");
}
