// Machine-local SessionRegistry.
// Workspace copy must not carry these files.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import type {
  AcpRuntimeObservation,
  SessionRecord,
  SessionState,
  StopReason,
} from "./types.js";
import {
  ACP_OBSERVATION_SIGNAL_BYTES,
  ACP_OBSERVATION_TEXT_BYTES,
  ACP_PERMISSION_REQUEST_COUNT_MAX,
  EXTERNAL_ADAPTER_ID,
  isSessionId,
} from "./types.js";
import { isConnectionId, isRoleId } from "../core/id.js";
import { parseAgentConnectionSnapshot } from "./agent-connection.js";
import { parseAcpSessionConfigSnapshot } from "../adapters/acp/types.js";
import { utf8Bytes } from "../adapters/acp/limits.js";

type SessionRecordMutablePatch = Partial<
  Omit<
    SessionRecord,
    "id" | "createdAt" | "connectionId" | "adapterId" | "connectionSnapshot" | "roleId"
  >
>;

const SESSION_STATES = new Set<SessionState>([
  "reserved",
  "starting",
  "live",
  "waiting-user",
  "stopped",
  "failed",
  "external",
]);

const STOP_REASONS = new Set<StopReason>(["user", "interrupt", "shutdown"]);

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

function parseAcpRuntimeObservation(
  value: unknown
): AcpRuntimeObservation | undefined {
  if (!isPlainObject(value)) return undefined;
  const allowed = new Set([
    "permissionRequestCount",
    "permissionPolicy",
    "permissionDecision",
    "permissionOutcome",
    "promptStopReason",
    "spontaneousChildExit",
    "exitCode",
    "signal",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    !Number.isInteger(value.permissionRequestCount) ||
    (value.permissionRequestCount as number) < 0 ||
    (value.permissionRequestCount as number) > ACP_PERMISSION_REQUEST_COUNT_MAX
  ) return undefined;
  if (!new Set(["allow", "ask", "deny"]).has(value.permissionPolicy as string)) {
    return undefined;
  }
  if (
    value.permissionDecision !== undefined &&
    !new Set(["allow", "deny"]).has(value.permissionDecision as string)
  ) return undefined;
  if (
    value.permissionOutcome !== undefined &&
    !new Set(["allow_once", "cancelled"]).has(value.permissionOutcome as string)
  ) return undefined;
  if (typeof value.spontaneousChildExit !== "boolean") return undefined;
  if (
    value.promptStopReason !== undefined &&
    (typeof value.promptStopReason !== "string" ||
      utf8Bytes(value.promptStopReason) > ACP_OBSERVATION_TEXT_BYTES)
  ) return undefined;
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    (typeof value.exitCode !== "number" ||
      !Number.isInteger(value.exitCode) ||
      value.exitCode < -2_147_483_648 ||
      value.exitCode > 2_147_483_647)
  ) return undefined;
  if (
    value.signal !== undefined &&
    (typeof value.signal !== "string" ||
      utf8Bytes(value.signal) > ACP_OBSERVATION_SIGNAL_BYTES)
  ) return undefined;
  return {
    permissionRequestCount: value.permissionRequestCount as number,
    permissionPolicy: value.permissionPolicy as AcpRuntimeObservation["permissionPolicy"],
    ...(value.permissionDecision !== undefined
      ? {
          permissionDecision:
            value.permissionDecision as AcpRuntimeObservation["permissionDecision"],
        }
      : {}),
    ...(value.permissionOutcome !== undefined
      ? {
          permissionOutcome:
            value.permissionOutcome as AcpRuntimeObservation["permissionOutcome"],
        }
      : {}),
    ...(value.promptStopReason !== undefined
      ? { promptStopReason: value.promptStopReason as string }
      : {}),
    spontaneousChildExit: value.spontaneousChildExit as boolean,
    ...(value.exitCode !== undefined
      ? { exitCode: value.exitCode as number | null }
      : {}),
    ...(value.signal !== undefined ? { signal: value.signal as string } : {}),
  };
}

/**
 * Validate a parsed session JSON row. Returns the record when shape is safe for
 * runtime consumers (list sort, probe, stop). Identity consistency of
 * connectionSnapshot is immutable continuity authority. Unknown fields are rejected.
 */
function parseSessionRecord(data: unknown, sessionId: string): SessionRecord | null {
  if (!isPlainObject(data)) return null;
  const allowedKeys = new Set([
    "id",
    "connectionId",
    "adapterId",
    "connectionSnapshot",
    "acpSession",
    "acpObservation",
    "roleId",
    "state",
    "pid",
    "resumeToken",
    "runtimeWorkspace",
    "workspace",
    "workspaceLane",
    "createdAt",
    "updatedAt",
    "currentTaskId",
    "exitCode",
    "lastError",
    "stopReason",
    "providerContextRestored",
    "restoreReason",
    "replacedSessionId",
    "replacedBySessionId",
    "externalKey",
    "contextGeneration",
  ]);
  if (Object.keys(data).some((key) => !allowedKeys.has(key))) return null;

  // Required non-empty strings + formal state enum.
  if (!isNonEmptyString(data.id) || data.id !== sessionId) return null;
  if (!isSessionState(data.state)) return null;
  if (!isNonEmptyString(data.createdAt)) return null;
  if (!isNonEmptyString(data.updatedAt)) return null;
  // External Role Sessions remain external history after stop/failure. Their
  // adapter identity, not the mutable lifecycle state, selects the schema.
  const external = data.adapterId === EXTERNAL_ADAPTER_ID;
  if (external) {
    if (
      data.connectionId !== undefined ||
      data.connectionSnapshot !== undefined ||
      data.acpSession !== undefined ||
      data.acpObservation !== undefined
    ) return null;
  } else {
    if (!isConnectionId(data.connectionId) || !isNonEmptyString(data.adapterId)) return null;
    if (data.roleId !== undefined) return null;
  }

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
    "roleId",
    "resumeToken",
    "workspace",
    "currentTaskId",
    "lastError",
    "externalKey",
    "contextGeneration",
  ] as const) {
    if (key in data && data[key] !== undefined && typeof data[key] !== "string") {
      return null;
    }
  }
  if (
    data.roleId !== undefined &&
    (typeof data.roleId !== "string" || !isRoleId(data.roleId))
  ) {
    return null;
  }
  if ("stopReason" in data && data.stopReason !== undefined) {
    if (typeof data.stopReason !== "string" || !STOP_REASONS.has(data.stopReason as StopReason)) {
      return null;
    }
  }
  if ("providerContextRestored" in data && data.providerContextRestored !== undefined) {
    if (typeof data.providerContextRestored !== "boolean") return null;
  }
  for (const key of [
    "restoreReason",
    "replacedSessionId",
    "replacedBySessionId",
  ] as const) {
    if (key in data && data[key] !== undefined && typeof data[key] !== "string") {
      return null;
    }
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
  if (external) return data as unknown as SessionRecord;
  const snapshot = parseAgentConnectionSnapshot(data.connectionSnapshot);
  if (!snapshot) return null;
  if (snapshot.connectionId !== data.connectionId || !isConnectionId(snapshot.connectionId)) return null;
  if (!isNonEmptyString(snapshot.provider)) return null;
  if (snapshot.adapterId !== data.adapterId || !isNonEmptyString(snapshot.adapterId)) return null;
  if (!isNonEmptyString(snapshot.launchDigest)) return null;

  const acpSession =
    data.acpSession === undefined
      ? undefined
      : parseAcpSessionConfigSnapshot(data.acpSession);
  if (data.acpSession !== undefined && !acpSession) return null;
  const acpObservation =
    data.acpObservation === undefined
      ? undefined
      : parseAcpRuntimeObservation(data.acpObservation);
  if (data.acpObservation !== undefined && !acpObservation) return null;

  return {
    ...data,
    connectionSnapshot: snapshot,
    ...(acpSession ? { acpSession } : {}),
    ...(acpObservation ? { acpObservation } : {}),
  } as unknown as SessionRecord;
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

  async create(record: SessionRecord): Promise<void> {
    assertSessionId(record.id);
    return this.enqueue(async () => {
      await this.ensureDir();
      const file = sessionFilePath(this.dataDir, record.id);
      try {
        await fs.access(file);
        throw new Error(`Session already exists: ${record.id}`);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      await writeJsonAtomic(file, record);
    });
  }

  /** Create-only persisted identity. Never overwrites an existing Session row. */
  async write(record: SessionRecord): Promise<void> {
    return this.create(record);
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
    patch: SessionRecordMutablePatch
  ): Promise<SessionRecord> {
    return this.enqueue(async () => {
      const current = await this.readUnlocked(sessionId);
      if (!current) throw new Error(`Session not found: ${sessionId}`);
      for (const immutable of ["id", "createdAt", "connectionId", "adapterId", "connectionSnapshot", "roleId"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, immutable)) {
          throw new Error(`SessionRegistry.update cannot mutate immutable field: ${immutable}`);
        }
      }
      const next: SessionRecord = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        connectionId: current.connectionId,
        adapterId: current.adapterId,
        connectionSnapshot: current.connectionSnapshot,
        roleId: current.roleId,
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
    extra: SessionRecordMutablePatch = {}
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
    return state === "reserved" || SessionRegistry.isNonTerminal(state) || state === "external";
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
