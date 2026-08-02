import { FsAdapter, withTentMutation } from "./adapter.js";
import { Node } from "./types.js";
import { loadTent } from "./tree.js";
import { loadTaskEnvelopes } from "./task.js";
import { envelopeIsActiveOccupation } from "./claim.js";
import { taskReferencedNodeIds } from "./task-node-refs.js";
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
  /**
   * Active task roles occupying referenced nodes (or related ancestor/descendant range).
   * Values are canonical Task assignee labels, not Node frontmatter ownership.
   */
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
  const nodes = [...tent.byId.values()];
  const referenced = nodes.filter((node) => {
    const { base, modifier } = splitType(node.type);
    return node.type === name || base === name || modifier === name;
  });
  const tasks = await loadTaskEnvelopes(fs);
  const ownerMap = new Map<string, { id: string; path: string; owner: string }>();

  const relatedIds = new Set<string>();
  for (const reference of referenced) {
    for (const node of relatedNodes(reference, nodes)) {
      relatedIds.add(node.id);
    }
  }

  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    // Direct Node refs only (cx-tsw53f). Workspace context is not a Tent-wide type lock.
    for (const nodeId of taskReferencedNodeIds(task)) {
      if (!relatedIds.has(nodeId)) continue;
      const node = tent.byId.get(nodeId);
      if (!node) continue;
      ownerMap.set(node.id, {
        id: node.id,
        path: node.path,
        owner: `${task.assigneeKind}:${task.assigneeId}`,
      });
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
    references: referenced.map(({ id, path, name: nodeName }) => ({ id, path, name: nodeName })),
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
    // Fail loud while any Node still uses the name as type, primary base, or secondary modifier.
    // Leaving refs would mark Nodes invalid on next load — not an acceptable silent path.
    if (inspection.references.length > 0) {
      throw new Error(
        `Type still in use by ${inspection.references.length} node(s); retype them first: ${inspection.references
          .map((x) => x.path)
          .join(", ")}.`
      );
    }
    if (inspection.activeOwners.length > 0) {
      throw new Error(
        `Referenced range still has an active task; cancel or fail first: ${inspection.activeOwners.map((x) => x.path).join(", ")}.`
      );
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

function relatedNodes(reference: Node, nodes: Node[]): Node[] {
  return nodes.filter((node) =>
    node.path === reference.path ||
    node.path.startsWith(reference.path + "/") ||
    reference.path.startsWith(node.path + "/")
  );
}
