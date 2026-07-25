// First-class semantic Node relations (V0.2 Canvas P0).
// Source Node frontmatter owns a `relations` array. No global relation DB.
// Markdown/wiki body links remain separate derived graph edges — never merged here.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import {
  BOX_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter.js";
import type { RandomSource } from "./id.js";
import { boxNotePath, isUsableBox, loadTent, type LoadedTent } from "./tree.js";
import type { Box, RelationDirection, RelationRecord, RelationTarget } from "./types.js";

/** Stable relation handle prefix (contract). Distinct domain from role ids despite shared `rl-` form. */
export const RELATION_ID_PREFIX = "rl-";

const REL_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type RelationErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "TARGET"
  | "ARCHIVED"
  | "INVALID"
  /** Raw source relations cannot all round-trip as canonical records; refuse mutation. */
  | "CORRUPT";

export class RelationError extends Error {
  code: RelationErrorCode;
  constructor(code: RelationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RelationError";
  }
}

/** Keys allowed on a durable relation frontmatter item (flat or nested-target form). */
const CANONICAL_RELATION_KEYS = new Set([
  "id",
  "kind",
  "direction",
  "label",
  "nodeId",
  "unresolved",
  "target",
]);

export type CreateRelationInput = {
  kind: string;
  direction: RelationDirection;
  label?: string;
  target: RelationTarget;
};

export type UpdateRelationInput = {
  kind?: string;
  direction?: RelationDirection;
  /** Pass null/empty to clear optional label. */
  label?: string | null;
  target?: RelationTarget;
};

export type RelationOutgoingView = RelationRecord;

/** Derived reverse view: relation is stored on `sourceId`, points at the listed node. */
export type RelationIncomingView = RelationRecord & {
  sourceId: string;
  sourcePath: string;
};

export type RelationListProjection = {
  nodeId: string;
  path: string;
  outgoing: RelationOutgoingView[];
  incoming: RelationIncomingView[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeRelationId(rand: RandomSource = Math.random, len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += REL_ALPHABET[Math.floor(rand() * REL_ALPHABET.length)];
  }
  return RELATION_ID_PREFIX + s;
}

export function makeUniqueRelationId(
  existing: Set<string>,
  rand: RandomSource = Math.random
): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeRelationId(rand);
    if (!existing.has(id)) return id;
  }
  return makeRelationId(rand, 12);
}

export function isRelationId(id: string): boolean {
  return id.startsWith(RELATION_ID_PREFIX) && id.length > RELATION_ID_PREFIX.length;
}

export function cloneRelation(record: RelationRecord): RelationRecord {
  const out: RelationRecord = {
    id: record.id,
    kind: record.kind,
    direction: record.direction,
    target:
      "nodeId" in record.target
        ? { nodeId: record.target.nodeId }
        : { unresolved: record.target.unresolved },
  };
  if (record.label !== undefined) out.label = record.label;
  return out;
}

/** Normalize one target: exactly one of nodeId | unresolved. */
export function normalizeRelationTarget(raw: unknown): RelationTarget {
  if (!isRecord(raw)) {
    throw new RelationError("INVALID_INPUT", "relation target must be an object");
  }
  const hasNodeId = Object.prototype.hasOwnProperty.call(raw, "nodeId");
  const hasUnresolved = Object.prototype.hasOwnProperty.call(raw, "unresolved");
  if (hasNodeId && hasUnresolved) {
    throw new RelationError(
      "INVALID_INPUT",
      "relation target must be exactly one of { nodeId } or { unresolved }"
    );
  }
  if (hasNodeId) {
    if (typeof raw.nodeId !== "string" || !raw.nodeId.trim()) {
      throw new RelationError("INVALID_INPUT", "relation target.nodeId must be a non-empty string");
    }
    return { nodeId: raw.nodeId.trim() };
  }
  if (hasUnresolved) {
    if (typeof raw.unresolved !== "string" || !raw.unresolved.trim()) {
      throw new RelationError(
        "INVALID_INPUT",
        "relation target.unresolved must be a non-empty string"
      );
    }
    return { unresolved: raw.unresolved.trim() };
  }
  throw new RelationError(
    "INVALID_INPUT",
    "relation target must be exactly one of { nodeId } or { unresolved }"
  );
}

export function normalizeRelationDirection(raw: unknown): RelationDirection {
  if (raw === "directed" || raw === "bidirectional") return raw;
  throw new RelationError(
    "INVALID_INPUT",
    'relation direction must be "directed" or "bidirectional"'
  );
}

export function normalizeRelationKind(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RelationError("INVALID_INPUT", "relation kind must be a non-empty string");
  }
  const kind = raw.trim();
  if (/[\r\n]/.test(kind)) {
    throw new RelationError("INVALID_INPUT", "relation kind cannot contain newlines");
  }
  return kind;
}

export function normalizeRelationLabel(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new RelationError("INVALID_INPUT", "relation label must be a string when present");
  }
  const label = raw.trim();
  return label.length > 0 ? label : undefined;
}

/**
 * Load-time / migration-safe parse of one frontmatter relation item.
 * Accepts nested `target` or flat `nodeId` / `unresolved` on the record.
 * Invalid items are skipped (return null) so a bad row does not poison the Node.
 */
export function parseRelationRecord(raw: unknown): RelationRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !isRelationId(raw.id)) return null;
  let kind: string;
  let direction: RelationDirection;
  let target: RelationTarget;
  let label: string | undefined;
  try {
    kind = normalizeRelationKind(raw.kind);
    direction = normalizeRelationDirection(raw.direction);
    label = normalizeRelationLabel(raw.label);
    if (isRecord(raw.target)) {
      target = normalizeRelationTarget(raw.target);
    } else if (
      Object.prototype.hasOwnProperty.call(raw, "nodeId") ||
      Object.prototype.hasOwnProperty.call(raw, "unresolved")
    ) {
      target = normalizeRelationTarget({
        ...(Object.prototype.hasOwnProperty.call(raw, "nodeId") ? { nodeId: raw.nodeId } : {}),
        ...(Object.prototype.hasOwnProperty.call(raw, "unresolved")
          ? { unresolved: raw.unresolved }
          : {}),
      });
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const out: RelationRecord = { id: raw.id, kind, direction, target };
  if (label !== undefined) out.label = label;
  return out;
}

/**
 * Load-time / read-projection normalize: drop corrupt rows; preserve first-seen id order.
 * Migration-tolerant — never fail load on a bad row.
 */
export function normalizeRelationsList(value: unknown): RelationRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RelationRecord[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = parseRelationRecord(item);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/**
 * Mutation durability gate: every raw relations array item must round-trip as a
 * valid canonical RelationRecord. Unrecognized / corrupt / future-format rows and
 * duplicate ids fail loud — no silent erase, no repair heuristics.
 *
 * Read projection continues to use normalizeRelationsList (tolerant).
 * Returns the full canonical list to use as the mutation base.
 */
export function assertRawRelationsCanonicalForMutation(value: unknown): RelationRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RelationError(
      "CORRUPT",
      "Source relations must be an array of canonical relation records"
    );
  }
  const out: RelationRecord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) {
      throw new RelationError(
        "CORRUPT",
        `Source relations[${i}] is not a canonical relation record`
      );
    }
    for (const key of Object.keys(item)) {
      if (!CANONICAL_RELATION_KEYS.has(key)) {
        throw new RelationError(
          "CORRUPT",
          `Source relations[${i}] has unrecognized field: ${key}`
        );
      }
    }
    if (isRecord(item.target)) {
      for (const key of Object.keys(item.target)) {
        if (key !== "nodeId" && key !== "unresolved") {
          throw new RelationError(
            "CORRUPT",
            `Source relations[${i}].target has unrecognized field: ${key}`
          );
        }
      }
    }
    const parsed = parseRelationRecord(item);
    if (!parsed) {
      throw new RelationError(
        "CORRUPT",
        `Source relations[${i}] is corrupt or non-canonical`
      );
    }
    if (seen.has(parsed.id)) {
      throw new RelationError(
        "CORRUPT",
        `Source relations contain duplicate id: ${parsed.id}`
      );
    }
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/**
 * Read identity-note raw relations and assert they are fully canonical for mutation.
 * Leaves disk untouched on failure (caller must not write after throw).
 */
export async function loadCanonicalRelationsForMutation(
  fs: FsAdapter,
  boxPath: string
): Promise<RelationRecord[]> {
  const notePath = boxNotePath(boxPath);
  const { data } = parseFrontmatter(await fs.readFile(notePath));
  return assertRawRelationsCanonicalForMutation(data.relations);
}

/** Persist shape: flat target fields (no nested target object) for honest minimal YAML. */
export function relationToFrontmatterItem(record: RelationRecord): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    direction: record.direction,
  };
  if (record.label !== undefined) item.label = record.label;
  if ("nodeId" in record.target) item.nodeId = record.target.nodeId;
  else item.unresolved = record.target.unresolved;
  return item;
}

export function relationsToFrontmatterValue(
  records: readonly RelationRecord[]
): Record<string, unknown>[] | undefined {
  if (records.length === 0) return undefined;
  return records.map(relationToFrontmatterItem);
}

function boxKeyOrder(existing: string[]): string[] {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}

async function writeBoxRelations(
  fs: FsAdapter,
  box: Box,
  relations: readonly RelationRecord[]
): Promise<void> {
  const path = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(path));
  const value = relationsToFrontmatterValue(relations);
  if (value === undefined) delete data.relations;
  else data.relations = value;
  await fs.writeFile(path, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}

function assertSourceMutable(box: Box): void {
  if (box.invalid) {
    throw new RelationError("INVALID", `Invalid boxes cannot own relations: ${box.path}`);
  }
  if (box.archived || box.mode === "archived") {
    throw new RelationError("ARCHIVED", `Archived boxes cannot own relations: ${box.path}`);
  }
}

/**
 * Resolved target must exist and be a usable (non-invalid, non-archived) Node.
 * Unresolved targets skip this check.
 */
export function assertResolvedTargetUsable(tent: LoadedTent, target: RelationTarget): void {
  if (!("nodeId" in target)) return;
  const targetBox = tent.byId.get(target.nodeId);
  if (!targetBox) {
    throw new RelationError("TARGET", `Relation target node not found: ${target.nodeId}`);
  }
  if (!isUsableBox(targetBox)) {
    throw new RelationError(
      "TARGET",
      `Relation target is not a usable Node: ${target.nodeId}`
    );
  }
}

export function listRelationsForNode(tent: LoadedTent, nodeId: string): RelationListProjection {
  const box = tent.byId.get(nodeId);
  if (!box) throw new RelationError("NOT_FOUND", `Concept not found: ${nodeId}`);

  const outgoing = box.relations.map(cloneRelation);
  const incoming: RelationIncomingView[] = [];
  for (const other of tent.byId.values()) {
    for (const rel of other.relations) {
      if (!("nodeId" in rel.target)) continue;
      if (rel.target.nodeId !== nodeId) continue;
      // Do not mirror a node's own outgoing as incoming.
      if (other.id === nodeId) continue;
      incoming.push({
        ...cloneRelation(rel),
        sourceId: other.id,
        sourcePath: other.path,
      });
    }
  }
  // Stable order: source path then relation id.
  incoming.sort((a, b) => {
    const byPath = a.sourcePath.localeCompare(b.sourcePath);
    if (byPath !== 0) return byPath;
    return a.id.localeCompare(b.id);
  });

  return {
    nodeId: box.id,
    path: box.path,
    outgoing,
    incoming,
  };
}

export async function createRelation(
  fs: FsAdapter,
  sourceId: string,
  input: CreateRelationInput,
  rand: RandomSource = Math.random,
  loadedTent?: LoadedTent
): Promise<RelationRecord> {
  return withTentMutation(fs, async () => {
    const tent = loadedTent ?? (await loadTent(fs));
    const box = tent.byId.get(sourceId);
    if (!box) throw new RelationError("NOT_FOUND", `Concept not found: ${sourceId}`);
    assertSourceMutable(box);

    // Durability: refuse mutation if raw FM would lose unrecognized/corrupt rows.
    const base = await loadCanonicalRelationsForMutation(fs, box.path);

    const kind = normalizeRelationKind(input.kind);
    const direction = normalizeRelationDirection(input.direction);
    const label = normalizeRelationLabel(input.label);
    const target = normalizeRelationTarget(input.target);
    assertResolvedTargetUsable(tent, target);

    // Collect ids across the tent so relation ids stay unique in practice.
    const existing = new Set<string>();
    for (const b of tent.byId.values()) {
      for (const r of b.relations) existing.add(r.id);
    }
    for (const r of base) existing.add(r.id);
    const id = makeUniqueRelationId(existing, rand);
    const record: RelationRecord = { id, kind, direction, target };
    if (label !== undefined) record.label = label;

    const next = [...base.map(cloneRelation), record];
    await writeBoxRelations(fs, box, next);
    box.relations = next.map(cloneRelation);
    box.fm.relations = relationsToFrontmatterValue(next);
    return cloneRelation(record);
  });
}

export async function updateRelation(
  fs: FsAdapter,
  sourceId: string,
  relationId: string,
  patch: UpdateRelationInput,
  loadedTent?: LoadedTent
): Promise<RelationRecord> {
  return withTentMutation(fs, async () => {
    const tent = loadedTent ?? (await loadTent(fs));
    const box = tent.byId.get(sourceId);
    if (!box) throw new RelationError("NOT_FOUND", `Concept not found: ${sourceId}`);
    assertSourceMutable(box);

    const base = await loadCanonicalRelationsForMutation(fs, box.path);
    const idx = base.findIndex((r) => r.id === relationId);
    if (idx < 0) {
      throw new RelationError("NOT_FOUND", `Relation not found: ${relationId}`);
    }
    const current = cloneRelation(base[idx]!);

    if (patch.kind !== undefined) current.kind = normalizeRelationKind(patch.kind);
    if (patch.direction !== undefined) {
      current.direction = normalizeRelationDirection(patch.direction);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "label")) {
      const nextLabel = normalizeRelationLabel(patch.label);
      if (nextLabel === undefined) delete current.label;
      else current.label = nextLabel;
    }
    if (patch.target !== undefined) {
      current.target = normalizeRelationTarget(patch.target);
      assertResolvedTargetUsable(tent, current.target);
    }

    const next = base.map((r, i) => (i === idx ? current : cloneRelation(r)));
    await writeBoxRelations(fs, box, next);
    box.relations = next.map(cloneRelation);
    box.fm.relations = relationsToFrontmatterValue(next);
    return cloneRelation(current);
  });
}

export async function deleteRelation(
  fs: FsAdapter,
  sourceId: string,
  relationId: string,
  loadedTent?: LoadedTent
): Promise<{ deleted: string }> {
  return withTentMutation(fs, async () => {
    const tent = loadedTent ?? (await loadTent(fs));
    const box = tent.byId.get(sourceId);
    if (!box) throw new RelationError("NOT_FOUND", `Concept not found: ${sourceId}`);
    assertSourceMutable(box);

    const base = await loadCanonicalRelationsForMutation(fs, box.path);
    const idx = base.findIndex((r) => r.id === relationId);
    if (idx < 0) {
      throw new RelationError("NOT_FOUND", `Relation not found: ${relationId}`);
    }
    const next = base.filter((_, i) => i !== idx).map(cloneRelation);
    await writeBoxRelations(fs, box, next);
    box.relations = next.map(cloneRelation);
    const fmValue = relationsToFrontmatterValue(next);
    if (fmValue === undefined) delete box.fm.relations;
    else box.fm.relations = fmValue;
    return { deleted: relationId };
  });
}
