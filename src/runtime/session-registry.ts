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
import type { SessionRecord, SessionState } from "./types.js";
import { isSessionId } from "./types.js";

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

  /** Non-terminal states that should be probed after service restart. */
  static isNonTerminal(state: SessionState): boolean {
    return state === "starting" || state === "live" || state === "waiting-user";
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
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        await this.quarantineCorrupt(file);
        return null;
      }
      const rec = data as SessionRecord;
      if (typeof rec.id !== "string" || typeof rec.state !== "string") {
        await this.quarantineCorrupt(file);
        return null;
      }
      if (rec.id !== sessionId) {
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
