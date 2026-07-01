import { FsAdapter } from "./adapter.js";

export const TYPE_REGISTRY_PATH = ".tent/types.json";

export const TYPE_COLOR_PALETTE = ["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "brown"];

/** type 分层:base = 主类(决定基础 R/W);modifier = 修饰类(覆盖 base 的 R/W)。
 *  一个框的 type 是单个字符串,可为 "base" 或复合 "base-modifier"(如 goal-asset)。 */
export type TypeTier = "base" | "modifier";

interface TypeDefinitionMetadata {
  color?: string;
  description?: string;
}

export type TypeDefinition =
  | (TypeDefinitionMetadata & {
      /** base 必须明确两轴。缺省 tier 也按 base 处理。 */
      tier?: "base";
      readable: boolean;
      writable: boolean;
    })
  | (TypeDefinitionMetadata & {
      /** modifier 缺省的轴继承复合 type 的 base。 */
      tier: "modifier";
      readable?: boolean;
      writable?: boolean;
    });

export type TypeRegistry = Record<string, TypeDefinition>;

export const DEFAULT_TYPE_REGISTRY: TypeRegistry = {
  goal: {
    readable: true,
    writable: false,
    color: "blue",
    tier: "base",
    description: "定义目标、意图与验收方向",
  },
  prompt: {
    readable: true,
    writable: true,
    color: "purple",
    tier: "base",
    description: "提供任务说明与工作上下文",
  },
  output: {
    readable: true,
    writable: true,
    color: "cyan",
    tier: "base",
    description: "映射真实交付物与 workspace",
  },
  open: {
    readable: true,
    writable: true,
    color: "green",
    tier: "modifier",
    description: "仍在推进、可继续处理",
  },
  reference: {
    readable: true,
    color: "blue",
    tier: "modifier",
    description: "作为背景资料供查阅与引用",
  },
  asset: {
    writable: true,
    color: "purple",
    tier: "modifier",
    description: "作为实际产物或可复用资源",
  },
  sealed: {
    readable: false,
    writable: false,
    color: "red",
    tier: "modifier",
    description: "已封存，不再参与后续处理",
  },
};

/** 拆复合 type:"goal-asset" → {base:"goal", modifier:"asset"};"goal" → {base:"goal"}。
 *  按第一个 "-" 拆(内置名不含 "-")。 */
export function splitType(type: string): { base: string; modifier?: string } {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}

/** 组合 base + modifier 成单个 type 串。modifier 空则只返回 base。 */
export function joinType(base: string, modifier?: string): string {
  return modifier ? `${base}-${modifier}` : base;
}

/** type 是否可被注册表解析(精确命中,或 base[+modifier] 都在册)。 */
export function typeExists(type: string, registry: TypeRegistry): boolean {
  if (registry[type]) return true;
  const { base, modifier } = splitType(type);
  return !!(registry[base] && (modifier === undefined || !!registry[modifier]));
}

/** 解析复合 type 在某根轴上的 R/W:modifier 覆盖 base。精确命中的单 type 直接取其值。 */
export function resolveTypeAxis(
  type: string,
  axis: "readable" | "writable",
  registry: TypeRegistry
): boolean | undefined {
  const exact = registry[type];
  if (exact) return exact[axis];
  const { base, modifier } = splitType(type);
  const baseVal = registry[base]?.[axis];
  const modVal = modifier ? registry[modifier]?.[axis] : undefined;
  return typeof modVal === "boolean" ? modVal : baseVal;
}

export async function loadTypeRegistry(fs: FsAdapter): Promise<TypeRegistry> {
  if (!(await fs.exists(TYPE_REGISTRY_PATH))) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs.readFile(TYPE_REGISTRY_PATH)) as unknown;
    return normalizeRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`types.json 损坏: ${detail}`);
  }
}

export function normalizeRegistry(value: unknown): TypeRegistry {
  const root = isRecord(value) ? value : {};
  const registry = cloneDefaults();

  // Legacy schema: { primary, secondary } → primary=base, secondary=modifier。
  if (isRecord(root.primary) || isRecord(root.secondary)) {
    mergeDefinitions(registry, root.primary, true, "base");
    mergeDefinitions(registry, root.secondary, false, "modifier");
    return registry;
  }

  mergeDefinitions(registry, root);
  return registry;
}

function mergeDefinitions(
  registry: TypeRegistry,
  source: unknown,
  legacyBase = false,
  defaultTier?: TypeTier
): void {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;
    const current = registry[name];
    const tier: TypeTier | undefined =
      raw.tier === "base" || raw.tier === "modifier" ? raw.tier : current?.tier ?? defaultTier;
    const resolvedTier = tier ?? "base";
    const readable = typeof raw.readable === "boolean" ? raw.readable : undefined;
    const writable = typeof raw.writable === "boolean" ? raw.writable : undefined;
    if ((legacyBase || resolvedTier === "base") && (readable === undefined || writable === undefined)) continue;
    const metadata = {
      ...(typeof raw.color === "string" && raw.color
        ? { color: raw.color }
        : current?.color
          ? { color: current.color }
          : {}),
      ...(typeof raw.description === "string" && raw.description
        ? { description: raw.description }
        : current?.description
          ? { description: current.description }
          : {}),
    };
    registry[name] = resolvedTier === "modifier"
      ? {
          tier: "modifier",
          ...(readable !== undefined ? { readable } : {}),
          ...(writable !== undefined ? { writable } : {}),
          ...metadata,
        }
      : { tier: "base", readable: readable!, writable: writable!, ...metadata };
  }
}

function cloneDefaults(): TypeRegistry {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
