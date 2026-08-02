// Shared machine-local JSON persistence helpers.
// Used by runtime + service stores. Not collaboration facts, not workspace Git.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** True when the error is a missing path (fresh store / first write). */
export function isNotFoundError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRetryableRenameError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  // Windows: concurrent replace / AV scanners can yield EPERM or EBUSY briefly.
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EEXIST";
}

/**
 * Write pretty-printed UTF-8 JSON via same-directory unique temp + rename.
 * Best-effort temp cleanup on failure. Callers that need mutual exclusion
 * must serialize around this (see the machine-local approval stores).
 *
 * On Windows, rename-over-existing is retried briefly; still prefer a write chain
 * when multiple writers target the same path.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(value, null, 2) + "\n";
  // Include a counter-ish suffix so same-ms concurrent temps never collide.
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, body, "utf8");
    await renameReplace(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

/** Rename temp → final; retry transient Windows replace failures. */
async function renameReplace(tmp: string, filePath: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRenameError(err) || i === attempts - 1) break;
      // Brief backoff; deterministic upper bound (no open-ended wait).
      await new Promise((r) => setTimeout(r, 5 + i * 5));
    }
  }
  // Preserve the previous valid file when replacement still fails. Deleting the
  // destination here would reintroduce the torn/missing window this helper avoids.
  throw lastErr;
}

/**
 * Preserve a corrupt machine-local file beside the original via rename when possible
 * (so re-reads do not re-quarantine), falling back to copy+unlink.
 * Backup name uses only path + timestamp — never content (may hold tokens).
 */
export async function backupCorruptMachineFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.corrupt-${corruptTimestamp()}`;
  try {
    await fs.rename(filePath, backupPath);
    return backupPath;
  } catch {
    // Cross-device or locked: copy then remove original so loaders stop re-warning.
    await fs.copyFile(filePath, backupPath);
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
    return backupPath;
  }
}

/**
 * Concise recovery warning. Paths only — never file contents or secrets.
 * Mirrors core registry recovery wording for a familiar operator signal.
 */
export function warnCorruptMachineState(
  filePath: string,
  backupPath: string,
  action: "reset" | "ignored",
  extra = ""
): void {
  console.error(
    `WARNING: ${filePath} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
  );
}

function corruptTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
