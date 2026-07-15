// Machine-local bundled skill install / list.
// User surface only (shared-agents + claude skill dirs). Not workspace-scoped.
// Source is always package bundled skills/; never RPC-supplied paths.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Install destinations. Bundled SKILL.md is compatible with both (no format fork). */
export const SKILL_TARGET_IDS = ["shared-agents", "claude"] as const;
export type SkillTargetId = (typeof SKILL_TARGET_IDS)[number];

/** Safe skill directory name: no path separators, no traversal. */
const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface SkillPathsOptions {
  /** Override home (tests). Default: os.homedir(). */
  home?: string;
}

export interface SkillInstallItemResult {
  targetDir: string;
  target?: SkillTargetId;
  skill: string;
  status: "installed" | "skipped";
  reason?: string;
}

export interface SkillTargetStatus {
  target: SkillTargetId;
  path: string;
  installed: boolean;
}

export interface BundledSkillListEntry {
  name: string;
  targets: SkillTargetStatus[];
}

export interface SkillListResult {
  skills: BundledSkillListEntry[];
}

export interface ListSkillsOptions extends SkillPathsOptions {
  packageRoot: string;
}

export interface InstallSkillsOptions extends SkillPathsOptions {
  packageRoot: string;
  /** Skill names; omit / empty = all bundled. */
  skills?: string[];
  /** Target ids; omit / empty = both shared-agents and claude. */
  targets?: SkillTargetId[];
  force?: boolean;
  /**
   * CLI/test override: install into these absolute dirs instead of home targets.
   * When set, `targets` is ignored for destination resolution (still may validate CLI format).
   */
  targetDirs?: string[];
}

export function isSkillTargetId(value: string): value is SkillTargetId {
  return (SKILL_TARGET_IDS as readonly string[]).includes(value);
}

/**
 * Resolve skill install directory for a target under home.
 * Paths always derive from os.homedir() or injected home — never hard-coded user paths.
 */
export function skillTargetDir(target: SkillTargetId, home?: string): string {
  const root = home ?? os.homedir();
  switch (target) {
    case "claude":
      return path.join(root, ".claude", "skills");
    case "shared-agents":
      return path.join(root, ".agents", "skills");
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown skill target: ${String(_exhaustive)}`);
    }
  }
}

/** Default install destinations: shared-agents + claude under home. */
export function defaultSkillInstallDirs(home?: string): string[] {
  return SKILL_TARGET_IDS.map((id) => skillTargetDir(id, home));
}

/** Resolve the CLI target selector; `all` installs to both supported roots. */
export function resolveCliSkillInstallDirs(cliTarget: string, home?: string): string[] {
  const target = cliTarget.trim();
  if (target === "all") return defaultSkillInstallDirs(home);
  return [skillTargetDir(parseSkillTargetId(target), home)];
}

export function assertSafeSkillName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    !SAFE_SKILL_NAME.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    path.basename(trimmed) !== trimmed
  ) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return trimmed;
}

export function parseSkillTargetId(value: string): SkillTargetId {
  const trimmed = value.trim();
  if (!isSkillTargetId(trimmed)) {
    throw new Error(
      `Unknown skill target: ${value} (allowed: ${SKILL_TARGET_IDS.join(", ")})`
    );
  }
  return trimmed;
}

export function bundledSkillsDir(packageRoot: string): string {
  return path.join(packageRoot, "skills");
}

/** Discover installable bundled skill names (dirs containing SKILL.md). */
export async function listBundledSkillNames(packageRoot: string): Promise<string[]> {
  const sourceDir = bundledSkillsDir(packageRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      throw new Error(`No installable skills found in ${sourceDir}`);
    }
    throw err;
  }
  const skillNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Reject unexpected directory names at discovery time.
    if (!SAFE_SKILL_NAME.test(entry.name)) continue;
    if (await existsPath(path.join(sourceDir, entry.name, "SKILL.md"))) {
      skillNames.push(entry.name);
    }
  }
  skillNames.sort();
  return skillNames;
}

/**
 * List bundled skills and whether each is installed under each target.
 * Machine-local only — no workspaceId.
 */
export async function listSkills(options: ListSkillsOptions): Promise<SkillListResult> {
  const home = options.home ?? os.homedir();
  const names = await listBundledSkillNames(options.packageRoot);
  const skills: BundledSkillListEntry[] = [];
  for (const name of names) {
    const targets: SkillTargetStatus[] = [];
    for (const target of SKILL_TARGET_IDS) {
      const dir = skillTargetDir(target, home);
      const skillPath = path.join(dir, name);
      assertChildPath(dir, skillPath);
      targets.push({
        target,
        path: skillPath,
        installed: await existsPath(skillPath),
      });
    }
    skills.push({ name, targets });
  }
  return { skills };
}

/**
 * Copy bundled skills into target dirs.
 * Without force: each (target, skill) is judged independently — existing skills are skipped.
 * With force: overwrite existing skill dirs.
 * Only copies from packageRoot/skills; never accepts arbitrary source/destination from callers
 * beyond target ids / CLI targetDirs override.
 */
export async function installSkills(options: InstallSkillsOptions): Promise<SkillInstallItemResult[]> {
  const home = options.home ?? os.homedir();
  const force = options.force === true;
  const sourceDir = bundledSkillsDir(options.packageRoot);
  const allNames = await listBundledSkillNames(options.packageRoot);
  if (allNames.length === 0) {
    throw new Error(`No installable skills found in ${sourceDir}`);
  }

  const selectedNames = resolveSkillSelection(options.skills, allNames);
  const destinations = resolveInstallDestinations(options, home);
  if (destinations.length === 0) {
    throw new Error("skill-install requires at least one target directory");
  }

  const results: SkillInstallItemResult[] = [];
  for (const dest of destinations) {
    await fs.mkdir(dest.dir, { recursive: true });
    for (const name of selectedNames) {
      const source = path.join(sourceDir, name);
      const target = path.join(dest.dir, name);
      assertChildPath(sourceDir, source);
      assertChildPath(dest.dir, target);
      const exists = await existsPath(target);
      if (exists && !force) {
        results.push({
          targetDir: dest.dir,
          ...(dest.target ? { target: dest.target } : {}),
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)",
        });
        continue;
      }
      if (exists && force) {
        await fs.rm(target, { recursive: true, force: true });
      }
      await fs.cp(source, target, { recursive: true, errorOnExist: true });
      results.push({
        targetDir: dest.dir,
        ...(dest.target ? { target: dest.target } : {}),
        skill: name,
        status: "installed",
      });
    }
  }
  return results;
}

function resolveSkillSelection(requested: string[] | undefined, allNames: string[]): string[] {
  if (!requested || requested.length === 0) return [...allNames];
  const known = new Set(allNames);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const name = assertSafeSkillName(raw);
    if (!known.has(name)) {
      throw new Error(`Unknown bundled skill: ${name}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
  }
  selected.sort();
  return selected;
}

function resolveInstallDestinations(
  options: InstallSkillsOptions,
  home: string
): Array<{ dir: string; target?: SkillTargetId }> {
  if (options.targetDirs !== undefined) {
    if (options.targetDirs.length === 0) {
      throw new Error("skill-install requires at least one target directory");
    }
    return options.targetDirs.map((dir) => ({ dir: path.resolve(dir) }));
  }

  const targetIds =
    options.targets && options.targets.length > 0
      ? options.targets.map((t) => parseSkillTargetId(t))
      : [...SKILL_TARGET_IDS];

  // De-dupe while preserving order.
  const seen = new Set<SkillTargetId>();
  const out: Array<{ dir: string; target: SkillTargetId }> = [];
  for (const id of targetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ dir: skillTargetDir(id, home), target: id });
  }
  return out;
}

function assertChildPath(parent: string, child: string): void {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
