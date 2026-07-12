import { FsAdapter } from "./adapter.js";
import { TYPE_REGISTRY_PATH } from "./paths.js";

export { TYPE_REGISTRY_PATH };

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
      /**
       * 是否可承载协作生命周期（status / task occupation / delivery projection）。
       * 默认 false；compound type 跟随 base，modifier 不可单独配置。
       */
      coordination?: boolean;
      /**
       * @deprecated 运行时已退役；normalize/load 忽略。仅保留类型形状以免旧插件编译面瞬间断裂。
       */
      workspacePointer?: boolean;
    })
  | (TypeDefinitionMetadata & {
      /** modifier 缺省的轴继承复合 type 的 base。 */
      tier: "modifier";
      readable?: boolean;
      writable?: boolean;
    });

export type TypeRegistry = Record<string, TypeDefinition>;

/**
 * 内置默认 type 注册表。
 * - note: 普通 concept，coordination=false
 * - goal / prompt / artifact: 默认可作 box（coordination=true）
 * - artifact: 替代旧 output；不再携带 workspacePointer 运行时语义
 */
export const DEFAULT_TYPE_REGISTRY: TypeRegistry = {
  note: {
    readable: true,
    writable: true,
    color: "gray",
    tier: "base",
    coordination: false,
    description: "普通笔记 concept，默认不进入协作生命周期",
  },
  goal: {
    readable: true,
    writable: false,
    color: "blue",
    tier: "base",
    coordination: true,
    description: "定义目标、意图与验收方向",
  },
  prompt: {
    readable: true,
    writable: true,
    color: "purple",
    tier: "base",
    coordination: true,
    description: "提供任务说明与工作上下文",
  },
  artifact: {
    readable: true,
    writable: true,
    color: "cyan",
    tier: "base",
    coordination: true,
    description: "映射真实交付物与 ArtifactRef 关联",
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

/**
 * 迁移窗口：落盘 type 名 `output` 解析时映射到 canonical `artifact`。
 * 新写入应只使用 artifact；长期双 type 产品语义不保留。
 */
export function canonicalTypeName(type: string): string {
  if (type === "output") return "artifact";
  if (type.startsWith("output-")) return "artifact" + type.slice("output".length);
  return type;
}

/** type 是否可被注册表解析(精确命中,或 base[+modifier] 都在册)。 */
export function typeExists(type: string, registry: TypeRegistry): boolean {
  const canonical = canonicalTypeName(type);
  if (registry[canonical] || registry[type]) return true;
  const { base, modifier } = splitType(canonical);
  return !!(registry[base] && (modifier === undefined || !!registry[modifier]));
}

/** 解析复合 type 在某根轴上的 R/W:modifier 覆盖 base。精确命中的单 type 直接取其值。 */
export function resolveTypeAxis(
  type: string,
  axis: "readable" | "writable",
  registry: TypeRegistry
): boolean | undefined {
  const canonical = canonicalTypeName(type);
  const exact = registry[canonical] ?? registry[type];
  if (exact) return exact[axis];
  const { base, modifier } = splitType(canonical);
  const baseVal = registry[base]?.[axis];
  const modVal = modifier ? registry[modifier]?.[axis] : undefined;
  return typeof modVal === "boolean" ? modVal : baseVal;
}

/**
 * 框/concept 的一级 type 是否开启 coordination（可作 box）。
 * 永远读注册表 capability，禁止按 type 名称硬编码。
 */
export function typeHasCoordination(type: string, registry: TypeRegistry): boolean {
  const canonical = canonicalTypeName(type);
  const { base } = splitType(canonical);
  return baseDefinitionCoordination(registry[base] ?? registry[canonical] ?? registry[type]) === true;
}

/** 读取一级 type 定义上的 coordination；modifier 恒为 undefined。 */
export function baseDefinitionCoordination(definition: TypeDefinition | undefined): boolean | undefined {
  if (!definition || definition.tier === "modifier") return undefined;
  return definition.coordination;
}

/** 写入一级 type 的 coordination；modifier 抛错。 */
export function setBaseCoordination(definition: TypeDefinition, value: boolean): void {
  if (definition.tier === "modifier") {
    throw new Error("Modifier types cannot configure coordination capability.");
  }
  definition.coordination = value;
}

/**
 * @deprecated workspacePointer 运行时语义已退役；保留空实现兼容旧调用点编译，恒为 false。
 * 新代码请使用 in-workspace `.tent` 布局与 WorkspaceLane，不要再依赖 type 轴。
 */
export function typeAllowsWorkspacePointer(_type: string, _registry: TypeRegistry): boolean {
  void _type;
  void _registry;
  return false;
}

/** @deprecated 见 typeAllowsWorkspacePointer。 */
export function baseDefinitionWorkspacePointer(_definition: TypeDefinition | undefined): boolean | undefined {
  void _definition;
  return undefined;
}

/** @deprecated 见 setBaseCoordination；workspacePointer 不再可写。 */
export function setBaseWorkspacePointer(_definition: TypeDefinition, _value: boolean): void {
  void _definition;
  void _value;
  throw new Error(
    "workspacePointer capability is retired; use in-workspace .tent layout and WorkspaceLane on tasks."
  );
}

/** 新布局 types.json；迁移窗口兼容嵌套 .tent/types.json。 */
const TYPE_REGISTRY_CANDIDATES = [TYPE_REGISTRY_PATH, `.tent/${TYPE_REGISTRY_PATH}`];

export async function loadTypeRegistry(fs: FsAdapter): Promise<TypeRegistry> {
  for (const candidate of TYPE_REGISTRY_CANDIDATES) {
    if (!(await fs.exists(candidate))) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(candidate)) as unknown;
      return normalizeRegistry(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`types.json is corrupt: ${detail}.`);
    }
  }
  return cloneDefaults();
}

export function normalizeRegistry(value: unknown): TypeRegistry {
  const root = isRecord(value) ? value : {};
  const registry = cloneDefaults();

  // Legacy schema: { primary, secondary } → primary=base, secondary=modifier。
  if (isRecord(root.primary) || isRecord(root.secondary)) {
    mergeDefinitions(registry, root.primary, true, "base");
    mergeDefinitions(registry, root.secondary, false, "modifier");
    applyLegacyOutputAlias(registry);
    return registry;
  }

  mergeDefinitions(registry, root);
  applyLegacyOutputAlias(registry);
  return registry;
}

/**
 * 一次性兼容：磁盘上仍写 `output` 时映射为 `artifact` 的定义字段，
 * 不保留长期双 type 产品语义；迁移函数会把落盘名改成 artifact。
 */
function applyLegacyOutputAlias(registry: TypeRegistry): void {
  if (registry.output && !isRecord(registry.output)) return;
  if (registry.output) {
    const out = registry.output;
    if (out.tier !== "modifier") {
      // 若用户未显式写 artifact，用 output 定义填充 artifact 缺省轴
      const artifact = registry.artifact;
      if (artifact && artifact.tier !== "modifier") {
        if (typeof out.readable === "boolean") artifact.readable = out.readable;
        if (typeof out.writable === "boolean") artifact.writable = out.writable;
        if (typeof out.coordination === "boolean") artifact.coordination = out.coordination;
        else if (out.coordination === undefined) artifact.coordination = true;
        if (out.color) artifact.color = out.color;
        if (out.description) artifact.description = out.description;
      }
    }
  }
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
    if (resolvedTier === "modifier") {
      registry[name] = {
        tier: "modifier",
        ...(readable !== undefined ? { readable } : {}),
        ...(writable !== undefined ? { writable } : {}),
        ...metadata,
      };
      continue;
    }
    const coordination = resolveCoordinationFlag(name, raw, current);
    const entry: TypeDefinition = {
      tier: "base",
      readable: readable!,
      writable: writable!,
      ...metadata,
      ...(coordination !== undefined ? { coordination } : {}),
    };
    // 永不把 workspacePointer 带入运行时注册表
    delete (entry as { workspacePointer?: boolean }).workspacePointer;
    registry[name] = entry;
  }
}

/**
 * 解析一级 type 的 coordination。
 * - 显式 boolean 优先；
 * - 旧 types.json 无字段：内置倾向 goal/prompt/artifact/output → true，note → false。
 * - 忽略遗留 workspacePointer 字段（不读入运行时）。
 */
function resolveCoordinationFlag(
  name: string,
  raw: Record<string, unknown>,
  current: TypeDefinition | undefined
): boolean | undefined {
  if (typeof raw.coordination === "boolean") return raw.coordination;
  if (current && current.tier !== "modifier" && typeof current.coordination === "boolean") {
    return current.coordination;
  }
  if (name === "note") return false;
  if (name === "goal" || name === "prompt" || name === "artifact" || name === "output") return true;
  return undefined;
}

function cloneDefaults(): TypeRegistry {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
