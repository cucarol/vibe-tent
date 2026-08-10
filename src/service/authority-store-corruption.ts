import * as fs from "node:fs/promises";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

const LATCH_SUFFIX = ".corrupt-latch.json";
const MAX_LATCH_BYTES = 4_096;

export class AuthorityStoreCorruptError extends Error {
  constructor(
    readonly code: string,
    readonly filePath: string,
    readonly reason: string,
    readonly backupPath?: string
  ) {
    super(`${code}: ${reason}`);
    this.name = "AuthorityStoreCorruptError";
  }
}

function latchPath(filePath: string): string {
  return `${filePath}${LATCH_SUFFIX}`;
}

async function readBoundedUtf8(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_LATCH_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_LATCH_BYTES) {
      throw new Error("corruption latch exceeds byte bound");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readAuthorityStoreCorruption(
  filePath: string,
  expectedCode: string
): Promise<AuthorityStoreCorruptError | null> {
  const file = latchPath(filePath);
  let raw: string;
  try {
    raw = await readBoundedUtf8(file);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    return new AuthorityStoreCorruptError(
      expectedCode,
      filePath,
      "persisted corruption latch is unreadable"
    );
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const row = parsed as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !["code", "reason", "createdAt"].includes(key)) ||
      row.code !== expectedCode ||
      typeof row.reason !== "string" ||
      !row.reason ||
      Buffer.byteLength(row.reason, "utf8") > 256 ||
      typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt))
    ) {
      throw new Error();
    }
    return new AuthorityStoreCorruptError(
      expectedCode,
      filePath,
      row.reason
    );
  } catch {
    return new AuthorityStoreCorruptError(
      expectedCode,
      filePath,
      "persisted corruption latch is invalid"
    );
  }
}

/**
 * Persist the fail-closed latch before moving the corrupt authority file.
 * If latch persistence fails, the original remains in place so restart reads
 * corruption again; no empty healthy window is possible.
 */
export async function persistAuthorityStoreCorruption(
  filePath: string,
  code: string,
  reason: string,
  options?: {
    /** Test-only seam for proving latch-first failure ordering. */
    writeLatch?: typeof writeJsonAtomic;
  }
): Promise<AuthorityStoreCorruptError> {
  const file = latchPath(filePath);
  try {
    await (options?.writeLatch ?? writeJsonAtomic)(file, {
      code,
      reason,
      createdAt: new Date().toISOString(),
    });
  } catch {
    return new AuthorityStoreCorruptError(
      code,
      filePath,
      `${reason}; corruption latch persistence failed`
    );
  }

  let backupPath: string | undefined;
  try {
    backupPath = await backupCorruptMachineFile(filePath);
    warnCorruptMachineState(filePath, backupPath, "ignored");
  } catch {
    // The durable latch is authority; a locked original may remain as evidence.
  }
  return new AuthorityStoreCorruptError(code, filePath, reason, backupPath);
}

export function authorityStoreCorruptionLatchPath(filePath: string): string {
  return latchPath(filePath);
}
