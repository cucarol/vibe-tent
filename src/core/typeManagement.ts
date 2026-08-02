import { FsAdapter, withTentMutation } from "./adapter.js";
import { NODE_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { Node } from "./types.js";
import { loadTent, nodeNotePath } from "./tree.js";
import { loadTaskEnvelopes, taskExecutionLabel } from "./task.js";
import { envelopeIsActiveOccupation } from "./claim.js";
import { taskReferencedNodeIds } from "./task-node-refs.js";
import {
  BUILTIN_SECONDARY_TYPES,
  CANONICAL_PRIMARY_TYPES,
  DEFAULT_TYPE_REGISTRY,
  isCanonicalPrimary,
  joinType,
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

/**
 * Create a user-configured secondary marker (modifier).
 * Primaries are fixed to goal|prompt|output — never creatable.
 * Rename is not supported in V0.2 (identifiers are immutable).
 */
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

/** Create a custom secondary marker. Alias of createType({ tier: "modifier" }). */
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
  const referenced = nodes.filter((node) => nodeReferencesTypeName(node, name));
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
        owner: taskExecutionLabel(task),
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

/**
 * Delete a custom secondary marker.
 * Nodes that use it as `primary-marker` are rewritten atomically to the primary
 * type before the registry entry is removed. Bare-marker Node types cannot be
 * auto-rewritten and fail loud. Rename is not supported.
 */
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
      throw new Error(
        `Referenced range still has an active task; cancel or fail first: ${inspection.activeOwners.map((x) => x.path).join(", ")}.`
      );
    }

    // Atomic rewrite: every compound primary-marker → primary before registry drop.
    const tent = await loadTent(fs);
    const rewrites: NodeTypeRewrite[] = [];
    for (const node of tent.byId.values()) {
      const nextType = retypeAfterMarkerRemoval(node.type, name);
      if (nextType === null) {
        throw new Error(
          `Cannot delete marker ${name}: node ${node.path} uses bare marker as type; ` +
            `retype to goal|prompt|output[-marker] first.`
        );
      }
      if (nextType === node.type) continue;
      rewrites.push(await prepareNodeTypeRewrite(fs, node, nextType));
    }

    const registry = await loadTypeRegistry(fs);
    const registryRaw = await fs.readFile(TYPE_REGISTRY_PATH);
    delete registry[name];
    const changed: NodeTypeRewrite[] = [];
    let registryWriteAttempted = false;
    try {
      for (const rewrite of rewrites) {
        await fs.writeFile(rewrite.path, rewrite.nextRaw);
        changed.push(rewrite);
      }
      registryWriteAttempted = true;
      await writeTypeRegistryUnlocked(fs, registry);
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (registryWriteAttempted) {
        try {
          await fs.writeFile(TYPE_REGISTRY_PATH, registryRaw);
        } catch (rollbackError) {
          rollbackErrors.push(`registry: ${errorMessage(rollbackError)}`);
        }
      }
      for (const rewrite of changed.reverse()) {
        try {
          await fs.writeFile(rewrite.path, rewrite.previousRaw);
        } catch (rollbackError) {
          rollbackErrors.push(`${rewrite.path}: ${errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Type marker deletion failed (${errorMessage(error)}) and rollback failed: ${rollbackErrors.join("; ")}`
        );
      }
      throw error;
    }

    return { ...inspection, exists: false, references: [], activeOwners: [] };
  });
}

/**
 * Compute the Node type after removing a marker name.
 * - `primary-marker` → `primary`
 * - bare `marker` → null (cannot derive primary; caller must fail loud)
 * - unrelated → unchanged
 */
export function retypeAfterMarkerRemoval(type: string, markerName: string): string | null {
  if (type === markerName) return null;
  const { base, modifier } = splitType(type);
  if (modifier === markerName) return joinType(base);
  if (base === markerName && modifier !== undefined) {
    // Marker name colliding as primary base of a compound — not a supported shape.
    return null;
  }
  return type;
}

type NodeTypeRewrite = {
  path: string;
  previousRaw: string;
  nextRaw: string;
};

async function prepareNodeTypeRewrite(
  fs: FsAdapter,
  node: Node,
  nextType: string
): Promise<NodeTypeRewrite> {
  const boxFile = nodeNotePath(node.path);
  const raw = await fs.readFile(boxFile);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.type = nextType;
  return {
    path: boxFile,
    previousRaw: raw,
    nextRaw: serializeFrontmatter(
      data,
      body,
      keyOrder.length ? keyOrder : NODE_FRONTMATTER_KEY_ORDER
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeTypeRegistryUnlocked(fs: FsAdapter, registry: TypeRegistry): Promise<void> {
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

function nodeReferencesTypeName(node: Node, name: string): boolean {
  const { base, modifier } = splitType(node.type);
  return node.type === name || base === name || modifier === name;
}

function relatedNodes(reference: Node, nodes: Node[]): Node[] {
  return nodes.filter(
    (node) =>
      node.path === reference.path ||
      node.path.startsWith(reference.path + "/") ||
      reference.path.startsWith(node.path + "/")
  );
}
