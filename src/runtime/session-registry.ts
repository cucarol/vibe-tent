// Machine-local SessionRegistry (B0 agent-runtime.md §6).
// Workspace copy must not carry these files.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import type { SessionRecord, SessionState, StopReason } from "./types.js";
import { isSessionId } from "./types.js";

const SESSION_STATES = new Set<SessionState>([
  "starting",
  "live",
  "waiting-user",
  "stopped",
  "failed",
  "external",
]);

const STOP_REASONS = new Set<StopReason>(["user", "interrupt", "shutdown"]);
const ASSIGNEE_KINDS = new Set(["role", "agentProfile"]);

export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions");
}

export function sessionFilePath(dataDir: string, sessionId: string): string {
  return path.join(sessionsDir(dataDir), `${sessionId}.json`);
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && SESSION_STATES.has(value as SessionState);
}

/**
 * Validate a parsed session JSON row. Returns the record when shape is safe for
 * runtime consumers (list sort, probe, stop). Identity consistency of
 * profileSnapshot vs live catalog is checked by AgentRuntime, not here.
 * Unknown keys are allowed for forward compatibility.
 */
function parseSessionRecord(data: unknown, sessionId: string): SessionRecord | null {
  if (!isPlainObject(data)) return null;

  // Required non-empty strings + formal state enum.
  if (!isNonEmptyString(data.id) || data.id !== sessionId) return null;
  if (!isNonEmptyString(data.profileId)) return null;
  if (!isNonEmptyString(data.adapterId)) return null;
  if (!isSessionState(data.state)) return null;
  if (!isNonEmptyString(data.createdAt)) return null;
  if (!isNonEmptyString(data.updatedAt)) return null;

  // Optional fields that runtime code reads directly — type-check when present.
  if ("pid" in data && data.pid !== undefined) {
    if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) {
      return null;
    }
  }
  if ("exitCode" in data && data.exitCode !== undefined) {
    if (
      data.exitCode !== null &&
      (typeof data.exitCode !== "number" || !Number.isInteger(data.exitCode))
    ) {
      return null;
    }
  }
  for (const key of [
    "roleName",
    "resumeToken",
    "workspace",
    "lastTaskId",
    "lastError",
    "externalKey",
  ] as const) {
    if (key in data && data[key] !== undefined && typeof data[key] !== "string") {
      return null;
    }
  }
  if ("assigneeKind" in data && data.assigneeKind !== undefined) {
    if (typeof data.assigneeKind !== "string" || !ASSIGNEE_KINDS.has(data.assigneeKind)) {
      return null;
    }
  }
  if ("stopReason" in data && data.stopReason !== undefined) {
    if (typeof data.stopReason !== "string" || !STOP_REASONS.has(data.stopReason as StopReason)) {
      return null;
    }
  }
  if ("contextRestored" in data && data.contextRestored !== undefined) {
    if (typeof data.contextRestored !== "boolean") return null;
  }
  if ("runtimeWorkspace" in data && data.runtimeWorkspace !== undefined) {
    if (!isPlainObject(data.runtimeWorkspace)) return null;
    if (!isNonEmptyString(data.runtimeWorkspace.cwd)) return null;
  }
  if ("workspaceLane" in data && data.workspaceLane !== undefined) {
    if (!isPlainObject(data.workspaceLane)) return null;
    const lane = data.workspaceLane;
    if (!isNonEmptyString(lane.workspace)) return null;
    if (!isNonEmptyString(lane.worktree)) return null;
    if (!isNonEmptyString(lane.branch)) return null;
    if (
      "targetBranch" in lane &&
      lane.targetBranch !== undefined &&
      typeof lane.targetBranch !== "string"
    ) {
      return null;
    }
  }
  // profileSnapshot: plain object only; field identity left to AgentRuntime.
  if ("profileSnapshot" in data && data.profileSnapshot !== undefined) {
    if (!isPlainObject(data.profileSnapshot)) return null;
  }

  return data as unknown as SessionRecord;
}

export class SessionRegistry {
  /** Serialize disk mutations so stop + exit handlers cannot race rename. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  get dataRoot(): string {
    return this.dataDir;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(sessionsDir(this.dataDir), { recursive: true });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async write(record: SessionRecord): Promise<void> {
    assertSessionId(record.id);
    return this.enqueue(async () => {
      await this.ensureDir();
      const file = sessionFilePath(this.dataDir, record.id);
      await writeJsonAtomic(file, record);
    });
  }

  async read(sessionId: string): Promise<SessionRecord | null> {
    assertSessionId(sessionId);
    // A read racing an atomic replace can observe a transient missing file on
    // Windows. Wait for already-enqueued writes so runtime events never lose
    // their task binding because of that replacement window.
    await this.writeChain;
    return this.readUnlocked(sessionId);
  }

  async update(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, "id" | "createdAt">>
  ): Promise<SessionRecord> {
    return this.enqueue(async () => {
      const current = await this.readUnlocked(sessionId);
      if (!current) throw new Error(`Session not found: ${sessionId}`);
      const next: SessionRecord = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await this.ensureDir();
      const file = sessionFilePath(this.dataDir, sessionId);
      await writeJsonAtomic(file, next);
      return next;
    });
  }

  async setState(
    sessionId: string,
    state: SessionState,
    extra: Partial<SessionRecord> = {}
  ): Promise<SessionRecord> {
    return this.update(sessionId, { ...extra, state });
  }

  async list(): Promise<SessionRecord[]> {
    await this.ensureDir();
    const dir = sessionsDir(this.dataDir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
    const out: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      // Skip corrupt backups and temp write files.
      if (name.includes(".corrupt-") || name.endsWith(".tmp")) continue;
      const id = name.slice(0, -".json".length);
      if (!isSessionId(id)) continue;
      const rec = await this.read(id);
      if (rec) out.push(rec);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  async remove(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    return this.enqueue(async () => {
      try {
        await fs.rm(sessionFilePath(this.dataDir, sessionId), { force: true });
      } catch {
        // ignore
      }
    });
  }

  /**
   * Non-terminal managed states that should be process-probed after service restart.
   * Does **not** include `external` (pull-host has no supervised PID).
   */
  static isNonTerminal(state: SessionState): boolean {
    return state === "starting" || state === "live" || state === "waiting-user";
  }

  /**
   * Session is still open for collaboration: managed non-terminal **or** pull-host external.
   * Use for list/status/idempotent enter; not for process reconcile (see isNonTerminal).
   */
  static isOpen(state: SessionState): boolean {
    return SessionRegistry.isNonTerminal(state) || state === "external";
  }

  private async readUnlocked(sessionId: string): Promise<SessionRecord | null> {
    const file = sessionFilePath(this.dataDir, sessionId);
    try {
      const raw = await fs.readFile(file, "utf8");
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        await this.quarantineCorrupt(file);
        return null;
      }
      const rec = parseSessionRecord(data, sessionId);
      if (!rec) {
        await this.quarantineCorrupt(file);
        return null;
      }
      return rec;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  private async quarantineCorrupt(file: string): Promise<void> {
    try {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "ignored");
    } catch {
      // If backup itself fails, still treat row as missing rather than crash reads.
    }
  }
}
