import { FsAdapter, withTentMutation } from "./adapter.js";
import { Box } from "./types.js";
import { boxNotePath, loadTent } from "./tree.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  DEFAULT_TYPE_REGISTRY,
  TYPE_COLOR_PALETTE,
  loadTypeRegistry,
  TypeDefinition,
  TYPE_REGISTRY_PATH,
  TypeRegistry,
  joinType,
  splitType,
} from "./typeRegistry.js";

export type TypeLevel = "type";

export interface TypeMetadataPatch {
  color?: string;
  description?: string;
  readable?: boolean | "inherit";
  writable?: boolean | "inherit";
}

export interface TypeReference {
  id: string;
  path: string;
  name: string;
}

export interface TypeDeletionInspection {
  level: TypeLevel;
  name: string;
  builtIn: boolean;
  exists: boolean;
  references: TypeReference[];
  activeOwners: { id: string; path: string; owner: string }[];
}

export async function createType(
  fs: FsAdapter,
  name: string,
  definition: TypeDefinition
): Promise<void> {
  await withTentMutation(fs, async () => {
    assertTypeName(name);
    if (
      definition.tier !== "modifier" &&
      (typeof definition.readable !== "boolean" || typeof definition.writable !== "boolean")
    ) {
      throw new Error("Base type must specify readable and writable.");
    }
    const registry = await loadTypeRegistry(fs);
    if (registry[name]) throw new Error(`Type already exists: ${name}.`);
    registry[name] = withDefaultColor(registry, definition);
    await writeTypeRegistryUnlocked(fs, registry);
  });
}

// Backward-compatible exports for older callers/tests; both now create a first-class OKF type.
export const createPrimaryType = createType;
export async function createSecondaryType(
  fs: FsAdapter,
  name: string,
  definition: Partial<TypeDefinition>
): Promise<void> {
  await createType(fs, name, {
    tier: "modifier",
    ...(typeof definition.readable === "boolean" ? { readable: definition.readable } : {}),
    ...(typeof definition.writable === "boolean" ? { writable: definition.writable } : {}),
    color: definition.color,
    description: definition.description,
  });
}

export async function updateTypeMetadata(
  fs: FsAdapter,
  level: TypeLevel,
  name: string,
  patch: TypeMetadataPatch
): Promise<void> {
  await withTentMutation(fs, async () => {
    void level;
    assertTypeName(name);
    const registry = await loadTypeRegistry(fs);
    const current = registry[name];
    if (!current) throw new Error(`Type does not exist: ${name}.`);

    if (patch.color !== undefined) {
      const color = patch.color.trim();
      if (color) current.color = color;
      else delete current.color;
    }
    if (patch.description !== undefined) {
      const description = patch.description.trim();
      if (description) current.description = description;
      else delete current.description;
    }
    updateAxis(current, "readable", patch.readable);
    updateAxis(current, "writable", patch.writable);
    await writeTypeRegistryUnlocked(fs, registry);
  });
}

export async function inspectTypeDeletion(
  fs: FsAdapter,
  level: TypeLevel,
  name: string
): Promise<TypeDeletionInspection> {
  void level;
  const tent = await loadTent(fs);
  const registry = tent.typeRegistry;
  const boxes = [...tent.byId.values()];
  const referenced = boxes.filter((box) => {
    const { base, modifier } = splitType(box.type);
    return box.type === name || base === name || modifier === name;
  });
  const ownerMap = new Map<string, { id: string; path: string; owner: string }>();

  for (const reference of referenced) {
    for (const box of relatedBoxes(reference, boxes)) {
      if (!box.fm.owner) continue;
      ownerMap.set(box.id, { id: box.id, path: box.path, owner: box.fm.owner });
    }
  }

  return {
    level: "type",
    name,
    builtIn: name in DEFAULT_TYPE_REGISTRY,
    exists: name in registry,
    references: referenced.map(({ id, path, name: boxName }) => ({ id, path, name: boxName })),
    activeOwners: [...ownerMap.values()],
  };
}

export async function deleteCustomType(
  fs: FsAdapter,
  level: TypeLevel,
  name: string,
  confirmation: string
): Promise<TypeDeletionInspection> {
  return withTentMutation(fs, async () => {
    if (confirmation !== name) throw new Error(`Confirmation mismatch; enter the type name ${name}.`);
    const inspection = await inspectTypeDeletion(fs, level, name);
    if (!inspection.exists) throw new Error(`Type does not exist: ${name}.`);
    if (inspection.builtIn) throw new Error(`Built-in types cannot be deleted: ${name}.`);
    if (inspection.activeOwners.length > 0) {
      throw new Error(`Referenced range still has an owner; stamp or force-release first: ${inspection.activeOwners.map((x) => x.path).join(", ")}.`);
    }
    const registry = await loadTypeRegistry(fs);
    delete registry[name];
    await writeTypeRegistryUnlocked(fs, registry);
    return inspection;
  });
}

export async function migrateKindToType(fs: FsAdapter): Promise<string[]> {
  return withTentMutation(fs, async () => {
    const tent = await loadTent(fs);
    const touched: string[] = [];
    for (const box of tent.byPath.values()) {
      const kind = typeof box.fm.kind === "string" ? box.fm.kind.trim() : "";
      if (!kind) continue;
      const path = boxNotePath(box.path);
      const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(path));
      const base = typeof data.type === "string" && data.type.trim() ? data.type.trim() : "custom";
      data.type = joinType(base, kind);
      delete data.kind;
      await fs.writeFile(path, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
      touched.push(path);
    }
    if (touched.length === 0) return touched;
    const registry = await loadTypeRegistry(fs);
    await writeTypeRegistryUnlocked(fs, registry);
    touched.push(TYPE_REGISTRY_PATH);
    return touched;
  });
}

async function writeTypeRegistryUnlocked(fs: FsAdapter, registry: TypeRegistry): Promise<void> {
  if (!(await fs.exists(".tent"))) await fs.mkdir(".tent");
  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function assertTypeName(name: string): void {
  if (!name.trim()) throw new Error("Type name cannot be empty.");
  if (name === "temp") throw new Error("temp/ is a system pipeline and cannot be used as a type.");
}

function updateAxis(
  definition: TypeDefinition,
  axis: "readable" | "writable",
  value: boolean | "inherit" | undefined
): void {
  if (value === undefined) return;
  if (value === "inherit") {
    if (definition.tier !== "modifier") throw new Error("Base types cannot inherit readable/writable settings.");
    delete definition[axis];
    return;
  }
  definition[axis] = value;
}

function relatedBoxes(reference: Box, boxes: Box[]): Box[] {
  return boxes.filter((box) =>
    box.path === reference.path ||
    box.path.startsWith(reference.path + "/") ||
    reference.path.startsWith(box.path + "/")
  );
}

function withDefaultColor<T extends { color?: string }>(registry: TypeRegistry, definition: T): T {
  const color = definition.color?.trim();
  if (color) return { ...definition, color };
  const used = Object.keys(registry).length;
  return { ...definition, color: TYPE_COLOR_PALETTE[used % TYPE_COLOR_PALETTE.length] };
}

function boxKeyOrder(existing: string[]): string[] {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}
