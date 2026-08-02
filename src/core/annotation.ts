// First-class Node Markdown underline annotations (划线注释).
// Independent of Markdown body markers, Node frontmatter attributes, and Task.
// Persistence lives under system root; projection relocates by quote without
// rewriting stored anchors or document text.

import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import type { RandomSource } from "./id.js";
import { ANNOTATIONS_PATH } from "./paths.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";

/** Stable annotation handle prefix (contract). */
export const ANNOTATION_ID_PREFIX = "an-";

// Same alphabet as Node/Role ids (id.ts) — avoid exporting private helpers.
const AN_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type AnnotationStatus = "open" | "resolved";

/** Projection-only anchor state — never silently rewritten into the store. */
export type AnnotationAnchorState = "anchored" | "relocated" | "orphan";

export type AnnotationOrphanReason = "quote-mismatch" | "ambiguous" | "missing-node";

export interface AnnotationRecord {
  id: string;
  nodeId: string;
  quote: string;
  /** Inclusive-exclusive offsets into the Node Markdown body at create time. */
  start: number;
  end: number;
  /** Document etag (docs.readForEdit style) captured at create. */
  documentEtag: string;
  /** Comment body (plain text). */
  body: string;
  author: "user";
  status: AnnotationStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/** List/read projection: stored record + live relocate outcome. */
export interface AnnotationProjection extends AnnotationRecord {
  anchorState: AnnotationAnchorState;
  orphanReason?: AnnotationOrphanReason;
  /** Effective offsets when anchored or relocated. */
  currentStart?: number;
  currentEnd?: number;
}

export type AnnotationFile = {
  annotations: AnnotationRecord[];
};

export type CreateAnnotationInput = {
  nodeId: string;
  quote: string;
  start: number;
  end: number;
  documentEtag: string;
  body: string;
  /** Authoritative Node Markdown body (not full raw with frontmatter). */
  documentBody: string;
};

export class AnnotationError extends Error {
  code:
    | "INVALID_INPUT"
    | "RANGE"
    | "QUOTE_MISMATCH"
    | "NOT_FOUND"
    | "INVALID_STATUS";
  constructor(
    code: AnnotationError["code"],
    message: string
  ) {
    super(message);
    this.code = code;
    this.name = "AnnotationError";
  }
}

const ANNOTATION_STATUSES = new Set<AnnotationStatus>(["open", "resolved"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function cloneRecord(item: AnnotationRecord): AnnotationRecord {
  return { ...item };
}

function defaultClock(): Clock {
  return { now: () => new Date().toISOString() };
}

/** Random an- id (same alphabet family as Node/Role ids). */
export function makeAnnotationId(rand: RandomSource = Math.random, len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += AN_ALPHABET[Math.floor(rand() * AN_ALPHABET.length)];
  }
  return ANNOTATION_ID_PREFIX + s;
}

export function makeUniqueAnnotationId(
  existing: Set<string>,
  rand: RandomSource = Math.random
): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeAnnotationId(rand);
    if (!existing.has(id)) return id;
  }
  return makeAnnotationId(rand, 12);
}

export function isAnnotationId(id: string): boolean {
  return id.startsWith(ANNOTATION_ID_PREFIX) && id.length > ANNOTATION_ID_PREFIX.length;
}

/**
 * Validate create-time anchor against authoritative body.
 * Offsets are UTF-16 code unit indices (JS string), half-open [start, end).
 */
export function validateAnnotationAnchor(
  documentBody: string,
  quote: string,
  start: number,
  end: number
): void {
  if (typeof quote !== "string" || quote.length === 0) {
    throw new AnnotationError("INVALID_INPUT", "quote must be a non-empty string");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new AnnotationError("RANGE", "start/end must be integers");
  }
  if (start < 0 || end < 0 || start > end) {
    throw new AnnotationError("RANGE", "start/end out of order or negative");
  }
  if (end > documentBody.length) {
    throw new AnnotationError("RANGE", "annotation range exceeds document body");
  }
  const slice = documentBody.slice(start, end);
  if (slice !== quote) {
    throw new AnnotationError(
      "QUOTE_MISMATCH",
      "quote does not match document body at the given range"
    );
  }
}

/**
 * Find all start offsets of `quote` in `body` (non-overlapping sequential scan
 * that still reports overlapping occurrences via indexOf stepping by 1).
 */
export function findQuoteOccurrences(body: string, quote: string): number[] {
  if (!quote) return [];
  const hits: number[] = [];
  let from = 0;
  while (from <= body.length - quote.length) {
    const idx = body.indexOf(quote, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  return hits;
}

/**
 * Lightweight relocate for list/read projection.
 * - Original offsets still match → anchored
 * - Else unique quote hit, or unique nearest hit to original start → relocated
 * - No hit / distance tie (ambiguous) / missing node → orphan
 * Never mutates the stored record.
 */
export function projectAnnotation(
  record: AnnotationRecord,
  documentBody: string | null
): AnnotationProjection {
  const base = cloneRecord(record);
  if (documentBody === null) {
    return {
      ...base,
      anchorState: "orphan",
      orphanReason: "missing-node",
    };
  }

  const { quote, start, end } = record;
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= documentBody.length &&
    documentBody.slice(start, end) === quote
  ) {
    return {
      ...base,
      anchorState: "anchored",
      currentStart: start,
      currentEnd: end,
    };
  }

  const hits = findQuoteOccurrences(documentBody, quote);
  if (hits.length === 0) {
    return {
      ...base,
      anchorState: "orphan",
      orphanReason: "quote-mismatch",
    };
  }
  if (hits.length === 1) {
    const currentStart = hits[0]!;
    return {
      ...base,
      anchorState: "relocated",
      currentStart,
      currentEnd: currentStart + quote.length,
    };
  }

  // Multiple hits: unique nearest to original start wins; equal distance → ambiguous.
  let bestDist = Number.POSITIVE_INFINITY;
  let bestStarts: number[] = [];
  for (const hit of hits) {
    const dist = Math.abs(hit - start);
    if (dist < bestDist) {
      bestDist = dist;
      bestStarts = [hit];
    } else if (dist === bestDist) {
      bestStarts.push(hit);
    }
  }
  if (bestStarts.length !== 1) {
    return {
      ...base,
      anchorState: "orphan",
      orphanReason: "ambiguous",
    };
  }
  const currentStart = bestStarts[0]!;
  return {
    ...base,
    anchorState: "relocated",
    currentStart,
    currentEnd: currentStart + quote.length,
  };
}

function parseAnnotation(value: unknown): AnnotationRecord | null {
  if (!isRecord(value)) return null;
  const {
    id,
    nodeId,
    quote,
    start,
    end,
    documentEtag,
    body,
    author,
    status,
    createdAt,
    updatedAt,
    resolvedAt,
  } = value;
  if (
    !isRequiredString(id) ||
    !isAnnotationId(id) ||
    !isRequiredString(nodeId) ||
    !isRequiredString(quote) ||
    !isNonNegativeInt(start) ||
    !isNonNegativeInt(end) ||
    end < start ||
    !isRequiredString(documentEtag) ||
    typeof body !== "string" ||
    body.length === 0 ||
    author !== "user" ||
    typeof status !== "string" ||
    !ANNOTATION_STATUSES.has(status as AnnotationStatus) ||
    !isRequiredString(createdAt) ||
    !isRequiredString(updatedAt) ||
    !isValidDate(createdAt) ||
    !isValidDate(updatedAt) ||
    (resolvedAt !== undefined &&
      (typeof resolvedAt !== "string" || !isValidDate(resolvedAt)))
  ) {
    return null;
  }
  return {
    id,
    nodeId,
    quote,
    start,
    end,
    documentEtag,
    body,
    author: "user",
    status: status as AnnotationStatus,
    createdAt,
    updatedAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  };
}

function parseAnnotationFile(value: unknown): AnnotationFile | null {
  if (!isRecord(value) || !Array.isArray(value.annotations)) return null;
  const annotations: AnnotationRecord[] = [];
  for (const item of value.annotations) {
    const parsed = parseAnnotation(item);
    if (!parsed) return null;
    annotations.push(parsed);
  }
  return { annotations };
}

function emptyFile(): AnnotationFile {
  return { annotations: [] };
}

async function writeFileUnlocked(fs: FsAdapter, file: AnnotationFile): Promise<void> {
  const ordered = {
    annotations: file.annotations.map((a) => {
      const row: Record<string, unknown> = {
        id: a.id,
        nodeId: a.nodeId,
        quote: a.quote,
        start: a.start,
        end: a.end,
        documentEtag: a.documentEtag,
        body: a.body,
        author: a.author,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
      if (a.resolvedAt !== undefined) row.resolvedAt = a.resolvedAt;
      return row;
    }),
  };
  await fs.writeFile(ANNOTATIONS_PATH, JSON.stringify(ordered, null, 2) + "\n");
}

/**
 * Load `.tent/annotations.json` relative to system-root FsAdapter.
 * Missing → empty. Corrupt → backup + reset + warning (registry convention).
 */
export async function loadAnnotations(fs: FsAdapter): Promise<AnnotationFile> {
  if (!(await fs.exists(ANNOTATIONS_PATH))) {
    return emptyFile();
  }
  try {
    const parsed = JSON.parse(await fs.readFile(ANNOTATIONS_PATH)) as unknown;
    const file = parseAnnotationFile(parsed);
    if (!file) {
      throw new Error("invalid annotation file shape");
    }
    return {
      annotations: file.annotations.map(cloneRecord),
    };
  } catch {
    const backupPath = await backupCorruptRegistry(fs, ANNOTATIONS_PATH);
    const reset = emptyFile();
    await writeFileUnlocked(fs, reset);
    warnRegistryRecovered(
      ANNOTATIONS_PATH,
      backupPath,
      "reset",
      "IMPORTANT: annotations cannot be inferred; restore from the backup if needed."
    );
    return reset;
  }
}

export async function listAnnotationRecords(
  fs: FsAdapter,
  nodeId?: string
): Promise<AnnotationRecord[]> {
  const file = await loadAnnotations(fs);
  const rows = nodeId
    ? file.annotations.filter((a) => a.nodeId === nodeId)
    : file.annotations;
  return rows.map(cloneRecord);
}

export async function getAnnotationRecord(
  fs: FsAdapter,
  id: string
): Promise<AnnotationRecord | null> {
  const file = await loadAnnotations(fs);
  const found = file.annotations.find((a) => a.id === id);
  return found ? cloneRecord(found) : null;
}

/**
 * Create a validated annotation under mutation.lock.
 * Caller supplies authoritative documentBody + documentEtag (service checks etag).
 */
export async function createAnnotation(
  fs: FsAdapter,
  input: CreateAnnotationInput,
  opts?: { clock?: Clock; rand?: RandomSource }
): Promise<AnnotationRecord> {
  const clock = opts?.clock ?? defaultClock();
  const rand = opts?.rand ?? Math.random;

  if (!isRequiredString(input.nodeId)) {
    throw new AnnotationError("INVALID_INPUT", "nodeId is required");
  }
  if (!isRequiredString(input.documentEtag)) {
    throw new AnnotationError("INVALID_INPUT", "documentEtag is required");
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new AnnotationError("INVALID_INPUT", "body must be a non-empty string");
  }
  if (typeof input.quote !== "string" || input.quote.length === 0) {
    throw new AnnotationError("INVALID_INPUT", "quote must be a non-empty string");
  }

  validateAnnotationAnchor(input.documentBody, input.quote, input.start, input.end);

  return withTentMutation(fs, async () => {
    const file = await loadAnnotations(fs);
    const existing = new Set(file.annotations.map((a) => a.id));
    const now = clock.now();
    const record: AnnotationRecord = {
      id: makeUniqueAnnotationId(existing, rand),
      nodeId: input.nodeId,
      quote: input.quote,
      start: input.start,
      end: input.end,
      documentEtag: input.documentEtag,
      body: input.body.trim(),
      author: "user",
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    file.annotations.push(record);
    await writeFileUnlocked(fs, file);
    return cloneRecord(record);
  });
}

export async function resolveAnnotation(
  fs: FsAdapter,
  id: string,
  opts?: { clock?: Clock }
): Promise<AnnotationRecord> {
  const clock = opts?.clock ?? defaultClock();
  return withTentMutation(fs, async () => {
    const file = await loadAnnotations(fs);
    const idx = file.annotations.findIndex((a) => a.id === id);
    if (idx < 0) {
      throw new AnnotationError("NOT_FOUND", `Annotation not found: ${id}`);
    }
    const current = file.annotations[idx]!;
    if (current.status === "resolved") {
      return cloneRecord(current);
    }
    const now = clock.now();
    const next: AnnotationRecord = {
      ...current,
      status: "resolved",
      updatedAt: now,
      resolvedAt: now,
    };
    file.annotations[idx] = next;
    await writeFileUnlocked(fs, file);
    return cloneRecord(next);
  });
}

export async function reopenAnnotation(
  fs: FsAdapter,
  id: string,
  opts?: { clock?: Clock }
): Promise<AnnotationRecord> {
  const clock = opts?.clock ?? defaultClock();
  return withTentMutation(fs, async () => {
    const file = await loadAnnotations(fs);
    const idx = file.annotations.findIndex((a) => a.id === id);
    if (idx < 0) {
      throw new AnnotationError("NOT_FOUND", `Annotation not found: ${id}`);
    }
    const current = file.annotations[idx]!;
    if (current.status === "open") {
      // Drop resolvedAt if a corrupt row was open+resolvedAt.
      const cleaned: AnnotationRecord = {
        id: current.id,
        nodeId: current.nodeId,
        quote: current.quote,
        start: current.start,
        end: current.end,
        documentEtag: current.documentEtag,
        body: current.body,
        author: "user",
        status: "open",
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      };
      if (current.resolvedAt !== undefined) {
        file.annotations[idx] = cleaned;
        await writeFileUnlocked(fs, file);
      }
      return cloneRecord(file.annotations[idx]!);
    }
    const now = clock.now();
    const next: AnnotationRecord = {
      id: current.id,
      nodeId: current.nodeId,
      quote: current.quote,
      start: current.start,
      end: current.end,
      documentEtag: current.documentEtag,
      body: current.body,
      author: "user",
      status: "open",
      createdAt: current.createdAt,
      updatedAt: now,
    };
    file.annotations[idx] = next;
    await writeFileUnlocked(fs, file);
    return cloneRecord(next);
  });
}

export async function deleteAnnotation(
  fs: FsAdapter,
  id: string
): Promise<AnnotationRecord | null> {
  return withTentMutation(fs, async () => {
    const file = await loadAnnotations(fs);
    const idx = file.annotations.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const [removed] = file.annotations.splice(idx, 1);
    await writeFileUnlocked(fs, file);
    return removed ? cloneRecord(removed) : null;
  });
}
