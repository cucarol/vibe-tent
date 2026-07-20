// Canonical workspace-root AGENTS.md (not under .tent).
// Fixed filename only; no arbitrary path API. Missing file is an empty projection.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Sole canonical agents rules filename at workspace root. */
export const WORKSPACE_AGENTS_FILENAME = "AGENTS.md";

/**
 * Absolute path of `<workspaceRoot>/AGENTS.md`.
 * Enforces fixed basename and direct-child containment (no path traversal).
 */
export function resolveWorkspaceAgentsPath(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const agentsPath = path.resolve(root, WORKSPACE_AGENTS_FILENAME);
  if (path.basename(agentsPath) !== WORKSPACE_AGENTS_FILENAME) {
    throw new WorkspaceAgentsError(
      "INVALID_PATH",
      `Workspace agents file must be named ${WORKSPACE_AGENTS_FILENAME}`
    );
  }
  if (path.dirname(agentsPath) !== root) {
    throw new WorkspaceAgentsError(
      "INVALID_PATH",
      `${WORKSPACE_AGENTS_FILENAME} must be a direct child of the workspace root`
    );
  }
  return agentsPath;
}

export type WorkspaceAgentsFile = {
  /** Relative path from workspace root (always AGENTS.md). */
  path: typeof WORKSPACE_AGENTS_FILENAME;
  /** File body; empty string when missing. */
  content: string;
  /** Whether the file exists on disk. */
  exists: boolean;
};

/**
 * Read workspace-root AGENTS.md.
 * Missing file → `{ exists: false, content: "" }` (not an error).
 */
export async function loadWorkspaceAgents(workspaceRoot: string): Promise<WorkspaceAgentsFile> {
  const agentsPath = resolveWorkspaceAgentsPath(workspaceRoot);
  try {
    const content = await fs.readFile(agentsPath, "utf8");
    return {
      path: WORKSPACE_AGENTS_FILENAME,
      content,
      exists: true,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        path: WORKSPACE_AGENTS_FILENAME,
        content: "",
        exists: false,
      };
    }
    throw error;
  }
}

/**
 * Atomically write workspace-root AGENTS.md (temp sibling + rename).
 * Always creates/overwrites the fixed file; does not delete on empty content.
 * Returns whether the on-disk projection actually changed.
 */
export async function writeWorkspaceAgents(
  workspaceRoot: string,
  content: string
): Promise<{ file: WorkspaceAgentsFile; changed: boolean }> {
  if (typeof content !== "string") {
    throw new WorkspaceAgentsError("INVALID_CONTENT", "AGENTS.md content must be a string");
  }
  const agentsPath = resolveWorkspaceAgentsPath(workspaceRoot);
  const before = await loadWorkspaceAgents(workspaceRoot);
  const changed = !before.exists || before.content !== content;
  if (!changed) {
    return {
      file: {
        path: WORKSPACE_AGENTS_FILENAME,
        content: before.content,
        exists: true,
      },
      changed: false,
    };
  }

  await writeTextAtomic(agentsPath, content);
  return {
    file: {
      path: WORKSPACE_AGENTS_FILENAME,
      content,
      exists: true,
    },
    changed: true,
  };
}

export class WorkspaceAgentsError extends Error {
  code: "INVALID_PATH" | "INVALID_CONTENT";
  constructor(code: "INVALID_PATH" | "INVALID_CONTENT", message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspaceAgentsError";
  }
}

/** Atomic replace: write temp sibling then rename into place (Windows-safe retries). */
async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
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
      await new Promise((r) => setTimeout(r, 5 + i * 5));
    }
  }
  throw lastErr;
}

function isRetryableRenameError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
