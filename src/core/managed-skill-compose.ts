// Built-in Tent skill composition for managed Task executors (V0.2).
// tent-task is automatic for every managed Task; durable Role tasks also get tent-role.
// Route skills remain optional extras — not the mechanism for these contracts.

import * as fs from "node:fs";
import * as path from "node:path";
import type { RoleDefinition } from "./skillRoleRegistry.js";
import type { AssigneeKind } from "./task-model.js";

/**
 * Narrow skill-ref shape owned by Core for managed compose.
 * Structural match to an adapter route skill reference (name/path/enabled) —
 * Core must not import adapters (build:core rootDir=src/core).
 */
export type ManagedSkillRef = {
  name: string;
  path?: string;
  enabled?: boolean;
};

/** Built-in contract skill names (bundled under package skills/). */
export const BUILTIN_TENT_TASK_SKILL = "tent-task" as const;
export const BUILTIN_TENT_ROLE_SKILL = "tent-role" as const;

export type BuiltinTentSkillName =
  | typeof BUILTIN_TENT_TASK_SKILL
  | typeof BUILTIN_TENT_ROLE_SKILL;

/**
 * Which built-in contracts apply for a managed executor.
 * - every managed Task → tent-task
 * - durable Role assignee → tent-role as well
 * - temporary route execution → tent-task only
 */
export function builtinSkillNamesForExecutor(
  assigneeKind: AssigneeKind | undefined
): BuiltinTentSkillName[] {
  const kind = assigneeKind === "route" ? "route" : "role";
  if (kind === "role") {
    return [BUILTIN_TENT_ROLE_SKILL, BUILTIN_TENT_TASK_SKILL];
  }
  return [BUILTIN_TENT_TASK_SKILL];
}

export function bundledSkillDir(packageRoot: string, skillName: string): string {
  return path.join(packageRoot, "skills", skillName);
}

export function bundledSkillMdPath(packageRoot: string, skillName: string): string {
  return path.join(bundledSkillDir(packageRoot, skillName), "SKILL.md");
}

/**
 * Read bundled SKILL.md body (fail-loud when required skill is missing).
 * Strips YAML frontmatter so bootstrap embeds the contract body only once.
 */
export function readBundledSkillBody(packageRoot: string, skillName: string): string {
  const file = bundledSkillMdPath(packageRoot, skillName);
  if (!fs.existsSync(file)) {
    throw new Error(`Built-in skill missing: ${skillName} (${file})`);
  }
  const raw = fs.readFileSync(file, "utf8");
  return stripYamlFrontmatter(raw).trim();
}

/**
 * Read raw SKILL.md including YAML frontmatter (for version extraction).
 */
export function readBundledSkillRaw(packageRoot: string, skillName: string): string {
  const file = bundledSkillMdPath(packageRoot, skillName);
  if (!fs.existsSync(file)) {
    throw new Error(`Built-in skill missing: ${skillName} (${file})`);
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Skill version label for contextGeneration: frontmatter `version` / `compatibility`
 * when present, else package version, else skill name as stable marker.
 */
export function readBundledSkillVersion(
  packageRoot: string,
  skillName: string,
  packageVersion?: string
): string {
  try {
    const raw = readBundledSkillRaw(packageRoot, skillName);
    const fromFm = parseSkillFrontmatterVersion(raw);
    if (fromFm) return fromFm;
  } catch {
    // fall through
  }
  const pkg = packageVersion?.trim();
  if (pkg) return pkg;
  return skillName;
}

/** Extract version-like field from SKILL.md YAML frontmatter. */
export function parseSkillFrontmatterVersion(raw: string): string | undefined {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const fm = text.slice(3, end);
  for (const key of ["version", "compatibility", "schemaVersion"]) {
    const re = new RegExp(`^${key}\\s*:\\s*["']?([^"'\\n#]+)`, "im");
    const m = fm.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  // name field is not a version — skip
  return undefined;
}

export function stripYamlFrontmatter(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.slice(end + 4);
  return after.replace(/^\r?\n/, "");
}

/**
 * Marks the end of the cross-Task stable skill/role prefix.
 * Everything after this line is dynamic (Context Card, Task pointer, user prompt, …).
 * Used for prompt-cache identity tests and honest prefix/tail splits.
 */
export const STABLE_SKILL_CONTRACTS_END_MARKER =
  "--- End of stable Tent skill contracts ---" as const;

/**
 * Short invariant managed-session chrome (no taskId / taskPath / user prompt).
 * Prepended before skill contracts so the whole stable block is cache-friendly.
 */
export const MANAGED_SESSION_BOOTSTRAP_BANNER =
  "--- Tent managed session bootstrap ---" as const;

/**
 * Compose stable managed bootstrap prefix (contracts + role context).
 * Order (frozen, all task-independent when Role/skills are fixed):
 * 1. tent-role body (when durable Role)
 * 2. Role prompt (when durable Role)
 * 3. tent-task body
 * 4. {@link STABLE_SKILL_CONTRACTS_END_MARKER}
 *
 * Callers must place any short invariant chrome (e.g. {@link MANAGED_SESSION_BOOTSTRAP_BANNER})
 * before this block, and every taskId/taskPath/Context-Card/user-prompt field after it.
 */
export function composeManagedSkillBootstrapPrefix(input: {
  packageRoot: string;
  assigneeKind?: AssigneeKind;
  role?: RoleDefinition;
}): string {
  const names = builtinSkillNamesForExecutor(input.assigneeKind);
  const sections: string[] = [];

  if (names.includes(BUILTIN_TENT_ROLE_SKILL)) {
    const body = readBundledSkillBody(input.packageRoot, BUILTIN_TENT_ROLE_SKILL);
    sections.push(`## Built-in skill: ${BUILTIN_TENT_ROLE_SKILL}\n\n${body}`);
    const role = input.role;
    const rolePrompt = role?.prompt?.trim() || "(no persistent role prompt)";
    sections.push(`## Role prompt\n\n${rolePrompt}`);
  }

  if (names.includes(BUILTIN_TENT_TASK_SKILL)) {
    const body = readBundledSkillBody(input.packageRoot, BUILTIN_TENT_TASK_SKILL);
    sections.push(`## Built-in skill: ${BUILTIN_TENT_TASK_SKILL}\n\n${body}`);
  }

  sections.push(STABLE_SKILL_CONTRACTS_END_MARKER);
  return sections.join("\n\n");
}

/**
 * Assemble full managed bootstrap with frozen order:
 * invariant banner → stable skill/role contracts → dynamic Context Card + Task tail.
 * Pure; no I/O. Used by Service and by cache-identity tests.
 */
export function assembleManagedSessionBootstrap(input: {
  /** Output of {@link composeManagedSkillBootstrapPrefix} (includes end marker). */
  stableSkillPrefix: string;
  /** Task-specific Context Card prompt text. */
  contextCardPrompt: string;
  /** Dynamic session steps / user prompt (task pointer, acceptance, …). */
  dynamicTaskTail: string;
}): string {
  const stable = input.stableSkillPrefix.trimEnd();
  const card = input.contextCardPrompt.trim();
  const tail = input.dynamicTaskTail.trim();
  return (
    `${MANAGED_SESSION_BOOTSTRAP_BANNER}\n` +
    (stable ? `${stable}\n\n` : "") +
    `${card}\n\n` +
    `${tail}\n`
  );
}

/**
 * Split assembled bootstrap into stable prefix (through end of tent-task contracts)
 * and dynamic tail. Fail-loud if the end marker is missing.
 */
export function splitManagedBootstrapStableAndDynamic(full: string): {
  stablePrefix: string;
  dynamicTail: string;
} {
  const marker = STABLE_SKILL_CONTRACTS_END_MARKER;
  const idx = full.indexOf(marker);
  if (idx === -1) {
    throw new Error(
      "Managed bootstrap missing stable skill end marker; cannot split cache prefix"
    );
  }
  const end = idx + marker.length;
  // Include trailing newlines that belong to the stable block separator.
  let splitAt = end;
  while (splitAt < full.length && (full[splitAt] === "\n" || full[splitAt] === "\r")) {
    splitAt += 1;
  }
  return {
    stablePrefix: full.slice(0, splitAt),
    dynamicTail: full.slice(splitAt),
  };
}

/**
 * ACP `_meta.tent.skills` refs for optional route extras only.
 *
 * Built-in tent-role / tent-task contracts are model-visible solely via the
 * stable bootstrap prefix (`composeManagedSkillBootstrapPrefix`) — the
 * cross-provider source of truth. Do **not** re-advertise those names as
 * activatable skill path refs (avoids provider-dependent double-load when an
 * adapter honors skill metadata).
 *
 * Route skills that collide with built-in names are dropped. Remaining
 * extras are deduped by name (case-insensitive; first wins).
 */
export function composeManagedSkillRefs(input: {
  packageRoot: string;
  assigneeKind?: AssigneeKind;
  routeSkills?: ManagedSkillRef[];
}): ManagedSkillRef[] {
  void input.packageRoot; // reserved for future path resolution of extras
  // Always reserve both built-in names so a route cannot re-inject them as meta.
  const reserved = new Set<string>([
    BUILTIN_TENT_ROLE_SKILL.toLowerCase(),
    BUILTIN_TENT_TASK_SKILL.toLowerCase(),
  ]);
  const out: ManagedSkillRef[] = [];
  const seen = new Set<string>(reserved);

  for (const ref of input.routeSkills ?? []) {
    if (!ref || ref.enabled === false) continue;
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      ...(ref.path !== undefined ? { path: ref.path } : {}),
      enabled: true,
    });
  }

  return out;
}

/**
 * Short non-secret compatibility fingerprint inputs (not a Session reuse claim).
 * Callers may embed or hash; changes invalidate prompt-cache friendliness honestly.
 */
export function managedSkillCompatibilityInputs(input: {
  packageRoot: string;
  assigneeKind?: AssigneeKind;
  role?: RoleDefinition;
  /** Package version used when skill frontmatter has no version field. */
  packageVersion?: string;
}): {
  builtinSkills: BuiltinTentSkillName[];
  rolePrompt: string;
  skillBodyDigests: Record<string, string>;
  skillVersions: Record<string, string>;
  skillBodies: Record<string, string>;
} {
  const builtinSkills = builtinSkillNamesForExecutor(input.assigneeKind);
  const skillBodyDigests: Record<string, string> = {};
  const skillVersions: Record<string, string> = {};
  const skillBodies: Record<string, string> = {};
  for (const name of builtinSkills) {
    const body = readBundledSkillBody(input.packageRoot, name);
    skillBodies[name] = body;
    skillBodyDigests[name] = simpleDigest(body);
    skillVersions[name] = readBundledSkillVersion(
      input.packageRoot,
      name,
      input.packageVersion
    );
  }
  return {
    builtinSkills,
    rolePrompt: input.role?.prompt?.trim() || "",
    skillBodyDigests,
    skillVersions,
    skillBodies,
  };
}

/** Non-cryptographic short digest for compatibility / test assertions. */
export function simpleDigest(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `d${h.toString(16).padStart(8, "0")}`;
}
