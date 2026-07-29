// Task Context Card v1 + managed prompt assembly + Session reuse compatibility gate.
// Frozen by Node cx-5q6za6. No new lifecycle entity — projected via Task envelope /
// Session registry / manifest only.
//
// Canonical types (no parallel wire):
// - TaskActorRef / parseTaskActorRef from task-model (52a0da2 / tk-a2z8j1y2)
// - agentId / roster / skill compose from managed-skill-compose (52a0da2 / tk-3s598jtn)
// Stable-prefix omission is reachable only via decideStablePrefixInjection (Core gate).
// workspaceLane baseCommit/targetBranch/integrationAuthority are Task truth;
// Context Card executionLane is a derived dynamic projection only.

import { createHash } from "node:crypto";
import {
  assertParentReviewerEqual,
  parseTaskActorRef,
  resolveParentReviewerPair,
  TaskLifecycleError,
  type AssigneeKind,
  type TaskActorRef,
} from "./task-model.js";
import type { TaskEnvelope } from "./task.js";
import { taskAssigneeKind } from "./task.js";

/** Re-export canonical actor type — single authoritative wire (task-model). */
export type { TaskActorRef, TaskActorKind } from "./task-model.js";

/** Context Card schema version (prompt + wire). */
export const TASK_CONTEXT_CARD_SCHEMA_VERSION = "v1" as const;

/** contextGeneration prefix: cg-v1-<sha256 hex>. */
export const CONTEXT_GENERATION_VERSION = "v1" as const;

/** Stable bootstrap invariant — first bytes of every full managed prompt. */
export const MANAGED_BOOTSTRAP_INVARIANT =
  "Tent managed bootstrap invariant v1: Core is authoritative. " +
  "Fetch by durable id before answering. Never invent missing Context Card fields, " +
  "refs, parent/reviewer, or chat-memory continuity. Final report goes through Delivery only.";

/**
 * Git mutator for ordinary Task lanes. Always Local Service —
 * ordinary executors never hold integration authority.
 */
export const INTEGRATION_MUTATOR_SERVICE = "service" as const;

/** Assignee projected onto the card (role name or logical agentId). */
export type TaskContextCardAssignee = {
  kind: "role" | "agentId";
  id: string;
};

/** Durable pointer only — never a long body copy. */
export type TaskContextCardRef = {
  id: string;
  /** Optional human path / locator. */
  path?: string;
  /** Optional revision (git sha, etag, …). */
  revision?: string;
};

export type TaskContextCardRefs = {
  nodes: TaskContextCardRef[];
  tasks: TaskContextCardRef[];
  deliveries: TaskContextCardRef[];
  git: TaskContextCardRef[];
};

export type TaskContextCardScope = {
  include: string[];
  exclude: string[];
};

/**
 * Authoritative Task Context Card v1.
 * Carried on Task envelope frontmatter / projected into managed prompts.
 */
export type TaskContextCardV1 = {
  schemaVersion: typeof TASK_CONTEXT_CARD_SCHEMA_VERSION;
  objective: string;
  frozenDecisions: string[];
  scope: TaskContextCardScope;
  acceptance: string[];
  refs: TaskContextCardRefs;
  parentActor: TaskActorRef;
  reviewer: TaskActorRef;
  assignee: TaskContextCardAssignee;
  /** `cg-v1-<sha256>` of canonical stable prefix / compatibility inputs. */
  contextGeneration: string;
  /** Canonical digest of current card context + TaskInput/review delta. */
  taskDeltaDigest: string;
};

/** Inputs that produce contextGeneration (stable prefix / compatibility). */
export type ContextGenerationInputs = {
  /** Workspace identity string (mounted workspace id or absolute root). */
  workspaceIdentity: string;
  /** Authoritative AGENTS.md pointer and/or content digest. */
  agentsPointerDigest: string;
  /** Optional tent-role skill body digest (tk-3s598jtn). */
  tentRoleDigest?: string;
  /**
   * tent-role skill version marker (package/skill version string).
   * Body digest alone is not enough when version labels change without body edit.
   */
  tentRoleVersion?: string;
  /** Role prompt text (durable Role only). */
  rolePrompt?: string;
  /** Sorted authorized agentIds / profile ids for roster digest. */
  rosterAgentIds?: readonly string[];
  /** Optional tent-task skill body digest. */
  tentTaskDigest?: string;
  /** tent-task skill version marker. */
  tentTaskVersion?: string;
  /** Profile/adapter compatibility fingerprint (ids only — no secrets). */
  profileAdapterCompatibility?: string;
  /**
   * purpose / subKey for Session reuse identity (empty when unused).
   * Never taskId / objective / acceptance / Task delta.
   */
  purpose?: string;
  /**
   * Extra stable compatibility bytes (agent/profile purpose flags, …).
   * Must never include taskId, objective, acceptance, or current Task delta.
   */
  extraStable?: Record<string, string | number | boolean | null | undefined>;
};

/**
 * Forbidden dynamic keys that must never enter contextGeneration extraStable.
 * Production collectors strip these; pure compute still hashes whatever is passed,
 * so callers must not put Task-dynamic fields here.
 */
export const CONTEXT_GENERATION_FORBIDDEN_EXTRA_KEYS = [
  "taskId",
  "taskPath",
  "objective",
  "acceptance",
  "taskDeltaDigest",
  "userPrompt",
  "taskInputDelta",
  "checkpoint",
] as const;

/** Dynamic delta inputs (per Task / turn). */
export type TaskDeltaInputs = {
  card: Omit<TaskContextCardV1, "contextGeneration" | "taskDeltaDigest">;
  /** Formatted TaskInput / review-feedback blocks, if any. */
  taskInputDelta?: string;
  /** Optional Role Checkpoint tail. */
  checkpoint?: string;
  /** Near-field user prompt excerpt (already on envelope). */
  userPrompt?: string;
};

export type TaskContextCardErrorCode =
  | "MISSING_OBJECTIVE"
  | "MISSING_ACCEPTANCE"
  | "MISSING_PARENT_ACTOR"
  | "MISSING_REVIEWER"
  | "MISSING_ASSIGNEE"
  | "UNRESOLVED_REF"
  | "INVALID_ACTOR"
  | "INVALID_GENERATION"
  | "INVALID_CARD";

export class TaskContextCardError extends Error {
  code: TaskContextCardErrorCode;
  details?: Record<string, unknown>;
  constructor(
    code: TaskContextCardErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TaskContextCardError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Canonical digests
// ---------------------------------------------------------------------------

/** Deterministic JSON for hashing (sorted object keys, stable arrays). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

function sortForCanonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortForCanonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = sortForCanonical(v);
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Format `cg-v1-<sha256>`. */
export function formatContextGeneration(stableCanonicalBytes: string): string {
  return `cg-${CONTEXT_GENERATION_VERSION}-${sha256Hex(stableCanonicalBytes)}`;
}

export function isContextGenerationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^cg-v1-[a-f0-9]{64}$/.test(value)
  );
}

/**
 * Build contextGeneration from stable prefix / compatibility inputs.
 * Does not include per-Task objective, TaskInput, acceptance, taskId, or checkpoint.
 */
export function computeContextGeneration(inputs: ContextGenerationInputs): string {
  const roster = [...(inputs.rosterAgentIds ?? [])]
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const extraStable = sanitizeContextGenerationExtraStable(inputs.extraStable);
  const payload = {
    v: CONTEXT_GENERATION_VERSION,
    workspaceIdentity: inputs.workspaceIdentity.trim(),
    agentsPointerDigest: inputs.agentsPointerDigest.trim(),
    tentRoleDigest: inputs.tentRoleDigest?.trim() || "",
    tentRoleVersion: inputs.tentRoleVersion?.trim() || "",
    rolePrompt: inputs.rolePrompt?.trim() || "",
    roster,
    tentTaskDigest: inputs.tentTaskDigest?.trim() || "",
    tentTaskVersion: inputs.tentTaskVersion?.trim() || "",
    profileAdapterCompatibility: inputs.profileAdapterCompatibility?.trim() || "",
    purpose: inputs.purpose?.trim() || "",
    extraStable,
  };
  return formatContextGeneration(canonicalJson(payload));
}

/**
 * Strip Task-dynamic keys from extraStable so contextGeneration stays cache-stable
 * across Tasks that share workspace/Role/Skills/profile facts.
 */
export function sanitizeContextGenerationExtraStable(
  extra?: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!extra) return out;
  const forbidden = new Set<string>(
    CONTEXT_GENERATION_FORBIDDEN_EXTRA_KEYS.map((k) => k.toLowerCase())
  );
  for (const key of Object.keys(extra).sort((a, b) => a.localeCompare(b))) {
    if (forbidden.has(key.toLowerCase())) continue;
    const v = extra[key];
    if (v === undefined) continue;
    out[key] = v;
  }
  return out;
}

/**
 * Digest AGENTS.md body for contextGeneration (empty body → stable empty digest).
 * Pointer path is fixed (workspace-root AGENTS.md); content is the compatibility byte.
 */
export function agentsBodyCompatibilityDigest(agentsBody: string | undefined | null): string {
  return sha256Hex(typeof agentsBody === "string" ? agentsBody : "");
}

/**
 * Digest a skill body (+ optional version label) for contextGeneration.
 * Version alone changing without body still flips the digest when provided.
 */
export function skillBodyCompatibilityDigest(input: {
  body: string;
  version?: string;
  name?: string;
}): string {
  return sha256Hex(
    canonicalJson({
      name: input.name?.trim() || "",
      version: input.version?.trim() || "",
      body: input.body,
    })
  );
}

/**
 * Build real stable contextGeneration from collected workspace/Skill/Role/profile facts.
 * Callers supply already-loaded bodies — no I/O here. Never accepts taskId/objective.
 */
export function computeContextGenerationFromStableFacts(input: {
  workspaceIdentity: string;
  /** Raw AGENTS.md body (may be empty when file missing). */
  agentsBody?: string;
  /** Precomputed agents digest; wins over agentsBody when both set. */
  agentsPointerDigest?: string;
  tentRoleBody?: string;
  tentRoleVersion?: string;
  tentTaskBody?: string;
  tentTaskVersion?: string;
  rolePrompt?: string;
  rosterAgentIds?: readonly string[];
  profileId: string;
  adapterId: string;
  purpose?: string;
  /** Logical agentId or profile assignee label for extraStable only. */
  agentId?: string;
  assigneeKind?: AssigneeKind | string;
  capabilityFlags?: readonly string[];
  extraStable?: Record<string, string | number | boolean | null | undefined>;
}): string {
  const tentRoleDigest =
    input.tentRoleBody !== undefined
      ? skillBodyCompatibilityDigest({
          body: input.tentRoleBody,
          version: input.tentRoleVersion,
          name: "tent-role",
        })
      : "";
  const tentTaskDigest =
    input.tentTaskBody !== undefined
      ? skillBodyCompatibilityDigest({
          body: input.tentTaskBody,
          version: input.tentTaskVersion,
          name: "tent-task",
        })
      : "";
  return computeContextGeneration({
    workspaceIdentity: input.workspaceIdentity,
    agentsPointerDigest:
      input.agentsPointerDigest?.trim() ||
      agentsBodyCompatibilityDigest(input.agentsBody),
    tentRoleDigest: tentRoleDigest || undefined,
    tentRoleVersion: input.tentRoleVersion,
    rolePrompt: input.rolePrompt,
    rosterAgentIds: input.rosterAgentIds,
    tentTaskDigest: tentTaskDigest || undefined,
    tentTaskVersion: input.tentTaskVersion,
    profileAdapterCompatibility: profileAdapterCompatibilityDigest({
      profileId: input.profileId,
      adapterId: input.adapterId,
      capabilityFlags: input.capabilityFlags,
    }),
    purpose: input.purpose,
    extraStable: {
      ...(input.assigneeKind ? { assigneeKind: String(input.assigneeKind) } : {}),
      ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
      ...input.extraStable,
    },
  });
}

/**
 * Digest of current Context Card body + TaskInput/review delta (+ optional checkpoint).
 * Excludes contextGeneration itself to avoid circular self-hash.
 */
export function computeTaskDeltaDigest(inputs: TaskDeltaInputs): string {
  const { card, taskInputDelta, checkpoint, userPrompt } = inputs;
  const payload = {
    v: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    objective: card.objective,
    frozenDecisions: card.frozenDecisions,
    scope: card.scope,
    acceptance: card.acceptance,
    refs: card.refs,
    parentActor: card.parentActor,
    reviewer: card.reviewer,
    assignee: card.assignee,
    taskInputDelta: taskInputDelta?.trim() || "",
    checkpoint: checkpoint?.trim() || "",
    userPrompt: userPrompt?.trim() || "",
  };
  return sha256Hex(canonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Parse / validate / project
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Map canonical TaskLifecycleError into Context Card fail-loud codes. */
function parseActorRef(value: unknown, label: "parentActor" | "reviewer"): TaskActorRef {
  if (value === undefined || value === null) {
    throw new TaskContextCardError(
      label === "parentActor" ? "MISSING_PARENT_ACTOR" : "MISSING_REVIEWER",
      `Context Card requires ${label} { kind, id } (canonical TaskActorRef).`,
      { label, value }
    );
  }
  try {
    return parseTaskActorRef(value, label);
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      const code =
        err.code === "INVALID_ACTOR"
          ? "INVALID_ACTOR"
          : label === "parentActor"
            ? "MISSING_PARENT_ACTOR"
            : "MISSING_REVIEWER";
      throw new TaskContextCardError(code, err.message, { label, value });
    }
    throw err;
  }
}

function parseAssignee(value: unknown): TaskContextCardAssignee {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskContextCardError(
      "MISSING_ASSIGNEE",
      "Context Card requires assignee { kind: role|agentId, id }."
    );
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if ((kind !== "role" && kind !== "agentId") || !id) {
    throw new TaskContextCardError(
      "MISSING_ASSIGNEE",
      "Context Card assignee must be { kind: role|agentId, id: non-empty }."
    );
  }
  return { kind, id };
}

function parseRefList(value: unknown, bucket: string): TaskContextCardRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TaskContextCardError(
      "INVALID_CARD",
      `Context Card refs.${bucket} must be an array of durable pointers.`,
      { bucket, value }
    );
  }
  const out: TaskContextCardRef[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      const id = item.trim();
      if (!id) {
        throw new TaskContextCardError(
          "UNRESOLVED_REF",
          `Context Card refs.${bucket}[${i}] id is empty.`,
          { bucket, index: i }
        );
      }
      out.push({ id });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TaskContextCardError(
        "UNRESOLVED_REF",
        `Context Card refs.${bucket}[${i}] is not a durable pointer.`,
        { bucket, index: i, value: item }
      );
    }
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      throw new TaskContextCardError(
        "UNRESOLVED_REF",
        `Context Card refs.${bucket}[${i}] missing id.`,
        { bucket, index: i }
      );
    }
    const ref: TaskContextCardRef = { id };
    if (typeof raw.path === "string" && raw.path.trim()) ref.path = raw.path.trim();
    if (typeof raw.revision === "string" && raw.revision.trim()) {
      ref.revision = raw.revision.trim();
    }
    out.push(ref);
  }
  return out;
}

export type BuildTaskContextCardInput = {
  objective: string;
  frozenDecisions?: readonly string[];
  scope?: { include?: readonly string[]; exclude?: readonly string[] };
  acceptance: readonly string[];
  refs?: Partial<TaskContextCardRefs>;
  parentActor: TaskActorRef;
  reviewer: TaskActorRef;
  assignee: TaskContextCardAssignee;
  /** Precomputed or from computeContextGeneration. */
  contextGeneration: string;
  /** Optional precomputed delta digest; recomputed when omitted. */
  taskDeltaDigest?: string;
  taskInputDelta?: string;
  checkpoint?: string;
  userPrompt?: string;
};

/**
 * Build a complete Context Card v1. Fail-loud on missing required fields.
 * Never invents objective / acceptance / parent / reviewer from chat memory.
 */
export function buildTaskContextCard(input: BuildTaskContextCardInput): TaskContextCardV1 {
  const objective = input.objective?.trim() || "";
  if (!objective) {
    throw new TaskContextCardError(
      "MISSING_OBJECTIVE",
      "Context Card requires objective (fail-loud to parent; do not invent from chat memory)."
    );
  }
  const acceptance = asStringList([...(input.acceptance ?? [])]);
  if (acceptance.length === 0) {
    throw new TaskContextCardError(
      "MISSING_ACCEPTANCE",
      "Context Card requires at least one acceptance criterion (fail-loud to parent)."
    );
  }
  const parentActor = parseActorRef(input.parentActor, "parentActor");
  const reviewer = parseActorRef(input.reviewer, "reviewer");
  // Canonical V0.2: reviewer must equal parentActor (no arbitrary delegation).
  try {
    assertParentReviewerEqual(parentActor, reviewer);
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, {
        parentActor,
        reviewer,
      });
    }
    throw err;
  }
  const assignee = parseAssignee(input.assignee);
  if (!isContextGenerationId(input.contextGeneration)) {
    throw new TaskContextCardError(
      "INVALID_GENERATION",
      `contextGeneration must match cg-v1-<sha256>; got ${String(input.contextGeneration)}`
    );
  }

  const cardBody: Omit<TaskContextCardV1, "contextGeneration" | "taskDeltaDigest"> = {
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    objective,
    frozenDecisions: asStringList([...(input.frozenDecisions ?? [])]),
    scope: {
      include: asStringList([...(input.scope?.include ?? [])]),
      exclude: asStringList([...(input.scope?.exclude ?? [])]),
    },
    acceptance,
    refs: {
      nodes: parseRefList(input.refs?.nodes ?? [], "nodes"),
      tasks: parseRefList(input.refs?.tasks ?? [], "tasks"),
      deliveries: parseRefList(input.refs?.deliveries ?? [], "deliveries"),
      git: parseRefList(input.refs?.git ?? [], "git"),
    },
    parentActor,
    reviewer,
    assignee,
  };

  const taskDeltaDigest =
    input.taskDeltaDigest?.trim() ||
    computeTaskDeltaDigest({
      card: cardBody,
      taskInputDelta: input.taskInputDelta,
      checkpoint: input.checkpoint,
      userPrompt: input.userPrompt,
    });

  return {
    ...cardBody,
    contextGeneration: input.contextGeneration,
    taskDeltaDigest,
  };
}

/**
 * Parse a Context Card from Task envelope frontmatter / projection bag.
 * Fail-loud when required fields are missing or malformed.
 */
export function parseTaskContextCard(data: unknown): TaskContextCardV1 {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TaskContextCardError(
      "INVALID_CARD",
      "Context Card payload must be a plain object."
    );
  }
  const raw = data as Record<string, unknown>;
  const scopeRaw =
    raw.scope && typeof raw.scope === "object" && !Array.isArray(raw.scope)
      ? (raw.scope as Record<string, unknown>)
      : {};
  const refsRaw =
    raw.refs && typeof raw.refs === "object" && !Array.isArray(raw.refs)
      ? (raw.refs as Record<string, unknown>)
      : {};

  return buildTaskContextCard({
    objective: typeof raw.objective === "string" ? raw.objective : "",
    frozenDecisions: asStringList(raw.frozenDecisions),
    scope: {
      include: asStringList(scopeRaw.include ?? raw.scopeInclude),
      exclude: asStringList(scopeRaw.exclude ?? raw.scopeExclude),
    },
    acceptance: asStringList(raw.acceptance),
    refs: {
      nodes: parseRefList(refsRaw.nodes ?? raw.refsNodes, "nodes"),
      tasks: parseRefList(refsRaw.tasks ?? raw.refsTasks, "tasks"),
      deliveries: parseRefList(refsRaw.deliveries ?? raw.refsDeliveries, "deliveries"),
      git: parseRefList(refsRaw.git ?? raw.refsGit, "git"),
    },
    parentActor: raw.parentActor as TaskActorRef,
    reviewer: raw.reviewer as TaskActorRef,
    assignee: raw.assignee as TaskContextCardAssignee,
    contextGeneration:
      typeof raw.contextGeneration === "string" ? raw.contextGeneration : "",
    taskDeltaDigest:
      typeof raw.taskDeltaDigest === "string" ? raw.taskDeltaDigest : undefined,
  });
}

/**
 * Body fields that imply a full Context Card v1 (not generation-only mirrors).
 * Used to distinguish legacy envelopes from partial cards (must fail loud).
 */
export function hasTaskContextCardBodyFields(data: Record<string, unknown>): boolean {
  // parentActor / reviewer are canonical Task wire and do NOT alone imply a Context Card.
  const keys = [
    "objective",
    "frozenDecisions",
    "acceptance",
    "scope",
    "scopeInclude",
    "scopeExclude",
    "refs",
    "refsNodes",
    "refsTasks",
    "refsDeliveries",
    "refsGit",
    "assignee",
    "contextCard",
  ];
  return keys.some((k) => data[k] !== undefined && data[k] !== null);
}

/** @deprecated Use hasTaskContextCardBodyFields; generation-only is not a full card. */
export function hasAnyTaskContextCardField(data: Record<string, unknown>): boolean {
  return (
    hasTaskContextCardBodyFields(data) ||
    (data.contextGeneration !== undefined && data.contextGeneration !== null) ||
    (data.taskDeltaDigest !== undefined && data.taskDeltaDigest !== null)
  );
}

/**
 * Load Context Card from envelope frontmatter data.
 * - Nested `contextCard` → full parse (fail-loud).
 * - Body fields present → full parse from flat keys (fail-loud on incomplete).
 * - Only contextGeneration / taskDeltaDigest mirrors → null (not a full card).
 * - No card fields → null (legacy envelope).
 */
export function loadTaskContextCardFromFrontmatter(
  data: Record<string, unknown>
): TaskContextCardV1 | null {
  if (data.contextCard !== undefined && data.contextCard !== null) {
    return parseTaskContextCard(data.contextCard);
  }
  if (!hasTaskContextCardBodyFields(data)) return null;
  return parseTaskContextCard(data);
}

/** Serialize card for Task envelope frontmatter (single nested object). */
export function serializeTaskContextCardForFrontmatter(
  card: TaskContextCardV1
): Record<string, unknown> {
  return {
    schemaVersion: card.schemaVersion,
    objective: card.objective,
    frozenDecisions: [...card.frozenDecisions],
    scope: {
      include: [...card.scope.include],
      exclude: [...card.scope.exclude],
    },
    acceptance: [...card.acceptance],
    refs: {
      nodes: card.refs.nodes.map((r) => ({ ...r })),
      tasks: card.refs.tasks.map((r) => ({ ...r })),
      deliveries: card.refs.deliveries.map((r) => ({ ...r })),
      git: card.refs.git.map((r) => ({ ...r })),
    },
    parentActor: { kind: card.parentActor.kind, id: card.parentActor.id },
    reviewer: { kind: card.reviewer.kind, id: card.reviewer.id },
    assignee: { kind: card.assignee.kind, id: card.assignee.id },
    contextGeneration: card.contextGeneration,
    taskDeltaDigest: card.taskDeltaDigest,
  };
}

/**
 * Project assignee onto the card from Task envelope assigneeKind + role label.
 * Does not invent parent/reviewer (those require explicit wire / tk-a2z8j1y2).
 */
export function projectAssigneeFromTask(
  task: Pick<TaskEnvelope, "role" | "assigneeKind" | "agentId">
): TaskContextCardAssignee {
  const agentId = typeof task.agentId === "string" ? task.agentId.trim() : "";
  if (agentId) {
    return { kind: "agentId", id: agentId };
  }
  const kind = taskAssigneeKind(task);
  if (kind === "agentProfile") {
    return { kind: "agentId", id: task.role };
  }
  return { kind: "role", id: task.role };
}

/**
 * Validate declared durable refs against a resolver.
 * Unresolved declared refs fail loud — never drop silently.
 */
export function assertRefsResolved(
  card: TaskContextCardV1,
  resolve: (kind: keyof TaskContextCardRefs, ref: TaskContextCardRef) => boolean
): void {
  const buckets: (keyof TaskContextCardRefs)[] = [
    "nodes",
    "tasks",
    "deliveries",
    "git",
  ];
  for (const bucket of buckets) {
    for (const ref of card.refs[bucket]) {
      if (!resolve(bucket, ref)) {
        throw new TaskContextCardError(
          "UNRESOLVED_REF",
          `Context Card refs.${bucket} id=${ref.id} could not be resolved (fail-loud to parent).`,
          { bucket, ref }
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly (stable prefix once per generation; later Tasks append delta)
// ---------------------------------------------------------------------------

export type ManagedPromptAssemblyInput = {
  /** Workspace absolute root. */
  workspaceRoot: string;
  /** Tent system root (`.tent`). */
  systemRoot: string;
  /** AGENTS pointer line(s) or digest note. */
  agentsPointer: string;
  /**
   * tent-role skill section when applicable (body or pointer).
   * Supplied by tk-3s598jtn compose; optional here.
   */
  tentRoleSection?: string;
  /** Role prompt + roster digest block (durable Role). */
  rolePromptRosterSection?: string;
  /**
   * tent-task skill section.
   * Supplied by tk-3s598jtn compose; optional here.
   */
  tentTaskSection?: string;
  /** Authoritative Context Card v1. */
  contextCard: TaskContextCardV1;
  /** Task envelope path / id pointers for the dynamic section. */
  taskPointers?: string;
  /** Near-field user prompt. */
  userPrompt?: string;
  /** TaskInput / review-feedback delta text. */
  taskInputDelta?: string;
  /** Optional Role Checkpoint tail. */
  checkpoint?: string;
  /**
   * When false, omit stable prefix (invariant → tent-task) and emit only
   * dynamic Context Card + deltas. Use when the Session already received
   * the same contextGeneration.
   */
  includeStablePrefix?: boolean;
};

export type ManagedPromptAssembly = {
  /** Full prompt text in frozen order. */
  text: string;
  contextGeneration: string;
  taskDeltaDigest: string;
  /** Whether the stable prefix was included. */
  includedStablePrefix: boolean;
  /** Stable prefix bytes only (empty when includeStablePrefix=false). */
  stablePrefix: string;
  /** Dynamic tail only. */
  dynamicDelta: string;
};

/** Format Context Card as a stable, cache-friendly markdown block. */
export function formatTaskContextCardPrompt(card: TaskContextCardV1): string {
  const lines: string[] = [
    "Tent Task Context Card v1",
    `schemaVersion: ${card.schemaVersion}`,
    `contextGeneration: ${card.contextGeneration}`,
    `taskDeltaDigest: ${card.taskDeltaDigest}`,
    `objective: ${card.objective}`,
  ];
  if (card.frozenDecisions.length) {
    lines.push("frozenDecisions:");
    for (const d of card.frozenDecisions) lines.push(`  - ${d}`);
  } else {
    lines.push("frozenDecisions: []");
  }
  lines.push("scope.include:");
  if (card.scope.include.length === 0) lines.push("  (none)");
  else for (const s of card.scope.include) lines.push(`  - ${s}`);
  lines.push("scope.exclude:");
  if (card.scope.exclude.length === 0) lines.push("  (none)");
  else for (const s of card.scope.exclude) lines.push(`  - ${s}`);
  lines.push("acceptance:");
  for (const a of card.acceptance) lines.push(`  - ${a}`);
  lines.push(
    `parentActor: ${card.parentActor.kind}:${card.parentActor.id}`,
    `reviewer: ${card.reviewer.kind}:${card.reviewer.id}`,
    `assignee: ${card.assignee.kind}:${card.assignee.id}`
  );
  const fmtRefs = (label: string, refs: TaskContextCardRef[]) => {
    lines.push(`refs.${label}:`);
    if (refs.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const r of refs) {
      const bits = [r.id];
      if (r.path) bits.push(`path=${r.path}`);
      if (r.revision) bits.push(`rev=${r.revision}`);
      lines.push(`  - ${bits.join(" ")}`);
    }
  };
  fmtRefs("nodes", card.refs.nodes);
  fmtRefs("tasks", card.refs.tasks);
  fmtRefs("deliveries", card.refs.deliveries);
  fmtRefs("git", card.refs.git);
  lines.push(
    "Core is authoritative for this card. Missing fields or unresolved refs must fail loud to parent — never invent from chat memory."
  );
  return lines.join("\n");
}

function formatStableProjectContext(input: ManagedPromptAssemblyInput): string {
  return [
    "Tent stable project context v1",
    `workspaceRoot: ${input.workspaceRoot}`,
    `systemRoot: ${input.systemRoot}`,
    `AGENTS: ${input.agentsPointer}`,
    "CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent).",
    "Do not resolve operational files as <workspaceRoot>/temp — use .tent/temp.",
  ].join("\n");
}

function formatDynamicDelta(input: ManagedPromptAssemblyInput): string {
  const parts: string[] = [
    "--- Tent Task dynamic context ---",
    formatTaskContextCardPrompt(input.contextCard),
  ];
  if (input.taskPointers?.trim()) {
    parts.push("", input.taskPointers.trim());
  }
  const userPrompt = input.userPrompt?.trim();
  parts.push(
    "",
    "## User Prompt",
    "",
    userPrompt || "(no user prompt on envelope)"
  );
  if (input.taskInputDelta?.trim()) {
    parts.push("", input.taskInputDelta.trim());
  }
  if (input.checkpoint?.trim()) {
    parts.push("", "--- Role Checkpoint ---", input.checkpoint.trim());
  }
  return parts.join("\n");
}

/**
 * Assemble managed Agent prompt in the frozen order:
 * invariant → stable project context → tent-role? → Role prompt/roster →
 * tent-task → dynamic Context Card → TaskInput/review delta → checkpoint?
 *
 * When `includeStablePrefix` is false (same contextGeneration already injected
 * on this Session), only the dynamic delta is returned.
 */
export function assembleManagedPrompt(
  input: ManagedPromptAssemblyInput
): ManagedPromptAssembly {
  // Re-validate card (fail loud).
  const card = buildTaskContextCard({
    objective: input.contextCard.objective,
    frozenDecisions: input.contextCard.frozenDecisions,
    scope: input.contextCard.scope,
    acceptance: input.contextCard.acceptance,
    refs: input.contextCard.refs,
    parentActor: input.contextCard.parentActor,
    reviewer: input.contextCard.reviewer,
    assignee: input.contextCard.assignee,
    contextGeneration: input.contextCard.contextGeneration,
    taskDeltaDigest: input.contextCard.taskDeltaDigest,
    taskInputDelta: input.taskInputDelta,
    checkpoint: input.checkpoint,
    userPrompt: input.userPrompt,
  });

  const includeStablePrefix = input.includeStablePrefix !== false;
  const dynamicDelta = formatDynamicDelta({ ...input, contextCard: card });

  if (!includeStablePrefix) {
    return {
      text: dynamicDelta + "\n",
      contextGeneration: card.contextGeneration,
      taskDeltaDigest: card.taskDeltaDigest,
      includedStablePrefix: false,
      stablePrefix: "",
      dynamicDelta,
    };
  }

  const stableParts: string[] = [
    MANAGED_BOOTSTRAP_INVARIANT,
    formatStableProjectContext(input),
  ];
  if (input.tentRoleSection?.trim()) {
    stableParts.push(input.tentRoleSection.trim());
  }
  if (input.rolePromptRosterSection?.trim()) {
    stableParts.push(input.rolePromptRosterSection.trim());
  }
  if (input.tentTaskSection?.trim()) {
    stableParts.push(input.tentTaskSection.trim());
  }
  const stablePrefix = stableParts.join("\n\n");
  const text = `${stablePrefix}\n\n${dynamicDelta}\n`;
  return {
    text,
    contextGeneration: card.contextGeneration,
    taskDeltaDigest: card.taskDeltaDigest,
    includedStablePrefix: true,
    stablePrefix,
    dynamicDelta,
  };
}

/**
 * Sole Core entry for stable-prefix omission (cx-5q6za6).
 * Omission is allowed only when both generations are valid cg-v1 ids and equal —
 * never from prompt-memory / chat-history inference.
 */
export function decideStablePrefixInjection(input: {
  sessionContextGeneration?: string | null;
  taskContextGeneration: string;
}): { includeStablePrefix: boolean; reason: string } {
  const taskGen = input.taskContextGeneration?.trim() || "";
  if (!isContextGenerationId(taskGen)) {
    return {
      includeStablePrefix: true,
      reason: "task_context_generation_invalid_or_missing",
    };
  }
  const prior = input.sessionContextGeneration?.trim() || "";
  if (!prior) {
    return { includeStablePrefix: true, reason: "session_has_no_context_generation" };
  }
  if (!isContextGenerationId(prior)) {
    return {
      includeStablePrefix: true,
      reason: "session_context_generation_invalid",
    };
  }
  if (prior !== taskGen) {
    return {
      includeStablePrefix: true,
      reason: "context_generation_mismatch",
    };
  }
  return {
    includeStablePrefix: false,
    reason: "same_context_generation",
  };
}

/**
 * Thin boolean wrapper over {@link decideStablePrefixInjection}.
 * Prefer the structured gate when logging reasons.
 */
export function shouldInjectStablePrefix(input: {
  sessionContextGeneration?: string | null;
  taskContextGeneration: string;
}): boolean {
  return decideStablePrefixInjection(input).includeStablePrefix;
}

// ---------------------------------------------------------------------------
// Session reuse compatibility gate (fail closed)
// ---------------------------------------------------------------------------

/**
 * Compatibility identity for Session reuse decisions.
 * Full live reuse still requires runtime probe / exclusive lease checks in Service;
 * this gate is the pure Core projection — fail closed when anything mismatches.
 */
export type SessionReuseCompatibilityFacts = {
  workspaceId: string;
  /** Parent Role operational id; omit / empty for user-parent one-shots. */
  parentRoleId?: string;
  /** Logical agentId (roster) or profile assignee id. */
  agentId: string;
  /** purpose / subKey — empty string when not used. */
  purpose?: string;
  /** Non-secret skills set digest. */
  skillsDigest: string;
  profileId: string;
  adapterId: string;
  contextGeneration: string;
  /** Absolute worktree / runtime cwd. */
  worktree?: string;
};

export type SessionReuseRuntimeGates = {
  /** Previous managed turn settled (not turnBusy). */
  previousTurnSettled: boolean;
  /** No open TaskInput / review-feedback on the binding. */
  noPendingInput: boolean;
  /** No ready/unresolved Delivery blocking reuse. */
  noPendingDelivery: boolean;
  /** Session has exclusive Task lease (not dual-bound). */
  exclusiveLease: boolean;
};

export type SessionReuseEvaluation = {
  /** True only when every compatibility + runtime gate passes. */
  allowed: boolean;
  reasons: string[];
  request: SessionReuseCompatibilityFacts;
  candidate: SessionReuseCompatibilityFacts;
};

function norm(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function samePathish(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  const na = a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return na === nb;
}

/**
 * Pure Session reuse compatibility gate.
 * Fail closed: any mismatch or unmet runtime gate → allowed=false with reasons.
 * Does **not** invent prompt-memory reuse; Service must still start fresh Session
 * when allowed=false. When a full reuse operation is absent, callers use this
 * seam and must not bypass it with chat-history heuristics.
 */
export function evaluateSessionReuseCompatibility(input: {
  request: SessionReuseCompatibilityFacts;
  candidate: SessionReuseCompatibilityFacts;
  runtime: SessionReuseRuntimeGates;
}): SessionReuseEvaluation {
  const reasons: string[] = [];
  const req = input.request;
  const cand = input.candidate;

  if (norm(req.workspaceId) !== norm(cand.workspaceId)) {
    reasons.push("workspace_mismatch");
  }
  if (norm(req.parentRoleId) !== norm(cand.parentRoleId)) {
    reasons.push("parent_role_mismatch");
  }
  if (norm(req.agentId) !== norm(cand.agentId)) {
    reasons.push("agent_mismatch");
  }
  if (norm(req.purpose) !== norm(cand.purpose)) {
    reasons.push("purpose_mismatch");
  }
  if (norm(req.skillsDigest) !== norm(cand.skillsDigest)) {
    reasons.push("skills_mismatch");
  }
  if (norm(req.profileId) !== norm(cand.profileId)) {
    reasons.push("profile_mismatch");
  }
  if (norm(req.adapterId) !== norm(cand.adapterId)) {
    reasons.push("adapter_mismatch");
  }
  if (norm(req.contextGeneration) !== norm(cand.contextGeneration)) {
    reasons.push("context_generation_mismatch");
  }
  if (!isContextGenerationId(req.contextGeneration)) {
    reasons.push("request_context_generation_invalid");
  }
  if (!isContextGenerationId(cand.contextGeneration)) {
    reasons.push("candidate_context_generation_invalid");
  }
  // Lane/worktree must match when either side declares one (acceptance: same lane).
  // Durable Role Tasks share tent-role/<role> across Tasks → cross-Task Session reuse.
  // agentProfile Tasks use tent-task/<taskId> → different Tasks fail closed to fresh.
  const reqWt = norm(req.worktree);
  const candWt = norm(cand.worktree);
  if (reqWt || candWt) {
    if (!samePathish(reqWt, candWt)) reasons.push("worktree_mismatch");
  }

  if (!input.runtime.previousTurnSettled) reasons.push("previous_turn_not_settled");
  if (!input.runtime.noPendingInput) reasons.push("pending_input");
  if (!input.runtime.noPendingDelivery) reasons.push("pending_delivery");
  if (!input.runtime.exclusiveLease) reasons.push("lease_not_exclusive");

  return {
    allowed: reasons.length === 0,
    reasons,
    request: req,
    candidate: cand,
  };
}

/**
 * Digest skills names for compatibility facts (sorted, lowercased names).
 * Paths/secrets must not appear here.
 */
export function skillsCompatibilityDigest(
  skillNames: readonly string[] | undefined
): string {
  const names = [...(skillNames ?? [])]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return sha256Hex(canonicalJson(names));
}

/**
 * Profile/adapter compatibility string (ids only).
 */
export function profileAdapterCompatibilityDigest(input: {
  profileId: string;
  adapterId: string;
  /** Optional non-secret capability flags. */
  capabilityFlags?: readonly string[];
}): string {
  const flags = [...(input.capabilityFlags ?? [])]
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return sha256Hex(
    canonicalJson({
      profileId: input.profileId.trim(),
      adapterId: input.adapterId.trim(),
      flags,
    })
  );
}

/**
 * Project SessionRecord compatibility fields into the pure reuse gate request shape.
 * Missing optional fields normalize to empty strings (fail closed on mismatch).
 */
export function sessionRecordToReuseCompatibilityFacts(
  record: {
    workspace?: string;
    parentRoleId?: string;
    agentId?: string;
    roleName?: string;
    purpose?: string;
    skillsDigest?: string;
    profileId: string;
    adapterId: string;
    contextGeneration?: string;
    runtimeWorkspace?: { cwd?: string };
    workspaceLane?: { worktree?: string };
  }
): SessionReuseCompatibilityFacts {
  return {
    workspaceId: record.workspace?.trim() || "",
    parentRoleId: record.parentRoleId?.trim() || "",
    agentId: (record.agentId || record.roleName || "").trim(),
    purpose: record.purpose?.trim() || "",
    skillsDigest: record.skillsDigest?.trim() || "",
    profileId: record.profileId.trim(),
    adapterId: record.adapterId.trim(),
    contextGeneration: record.contextGeneration?.trim() || "",
    worktree:
      record.workspaceLane?.worktree?.trim() ||
      record.runtimeWorkspace?.cwd?.trim() ||
      undefined,
  };
}

/**
 * Default managed purpose/subKey when none is declared on the Task.
 * Empty string keeps purpose optional in the gate (both sides must match).
 */
export function managedSessionPurpose(input?: {
  purpose?: string | null;
  subKey?: string | null;
}): string {
  const purpose = input?.purpose?.trim() || "";
  const subKey = input?.subKey?.trim() || "";
  if (purpose && subKey) return `${purpose}:${subKey}`;
  return purpose || subKey || "";
}

/** Helper: assignee kind → card assignee kind label. */
export function assigneeKindToCardKind(
  kind: AssigneeKind | undefined
): TaskContextCardAssignee["kind"] {
  return kind === "agentProfile" ? "agentId" : "role";
}


// ---------------------------------------------------------------------------
// Workspace lane authority + derived executionLane (cx-5q6za6)
// Truth lives on Task workspaceLane; Context Card only projects.
// ---------------------------------------------------------------------------

/** Integration authority: actor equals parent/reviewer; mutator is always service. */
export type IntegrationAuthority = {
  /** Exact parent/reviewer actor — ordinary accept authority. */
  actor: TaskActorRef;
  /** Git mutator is Local Service only (never the executor). */
  mutator: typeof INTEGRATION_MUTATOR_SERVICE;
};

/**
 * Derived dynamic projection of the Task workspace lane for Context Card tails.
 * Not a second truth — rebuild from Task envelope fields only.
 */
export type ExecutionLaneProjection = {
  baseCommit?: string;
  targetBranch?: string;
  branch?: string;
  worktree?: string;
  integrationAuthority?: IntegrationAuthority;
};

/**
 * Derive integrationAuthority from persisted Task parent/reviewer only.
 * mutator is always `service`. Rejects parent/reviewer mismatch (fail loud).
 * Never accepts an arbitrary Task-supplied authority object as truth.
 */
export function deriveIntegrationAuthority(input: {
  parentActor: TaskActorRef;
  reviewer: TaskActorRef;
}): IntegrationAuthority {
  try {
    const pair = resolveParentReviewerPair({
      parentActor: input.parentActor,
      reviewer: input.reviewer,
    });
    return {
      actor: { kind: pair.parentActor.kind, id: pair.parentActor.id },
      mutator: INTEGRATION_MUTATOR_SERVICE,
    };
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, {
        parentActor: input.parentActor,
        reviewer: input.reviewer,
      });
    }
    throw err;
  }
}

/**
 * @deprecated Prefer {@link deriveIntegrationAuthority} with both parent+reviewer.
 * Single-actor helper still fail-loud-parses the actor; mutator is always service.
 */
export function buildIntegrationAuthority(actor: TaskActorRef): IntegrationAuthority {
  const parsed = parseTaskActorRef(actor, "parentActor");
  return {
    actor: { kind: parsed.kind, id: parsed.id },
    mutator: INTEGRATION_MUTATOR_SERVICE,
  };
}

/**
 * Assert a projected/persisted authority bag matches derived parent/reviewer + service.
 * Fail loud on actor mismatch or non-service mutator — never trust executor-supplied bags.
 */
export function assertIntegrationAuthorityMatchesParent(
  authority: IntegrationAuthority | unknown,
  parentActor: TaskActorRef,
  reviewer: TaskActorRef
): IntegrationAuthority {
  const derived = deriveIntegrationAuthority({ parentActor, reviewer });
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      "integrationAuthority must be { actor, mutator: service } derived from parent/reviewer.",
      { authority }
    );
  }
  const raw = authority as Record<string, unknown>;
  if (raw.mutator !== INTEGRATION_MUTATOR_SERVICE) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.mutator must be "${INTEGRATION_MUTATOR_SERVICE}" (Service only); got ${String(raw.mutator)}.`,
      { authority }
    );
  }
  let actor: TaskActorRef;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, { authority });
    }
    throw err;
  }
  if (actor.kind !== derived.actor.kind || actor.id !== derived.actor.id) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.actor must equal Task parent/reviewer ` +
        `(${derived.actor.kind}:${derived.actor.id}); got ${actor.kind}:${actor.id}.`,
      { authority, derived }
    );
  }
  return derived;
}

/**
 * Derive executionLane projection from Task lane truth.
 * - baseCommit: exact workspaceLane.baseCommit only (never roleBranchBase substitution).
 * - integrationAuthority: always re-derived from parentActor+reviewer + service mutator.
 * Invalid parent/reviewer fails loud — never silently drop authority.
 */
export function projectExecutionLaneFromTask(
  task: Pick<
    TaskEnvelope,
    "targetBranch" | "branch" | "worktree" | "parentActor" | "reviewer" | "baseCommit"
  >
): ExecutionLaneProjection | undefined {
  const baseCommit =
    typeof task.baseCommit === "string" && task.baseCommit.trim()
      ? task.baseCommit.trim()
      : "";
  const targetBranch =
    typeof task.targetBranch === "string" ? task.targetBranch.trim() : "";
  const branch = typeof task.branch === "string" ? task.branch.trim() : "";
  const worktree = typeof task.worktree === "string" ? task.worktree.trim() : "";

  let integrationAuthority: IntegrationAuthority | undefined;
  if (task.parentActor || task.reviewer) {
    if (!task.parentActor || !task.reviewer) {
      throw new TaskContextCardError(
        "INVALID_ACTOR",
        "executionLane requires both parentActor and reviewer to derive integrationAuthority.",
        { parentActor: task.parentActor, reviewer: task.reviewer }
      );
    }
    // Fail loud on invalid / mismatched actors — do not catch and drop.
    integrationAuthority = deriveIntegrationAuthority({
      parentActor: task.parentActor,
      reviewer: task.reviewer,
    });
  }

  if (!baseCommit && !targetBranch && !branch && !worktree && !integrationAuthority) {
    return undefined;
  }
  const out: ExecutionLaneProjection = {};
  if (baseCommit) out.baseCommit = baseCommit;
  if (targetBranch) out.targetBranch = targetBranch;
  if (branch) out.branch = branch;
  if (worktree) out.worktree = worktree;
  if (integrationAuthority) out.integrationAuthority = integrationAuthority;
  return out;
}

/** Format executionLane for dynamic Context Card / prompt tails. */
export function formatExecutionLanePrompt(
  lane: ExecutionLaneProjection | undefined
): string {
  if (!lane) return "";
  const lines = ["executionLane (derived projection — Task workspaceLane is truth):"];
  if (lane.baseCommit) lines.push(`  baseCommit: ${lane.baseCommit}`);
  if (lane.targetBranch) lines.push(`  targetBranch: ${lane.targetBranch}`);
  if (lane.branch) lines.push(`  branch: ${lane.branch}`);
  if (lane.worktree) lines.push(`  worktree: ${lane.worktree}`);
  if (lane.integrationAuthority) {
    const a = lane.integrationAuthority.actor;
    lines.push(
      `  integrationAuthority.actor: ${a.kind}:${a.id}`,
      `  integrationAuthority.mutator: ${lane.integrationAuthority.mutator}`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pre-ready Delivery history gate (ordinary executor lanes) — pure Core
// ---------------------------------------------------------------------------

export type ExecutorLaneCommitInfo = {
  /** Full SHA. */
  sha: string;
  /** Parent SHAs in git order (first parent is parents[0]). */
  parents: string[];
};

export type ExecutorLaneHistoryGateInput = {
  /** Recorded Task workspaceLane baseCommit (exact lane start). */
  baseCommit: string;
  /** Task branch tip full SHA. */
  tipCommit: string;
  /**
   * Commits on base..tip, oldest-first.
   * Empty when tip === base (no Task commits yet).
   */
  commits: readonly ExecutorLaneCommitInfo[];
};

export type ExecutorLaneHistoryErrorCode =
  | "MISSING_BASE"
  | "MISSING_TIP"
  | "BASE_NOT_FIRST_PARENT"
  | "MERGE_COMMIT"
  | "FOREIGN_ANCESTRY"
  | "TIP_MISMATCH"
  | "EMPTY_PARENT";

export class ExecutorLaneHistoryError extends Error {
  code: ExecutorLaneHistoryErrorCode;
  details?: Record<string, unknown>;
  constructor(
    code: ExecutorLaneHistoryErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ExecutorLaneHistoryError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Pure pre-ready Delivery history gate for ordinary executor lanes.
 *
 * Rules (cx-5q6za6):
 * 1. recorded baseCommit must be the exact first parent of the first Task commit
 *    when the range is non-empty; when empty, tip must equal base.
 * 2. every commit in base..tip is single-parent (no merge commits).
 * 3. the chain is linear tip-contiguous: each commit's first parent is the prior
 *    commit (or base for the first). Foreign ancestry / multi-parent fails loud.
 *
 * Does **not** publish Delivery; callers refuse ready Delivery and preserve lane/audit.
 * No generic allowMerge switch — authorized integration is parent accept + Service only.
 */
export function assertOrdinaryExecutorLaneHistory(
  input: ExecutorLaneHistoryGateInput
): void {
  const base = input.baseCommit?.trim() || "";
  const tip = input.tipCommit?.trim() || "";
  if (!base) {
    throw new ExecutorLaneHistoryError(
      "MISSING_BASE",
      "Executor lane history gate requires recorded baseCommit (fail-loud; no ready Delivery)."
    );
  }
  if (!tip) {
    throw new ExecutorLaneHistoryError(
      "MISSING_TIP",
      "Executor lane history gate requires tip commit (fail-loud; no ready Delivery)."
    );
  }
  const commits = input.commits ?? [];
  if (commits.length === 0) {
    if (base !== tip) {
      throw new ExecutorLaneHistoryError(
        "TIP_MISMATCH",
        `Executor lane has no commits in base..tip but tip ${tip} !== base ${base}.`,
        { base, tip }
      );
    }
    return;
  }

  const first = commits[0];
  if (!first.sha?.trim()) {
    throw new ExecutorLaneHistoryError(
      "FOREIGN_ANCESTRY",
      "Executor lane history contains a commit with empty sha.",
      { index: 0 }
    );
  }
  if (!first.parents || first.parents.length === 0) {
    throw new ExecutorLaneHistoryError(
      "EMPTY_PARENT",
      `Executor lane commit ${first.sha} has no parents (unexpected root in task range).`,
      { sha: first.sha }
    );
  }
  if (first.parents.length !== 1) {
    throw new ExecutorLaneHistoryError(
      "MERGE_COMMIT",
      `Unauthorized merge commit on ordinary executor lane: ${first.sha} has ${first.parents.length} parents (no ready Delivery; lane/audit preserved).`,
      { sha: first.sha, parents: first.parents }
    );
  }
  if (first.parents[0] !== base) {
    throw new ExecutorLaneHistoryError(
      "BASE_NOT_FIRST_PARENT",
      `Recorded baseCommit ${base} is not the exact first parent of the first Task commit ${first.sha} (parent=${first.parents[0]}). Unauthorized foreign ancestry; no ready Delivery.`,
      { base, firstSha: first.sha, firstParent: first.parents[0] }
    );
  }

  let prev = first.sha;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const sha = c.sha?.trim() || "";
    if (!sha) {
      throw new ExecutorLaneHistoryError(
        "FOREIGN_ANCESTRY",
        `Executor lane history contains a commit with empty sha at index ${i}.`,
        { index: i }
      );
    }
    const parents = c.parents ?? [];
    if (parents.length === 0) {
      throw new ExecutorLaneHistoryError(
        "EMPTY_PARENT",
        `Executor lane commit ${sha} has no parents.`,
        { sha, index: i }
      );
    }
    if (parents.length !== 1) {
      throw new ExecutorLaneHistoryError(
        "MERGE_COMMIT",
        `Unauthorized merge commit on ordinary executor lane: ${sha} has ${parents.length} parents (executor must not merge parent/target/dependency; no ready Delivery).`,
        { sha, parents, index: i }
      );
    }
    if (i > 0 && parents[0] !== prev) {
      throw new ExecutorLaneHistoryError(
        "FOREIGN_ANCESTRY",
        `Executor lane commit ${sha} first parent ${parents[0]} is not prior tip ${prev} (foreign ancestry / non-linear history; no ready Delivery).`,
        { sha, firstParent: parents[0], expectedParent: prev, index: i }
      );
    }
    prev = sha;
  }

  if (prev !== tip) {
    throw new ExecutorLaneHistoryError(
      "TIP_MISMATCH",
      `Executor lane tip ${tip} does not match last commit in base..tip range ${prev}.`,
      { tip, last: prev, base }
    );
  }
}
