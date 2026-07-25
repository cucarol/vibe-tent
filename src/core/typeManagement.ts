import { FsAdapter, withTentMutation } from "./adapter.js";
import { Box } from "./types.js";
import { loadTent } from "./tree.js";
import {
  BUILTIN_SECONDARY_TYPES,
  CANONICAL_PRIMARY_TYPES,
  DEFAULT_TYPE_REGISTRY,
  isCanonicalPrimary,
  loadTypeRegistry,
  TYPE_REGISTRY_PATH,
  TypeDefinition,
  TypeRegistry,
  splitType,
} from "./typeRegistry.js";

export type TypeLevel = "type";

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
    if (isCanonicalPrimary(name) || (CANONICAL_PRIMARY_TYPES as readonly string[]).includes(name)) {
      throw new Error(`Built-in primary types cannot be created: ${name}.`);
    }
    if ((BUILTIN_SECONDARY_TYPES as readonly string[]).includes(name)) {
      throw new Error(`Built-in secondary types already exist: ${name}.`);
    }
    if (definition.tier !== "modifier") {
      throw new Error("V0.2 only allows creating custom secondary (modifier) types; primaries are fixed.");
    }
    const registry = await loadTypeRegistry(fs);
    if (registry[name]) throw new Error(`Type already exists: ${name}.`);
    registry[name] = { tier: "modifier" };
    await writeTypeRegistryUnlocked(fs, registry);
  });
}

// Backward-compatible exports for older callers/tests.
export const createPrimaryType = async (
  fs: FsAdapter,
  name: string,
  _definition?: TypeDefinition
): Promise<void> => {
  void _definition;
  throw new Error(
    `Primary types are fixed to goal|prompt|output; cannot create primary type: ${name}.`
  );
};

export async function createSecondaryType(
  fs: FsAdapter,
  name: string,
  _definition?: Partial<TypeDefinition>
): Promise<void> {
  void _definition;
  await createType(fs, name, { tier: "modifier" });
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
      const owner = typeof box.fm.owner === "string" ? box.fm.owner : undefined;
      if (!owner) continue;
      ownerMap.set(box.id, { id: box.id, path: box.path, owner });
    }
  }

  const builtIn =
    name in DEFAULT_TYPE_REGISTRY ||
    isCanonicalPrimary(name) ||
    (BUILTIN_SECONDARY_TYPES as readonly string[]).includes(name);

  return {
    level: "type",
    name,
    builtIn,
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

async function writeTypeRegistryUnlocked(fs: FsAdapter, registry: TypeRegistry): Promise<void> {
  // Persist slim V0.2 registry only.
  const slim: TypeRegistry = {};
  for (const [name, def] of Object.entries(registry)) {
    slim[name] = { tier: def.tier === "modifier" ? "modifier" : "base" };
  }
  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(slim, null, 2) + "\n");
}

function assertTypeName(name: string): void {
  if (!name.trim()) throw new Error("Type name cannot be empty.");
  if (name === "temp") throw new Error("temp/ is a system pipeline and cannot be used as a type.");
  if (name.includes("-")) throw new Error("Type names cannot contain '-' (compound separator).");
}

function relatedBoxes(reference: Box, boxes: Box[]): Box[] {
  return boxes.filter((box) =>
    box.path === reference.path ||
    box.path.startsWith(reference.path + "/") ||
    reference.path.startsWith(box.path + "/")
  );
}
