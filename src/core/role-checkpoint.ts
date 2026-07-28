/**
 * Role Checkpoint — optional cooperative continuation note for Role Session
 * replacement/transfer. Operational under temp/<role>/checkpoint.md only.
 *
 * Not a Core entity, Task state, Delivery, or OS-temp artifact.
 * Never replaces Delivery or persisted Tent/Git facts.
 * Abnormal crash/restart recovery must work without it.
 *
 * Dynamic tail context only — never fold into stable Role init / cache prefix.
 */

import type { FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { AGENT_PROFILES_TEMP_DIR, TEMP_DIR } from "./paths.js";
import { assertRoleNameAvailable } from "./skillRoleRegistry.js";
import { join } from "./tree.js";

/** Frontmatter type for the single per-role continuation note. */
export const ROLE_CHECKPOINT_TYPE = "role-checkpoint" as const;

/** Soft cap so notes stay short (pointers + judgment, not Delivery bodies). */
export const ROLE_CHECKPOINT_MAX_TEXT_CHARS = 4_000;

/** Filename under temp/<role>/ (system-root relative). */
export const ROLE_CHECKPOINT_FILENAME = "checkpoint.md";

export type RoleCheckpointPointers = {
  /** Durable Node / box ids (cx-…). */
  nodes?: string[];
  /** Task ids or envelope paths (tk-… or temp/…). */
  tasks?: string[];
  /** Delivery ids (dl-…). */
  deliveries?: string[];
  /** Git refs: branch names, SHAs, or short lane labels. */
  git?: string[];
};

export type RoleCheckpointRecord = {
  role: string;
  /** Concise continuation judgment / next step (required). */
  text: string;
  updatedAt: string;
  /** Session that wrote the note (ss-… or external key); optional audit. */
  sourceSessionId?: string;
  pointers?: RoleCheckpointPointers;
  /** System-root relative path. */
  path: string;
};

export type WriteRoleCheckpointInput = {
  role: string;
  text: string;
  /** ISO timestamp; callers may pass clock.now(). */
  updatedAt: string;
  sourceSessionId?: string;
  pointers?: RoleCheckpointPointers;
};

/** Windows device names unsafe as a single path segment (case-insensitive). */
const WINDOWS_RESERVED_DEVICE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Path-safe operational Role name for checkpoint paths under temp/<role>/.
 * Rejects traversal (`.` / `..`), separators, control characters, Windows
 * reserved device segments, and Tent-owned temp names.
 * Does **not** check the Role registry — Service RPC does that.
 */
export function assertRoleCheckpointRoleName(role: string): string {
  const name = typeof role === "string" ? role.trim() : "";
  if (!name) throw new Error("Role name cannot be empty.");
  // Control characters (incl. CR/LF/TAB) and DEL — never path segments.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Role name cannot contain control characters.");
  }
  // Path separators and Windows-invalid path chars that break operational dirs.
  if (/[\/\\<>:"|?*]/.test(name)) {
    throw new Error("Role name cannot contain path separators or reserved path characters.");
  }
  // Dot segments: bare `.` / `..`, or any `..` substring (traversal).
  if (name === "." || name === ".." || name.includes("..")) {
    throw new Error("Role name cannot be a dot segment or contain path traversal.");
  }
  // Leading/trailing `.` is not a valid durable Role operational name for temp/.
  if (name.startsWith(".") || name.endsWith(".")) {
    throw new Error("Role name cannot start or end with a dot.");
  }
  // Windows reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9).
  if (WINDOWS_RESERVED_DEVICE.test(name)) {
    throw new Error(`Role name is a reserved Windows path segment: ${name}.`);
  }
  // Collisions with Tent-owned operational directories (e.g. agent-profiles).
  assertRoleNameAvailable(name);
  // Defense in depth if assertRoleNameAvailable only covers known reserved set.
  if (name.toLowerCase() === AGENT_PROFILES_TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${AGENT_PROFILES_TEMP_DIR}.`);
  }
  if (name.toLowerCase() === TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${TEMP_DIR}.`);
  }
  return name;
}

/** @deprecated Use assertRoleCheckpointRoleName — kept as internal alias. */
function assertRoleSegment(role: string): string {
  return assertRoleCheckpointRoleName(role);
}

/** System-root relative path for the Role's single continuation note. */
export function roleCheckpointPath(role: string): string {
  const name = assertRoleCheckpointRoleName(role);
  return join(TEMP_DIR, name, ROLE_CHECKPOINT_FILENAME);
}

/** Workspace-relative file path for agent file reads. */
export function roleCheckpointFileReadPath(role: string): string {
  return join(".tent", roleCheckpointPath(role));
}

function normalizePointerList(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Role Checkpoint pointers.${label} must be an array of strings.`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Role Checkpoint pointers.${label} entries must be non-empty strings.`);
    }
    out.push(item.trim());
  }
  return out.length > 0 ? out : undefined;
}

function normalizePointers(raw?: RoleCheckpointPointers | Record<string, unknown>): RoleCheckpointPointers | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const nodes = normalizePointerList((raw as RoleCheckpointPointers).nodes, "nodes");
  const tasks = normalizePointerList((raw as RoleCheckpointPointers).tasks, "tasks");
  const deliveries = normalizePointerList((raw as RoleCheckpointPointers).deliveries, "deliveries");
  const git = normalizePointerList((raw as RoleCheckpointPointers).git, "git");
  if (!nodes && !tasks && !deliveries && !git) return undefined;
  return {
    ...(nodes ? { nodes } : {}),
    ...(tasks ? { tasks } : {}),
    ...(deliveries ? { deliveries } : {}),
    ...(git ? { git } : {}),
  };
}

function normalizeText(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) throw new Error("Role Checkpoint text cannot be empty.");
  if (trimmed.length > ROLE_CHECKPOINT_MAX_TEXT_CHARS) {
    throw new Error(
      `Role Checkpoint text exceeds ${ROLE_CHECKPOINT_MAX_TEXT_CHARS} characters; keep a short continuation note with pointers only.`
    );
  }
  return trimmed;
}

/**
 * Write (overwrite) the single current continuation note for a durable Role.
 * Later writes replace earlier ones — no handoff pile.
 */
export async function writeRoleCheckpoint(
  fs: FsAdapter,
  input: WriteRoleCheckpointInput
): Promise<RoleCheckpointRecord> {
  const role = assertRoleSegment(input.role);
  const text = normalizeText(input.text);
  const pointers = normalizePointers(input.pointers);
  const updatedAt = input.updatedAt?.trim();
  if (!updatedAt) throw new Error("Role Checkpoint updatedAt is required.");
  const sourceSessionId = input.sourceSessionId?.trim() || undefined;
  const path = roleCheckpointPath(role);

  const data: Record<string, unknown> = {
    type: ROLE_CHECKPOINT_TYPE,
    role,
    updatedAt,
  };
  if (sourceSessionId) data.sourceSessionId = sourceSessionId;
  if (pointers?.nodes) data.nodes = pointers.nodes;
  if (pointers?.tasks) data.tasks = pointers.tasks;
  if (pointers?.deliveries) data.deliveries = pointers.deliveries;
  if (pointers?.git) data.git = pointers.git;

  const body =
    `# Role Checkpoint\n\n` +
    `Optional cooperative continuation for Role Session replacement/transfer.\n` +
    `Dynamic tail only — not Delivery, not Task state, not stable Role init.\n\n` +
    `## Continuation\n\n` +
    `${text}\n`;

  await fs.writeFile(path, serializeFrontmatter(data, body));
  return {
    role,
    text,
    updatedAt,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(pointers ? { pointers } : {}),
    path,
  };
}

/**
 * Read the current Role Checkpoint, or null when absent / unreadable as checkpoint.
 * Malformed files throw so callers fail loud rather than inventing continuity.
 */
export async function readRoleCheckpoint(
  fs: FsAdapter,
  role: string
): Promise<RoleCheckpointRecord | null> {
  const name = assertRoleSegment(role);
  const path = roleCheckpointPath(name);
  if (!(await fs.exists(path))) return null;
  const raw = await fs.readFile(path);
  const parsed = parseFrontmatter(raw);
  const type = typeof parsed.data.type === "string" ? parsed.data.type.trim() : "";
  if (type && type !== ROLE_CHECKPOINT_TYPE) {
    throw new Error(
      `Role Checkpoint at ${path} has unexpected type ${type}; expected ${ROLE_CHECKPOINT_TYPE}.`
    );
  }
  const fmRole = typeof parsed.data.role === "string" ? parsed.data.role.trim() : name;
  if (fmRole !== name) {
    throw new Error(`Role Checkpoint role mismatch at ${path}: file has ${fmRole}, expected ${name}.`);
  }
  const updatedAt =
    typeof parsed.data.updatedAt === "string" ? parsed.data.updatedAt.trim() : "";
  if (!updatedAt) {
    throw new Error(`Role Checkpoint at ${path} is missing updatedAt.`);
  }
  const sourceSessionId =
    typeof parsed.data.sourceSessionId === "string"
      ? parsed.data.sourceSessionId.trim() || undefined
      : undefined;
  const pointers = normalizePointers({
    nodes: parsed.data.nodes as string[] | undefined,
    tasks: parsed.data.tasks as string[] | undefined,
    deliveries: parsed.data.deliveries as string[] | undefined,
    git: parsed.data.git as string[] | undefined,
  });

  // Prefer ## Continuation section; else whole body trimmed (minus heading noise).
  let text = "";
  const body = parsed.body.replace(/\r\n/g, "\n");
  const cont = body.match(/##\s*Continuation\s*\r?\n+([\s\S]*?)\s*$/i);
  if (cont) {
    text = cont[1].trim();
  } else {
    text = body
      .replace(/^#\s*Role Checkpoint\s*/i, "")
      .replace(
        /^Optional cooperative continuation[\s\S]*?stable Role init\.\s*/i,
        ""
      )
      .trim();
  }
  if (!text) {
    throw new Error(`Role Checkpoint at ${path} has empty continuation text.`);
  }
  if (text.length > ROLE_CHECKPOINT_MAX_TEXT_CHARS) {
    throw new Error(
      `Role Checkpoint at ${path} exceeds ${ROLE_CHECKPOINT_MAX_TEXT_CHARS} characters.`
    );
  }

  return {
    role: name,
    text,
    updatedAt,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(pointers ? { pointers } : {}),
    path,
  };
}

/** Remove the current note. Idempotent when absent. */
export async function clearRoleCheckpoint(fs: FsAdapter, role: string): Promise<boolean> {
  const path = roleCheckpointPath(role);
  if (!(await fs.exists(path))) return false;
  await fs.remove(path);
  return true;
}

/**
 * Format checkpoint as dynamic bootstrap/enter tail.
 * Callers must append after stable prefix (Context Card + Role init + task body).
 * Returns empty string when record is null.
 */
export function formatRoleCheckpointTail(
  record: RoleCheckpointRecord | null | undefined
): string {
  if (!record) return "";
  const lines = [
    "--- Tent Role Checkpoint (dynamic tail; optional) ---",
    "This is cooperative continuation only. It is not Delivery, Task state, or stable Role init.",
    "Abnormal recovery must re-query persisted Tent Nodes, Tasks, Deliveries, and Git — never invent from this note alone.",
    `role: ${record.role}`,
    `updatedAt: ${record.updatedAt}`,
    `checkpointPath: ${record.path}`,
    `fileRead: ${roleCheckpointFileReadPath(record.role)}`,
  ];
  if (record.sourceSessionId) {
    lines.push(`sourceSessionId: ${record.sourceSessionId}`);
  }
  const p = record.pointers;
  if (p?.nodes?.length) lines.push(`nodes: ${p.nodes.join(", ")}`);
  if (p?.tasks?.length) lines.push(`tasks: ${p.tasks.join(", ")}`);
  if (p?.deliveries?.length) lines.push(`deliveries: ${p.deliveries.join(", ")}`);
  if (p?.git?.length) lines.push(`git: ${p.git.join(", ")}`);
  lines.push("");
  lines.push("## Continuation");
  lines.push("");
  lines.push(record.text);
  return lines.join("\n");
}

/**
 * Load + format tail for a role. Missing file → empty string.
 * Parse errors propagate (fail loud).
 */
export async function loadRoleCheckpointTail(
  fs: FsAdapter,
  role: string
): Promise<string> {
  const record = await readRoleCheckpoint(fs, role);
  return formatRoleCheckpointTail(record);
}
