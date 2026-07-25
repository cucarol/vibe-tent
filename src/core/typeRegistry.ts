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
 * type 是否可被注册表解析(精确命中,或 base[+modifier] 都在册)。
 * Primary bases must be canonical goal|prompt|output (or a residual custom base still in registry during transition tests).
 */
export function typeExists(type: string, registry: TypeRegistry): boolean {
  if (registry[type]) return true;
  const { base, modifier } = splitType(type);
  const baseOk = !!registry[base] && (registry[base].tier ?? "base") !== "modifier";
  if (!baseOk) return false;
  if (modifier === undefined) return true;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}

/**
 * Whether a type string is a valid V0.2 concept type after cutover:
 * primary ∈ goal|prompt|output, optional secondary present in registry as modifier.
 */
export function isValidConceptType(type: string, registry: TypeRegistry): boolean {
  const { base, modifier } = splitType(type);
  if (!isCanonicalPrimary(base)) return false;
  if (!registry[base] || (registry[base].tier ?? "base") === "modifier") return false;
  if (modifier === undefined) return true;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}

/**
 * 正常运行路径只读 system root 扁平 `types.json`。
 * 嵌套 `.tent/types.json` 仅由一次性迁移函数搬迁，不做长期 dual-read。
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
 * Normalize disk registry to V0.2 shape:
 * - drop R/W, coordination, color, description, workspacePointer
 * - map legacy primary keys note→prompt, artifact→output (definition merge only; node rewrites are migration)
 * - drop retired built-ins open/sealed/note/artifact from defaults (custom modifiers may remain)
 * - flatten legacy { primary, secondary }
 */
export function normalizeRegistry(value: unknown): TypeRegistry {
  const root = isRecord(value) ? value : {};
  const registry = cloneDefaults();

  if (isRecord(root.primary) || isRecord(root.secondary)) {
    mergeDefinitions(registry, mapLegacyBucketKeys(root.primary));
    mergeDefinitions(registry, mapLegacyBucketKeys(root.secondary), "modifier");
    finalizeRegistry(registry);
    return registry;
  }

  mergeDefinitions(registry, mapLegacyBucketKeys(root));
  finalizeRegistry(registry);
  return registry;
}

function mapLegacyBucketKeys(source: unknown): Record<string, unknown> {
  if (!isRecord(source)) return {};
  const out: Record<string, unknown> = {};
  for (const [rawName, raw] of Object.entries(source)) {
    const name = mapLegacyTypeKey(rawName);
    if (!name) continue;
    // Prefer first definition if both note and prompt present after map, etc.
    if (out[name] === undefined) out[name] = raw;
  }
  return out;
}

/** Map legacy registry key names; returns "" to drop the key entirely. */
function mapLegacyTypeKey(name: string): string {
  if (name === "note") return "prompt";
  if (name === "artifact") return "output";
  if (name === "open" || name === "sealed") return "";
  return name;
}

function mergeDefinitions(
  registry: TypeRegistry,
  source: unknown,
  defaultTier?: TypeTier
): void {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;
    const current = registry[name];
    const tier: TypeTier =
      raw.tier === "base" || raw.tier === "modifier"
        ? raw.tier
        : current?.tier ?? defaultTier ?? (isCanonicalPrimary(name) ? "base" : "modifier");

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
    // Custom: allow base only if not colliding with reserved retired names
    if (tier === "base") {
      // V0.2 product: only three primaries. Drop custom bases from registry.
      continue;
    }
    registry[name] = { tier: "modifier" };
  }
}

function finalizeRegistry(registry: TypeRegistry): void {
  // Ensure fixed primaries + built-in secondaries always present.
  for (const p of CANONICAL_PRIMARY_TYPES) {
    registry[p] = { tier: "base" };
  }
  for (const s of BUILTIN_SECONDARY_TYPES) {
    registry[s] = { tier: "modifier" };
  }
  // Never keep retired keys
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
