import { FsAdapter } from "./adapter.js";
import { TYPE_REGISTRY_PATH } from "./paths.js";

export { TYPE_REGISTRY_PATH };

/** type 分层:base = 一级主类;modifier = 可选二级修饰。复合串为 "base-modifier"。 */
export type TypeTier = "base" | "modifier";

/**
 * V0.2 type definition: identity + tier only.
 * Domain R/W, coordination, color, description, workspacePointer are not product fields.
 */
export type TypeDefinition = {
  tier?: "base" | "modifier";
};

export type TypeRegistry = Record<string, TypeDefinition>;

/** Fixed product primaries — not user-extensible. */
export const CANONICAL_PRIMARY_TYPES = ["goal", "prompt", "output"] as const;
export type CanonicalPrimaryType = (typeof CANONICAL_PRIMARY_TYPES)[number];

/** Built-in secondary presets (user may also register custom modifiers without chrome). */
export const BUILTIN_SECONDARY_TYPES = ["reference", "asset"] as const;
export type BuiltinSecondaryType = (typeof BUILTIN_SECONDARY_TYPES)[number];

/**
 * 内置默认 type 注册表。
 * - primary: goal | prompt | output
 * - secondary presets: reference | asset
 */
export const DEFAULT_TYPE_REGISTRY: TypeRegistry = {
  goal: { tier: "base" },
  prompt: { tier: "base" },
  output: { tier: "base" },
  reference: { tier: "modifier" },
  asset: { tier: "modifier" },
};

/** 拆复合 type:"goal-asset" → {base:"goal", modifier:"asset"};"goal" → {base:"goal"}。 */
export function splitType(type: string): { base: string; modifier?: string } {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}

/** 组合 base + modifier 成单个 type 串。modifier 空则只返回 base。 */
export function joinType(base: string, modifier?: string): string {
  return modifier ? `${base}-${modifier}` : base;
}

export function isCanonicalPrimary(name: string): name is CanonicalPrimaryType {
  return (CANONICAL_PRIMARY_TYPES as readonly string[]).includes(name);
}

export function isBuiltinSecondary(name: string): name is BuiltinSecondaryType {
  return (BUILTIN_SECONDARY_TYPES as readonly string[]).includes(name);
}

/**
 * Lifecycle / load path: a Node type string is readable when its primary base is
 * canonical goal|prompt|output. Optional markers may be unknown historically —
 * unknown markers must not break lifecycle reads. Bare markers (no primary) are
 * not Node types.
 *
 * Production writes must use {@link isValidNodeType} / {@link assertValidNodeType}.
 */
export function typeExists(type: string, registry: TypeRegistry): boolean {
  const trimmed = type.trim();
  if (!trimmed) return false;
  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) return false;
  if (!registry[base] || (registry[base].tier ?? "base") === "modifier") return false;
  // Empty modifier after trailing "-" is not a well-formed type string.
  if (modifier !== undefined && modifier.length === 0) return false;
  return true;
}

/**
 * Production write validator (create / patch / scaffold / type management).
 * primary ∈ goal|prompt|output; optional secondary must be registered as modifier.
 * Bare markers are never valid Node types.
 */
export function isValidNodeType(type: string, registry: TypeRegistry): boolean {
  const trimmed = type.trim();
  if (!trimmed) return false;
  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) return false;
  if (!registry[base] || (registry[base].tier ?? "base") === "modifier") return false;
  if (modifier === undefined) return true;
  if (modifier.length === 0) return false;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}

/**
 * Shared fail-loud gate for every production Node type write boundary.
 * Rejects bare markers, unknown markers, non-primary bases, and empty types.
 */
export function assertValidNodeType(type: string, registry: TypeRegistry): void {
  const trimmed = typeof type === "string" ? type.trim() : "";
  if (!trimmed) throw new Error("Primary type cannot be cleared.");
  if (isValidNodeType(trimmed, registry)) return;

  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) {
    throw new Error(
      `Invalid node type: ${trimmed}. Node type must be goal|prompt|output or ` +
        `goal|prompt|output-<marker>; bare markers are not valid node types.`
    );
  }
  if (modifier !== undefined) {
    if (modifier.length === 0) {
      throw new Error(`Invalid node type: ${trimmed}. Empty marker is not allowed.`);
    }
    throw new Error(
      `Unknown type marker: ${modifier} (in ${trimmed}). Register the marker before writing.`
    );
  }
  throw new Error(`Unknown type: ${trimmed}.`);
}

/**
 * 正常运行路径只读 system root 扁平 `types.json`。
 * 不做 dual-read / 迁移兼容；损坏则 fail loud。
 */
export async function loadTypeRegistry(fs: FsAdapter): Promise<TypeRegistry> {
  if (!(await fs.exists(TYPE_REGISTRY_PATH))) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs.readFile(TYPE_REGISTRY_PATH)) as unknown;
    return normalizeRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`types.json is corrupt: ${detail}.`);
  }
}

/**
 * Normalize disk registry to V0.2 hard-cut shape:
 * - drop R/W, coordination, color, description, workspacePointer
 * - fixed primaries goal|prompt|output only (custom bases dropped, no rename maps)
 * - modifiers kept; built-in secondaries always present
 * - flat Record only — dual { primary, secondary } buckets are ignored (no dual semantics)
 */
export function normalizeRegistry(value: unknown): TypeRegistry {
  if (!isRecord(value)) {
    throw new Error("types.json root must be an object.");
  }
  const root = value;
  if (Object.prototype.hasOwnProperty.call(root, "primary") || Object.prototype.hasOwnProperty.call(root, "secondary")) {
    throw new Error("Legacy primary/secondary type registry buckets are not supported.");
  }
  const registry = cloneDefaults();
  mergeDefinitions(registry, root);
  finalizeRegistry(registry);
  return registry;
}

function mergeDefinitions(registry: TypeRegistry, source: unknown): void {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;

    const tier: TypeTier =
      raw.tier === "base" || raw.tier === "modifier"
        ? raw.tier
        : registry[name]?.tier ?? (isCanonicalPrimary(name) ? "base" : "modifier");

    // Fixed primaries always base; cannot demote.
    if (isCanonicalPrimary(name)) {
      registry[name] = { tier: "base" };
      continue;
    }
    // Built-in secondaries always modifier.
    if (isBuiltinSecondary(name)) {
      registry[name] = { tier: "modifier" };
      continue;
    }
    // Hard cut: only three primaries. Drop custom bases; keep custom modifiers only.
    if (tier === "base") continue;
    registry[name] = { tier: "modifier" };
  }
}

function finalizeRegistry(registry: TypeRegistry): void {
  for (const p of CANONICAL_PRIMARY_TYPES) {
    registry[p] = { tier: "base" };
  }
  for (const s of BUILTIN_SECONDARY_TYPES) {
    registry[s] = { tier: "modifier" };
  }
  // Never keep retired dual-era primary aliases as registry keys.
  delete registry.note;
  delete registry.artifact;
  delete registry.open;
  delete registry.sealed;
}

function cloneDefaults(): TypeRegistry {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
