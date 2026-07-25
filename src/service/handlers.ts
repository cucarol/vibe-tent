// Service command/query handlers — sole client mutation entry into core + runtime.

import { boxNotePath, loadTent, type LoadedTent } from "../core/tree.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import {
  createBox,
  dispatch,
  patchBody,
  patchBox,
  setNodeMode,
} from "../core/ops.js";
import { syncTagRegistryAfterBoxTagsChange } from "../core/tags.js";
import { isContentMutable } from "../core/tree.js";
import type { NodeMode } from "../core/types.js";
import { promoteConcept } from "../core/concept.js";
import { forkNode } from "../core/forkOps.js";
import { renameNode } from "../core/renameOps.js";
import {
  extractTaskUserPrompt,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  sessionBootstrapPromptForTask,
  taskAssigneeKind,
  taskAsSub,
  type RoleWorkspaceContract,
  type TaskEnvelope,
} from "../core/task.js";
import { taskContextCard } from "../core/context-card.js";
import { systemRootFromWorkspace } from "../core/paths.js";
import {
  decodeBase64Strict,
  MAX_ATTACHMENT_BYTES,
  storeAttachmentBytes,
} from "../markdown/attachments.js";
import {
  collectBootstrapImageRefsFromTask,
  type BootstrapImageRef,
} from "../adapters/acp/image-prompt.js";
import { loadDeliveries } from "../core/delivery.js";
import {
  acceptProposal,
  loadProposal,
  loadProposals,
  rejectProposal,
  submitProposal,
  type Proposal,
} from "../core/proposal.js";
import { loadTypeRegistry } from "../core/typeRegistry.js";
import {
  createRole,
  deleteRole,
  loadRolesRegistry,
  normalizeAllowedProfiles,
  normalizeRoleDefinition,
  resolveRole,
  roleA2APolicy,
  roleAllowsProfile,
  updateRole,
  type RoleDefinition,
} from "../core/skillRoleRegistry.js";
import {
  boxProjectionOf,
  findActiveTaskForBox,
  taskAccept,
  taskCancel,
  taskClaim,
  taskDeliver,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
} from "../core/task-lifecycle.js";
import {
  normalizeKeepTerminalTasksDays,
  previewOperationalRetention,
  purgeOperationalRetention,
  RetentionError,
  type RetentionPurgeResult,
} from "../core/retention.js";
import {
  loadWorkspaceSettings,
  updateWorkspaceSettings,
  WorkspaceSettingsError,
  type WorkspaceSettings,
} from "../core/workspace-settings.js";
import {
  loadWorkspaceAgents,
  writeWorkspaceAgents,
  WorkspaceAgentsError,
  WORKSPACE_AGENTS_FILENAME,
  type WorkspaceAgentsFile,
} from "../core/workspace-agents.js";
import {
  AnnotationError,
  createAnnotation,
  deleteAnnotation,
  listAnnotationRecords,
  projectAnnotation,
  reopenAnnotation,
  resolveAnnotation,
  type AnnotationProjection,
  type AnnotationRecord,
} from "../core/annotation.js";
import { envelopeIsActiveOccupation } from "../core/claim.js";
import {
  TaskLifecycleError,
  isActiveTaskState,
  type A2APolicy,
  type DeliverDecision,
  type DeliveryPolicy,
  type WaitReason,
  evaluateA2A,
} from "../core/task-model.js";
import {
  ensureRoleWorkspace,
  ensureRoleWorkspaceIfGit,
  ensureTaskWorkspace,
  ensureTaskWorkspaceIfGit,
  inspectWorktreeDirtiness,
  integrateWorkspaceCommits,
  isGitWorkspace,
  isSameWorkspaceRoot,
  listPendingRoleCommits,
  readRoleBranchTip,
} from "../core/workspace.js";
import { makeTaskId } from "../core/task-model.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { RuntimeEvent, SessionRecord } from "../runtime/types.js";
import {
  isSessionId,
  makeSessionId,
  recordExternalKey,
} from "../runtime/types.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import {
  buildBacklinkIndex,
  extractOutLinksDetailed,
  indexFromBoxes,
  resolveOutLink,
} from "../markdown/links.js";
import { contentEtag } from "./etag.js";
import type { EventBus } from "./events.js";
import { MutationBus } from "./mutation-bus.js";
import type { WorkspaceHost } from "./workspace-host.js";
import type { A2AApprovalStore } from "./a2a-store.js";
import { makeApprovalId } from "./a2a-store.js";
import type { ToolApprovalStore, ToolPendingApproval } from "./tool-approval-store.js";
import {
  formatUserAskAnswerPrompt,
  makeUserAskId,
  type UserAskChoice,
  type UserAskRecord,
  type UserAskStore,
} from "./user-ask-store.js";
import {
  formatTaskInputPrompt,
  makeTaskInputId,
  normalizeTaskInputKind,
  type TaskInputRecord,
  type TaskInputStore,
} from "./task-input-store.js";
import type { ManagedDeliveryReportDraftStore } from "./managed-delivery-report-draft-store.js";
import type { CredentialStore } from "./credential-store.js";
import {
  isClientMethod,
  PROTECTED_COLLAB_FIELDS,
  RESERVED_DOCS_WRITE_FIELDS,
  RPC_A2A_ASK,
  RPC_A2A_DENIED,
  RPC_LIFECYCLE,
  type ArtifactRef,
  type BoxProjection,
  type BoxProjectionsResult,
  type ConceptProjection,
  type DeliveryProjection,
  type GraphLinkEdge,
  type GraphNodeSummary,
  type GraphParentEdge,
  type GraphProjection,
  type PendingA2AInteraction,
  type PendingDeliveryInteraction,
  type PendingInteractionItem,
  type PendingInteractionListResult,
  type PendingToolApprovalInteraction,
  type PendingUserAskInteraction,
  type ProposalProjection,
  type ProviderCatalogProjection,
  type RoleRegistryEntryProjection,
  type SessionProjection,
  type TaskProjection,
  type TypeRegistryEntryProjection,
} from "./types.js";
import {
  projectAgentProfile,
  projectAgentProfiles,
} from "./profiles.js";
import { projectProviderCatalog } from "./provider-catalog.js";
import type { AgentProfileCatalog } from "./profile-catalog.js";
import { RpcError, type JsonRpcError } from "./rpc-error.js";
import {
  installSkills,
  listSkills,
  parseSkillTargetId,
  type SkillTargetId,
} from "../machine/skills.js";

export type { JsonRpcError };
export { RpcError };

export interface HandlerContext {
  host: WorkspaceHost;
  mutations: MutationBus;
  events: EventBus;
  version: string;
  startedAt: string;
  getPid: () => number;
  /** Service-internal runtime (never exposed as client methods). */
  runtime: AgentRuntime;
  a2a: A2AApprovalStore;
  /** Machine-local ACP tool permission approvals (permissionPolicy=ask). */
  toolApprovals: ToolApprovalStore;
  /** Machine-local A2U business UserAsk rows (not chat; not tool permission). */
  userAsks: UserAskStore;
  /**
   * Machine-local U2A one-shot task inputs (user→agent append).
   * Not chat; not UserAsk answer; scoped by workspaceId+taskPath.
   */
  taskInputs: TaskInputStore;
  /**
   * Machine-local managed auto-deliver report drafts (final assistantText only).
   * Not chat history; not a ready Delivery; not a sixth pending-interaction.
   * Survives restart so publish failures can retry without re-prompting the Agent.
   */
  managedDeliveryReportDrafts: ManagedDeliveryReportDraftStore;
  /**
   * Machine-local encrypted credential vault (Windows DPAPI).
   * Client RPC: list/set/delete only — never get/resolve plaintext.
   */
  credentials: CredentialStore;
  dataDir: string;
  /** Machine-local AgentProfile catalog (serial CRUD + runtime sync). */
  profileCatalog: AgentProfileCatalog;
  /**
   * Package root for bundled skills (tests may inject).
   * Production: resolved once at service start.
   */
  packageRoot: string;
  /**
   * Home directory for machine-local user paths (skills, etc.).
   * Tests inject a temp home; production uses os.homedir().
   */
  home: string;
  /**
   * Optional integrate hook for tests.
   * Production path uses real workspace Git via ensureRoleWorkspace + integrateWorkspaceCommits.
   * Signature keeps role so role lane targetBranch/worktree can be resolved correctly.
   */
  integrateCommits?: (
    workspaceRoot: string,
    commits: string[],
    role: string
  ) => Promise<void>;
}

export async function dispatchMethod(
  ctx: HandlerContext,
  method: string,
  params: Record<string, unknown> | undefined
): Promise<unknown> {
  if (method.startsWith("AgentRuntimePort.") || method.startsWith("AgentRuntime.")) {
    throw new RpcError(
      -32601,
      `Method not found (AgentRuntimePort is service-internal): ${method}`
    );
  }
  if (!isClientMethod(method)) {
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  const p = params ?? {};

  try {
    switch (method) {
      case "service.health":
        return health(ctx);
      case "service.subscribe":
        return { ok: true, transport: "sse", path: "/events" };
      case "workspace.mount":
        return workspaceMount(ctx, p);
      case "workspace.unmount":
        return workspaceUnmount(ctx, p);
      case "workspace.list":
        return { workspaces: ctx.host.list() };
      case "workspace.setForeground":
        return workspaceSetForeground(ctx, p);
      case "workspace.settings":
        return workspaceSettingsRpc(ctx, p);
      case "workspace.settings.update":
        return workspaceSettingsUpdateRpc(ctx, p);
      case "workspace.agents":
        return workspaceAgentsRpc(ctx, p);
      case "workspace.agents.write":
        return workspaceAgentsWriteRpc(ctx, p);
      case "docs.list":
        return docsList(ctx, p);
      case "docs.get":
        return docsGet(ctx, p);
      case "docs.readForEdit":
        return docsReadForEdit(ctx, p);
      case "docs.write":
        return docsWrite(ctx, p);
      case "docs.createNote":
        return docsCreateNote(ctx, p);
      case "docs.promote":
        return docsPromote(ctx, p);
      case "docs.fork":
        return docsFork(ctx, p);
      case "docs.rename":
        return docsRename(ctx, p);
      case "docs.setMode":
        return docsSetMode(ctx, p);
      case "docs.search":
        return docsSearch(ctx, p);
      case "docs.backlinks":
        return docsBacklinks(ctx, p);
      case "docs.importAttachment":
        return docsImportAttachment(ctx, p);
      case "registry.types":
        return registryTypes(ctx, p);
      case "registry.roles":
        return registryRoles(ctx, p);
      case "registry.role.create":
        return registryRoleCreate(ctx, p);
      case "registry.role.update":
        return registryRoleUpdate(ctx, p);
      case "registry.role.delete":
        return registryRoleDelete(ctx, p);
      case "profile.list":
        return profileList(ctx, p);
      case "profile.get":
        return profileGet(ctx, p);
      case "profile.create":
        return profileCreate(ctx, p);
      case "profile.update":
        return profileUpdate(ctx, p);
      case "profile.delete":
        return profileDelete(ctx, p);
      case "provider.catalog":
        return providerCatalogRpc();
      case "credential.list":
        return credentialList(ctx);
      case "credential.set":
        return credentialSet(ctx, p);
      case "credential.delete":
        return credentialDelete(ctx, p);
      case "skill.list":
        return skillList(ctx);
      case "skill.install":
        return skillInstall(ctx, p);
      case "task.dispatch":
        return taskDispatch(ctx, p);
      case "task.claim":
        return taskClaimRpc(ctx, p);
      case "task.wait":
        return taskWaitRpc(ctx, p);
      case "task.resume":
        return taskResumeRpc(ctx, p);
      case "task.askUser":
        return taskAskUserRpc(ctx, p);
      case "task.sendInput":
        return taskSendInputRpc(ctx, p);
      case "task.deliver":
        return taskDeliverRpc(ctx, p);
      case "task.requestReview":
        return taskRequestReviewRpc(ctx, p);
      case "task.accept":
        return taskAcceptRpc(ctx, p);
      case "task.reject":
        return taskRejectRpc(ctx, p);
      case "task.interrupt":
        return taskInterruptRpc(ctx, p);
      case "task.cancel":
        return taskCancelRpc(ctx, p);
      case "task.startSession":
        return taskStartSessionRpc(ctx, p);
      case "task.list":
        return taskList(ctx, p);
      case "task.get":
        return taskGet(ctx, p);
      case "delivery.list":
        return deliveryList(ctx, p);
      case "delivery.get":
        return deliveryGet(ctx, p);
      case "box.projection":
        return boxProjectionRpc(ctx, p);
      case "box.projections":
        return boxProjectionsRpc(ctx, p);
      case "graph.projection":
        return graphProjectionRpc(ctx, p);
      case "proposal.list":
        return proposalList(ctx, p);
      case "proposal.submit":
        return proposalSubmit(ctx, p);
      case "proposal.resolve":
        return proposalResolve(ctx, p);
      case "session.list":
        return sessionList(ctx, p);
      case "session.get":
        return sessionGet(ctx, p);
      case "session.enter":
        return sessionEnter(ctx, p);
      case "session.status":
        return sessionStatus(ctx, p);
      case "session.leave":
        return sessionLeave(ctx, p);
      case "a2a.listPending":
        return a2aListPending(ctx, p);
      case "a2a.resolve":
        return a2aResolve(ctx, p);
      case "toolApproval.listPending":
        return toolApprovalListPending(ctx, p);
      case "toolApproval.get":
        return toolApprovalGet(ctx, p);
      case "toolApproval.approveOnce":
        return toolApprovalResolve(ctx, p, "approved");
      case "toolApproval.deny":
        return toolApprovalResolve(ctx, p, "denied");
      case "userAsk.listPending":
        return userAskListPending(ctx, p);
      case "userAsk.get":
        return userAskGet(ctx, p);
      case "userAsk.reply":
        return userAskReplyRpc(ctx, p);
      case "userAsk.deny":
        return userAskDenyRpc(ctx, p);
      case "interaction.listPending":
        return interactionListPending(ctx, p);
      case "taskInput.listPending":
        return taskInputListPending(ctx, p);
      case "taskInput.get":
        return taskInputGet(ctx, p);
      case "taskInput.ack":
        return taskInputAckRpc(ctx, p);
      case "operationalRetention.preview":
        return operationalRetentionPreviewRpc(ctx, p);
      case "operationalRetention.purge":
        return operationalRetentionPurgeRpc(ctx, p);
      case "annotation.list":
        return annotationListRpc(ctx, p);
      case "annotation.create":
        return annotationCreateRpc(ctx, p);
      case "annotation.resolve":
        return annotationResolveRpc(ctx, p);
      case "annotation.reopen":
        return annotationReopenRpc(ctx, p);
      case "annotation.delete":
        return annotationDeleteRpc(ctx, p);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof AnnotationError) {
      throw annotationErrorToRpc(error);
    }
    if (
      error instanceof RetentionError ||
      (error instanceof Error && error.name === "RetentionError")
    ) {
      const code =
        error instanceof RetentionError
          ? error.code
          : ((error as { code?: string }).code ?? "INVALID_KEEP_DAYS");
      throw new RpcError(-32602, error.message, { code });
    }
    if (
      error instanceof WorkspaceSettingsError ||
      (error instanceof Error && error.name === "WorkspaceSettingsError")
    ) {
      const code =
        error instanceof WorkspaceSettingsError
          ? error.code
          : ((error as { code?: string }).code ?? "INVALID_PATCH");
      throw new RpcError(-32602, error.message, { code });
    }
    if (error instanceof TaskLifecycleError) {
      throw new RpcError(RPC_LIFECYCLE, error.message, { code: error.code });
    }
    throw error;
  }
}

function health(ctx: HandlerContext) {
  return {
    status: "ok" as const,
    pid: ctx.getPid(),
    version: ctx.version,
    startedAt: ctx.startedAt,
    workspaceCount: ctx.host.list().length,
    foregroundWorkspaceId: ctx.host.getForegroundId(),
  };
}

async function workspaceMount(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceRoot = requireString(p, "workspaceRoot");
  const info = await ctx.host.mount(workspaceRoot, {
    workspaceId: optionalString(p, "workspaceId"),
    tentName: optionalString(p, "tentName"),
  });
  // One-shot machine-local SessionRecord.workspace upgrade after makeWorkspaceId
  // changed (sha256 digest). Must run before task/session reconcile so list,
  // resume, event routing, and active-role lookup see the current mount id.
  await migrateSessionWorkspaceIdsOnMount(ctx, info.workspaceId);
  // After SessionRegistry boot reconcile, each mount must re-bind tasks to live sessions.
  await reconcileTaskSessionsOnMount(ctx, info.workspaceId);
  return info;
}

/**
 * Rebind machine-local SessionRecord.workspace to the current mount id when
 * makeWorkspaceId algorithm changes leave stale keys on disk.
 *
 * Single boundary: workspace.mount only (before reconcileTaskSessionsOnMount).
 * Does not rewrite Tent documents; does not keep dual-id comparison elsewhere.
 *
 * Evidence (any one is enough):
 * - task envelope sessionId in this workspace (authoritative binding)
 * - workspaceLane.workspace matches this mount's canonical root
 * - no lane, but runtimeWorkspace.cwd matches this mount's canonical root
 *
 * Never steals a row whose workspace still names another currently mounted id.
 */
export async function migrateSessionWorkspaceIdsOnMount(
  ctx: HandlerContext,
  workspaceId: string
): Promise<{ migrated: string[] }> {
  const mount = ctx.host.require(workspaceId);
  const canonicalPaths = new Map<string, Promise<string>>();
  const canonicalize = (value: string): Promise<string> => {
    const resolved = nodePath.resolve(value);
    let pending = canonicalPaths.get(resolved);
    if (!pending) {
      pending = nodeFs.realpath(resolved).catch(() => resolved);
      canonicalPaths.set(resolved, pending);
    }
    return pending;
  };
  const root = await canonicalize(mount.workspaceRoot);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const boundSessionIds = new Set<string>();
  for (const task of tasks) {
    const sid = task.sessionId?.trim();
    if (sid) boundSessionIds.add(sid);
  }

  const otherMountedIds = new Set(
    ctx.host
      .list()
      .map((info) => info.workspaceId)
      .filter((id) => id !== workspaceId)
  );

  const all = await ctx.runtime.registry.list();
  const migrated: string[] = [];

  for (const rec of all) {
    if (rec.workspace === workspaceId) continue;
    // Still owned by another live mount — do not rebind away from it.
    if (rec.workspace && otherMountedIds.has(rec.workspace)) continue;

    const boundByTask = boundSessionIds.has(rec.id);
    const laneRoot = rec.workspaceLane?.workspace?.trim();
    const laneMatches =
      !!laneRoot &&
      isSameWorkspaceRoot(await canonicalize(laneRoot), root);
    const cwd = rec.runtimeWorkspace?.cwd?.trim();
    const cwdMatches =
      !rec.workspaceLane &&
      !!cwd &&
      isSameWorkspaceRoot(await canonicalize(cwd), root);

    if (!boundByTask && !laneMatches && !cwdMatches) continue;

    await ctx.runtime.registry.update(rec.id, { workspace: workspaceId });
    migrated.push(rec.id);
  }

  return { migrated };
}

/**
 * Chinese summary when a bound managed session is gone after service restart / remount.
 * Kept as a constant so tests and UI can match the exact contract text.
 */
export const SESSION_UNAVAILABLE_WAIT_SUMMARY =
  "绑定的 session 已不可用（服务重启或 session 已结束）。可重新启动 session，或 interrupt 任务；occupation 保持。";

/**
 * After workspace mount (and SessionRegistry.reconcileOnBoot already ran on service start):
 * scan non-terminal running/waiting tasks with sessionId; decide via runtime.probe(sessionId)
 * (process truth), not SessionRecord.state alone. missing / terminal / dead → park the task in
 * waiting(reason=external) via MutationBus + core taskWait / patch. Keeps occupation; never
 * auto done/release. Truly alive managed sessions are left alone.
 *
 * Note: probe may correct a stale nonterminal registry row to failed/stopped when the process
 * is gone. That correction is intentional and happens before the task park decision.
 *
 * Idempotent: already waiting with the same reason+summary is a no-op.
 * Leaves tasks without sessionId (external/manual) alone; terminal and other non-running/waiting
 * states alone. MutationBus re-probes for races.
 */
export async function reconcileTaskSessionsOnMount(
  ctx: HandlerContext,
  workspaceId: string
): Promise<{ reconciled: string[] }> {
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const reconciled: string[] = [];

  for (const task of tasks) {
    if (task.state !== "running" && task.state !== "waiting") continue;
    const sessionId = task.sessionId?.trim();
    if (!sessionId) continue;

    // Process truth — do not trust a stale disk "live"/"starting"/"waiting-user" row alone.
    // probe() may rewrite nonterminal registry → failed/stopped when the child is dead.
    const probe = await ctx.runtime.probe(sessionId);
    if (probe.alive) continue;

    const alreadyParked =
      task.state === "waiting" &&
      task.wait?.reason === "external" &&
      task.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
    if (alreadyParked) continue;

    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      // Re-load + re-probe inside the bus for races; only park when still non-terminal + dead.
      const current = await loadTaskEnvelope(mount.env.fs, task.path);
      if (current.state !== "running" && current.state !== "waiting") return;
      if (current.sessionId?.trim() !== sessionId) return;
      const probe2 = await ctx.runtime.probe(sessionId);
      if (probe2.alive) return;
      const parkedAlready =
        current.state === "waiting" &&
        current.wait?.reason === "external" &&
        current.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
      if (parkedAlready) return;

      let next = current;
      if (current.state === "running") {
        next = await taskWait(mount.env, task.path, {
          reason: "external",
          summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
        });
      } else {
        // waiting with another reason (user-input / a2a-approval / …): overwrite wait.
        // taskWait only allows running→waiting; MutationBus already serializes this path.
        next = await patchTaskEnvelope(mount.env.fs, task.path, {
          state: "waiting",
          wait: { reason: "external", summary: SESSION_UNAVAILABLE_WAIT_SUMMARY },
          updatedAt: mount.env.clock.now(),
        });
      }
      emitTaskState(ctx, workspaceId, next, "session.reconcile");
      reconciled.push(task.path);
    });
  }

  return { reconciled };
}

async function workspaceUnmount(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireString(p, "workspaceId");
  await ctx.host.unmount(workspaceId);
  return { ok: true };
}

function workspaceSetForeground(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireString(p, "workspaceId");
  return ctx.host.setForeground(workspaceId);
}

// ---- workspace.settings (collaboration defaults; system-root settings.json) ----

/**
 * Read projection of workspace collaboration settings.
 * Missing file/field → defaultDeliveryPolicy=manual (normalized in core).
 */
async function workspaceSettingsRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const settings = await loadWorkspaceSettings(mount.env.fs);
  return {
    workspaceId,
    settings: projectWorkspaceSettings(settings),
  };
}

/**
 * User-only settings mutation through MutationBus.
 * Emits exactly one workspace.settings.updated when the normalized projection
 * actually changes. No-op updates and failures emit no event.
 *
 * Authority note: only self-declared `actor` is checked (default "user"). The
 * loopback service token does not distinguish human vs role callers — see task-api.
 */
async function workspaceSettingsUpdateRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "workspace.settings.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const patch = parseWorkspaceSettingsPatch(p);

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    let result: { settings: WorkspaceSettings; changed: boolean };
    try {
      result = await updateWorkspaceSettings(mount.env.fs, patch);
    } catch (err) {
      if (
        err instanceof WorkspaceSettingsError ||
        (err instanceof Error && err.name === "WorkspaceSettingsError")
      ) {
        const code =
          err instanceof WorkspaceSettingsError
            ? err.code
            : ((err as { code?: string }).code ?? "INVALID_PATCH");
        throw new RpcError(-32602, err.message, { code });
      }
      throw err;
    }
    if (result.changed) {
      emitWorkspaceSettingsUpdated(ctx, workspaceId, result.settings);
    }
    return {
      workspaceId,
      settings: projectWorkspaceSettings(result.settings),
      changed: result.changed,
    };
  });
}

/**
 * Top-level RPC fields become the patch (excluding workspaceId / actor).
 * Nested `patch` object is rejected so clients pass fields at top level.
 */
function parseWorkspaceSettingsPatch(p: Record<string, unknown>): Record<string, unknown> {
  if (typeof p.patch === "object" && p.patch !== null && !Array.isArray(p.patch)) {
    throw new RpcError(
      -32602,
      "workspace.settings.update does not accept nested patch; pass fields at the top level"
    );
  }
  const reserved = new Set(["workspaceId", "actor", "patch"]);
  const supported = new Set(["defaultDeliveryPolicy"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (reserved.has(key)) continue;
    if (!supported.has(key)) {
      throw new RpcError(-32602, `Unknown workspace setting: ${key}`);
    }
    if (value === undefined) continue;
    out[key] = value;
  }
  // Explicit defaultDeliveryPolicy validation at the RPC boundary (clear error).
  if ("defaultDeliveryPolicy" in out) {
    const v = out.defaultDeliveryPolicy;
    if (v !== "manual" && v !== "bypass" && v !== "agent-decide") {
      throw new RpcError(-32602, `Invalid defaultDeliveryPolicy: ${String(v)}`, {
        code: "INVALID_DELIVERY_POLICY",
      });
    }
  }
  return out;
}

function projectWorkspaceSettings(settings: WorkspaceSettings): WorkspaceSettings {
  // Return a plain object projection; keep extensibility keys.
  return { ...settings };
}

function emitWorkspaceSettingsUpdated(
  ctx: HandlerContext,
  workspaceId: string,
  settings: WorkspaceSettings
): void {
  ctx.events.emit(
    "workspace.settings.updated",
    workspaceId,
    {
      settings: projectWorkspaceSettings(settings),
    },
    "self"
  );
}

// ---- workspace.agents (canonical workspace-root AGENTS.md) ----

/**
 * Read projection of workspace-root AGENTS.md.
 * Missing file → content "" + exists=false (not an error). Includes etag for edit.
 */
async function workspaceAgentsRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const file = await loadWorkspaceAgents(mount.workspaceRoot);
  return projectWorkspaceAgents(workspaceId, file);
}

/**
 * User-only AGENTS.md write through MutationBus.
 * Optional baseEtag matches docs.write conflict semantics (-32009).
 * Emits exactly one workspace.agents.updated when content actually changes.
 */
async function workspaceAgentsWriteRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "workspace.agents.write");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  if (typeof p.content !== "string") {
    throw new RpcError(-32602, "workspace.agents.write requires string content");
  }
  const content = p.content;
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const before = await loadWorkspaceAgents(mount.workspaceRoot);
    const currentEtag = contentEtag(before.content);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: WORKSPACE_AGENTS_FILENAME,
      });
    }

    ctx.host.markSelfWrite(workspaceId);
    let result: { file: WorkspaceAgentsFile; changed: boolean };
    try {
      result = await writeWorkspaceAgents(mount.workspaceRoot, content);
    } catch (err) {
      if (
        err instanceof WorkspaceAgentsError ||
        (err instanceof Error && err.name === "WorkspaceAgentsError")
      ) {
        const code =
          err instanceof WorkspaceAgentsError
            ? err.code
            : ((err as { code?: string }).code ?? "INVALID_CONTENT");
        throw new RpcError(-32602, err.message, { code });
      }
      throw err;
    }

    const projection = projectWorkspaceAgents(workspaceId, result.file);
    if (result.changed) {
      ctx.events.emit(
        "workspace.agents.updated",
        workspaceId,
        {
          path: projection.path,
          content: projection.content,
          exists: projection.exists,
          etag: projection.etag,
        },
        "self"
      );
    }
    return {
      ...projection,
      changed: result.changed,
    };
  });
}

function projectWorkspaceAgents(workspaceId: string, file: WorkspaceAgentsFile) {
  return {
    workspaceId,
    path: file.path,
    content: file.content,
    exists: file.exists,
    etag: contentEtag(file.content),
  };
}

async function docsList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const includeBody = p.includeBody === true;
  return {
    workspaceId,
    concepts: tent.roots.map((root) => projectConcept(root, includeBody, true)),
  };
}

async function docsGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept(tent, p);
  return {
    workspaceId,
    concept: projectConcept(concept, true, false),
  };
}

async function docsReadForEdit(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept(tent, p);
  const notePath = boxNotePath(concept.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { data, body } = parseFrontmatter(raw);
  return {
    workspaceId,
    id: concept.id,
    cx: concept.id,
    path: concept.path,
    name: concept.name,
    type: concept.type,
    coordination: concept.coordination,
    body,
    raw,
    etag: contentEtag(raw),
    frontmatter: data,
    artifactRefs: parseArtifactRefs(data),
  };
}

async function docsWrite(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  // Accept legacy alias `etag` as baseEtag; existing Node body/frontmatter writes require it.
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");
  const rawInput = typeof p.raw === "string" ? p.raw : undefined;
  const body = typeof p.body === "string" ? p.body : undefined;
  const frontmatter =
    p.frontmatter && typeof p.frontmatter === "object" && !Array.isArray(p.frontmatter)
      ? (p.frontmatter as Record<string, unknown>)
      : undefined;

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.write");
    const notePath = boxNotePath(concept.path);
    const diskRaw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(diskRaw);
    // Forced optimistic concurrency for existing nodes (createNote / migrate / role-init are other paths).
    if (!baseEtag) {
      throw new RpcError(-32008, "docs.write requires baseEtag for existing nodes", {
        code: "etag_required",
        currentEtag,
        path: concept.path,
        id: concept.id,
      });
    }
    if (baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        code: "etag_conflict",
        currentEtag,
        baseEtag,
        path: concept.path,
        id: concept.id,
      });
    }

    if (rawInput !== undefined) {
      const diskParsed = parseFrontmatter(diskRaw);
      const nextParsed = parseFrontmatter(rawInput);
      // Reserved identity/mode fields: raw path cannot set or change them.
      assertRawDocsWriteReserved(diskParsed.data, nextParsed.data);
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      // Only reject when protected collab projection fields actually change.
      const changed: Record<string, unknown> = {};
      for (const field of PROTECTED_COLLAB_FIELDS) {
        if (String(nextParsed.data[field] ?? "") !== String(diskParsed.data[field] ?? "")) {
          changed[field] = nextParsed.data[field];
        }
      }
      if (Object.keys(changed).length > 0) {
        assertDocsWriteAllowed(tent, concept.id, changed, tasks);
      }
      ctx.host.markSelfWrite(workspaceId);
      await mount.env.fs.writeFile(notePath, rawInput);
      // Auto-register newly used tags into tags.json via Core (not Service JSON).
      // Node detach does not prune the registry; only removeRegistryTag deletes.
      await syncTagRegistryAfterBoxTagsChange(
        mount.env.fs,
        concept.tags,
        tagsFromFrontmatterData(nextParsed.data)
      );
    } else {
      if (frontmatter) {
        assertReservedDocsWriteFields(frontmatter);
        assertDocsWriteAllowed(tent, concept.id, frontmatter, await loadTaskEnvelopes(mount.env.fs));
      }

      ctx.host.markSelfWrite(workspaceId);
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        // patchBox → Core auto-registers new tags when present
        await patchBox(mount.env, concept.path, frontmatter, tent);
      }
      if (body !== undefined) {
        await patchBody(mount.env, concept.path, body, tent);
      }
      if (body === undefined && (!frontmatter || Object.keys(frontmatter).length === 0)) {
        throw new RpcError(-32602, "docs.write requires raw, body, and/or frontmatter");
      }
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.write" },
      "self"
    );
    // Success: new etag only — clients already hold the written buffer; errors never include body.
    return {
      workspaceId,
      id: concept.id,
      cx: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * Sole Service surface for Node mode transitions.
 * Core setNodeMode enforces freeze/archive-root rules.
 */
async function docsSetMode(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const modeRaw = requireString(p, "mode");
  if (modeRaw !== "editable" && modeRaw !== "read-only" && modeRaw !== "archived") {
    throw new RpcError(-32602, 'docs.setMode mode must be "editable", "read-only", or "archived"');
  }
  const mode = modeRaw as NodeMode;

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    ctx.host.markSelfWrite(workspaceId);
    try {
      await setNodeMode(mount.env, concept.id, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : "docs.setMode failed";
      if (/not found/i.test(message)) throw new RpcError(-32004, message);
      if (
        /mode must be|Invalid boxes|archive root|already archived|Claimed ranges|restored to editable/i.test(
          message
        )
      ) {
        throw new RpcError(-32602, message);
      }
      throw new RpcError(-32000, message);
    }
    const after = await loadTent(mount.env.fs);
    const updated = after.byId.get(concept.id);
    if (!updated) throw new RpcError(-32004, `Concept not found after setMode: ${concept.id}`);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: updated.id, path: updated.path, reason: "docs.setMode", mode: updated.mode },
      "self"
    );
    return {
      workspaceId,
      id: updated.id,
      cx: updated.id,
      path: updated.path,
      mode: updated.mode,
      archived: updated.archived,
      concept: projectConcept(updated, false, false),
    };
  });
}

async function docsSearch(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const query = optionalString(p, "query") ?? optionalString(p, "q") ?? "";
  const q = query.trim().toLowerCase();
  if (!q) return { workspaceId, hits: [] as unknown[] };

  const tent = await loadTent(mount.env.fs);
  const hits: Array<{
    cx: string;
    path: string;
    name: string;
    title?: string;
    snippet: string;
    match: "title" | "body" | "path";
  }> = [];

  for (const box of tent.byId.values()) {
    if (box.archived || box.invalid) continue;
    const title = typeof box.fm.title === "string" ? box.fm.title : box.name;
    if (box.name.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: title,
        match: "title",
      });
      continue;
    }
    if (box.path.toLowerCase().includes(q)) {
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: box.path,
        match: "path",
      });
      continue;
    }
    const body = box.body ?? "";
    const idx = body.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + q.length + 40);
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: body.slice(start, end).replace(/\s+/g, " ").trim(),
        match: "body",
      });
    }
  }
  return { workspaceId, hits: hits.slice(0, 50) };
}

async function docsBacklinks(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept(tent, p);
  const concepts = [...tent.byId.values()].map((b) => ({
    id: b.id,
    path: b.path,
    name: b.name,
    body: b.body,
    notePath: boxNotePath(b.path),
  }));
  const reverse = buildBacklinkIndex(concepts);
  return {
    workspaceId,
    cx: concept.id,
    backlinks: reverse.get(concept.id) ?? [],
  };
}

/** Read-only type registry projection (coordination capability for desktop pickers). */
async function registryTypes(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadTypeRegistry(mount.env.fs);
  const types: TypeRegistryEntryProjection[] = Object.entries(registry)
    .map(([name, def]) => {
      const tier: "base" | "modifier" = def.tier === "modifier" ? "modifier" : "base";
      const coordination =
        tier === "base" && "coordination" in def ? def.coordination === true : false;
      return {
        name,
        tier,
        readable: def.readable,
        writable: def.writable,
        coordination,
        color: def.color,
        description: def.description,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, types };
}

/** Read-only role registry projection (dispatch target picker). */
async function registryRoles(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadRolesRegistry(mount.env.fs);
  const roles: RoleRegistryEntryProjection[] = registry.roles
    .map((role) => projectRoleRegistryEntry(role))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, roles };
}

function projectRoleRegistryEntry(role: RoleDefinition): RoleRegistryEntryProjection {
  const proj: RoleRegistryEntryProjection = {
    roleId: role.id ?? "",
    name: role.name,
    displayName: role.displayName || role.name,
    description: role.description,
    color: role.color,
    prompt: role.prompt,
    a2aPolicy: roleA2APolicy(role),
  };
  if (role.allowedProfiles && role.allowedProfiles.length > 0) {
    proj.allowedProfiles = [...role.allowedProfiles];
  }
  return proj;
}

/**
 * User-only role registry create. MutationBus; emits registry.roles.updated once on success.
 * Server assigns immutable roleId; operational name is fixed in this batch; displayName is mutable.
 */
async function registryRoleCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.role.create");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  if ("id" in p || "roleId" in p) {
    throw new RpcError(
      -32602,
      "registry.role.create does not accept client-supplied id/roleId; server assigns rl- handles"
    );
  }
  const definition = parseRoleDefinitionParams(p, { requireName: true });

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await createRole(mount.env.fs, definition);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.create");
    }
    const registry = await loadRolesRegistry(mount.env.fs);
    const role = resolveRole(registry.roles, definition.name);
    if (!role) {
      throw new RpcError(-32000, `Role create succeeded but role not found: ${definition.name}`);
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "create",
      name: role.name,
      roleId: role.id || "",
      displayName: role.displayName || role.name,
    });
    return { workspaceId, role: projectRoleRegistryEntry(role) };
  });
}

/**
 * User-only role registry update. Resolve by name (compat) or roleId.
 * Cannot change id or operational name; displayName and metadata may change.
 * MutationBus; emits registry.roles.updated once on success.
 */
async function registryRoleUpdate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.role.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  // Identity ref: prefer roleId when provided; else name (legacy operational key).
  const ref =
    typeof p.roleId === "string" && p.roleId.trim()
      ? p.roleId.trim()
      : requireString(p, "name");
  if (p.rename !== undefined || (typeof p.newName === "string" && p.newName.trim())) {
    throw new RpcError(
      -32602,
      "registry.role.update cannot rename operational name in this batch; pass displayName to change the label"
    );
  }
  if (typeof p.patch === "object" && p.patch !== null && !Array.isArray(p.patch)) {
    throw new RpcError(
      -32602,
      "registry.role.update does not accept nested patch; pass fields at the top level with name or roleId"
    );
  }
  if ("id" in p) {
    throw new RpcError(-32602, "registry.role.update cannot change id; role id is immutable");
  }
  const patch = parseRoleDefinitionParams(p, { requireName: false, forUpdate: true });
  // Strip identity keys. Also drop displayName unless the client sent it —
  // normalizeRoleDefinition invents displayName from name, which would wipe a
  // prior custom label on unrelated field updates.
  const { name: _ignoredName, id: _ignoredId, displayName: _ignoredDn, ...fields } = patch;
  const updatePatch: Partial<RoleDefinition> = { ...fields };
  for (const key of ["prompt", "description", "color"] as const) {
    if (key in p && (p[key] === null || (typeof p[key] === "string" && !p[key].trim()))) {
      updatePatch[key] = undefined;
    }
  }
  if ("displayName" in p) {
    if (p.displayName === null || (typeof p.displayName === "string" && !p.displayName.trim())) {
      updatePatch.displayName = undefined;
    } else if (typeof p.displayName === "string") {
      updatePatch.displayName = p.displayName;
    }
  }
  if ("a2aPolicy" in p && (p.a2aPolicy === null || p.a2aPolicy === "")) {
    updatePatch.a2aPolicy = undefined;
  }
  if ("allowedProfiles" in p) {
    updatePatch.allowedProfiles = normalizeAllowedProfiles(
      Array.isArray(p.allowedProfiles) ? p.allowedProfiles : []
    );
  }
  if ("cli" in p && p.cli === null) {
    updatePatch.cli = undefined;
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await updateRole(mount.env.fs, ref, updatePatch);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.update");
    }
    const registry = await loadRolesRegistry(mount.env.fs);
    const role = resolveRole(registry.roles, ref);
    if (!role) {
      throw new RpcError(-32004, `Role does not exist: ${ref}`);
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "update",
      name: role.name,
      roleId: role.id || "",
      displayName: role.displayName || role.name,
    });
    return { workspaceId, role: projectRoleRegistryEntry(role) };
  });
}

/**
 * User-only role registry delete. Requires confirmation === operational name or roleId.
 * Refuses when the role has an active task or a live/starting/waiting-user managed session.
 * MutationBus; emits registry.roles.updated once on success. Failure emits nothing.
 */
async function registryRoleDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.role.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const ref =
    typeof p.roleId === "string" && p.roleId.trim()
      ? p.roleId.trim()
      : requireString(p, "name");
  const confirmation = requireString(p, "confirmation");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);

    const registry = await loadRolesRegistry(mount.env.fs);
    const existing = resolveRole(registry.roles, ref);
    if (!existing) {
      throw new RpcError(-32004, `Role does not exist: ${ref}`);
    }
    const roleId = existing.id || "";
    if (confirmation !== existing.name && confirmation !== roleId) {
      throw new RpcError(
        -32602,
        `Confirmation mismatch; enter the role name ${existing.name} or id ${roleId}.`,
        { name: existing.name, roleId, confirmation }
      );
    }

    const tasks = await loadTaskEnvelopes(mount.env.fs);
    // Only durable role tasks block role delete — profile tasks may reuse the same label.
    // Match operational name (task.role) and future roleId if present on envelope.
    const activeTask = tasks.find(
      (t) =>
        taskAssigneeKind(t) === "role" &&
        isActiveTaskState(t.state) &&
        (t.role === existing.name || (roleId !== "" && t.role === roleId))
    );
    if (activeTask) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Cannot delete role "${existing.name}": active task ${activeTask.path} (state=${activeTask.state})`,
        {
          role: existing.name,
          roleId,
          taskPath: activeTask.path,
          taskState: activeTask.state,
        }
      );
    }

    const activeSession = await findActiveManagedSessionForRole(ctx, workspaceId, existing.name);
    if (activeSession) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Cannot delete role "${existing.name}": active managed session ${activeSession.id} (state=${activeSession.state})`,
        {
          role: existing.name,
          roleId,
          sessionId: activeSession.id,
          sessionState: activeSession.state,
        }
      );
    }

    try {
      await deleteRole(mount.env.fs, roleId || existing.name, confirmation);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.delete");
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "delete",
      name: existing.name,
      roleId,
      displayName: existing.displayName || existing.name,
    });
    return {
      workspaceId,
      deleted: existing.name,
      roleId,
      displayName: existing.displayName || existing.name,
    };
  });
}

function emitRegistryRolesUpdated(
  ctx: HandlerContext,
  workspaceId: string,
  payload: {
    action: "create" | "update" | "delete";
    name: string;
    roleId: string;
    displayName: string;
  }
): void {
  ctx.events.emit(
    "registry.roles.updated",
    workspaceId,
    {
      action: payload.action,
      name: payload.name,
      roleId: payload.roleId,
      displayName: payload.displayName,
    },
    "self"
  );
}

/**
 * Parse role definition fields from top-level RPC params.
 * Never accepts credentials / secret-shaped keys.
 */
function parseRoleDefinitionParams(
  p: Record<string, unknown>,
  opts: { requireName: boolean; forUpdate?: boolean }
): RoleDefinition {
  for (const banned of [
    "secret",
    "secrets",
    "token",
    "apiKey",
    "api_key",
    "password",
    "credential",
    "credentials",
    "env",
  ]) {
    if (banned in p) {
      throw new RpcError(
        -32602,
        `registry.role.* does not accept ${banned}; roles store ids/policy only, never credentials`
      );
    }
  }
  if ("role" in p && typeof p.role === "object" && p.role !== null) {
    throw new RpcError(
      -32602,
      "registry.role.* does not accept nested role; pass fields at the top level"
    );
  }

  const raw: Record<string, unknown> = {};
  if (opts.requireName || typeof p.name === "string") {
    raw.name = requireString(p, "name");
  } else if (!opts.forUpdate) {
    throw new RpcError(-32602, "Missing string param: name");
  } else {
    // update uses name as identity; body fields optional
    raw.name = "";
  }

  if ("displayName" in p) {
    if (p.displayName !== undefined && p.displayName !== null && typeof p.displayName !== "string") {
      throw new RpcError(-32602, "Invalid string param: displayName");
    }
    if (typeof p.displayName === "string") raw.displayName = p.displayName;
  }
  if ("prompt" in p) {
    if (p.prompt !== undefined && p.prompt !== null && typeof p.prompt !== "string") {
      throw new RpcError(-32602, "Invalid string param: prompt");
    }
    if (typeof p.prompt === "string") raw.prompt = p.prompt;
  }
  if ("description" in p) {
    if (p.description !== undefined && p.description !== null && typeof p.description !== "string") {
      throw new RpcError(-32602, "Invalid string param: description");
    }
    if (typeof p.description === "string") raw.description = p.description;
  }
  if ("color" in p) {
    if (p.color !== undefined && p.color !== null && typeof p.color !== "string") {
      throw new RpcError(-32602, "Invalid string param: color");
    }
    if (typeof p.color === "string") raw.color = p.color;
  }
  if ("a2aPolicy" in p) {
    if (p.a2aPolicy === null || p.a2aPolicy === "") {
      // explicit clear → omit (effective deny)
    } else if (p.a2aPolicy === "allow" || p.a2aPolicy === "ask" || p.a2aPolicy === "deny") {
      raw.a2aPolicy = p.a2aPolicy;
    } else {
      throw new RpcError(-32602, `Invalid a2aPolicy: ${String(p.a2aPolicy)}`);
    }
  }
  if ("allowedProfiles" in p) {
    if (p.allowedProfiles === null) {
      raw.allowedProfiles = [];
    } else if (!Array.isArray(p.allowedProfiles)) {
      throw new RpcError(-32602, "allowedProfiles must be an array of profile id strings");
    } else {
      for (const item of p.allowedProfiles) {
        if (typeof item !== "string") {
          throw new RpcError(-32602, "allowedProfiles must be an array of profile id strings");
        }
      }
      // Normalize here so invalid empties become [] (clear) rather than silent ignore.
      raw.allowedProfiles = normalizeAllowedProfiles(p.allowedProfiles) ?? [];
    }
  }
  if ("cli" in p) {
    if (p.cli === null) {
      // Explicit clear is re-attached to the update patch after normalization.
    } else if (typeof p.cli !== "object" || Array.isArray(p.cli)) {
      throw new RpcError(-32602, "role.cli must be an object");
    } else {
      raw.cli = p.cli;
    }
  }

  try {
    const role = normalizeRoleDefinition(raw);
    if (opts.requireName && !role.name) {
      throw new RpcError(-32602, "Role name cannot be empty.");
    }
    // For update with allowedProfiles: [] we need to pass empty to clear — core
    // normalize drops empty, so re-attach when caller explicitly set the field.
    if ("allowedProfiles" in p) {
      const normalized = normalizeAllowedProfiles(
        Array.isArray(p.allowedProfiles) ? p.allowedProfiles : []
      );
      if (normalized) role.allowedProfiles = normalized;
      else delete role.allowedProfiles;
    }
    return role;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : "Invalid role definition";
    throw new RpcError(-32602, message);
  }
}

function mapRoleRegistryError(err: unknown, surface: string): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (
    /already exists|does not exist|Confirmation mismatch|cannot be empty|cli\.|immutable|cannot be renamed/i.test(
      message
    )
  ) {
    if (/does not exist/i.test(message)) {
      return new RpcError(-32004, message);
    }
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

/**
 * Machine-local AgentProfile catalog for desktop launch picker / editor.
 * Safe projection only — no env maps, API keys, tokens, or secret values.
 * Optional includeTest: when true, also return fake/harness profiles (tests/dev).
 * Default product list hides testOnly profiles so fake is not a product default.
 */
async function profileList(ctx: HandlerContext, p: Record<string, unknown>) {
  const includeTest = p.includeTest === true;
  const catalog = ctx.profileCatalog.list();
  const existsMap = await credentialExistsLookup(ctx, catalog);
  // Single source of truth: injected catalog only (no runtime/disk fallback).
  let profiles = projectAgentProfiles(catalog, { credentialExistsById: existsMap });
  if (!includeTest) {
    profiles = profiles.filter((pr) => !pr.testOnly);
  }
  return { profiles };
}

async function profileGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const id = requireString(p, "id");
  const profile = ctx.profileCatalog.get(id);
  if (!profile) {
    throw new RpcError(-32004, `Profile not found: ${id}`);
  }
  return {
    profile: projectAgentProfile(
      profile,
      await profileCredentialExistsOpts(ctx, profile)
    ),
  };
}

async function profileCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  // Single top-level shape: create fields directly on params (no nested profile).
  if ("profile" in p) {
    throw new RpcError(
      -32602,
      "profile.create does not accept nested profile; pass fields at the top level"
    );
  }
  const created = await ctx.profileCatalog.create(p);
  const profile = projectAgentProfile(
    created,
    await profileCredentialExistsOpts(ctx, created)
  );
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "create", id: created.id, profile },
    "self"
  );
  return {
    profile,
  };
}

async function profileUpdate(ctx: HandlerContext, p: Record<string, unknown>) {
  // Single top-level shape: { id, ...patch } (no nested profile).
  if ("profile" in p) {
    throw new RpcError(
      -32602,
      "profile.update does not accept nested profile; pass { id, ...patch }"
    );
  }
  const id = requireString(p, "id");
  const { id: _id, ...patch } = p;
  const updated = await ctx.profileCatalog.update(id, patch);
  const profile = projectAgentProfile(
    updated,
    await profileCredentialExistsOpts(ctx, updated)
  );
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "update", id: updated.id, profile },
    "self"
  );
  return {
    profile,
  };
}

async function profileDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  const id = requireString(p, "id");
  const result = await ctx.profileCatalog.delete(id);
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "delete", id: result.deleted },
    "self"
  );
  return result;
}

async function credentialExistsLookup(
  ctx: HandlerContext,
  profiles: Array<{ acp?: { credentialRef?: string } }>
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  for (const p of profiles) {
    const ref =
      typeof p.acp?.credentialRef === "string" ? p.acp.credentialRef.trim() : "";
    if (ref && !map.has(ref)) {
      map.set(ref, await ctx.credentials.has(ref));
    }
  }
  return map;
}

async function profileCredentialExistsOpts(
  ctx: HandlerContext,
  profile: { acp?: { credentialRef?: string } }
): Promise<{ credentialExists: boolean } | undefined> {
  const ref =
    typeof profile.acp?.credentialRef === "string" && profile.acp.credentialRef.trim()
      ? profile.acp.credentialRef.trim()
      : undefined;
  if (!ref) return undefined;
  return { credentialExists: await ctx.credentials.has(ref) };
}

/**
 * Read-only product provider verification catalog (provider.catalog).
 * Machine-global product facts — no workspaceId, no secrets, no profile config.
 */
function providerCatalogRpc(): ProviderCatalogProjection {
  return projectProviderCatalog();
}

/**
 * Machine-local credential vault RPCs — user-only loopback surface.
 * set accepts secret in params but response/events/errors never echo it.
 * No credential.get / resolve on the client surface.
 */
async function credentialList(ctx: HandlerContext) {
  const credentials = await ctx.credentials.list();
  return { credentials };
}

async function credentialSet(ctx: HandlerContext, p: Record<string, unknown>) {
  if ("credential" in p) {
    throw new RpcError(
      -32602,
      "credential.set does not accept nested credential; pass { id, secret, metadata? } or { id, secret, label? }"
    );
  }
  const id = requireString(p, "id");
  // Accept secret only as a string param; never log or re-emit it.
  if (!("secret" in p) || typeof p.secret !== "string" || p.secret.length === 0) {
    throw new RpcError(-32602, "Missing or invalid string param: secret");
  }
  const secret = p.secret;
  // metadata bag or top-level label (both non-secret).
  let metadata: { label?: string } | undefined;
  if ("metadata" in p && p.metadata !== undefined && p.metadata !== null) {
    if (typeof p.metadata !== "object" || Array.isArray(p.metadata)) {
      throw new RpcError(-32602, "Invalid metadata: must be a plain object when set");
    }
    metadata = p.metadata as { label?: string };
  } else if ("label" in p && p.label !== undefined && p.label !== null) {
    if (typeof p.label !== "string") {
      throw new RpcError(-32602, "Invalid string param: label");
    }
    metadata = { label: p.label };
  }
  try {
    const credential = await ctx.credentials.set(id, secret, metadata);
    // Safe event: id/metadata only — never secret.
    ctx.events.emit(
      "credential.changed",
      "",
      {
        action: "set",
        id: credential.id,
        updatedAt: credential.updatedAt,
        ...(credential.metadata ? { metadata: credential.metadata } : {}),
      },
      "self"
    );
    return { credential };
  } catch (err) {
    // Sanitize: never include secret in error message/data.
    const message = err instanceof Error ? err.message : "credential.set failed";
    if (secret && message.includes(secret)) {
      throw new RpcError(-32602, "credential.set failed");
    }
    if (
      /Invalid credential id|Missing or invalid credential|credential secret|metadata|must match/i.test(
        message
      )
    ) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32000, message);
  }
}

async function credentialDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  const id = requireString(p, "id");
  try {
    const result = await ctx.credentials.delete(id);
    ctx.events.emit(
      "credential.changed",
      "",
      { action: "delete", id: result.deleted },
      "self"
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "credential.delete failed";
    if (/not found/i.test(message)) {
      throw new RpcError(-32004, message);
    }
    if (/Invalid credential id|Missing or invalid credential/i.test(message)) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32000, message);
  }
}

/**
 * Machine-local bundled skill surface — no workspaceId.
 * Only lists/installs package bundled skills into shared-agents + claude dirs.
 * Rejects arbitrary source/destination; skill names and targets are strictly validated.
 */
async function skillList(ctx: HandlerContext) {
  try {
    return await listSkills({ packageRoot: ctx.packageRoot, home: ctx.home });
  } catch (err) {
    const message = err instanceof Error ? err.message : "skill.list failed";
    throw new RpcError(-32000, message);
  }
}

async function skillInstall(ctx: HandlerContext, p: Record<string, unknown>) {
  // Refuse path-like params so RPC cannot install from/to arbitrary locations.
  for (const banned of ["source", "destination", "dest", "dir", "targetDir", "targetDirs", "path"]) {
    if (banned in p) {
      throw new RpcError(
        -32602,
        `skill.install does not accept ${banned}; only skills[], targets[], force`
      );
    }
  }
  if ("workspaceId" in p && p.workspaceId !== undefined && p.workspaceId !== null) {
    throw new RpcError(-32602, "skill.install is machine-local and does not accept workspaceId");
  }

  let skills: string[] | undefined;
  if ("skills" in p && p.skills !== undefined && p.skills !== null) {
    if (!Array.isArray(p.skills) || !p.skills.every((s) => typeof s === "string")) {
      throw new RpcError(-32602, "Invalid skills: must be an array of strings when set");
    }
    skills = p.skills as string[];
  }

  let targets: SkillTargetId[] | undefined;
  if ("targets" in p && p.targets !== undefined && p.targets !== null) {
    if (!Array.isArray(p.targets) || !p.targets.every((t) => typeof t === "string")) {
      throw new RpcError(-32602, "Invalid targets: must be an array of strings when set");
    }
    try {
      targets = (p.targets as string[]).map((t) => parseSkillTargetId(t));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid targets";
      throw new RpcError(-32602, message);
    }
  }

  let force = false;
  if ("force" in p && p.force !== undefined && p.force !== null) {
    if (typeof p.force !== "boolean") {
      throw new RpcError(-32602, "Invalid force: must be a boolean when set");
    }
    force = p.force;
  }

  try {
    const results = await installSkills({
      packageRoot: ctx.packageRoot,
      home: ctx.home,
      skills,
      targets,
      force,
    });
    ctx.events.emit(
      "skill.changed",
      "",
      {
        action: "install",
        installed: results.filter((r) => r.status === "installed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
      },
      "self"
    );
    return { results };
  } catch (err) {
    const message = err instanceof Error ? err.message : "skill.install failed";
    if (
      /Invalid skill name|Unknown skill target|Unknown bundled skill|escapes the destination/i.test(
        message
      )
    ) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32000, message);
  }
}

async function docsCreateNote(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const type = optionalString(p, "type") ?? "note";
  const parentPath = optionalString(p, "parentPath") ?? "";
  const body = typeof p.body === "string" ? p.body : undefined;

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const id = await createBox(mount.env, { parentPath, name, type });
    const notePath = parentPath ? `${parentPath}/${name}` : name;
    if (body !== undefined) {
      await patchBody(mount.env, notePath, body.endsWith("\n") ? body : body + "\n");
    }
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id, path: notePath, reason: "docs.createNote" },
      "self"
    );
    return { workspaceId, id, path: notePath, type };
  });
}

/**
 * Store original attachment bytes under attachments/<cx>/….
 * Wire transport is base64 (`bytesBase64` preferred; `contentBase64` accepted).
 * No .b64 companion files; disk is the decoded binary payload.
 */
async function docsImportAttachment(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const fileName = requireString(p, "fileName");
  const rawBase64 =
    typeof p.bytesBase64 === "string"
      ? p.bytesBase64
      : typeof p.contentBase64 === "string"
        ? p.contentBase64
        : typeof p.bytes === "string"
          ? p.bytes
          : undefined;
  if (rawBase64 === undefined) {
    throw new RpcError(
      -32602,
      "docs.importAttachment requires bytesBase64 (base64-encoded file bytes)"
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = rawBase64 === "" ? new Uint8Array() : decodeBase64Strict(rawBase64);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid base64";
    throw new RpcError(-32602, message);
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RpcError(
      -32602,
      `Attachment exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes (${bytes.byteLength} bytes)`,
      { maxBytes: MAX_ATTACHMENT_BYTES, byteLength: bytes.byteLength }
    );
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.importAttachment");
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await storeAttachmentBytes(
        mount.env.fs,
        concept.id,
        fileName,
        bytes,
        boxNotePath(concept.path)
      );
      return {
        workspaceId,
        id: concept.id,
        cx: concept.id,
        relativePath: result.relativePath,
        markdown: result.markdown,
        artifactRef: result.artifactRef,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "importAttachment failed";
      if (/exceeds max size|Invalid base64|path rejected|file name/i.test(message)) {
        throw new RpcError(-32602, message);
      }
      throw new RpcError(-32000, message);
    }
  });
}

async function docsPromote(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const toType = requireString(p, "toType");
  const idOrPath = optionalString(p, "id") ?? optionalString(p, "path") ?? requireString(p, "concept");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await promoteConcept(mount.env, idOrPath, toType);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: result.id, path: result.path, reason: "docs.promote", toType },
      "self"
    );
    return { workspaceId, ...result };
  });
}

async function docsFork(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "id") ?? optionalString(p, "boxId") ?? requireString(p, "path");

  return ctx.mutations.run(workspaceId, async () => {
    let id = boxId;
    if (!id.startsWith("cx-") && !id.startsWith("bx-")) {
      const tent = await loadTent(mount.env.fs);
      const box = tent.byPath.get(boxId);
      if (!box) throw new RpcError(-32004, `Concept not found: ${boxId}`);
      id = box.id;
    }
    ctx.host.markSelfWrite(workspaceId);
    const forkRootId = await forkNode(mount.env, id);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: forkRootId, reason: "docs.fork", forkOf: id },
      "self"
    );
    return { workspaceId, id: forkRootId, forkOf: id };
  });
}

/**
 * User-only atomic concept rename.
 * MutationBus; keeps cx- immutable; moves folder + identity note; rewrites path links.
 * Success emits exactly one concept.changed (reason docs.rename) with oldPath/path.
 */
async function docsRename(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.rename");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const newName = requireString(p, "newName");
  if ("id" in p && p.id !== undefined && p.id !== null && typeof p.id !== "string") {
    throw new RpcError(-32602, "docs.rename id must be a string when set");
  }
  // Client cannot supply a replacement identity — only a new display/path stem.
  if ("newId" in p) {
    throw new RpcError(-32602, "docs.rename cannot change concept id; cx- is immutable");
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await renameNode(mount.env, concept.id, newName);
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        {
          id: result.id,
          path: result.path,
          oldPath: result.oldPath,
          name: result.name,
          reason: "docs.rename",
          pathMap: result.pathMap,
        },
        "self"
      );
      return {
        workspaceId,
        id: result.id,
        cx: result.id,
        path: result.path,
        oldPath: result.oldPath,
        name: result.name,
        pathMap: result.pathMap,
        rewrittenNotes: result.rewrittenNotes,
      };
    } catch (err) {
      throw mapDocsRenameError(err);
    }
  });
}

function mapDocsRenameError(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : "docs.rename failed";
  if (/not found/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (
    /already exists|cannot be empty|path separators|control characters|newlines|longer than|Invalid or archived|Claimed ranges|Cannot rename|System directories|system pipelines|sibling concept|Identity note missing|id drift|immutable/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

// ---- task.* ----

async function taskDispatch(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId") ?? optionalString(p, "id") ?? requireString(p, "claimId");
  const assigneeKindRaw = optionalString(p, "assigneeKind");
  const assigneeKind =
    assigneeKindRaw === "agentProfile" ? "agentProfile" : assigneeKindRaw === "role" || !assigneeKindRaw
      ? "role"
      : (() => {
          throw new RpcError(-32602, `Invalid assigneeKind: ${assigneeKindRaw}`);
        })();
  const role = optionalString(p, "role");
  const profileId = optionalString(p, "profileId");
  const prompt = requireString(p, "prompt");
  const dispatchedBy = optionalString(p, "dispatchedBy");
  const asSub = p.asSub === true;
  const explicitDeliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }

  if (assigneeKind === "role" && !role) {
    throw new RpcError(-32602, "task.dispatch with assigneeKind=role requires role");
  }
  if (assigneeKind === "agentProfile" && !profileId) {
    throw new RpcError(-32602, "task.dispatch with assigneeKind=agentProfile requires profileId");
  }
  if (assigneeKind === "agentProfile" && role && role !== profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with assigneeKind=agentProfile must not pass a different role; profileId is the assignee label"
    );
  }
  if (assigneeKind === "agentProfile" && !ctx.profileCatalog.get(profileId!)) {
    throw new RpcError(-32004, `Profile not found: ${profileId}`);
  }
  if (startSession && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with startSession requires explicit profileId (no fake-default fallback)"
    );
  }

  // P0-1: role worktree create/reuse + envelope dispatch share the workspace MutationBus
  // critical section so concurrent role worktree add cannot race. Git ops stay inside the
  // bus action (never nested mutations.run).
  // Peer profile tasks: lane deferred until startSession (tent-task/<taskId>).
  // Sub profile tasks: allocate taskId + create task lane at dispatch (target = dispatcher).
  // When deliveryPolicy is omitted, snapshot current workspace default into the task
  // envelope at dispatch time (settings changes never rewrite existing tasks).
  const result = await ctx.mutations.run(workspaceId, async () => {
    const assigneeLabel = assigneeKind === "agentProfile" ? profileId! : role!;
    // Keep registry/Git validation in the same workspace mutation section as lane
    // creation and envelope persistence. Otherwise a concurrent role update could
    // invalidate a check made just before entering the bus.
    if (asSub) {
      await assertSubDispatchPreconditions(mount.env.fs, {
        workspaceRoot: mount.workspaceRoot,
        dispatcher: dispatchedBy,
        assigneeKind,
        assigneeLabel,
      });
    }
    let workspaceLane: RoleWorkspaceContract | undefined;
    let preallocatedTaskId: string | undefined;

    if (asSub) {
      // Dispatcher lane must exist so targetBranch is a real checked-out worktree.
      const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, dispatchedBy!.trim());
      if (assigneeKind === "role") {
        const assigneeLane = await ensureRoleWorkspace(mount.workspaceRoot, assigneeLabel);
        workspaceLane = { ...assigneeLane, targetBranch: dispatcherLane.branch };
      } else {
        // Profile sub: allocate taskId before lane creation; peer profile stays deferred.
        preallocatedTaskId = makeTaskId();
        workspaceLane = await ensureTaskWorkspace(
          mount.workspaceRoot,
          preallocatedTaskId,
          { targetBranch: dispatcherLane.branch }
        );
      }
    } else if (assigneeKind === "role") {
      // Peer role: durable tent-role lane when Git; pure Tent otherwise.
      workspaceLane = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, assigneeLabel);
    }
    // Peer profile: no lane at dispatch (deferred to startSession).

    ctx.host.markSelfWrite(workspaceId);
    let deliveryPolicy = explicitDeliveryPolicy;
    if (deliveryPolicy === undefined) {
      const settings = await loadWorkspaceSettings(mount.env.fs);
      deliveryPolicy = settings.defaultDeliveryPolicy;
    }
    const dispatched = await dispatch(mount.env, boxId, assigneeKind === "role" ? role : undefined, {
      userPrompt: prompt,
      dispatchedBy,
      asSub,
      deliveryPolicy,
      workspace: workspaceLane,
      assigneeKind,
      profileId: assigneeKind === "agentProfile" ? profileId : undefined,
      ...(preallocatedTaskId ? { taskId: preallocatedTaskId } : {}),
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched.taskPath,
        state: "queued",
        role: dispatched.assignee,
        assigneeKind: dispatched.assigneeKind,
        boxId,
        reason: "task.dispatch",
      },
      "self"
    );
    return { dispatched, workspaceLane };
  });
  const workspaceLane = result.workspaceLane;
  const dispatched = result.dispatched;

  let session: unknown = undefined;
  if (startSession) {
    // Claim then startSession so running+sessionId bind together.
    // Do not pass relayPrompt as bootstrap — relay still tells external agents to claim+deliver;
    // startSession builds managed bootstrap (Context Card + user prompt; auto-deliver on end).
    await taskClaimRpc(ctx, {
      workspaceId,
      taskPath: dispatched.taskPath,
    });
    session = await taskStartSessionRpc(ctx, {
      workspaceId,
      taskPath: dispatched.taskPath,
      profileId,
      callerKind,
    });
  }

  const taskAfter = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath).catch(() => null);
  return {
    workspaceId,
    taskPath: dispatched.taskPath,
    manifestPath: dispatched.manifestPath,
    initPath: dispatched.initPath,
    relayPrompt: dispatched.relayPrompt,
    assigneeKind: dispatched.assigneeKind,
    assignee: dispatched.assignee,
    asSub: taskAfter ? taskAsSub(taskAfter) : asSub,
    state: startSession ? "running" : "queued",
    session,
    workspaceLane: taskAfter ? projectTask(taskAfter).workspaceLane : workspaceLane
      ? {
          workspace: workspaceLane.workspace,
          worktree: workspaceLane.worktree,
          branch: workspaceLane.branch,
          targetBranch: workspaceLane.targetBranch,
        }
      : undefined,
  };
}

/**
 * Fail before lane/envelope creation for asSub dispatch.
 * Requires durable registry dispatcher role (not user, not the assignee itself),
 * and a real Git workspace. Soft policy only — not cryptographic auth.
 */
async function assertSubDispatchPreconditions(
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    workspaceRoot: string;
    dispatcher: string | undefined;
    assigneeKind: "role" | "agentProfile";
    assigneeLabel: string;
  }
): Promise<void> {
  const dispatcher = (input.dispatcher || "").trim();
  if (!dispatcher || dispatcher === "user") {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires dispatchedBy naming a real durable registry role (not user)"
    );
  }
  if (dispatcher === input.assigneeLabel) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub dispatchedBy must not equal the assignee itself",
      { dispatchedBy: dispatcher, assignee: input.assigneeLabel }
    );
  }
  const registry = await loadRolesRegistry(fs);
  const role = resolveRole(registry.roles, dispatcher);
  if (!role) {
    throw new RpcError(
      -32602,
      `task.dispatch asSub dispatchedBy role not found in registry: ${dispatcher}`,
      { dispatchedBy: dispatcher }
    );
  }
  if (!(await isGitWorkspace(input.workspaceRoot))) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires a real Git workspace lane; pure Tent / non-Git workspaces cannot host sub dispatch"
    );
  }
}

async function taskClaimRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const sessionId = optionalString(p, "sessionId");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskClaim(mount.env, taskPath, { sessionId });
    emitTaskState(ctx, workspaceId, task, "task.claim");
    for (const claimId of task.claims) {
      if (claimId === "root") continue;
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        { id: claimId, reason: "task.claim-projection" },
        "self"
      );
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(task),
      state: task.state,
      role: task.role,
      claims: task.claims,
      sessionId: task.sessionId,
    };
  });
}

async function taskWaitRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const reason = requireString(p, "reason") as WaitReason;
  const summary = requireString(p, "summary");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskWait(mount.env, taskPath, { reason, summary });
    emitTaskState(ctx, workspaceId, task, "task.wait");
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}

async function taskResumeRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskResume(mount.env, taskPath);
    emitTaskState(ctx, workspaceId, task, "task.resume");
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}

/**
 * A2U: create one pending business UserAsk and park the task on waiting(user-input).
 * Not tool permission, not chat. Same task may have at most one pending business ask.
 */
async function taskAskUserRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const question = requireString(p, "question").trim();
  if (!question) {
    throw new RpcError(-32602, "task.askUser requires non-empty question");
  }
  const choices = parseUserAskChoices(p.choices);
  const existing = await ctx.userAsks.getPendingForTask(workspaceId, taskPath);
  if (existing) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Task already has a pending UserAsk (${existing.id})`,
      { askId: existing.id, workspaceId, taskPath }
    );
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, taskPath);
    if (current.state !== "running") {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.askUser requires running task (state=${current.state})`,
        { taskPath, state: current.state }
      );
    }
    // Re-check under mutation lock so concurrent askUser cannot create two pendings.
    const again = await ctx.userAsks.getPendingForTask(workspaceId, taskPath);
    if (again) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Task already has a pending UserAsk (${again.id})`,
        { askId: again.id, workspaceId, taskPath }
      );
    }
    const now = new Date().toISOString();
    const ask = await ctx.userAsks.add({
      id: makeUserAskId(),
      workspaceId,
      taskPath,
      taskId: current.id || undefined,
      sessionId: current.sessionId || undefined,
      role: current.role || undefined,
      question,
      ...(choices ? { choices } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const summary = `UserAsk pending: ${question.slice(0, 200)}`;
    const task = await taskWait(mount.env, taskPath, {
      reason: "user-input",
      summary,
    });
    emitTaskState(ctx, workspaceId, task, "task.askUser");
    ctx.events.emit(
      "userAsk.pending",
      workspaceId,
      {
        askId: ask.id,
        taskPath: ask.taskPath,
        taskId: ask.taskId,
        sessionId: ask.sessionId,
        role: ask.role,
        question: ask.question,
        choices: ask.choices,
        createdAt: ask.createdAt,
      },
      "self"
    );
    // Reflect waiting-user on bound managed session when present.
    if (ask.sessionId) {
      try {
        const rec = await ctx.runtime.registry.read(ask.sessionId);
        if (rec && SessionRegistry.isNonTerminal(rec.state)) {
          await ctx.runtime.registry.update(ask.sessionId, {
            state: "waiting-user",
          });
        }
      } catch {
        // session projection is best-effort
      }
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(task),
      state: task.state,
      ask: projectUserAsk(ask),
    };
  });
}

function parseUserAskChoices(raw: unknown): UserAskChoice[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new RpcError(-32602, "task.askUser choices must be an array");
  }
  if (raw.length === 0) return undefined;
  const choices: UserAskChoice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RpcError(-32602, "task.askUser choice must be {id,label}");
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!id || !label) {
      throw new RpcError(-32602, "task.askUser choice requires non-empty id and label");
    }
    choices.push({ id, label });
  }
  return choices;
}

/**
 * U2A: user-only one-shot text and/or contextRefs to a running/waiting task.
 * Does not answer pending UserAsk; does not write chat history or mutate profiles.
 * RPC returns after durable accept (status=pending, accepted=true) — never waits
 * for the provider Agent turn. Managed inject runs on a per-task FIFO background
 * worker (status processing → delivered|failed). External: poll taskInput.* .
 *
 * Managed inject for one (workspaceId, taskPath) is FIFO-serialized with other
 * U2A items (including lifecycle review-feedback). Unrelated tasks stay concurrent.
 */
async function taskSendInputRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "task.sendInput is user-only; agent self-send is forbidden",
      { actor: actorRaw }
    );
  }

  const textRaw = optionalString(p, "text");
  const text = textRaw?.trim() ?? "";
  const contextRefs = parseContextRefs(p.contextRefs);
  if (!text && contextRefs.length === 0) {
    throw new RpcError(
      -32602,
      "task.sendInput requires non-empty text and/or contextRefs"
    );
  }

  // Fail loud when a business UserAsk is still pending — reply path is userAsk.reply.
  const pendingAsk = await ctx.userAsks.getPendingForTask(workspaceId, taskPath);
  if (pendingAsk) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Task has a pending UserAsk (${pendingAsk.id}); use userAsk.reply instead of task.sendInput`,
      { askId: pendingAsk.id, workspaceId, taskPath }
    );
  }

  const current = await loadTaskEnvelope(mount.env.fs, taskPath);
  if (current.state !== "running" && current.state !== "waiting") {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.sendInput requires running or waiting task (state=${current.state})`,
      { taskPath, state: current.state }
    );
  }

  const now = new Date().toISOString();
  const input = await ctx.taskInputs.add({
    id: makeTaskInputId(),
    workspaceId,
    taskPath,
    taskId: current.id || undefined,
    sessionId: current.sessionId || undefined,
    role: current.role || undefined,
    kind: "user-input",
    ...(text ? { text } : {}),
    ...(contextRefs.length > 0 ? { contextRefs } : {}),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  ctx.events.emit(
    "taskInput.pending",
    workspaceId,
    {
      inputId: input.id,
      taskPath: input.taskPath,
      taskId: input.taskId,
      sessionId: input.sessionId,
      role: input.role,
      kind: normalizeTaskInputKind(input.kind),
      text: input.text,
      contextRefs: input.contextRefs,
      createdAt: input.createdAt,
    },
    "self"
  );

  // Fast accept: durable pending is the contract. Managed inject runs on the
  // per-task FIFO in the background — RPC must not await the full Agent turn
  // (CLI false timeouts). External / no session: leave pending for poll+ack.
  const hasManagedSession = !!(current.sessionId?.trim());
  if (hasManagedSession) {
    enqueueManagedTaskInputBackground(ctx, input, {
      sessionIdOverride: current.sessionId,
    });
  }

  return {
    workspaceId,
    taskPath,
    task: projectTask(current),
    state: current.state,
    input: projectTaskInput(input),
    /** Durable row accepted; does not mean provider turn finished. */
    accepted: true,
    /** True when a managed session is bound and background inject was scheduled. */
    enqueued: hasManagedSession,
    /** Always false on accept — poll taskInput.get / events for delivered|failed. */
    continued: false,
  };
}

function parseContextRefs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new RpcError(-32602, "task.sendInput contextRefs must be an array");
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new RpcError(
        -32602,
        "task.sendInput contextRefs must be non-empty strings (stable entity ids)"
      );
    }
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  return refs;
}

/**
 * Per-(workspaceId, taskPath) FIFO for managed U2A inject turns.
 * Not process-wide: unrelated tasks remain concurrent.
 * Failure of one item does not drop later queued items (MutationBus catch-through).
 * Process-local only; open rows survive restart for external poll / retry inject.
 */
const managedTaskInputQueue = new MutationBus();

/** In-flight background deliver promises (sendInput path). Must not go unhandled. */
const managedTaskInputBackgroundInflight = new Set<Promise<unknown>>();
let managedTaskInputAccepting = true;

function managedTaskInputQueueKey(
  workspaceId: string,
  taskPath: string
): string {
  return `${workspaceId}\0${taskPath}`;
}

export type ManagedTaskInputDelivery = {
  input: TaskInputRecord;
  continued: boolean;
  continueError?: string;
};

/**
 * Track a background U2A delivery so rejections never become unhandled and
 * service shutdown can drain in-flight work before runtime teardown.
 */
function trackManagedTaskInputBackground(work: Promise<unknown>): void {
  managedTaskInputBackgroundInflight.add(work);
  void work.then(
    () => {
      managedTaskInputBackgroundInflight.delete(work);
    },
    (err) => {
      managedTaskInputBackgroundInflight.delete(work);
      const message = err instanceof Error ? err.message : String(err);
      // Last-resort log: deliverManagedTaskInput already markFailed when possible.
      console.error(`[taskInput] background managed deliver failed: ${message}`);
    }
  );
}

/**
 * Fire-and-forget managed inject after durable accept
 * (task.sendInput and task.reject resume:true review-feedback).
 * Per-task FIFO still serializes turns; RPC does not await this promise.
 */
function enqueueManagedTaskInputBackground(
  ctx: HandlerContext,
  item: TaskInputRecord,
  opts?: { sessionIdOverride?: string }
): void {
  if (!managedTaskInputAccepting) {
    // Shutdown in progress: leave durable pending/failed for next process.
    return;
  }
  const work = deliverManagedTaskInput(ctx, item, opts).then(
    () => undefined,
    async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const latest = await ctx.taskInputs.get(
          item.id,
          item.workspaceId,
          item.taskPath
        );
        if (
          latest &&
          (latest.status === "pending" ||
            latest.status === "processing" ||
            latest.status === "failed")
        ) {
          await ctx.taskInputs.markFailed(item.id, message, "service");
        }
      } catch {
        // store may be closed during shutdown
      }
      throw err;
    }
  );
  trackManagedTaskInputBackground(work);
}

/**
 * Stop accepting new background U2A enqueues (sendInput + reject-resume review
 * feedback; rows stay durable pending/failed). Call before runtime.shutdown so
 * late RPC paths do not schedule new injects.
 */
export function stopManagedTaskInputBackgroundAccept(): void {
  managedTaskInputAccepting = false;
}

/**
 * Bounded drain of background U2A delivers (sendInput + reject-resume review
 * feedback) after runtime interrupt/shutdown has already been requested so hung
 * provider turns can settle without waiting a full promptTimeout.
 * After stopManagedTaskInputBackgroundAccept, new background enqueues are ignored.
 *
 * @param timeoutMs max wait for in-flight work (default 5s). Remaining promises
 *   stay tracked until they settle (tracked catch prevents unhandled rejection);
 *   durable store rows are not dropped when the timeout fires.
 */
export async function drainManagedTaskInputBackgroundForShutdown(
  timeoutMs = 5_000
): Promise<void> {
  managedTaskInputAccepting = false;
  const pending = [...managedTaskInputBackgroundInflight];
  if (pending.length === 0) return;
  const bound =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : 5_000;
  if (bound === 0) {
    await Promise.allSettled(pending);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, bound);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Re-enable background accept (service start / tests after in-process stop).
 * Clears the inflight set only when empty — does not abort live work.
 */
export function enableManagedTaskInputBackgroundAccept(): void {
  managedTaskInputAccepting = true;
}

/** Test helper: re-enable accept and drop inflight tracking (process-local). */
export function resetManagedTaskInputBackgroundForTests(): void {
  managedTaskInputAccepting = true;
  managedTaskInputBackgroundInflight.clear();
}

/**
 * Shared U2A delivery primitive for managed ACP and external pending.
 *
 * - Persist is already done by the caller (TaskInputStore.add).
 * - Managed live/resume inject uses formatTaskInputPrompt (## User Input or
 *   ## Review Feedback) via the same transport as sendInput.
 * - When sessionIdOverride differs from the stored row (reject-resume new ss- only
 *   when prior was not resume-capable), rebind the pending/failed row to the inject
 *   target before pin/inject so durable state matches the live session.
 * - FIFO: concurrent deliverManagedTaskInput for the same task never overlap
 *   turns or reorder; different tasks run concurrently.
 * - Failure: status=failed with lastError (not dropped); later queue items still run.
 *   Lifecycle interrupt/cancel cancels pending|failed only (not processing/delivered).
 * - managed-inject pin + processing status preserved across inject→markDelivered race
 *   with session.prompt_complete cleanup.
 * - task.sendInput and task.reject(resume:true) both enqueue this in the background
 *   after durable accept + (for reject) session restore; neither RPC awaits the
 *   full Agent turn. Poll taskInput.get / events for processing→delivered|failed|uncertain.
 */
async function deliverManagedTaskInput(
  ctx: HandlerContext,
  item: TaskInputRecord,
  opts?: { sessionIdOverride?: string }
): Promise<ManagedTaskInputDelivery> {
  const sessionId =
    (opts?.sessionIdOverride?.trim() || item.sessionId?.trim() || "") ||
    undefined;
  // External / no managed session: leave pending for scoped poll+ack.
  if (!sessionId) {
    return { input: item, continued: false };
  }

  const queueKey = managedTaskInputQueueKey(item.workspaceId, item.taskPath);
  return managedTaskInputQueue.run(queueKey, async () => {
    // Re-read: interrupt/cancel may have cancelled this row while queued.
    let latest = await ctx.taskInputs.get(
      item.id,
      item.workspaceId,
      item.taskPath
    );
    if (!latest) {
      return {
        input: item,
        continued: false,
        continueError: `TaskInput disappeared before managed inject: ${item.id}`,
      };
    }
    if (latest.status !== "pending" && latest.status !== "failed") {
      // Already processing/delivered/uncertain/consumed/cancelled — do not re-inject.
      // uncertain is at-most-once (provider already accepted); never treat as open retry.
      return {
        input: latest,
        continued:
          latest.status === "delivered" || latest.status === "uncertain",
        continueError: `TaskInput already ${latest.status}; skip managed inject`,
      };
    }

    // Persist inject target session when it differs from create-time binding
    // (reject-resume may allocate a new ss- when prior was not resume-capable).
    if ((latest.sessionId?.trim() || "") !== sessionId) {
      try {
        latest = await ctx.taskInputs.rebindSession(
          latest.id,
          latest.workspaceId,
          latest.taskPath,
          sessionId
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          latest = await ctx.taskInputs.markFailed(
            latest.id,
            `TaskInput rebind to inject session failed: ${message}`,
            "service"
          );
        } catch {
          // keep prior row
        }
        return {
          input: latest,
          continued: false,
          continueError: `TaskInput rebind to inject session failed: ${message}`,
        };
      }
    }

    // Claim for background/awaited inject so projections show processing and
    // cancel skips mid-turn rows.
    try {
      latest = await ctx.taskInputs.markProcessing(latest.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        input: latest,
        continued: false,
        continueError: `TaskInput markProcessing failed: ${message}`,
      };
    }

    const forInject: TaskInputRecord = {
      ...latest,
      sessionId,
    };

    ctx.taskInputs.beginManagedInject(forInject.id);
    let continueResult: { continued: boolean; error?: string };
    let finalInput = forInject;
    try {
      continueResult = await continueManagedAfterTaskInput(ctx, forInject);
      if (continueResult.continued) {
        try {
          finalInput = await ctx.taskInputs.markDelivered(
            forInject.id,
            "service",
            { sessionId }
          );
          ctx.events.emit(
            "taskInput.delivered",
            forInject.workspaceId,
            {
              inputId: finalInput.id,
              taskPath: finalInput.taskPath,
              sessionId: finalInput.sessionId,
              kind: normalizeTaskInputKind(finalInput.kind),
              status: finalInput.status,
            },
            "service"
          );
        } catch (err) {
          // Provider already accepted the inject — never markFailed (that would
          // re-open ordinary retry / listPending and risk a second inject).
          const message = err instanceof Error ? err.message : String(err);
          try {
            finalInput = await ctx.taskInputs.markUncertain(
              forInject.id,
              `managed inject ok but markDelivered failed: ${message}`,
              "service",
              { sessionId }
            );
            ctx.events.emit(
              "taskInput.uncertain",
              forInject.workspaceId,
              {
                inputId: finalInput.id,
                taskPath: finalInput.taskPath,
                sessionId: finalInput.sessionId,
                kind: normalizeTaskInputKind(finalInput.kind),
                status: finalInput.status,
                lastError: finalInput.lastError,
              },
              "service"
            );
          } catch {
            // leave processing if store closed mid-shutdown
          }
          return {
            input: finalInput,
            continued: true,
            continueError: `managed inject ok but markDelivered failed: ${message}`,
          };
        }
      } else {
        // Inject did not complete — retain as failed (not dropped) for retry.
        const failMsg =
          continueResult.error ||
          "managed inject did not continue; external agent may poll taskInput";
        try {
          finalInput = await ctx.taskInputs.markFailed(
            forInject.id,
            failMsg,
            "service"
          );
        } catch {
          // store closed / already terminal
        }
      }
    } finally {
      ctx.taskInputs.endManagedInject(forInject.id);
    }

    return {
      input: finalInput,
      continued: continueResult.continued,
      continueError: continueResult.error,
    };
  });
}

/**
 * Managed ACP: feed fixed-format U2A payload into the same session.
 * Prefer live sendFollowUpPrompt; else resumeSession when capable.
 * External agents poll taskInput.* — no auto chat.
 * Caller must hold the per-task managed U2A FIFO (deliverManagedTaskInput).
 */
async function continueManagedAfterTaskInput(
  ctx: HandlerContext,
  item: TaskInputRecord
): Promise<{ continued: boolean; error?: string }> {
  if (!item.sessionId) return { continued: false };
  const basePrompt = formatTaskInputPrompt(item);
  // Independent recovery Sessions (contextRestored=false): rebuild orientation
  // from durable task/session/delivery facts at inject time so restart/retry
  // does not depend on in-memory enqueue options. Review note stays only in
  // ## Review Feedback (basePrompt) — never duplicated in recovery text.
  // When the target Session row says contextRestored=false, orientation is
  // mandatory (empty process bootstrap). Rebuild failures fail this inject so
  // TaskInput stays failed/retryable — never send bare ## Review Feedback alone.
  let prompt = basePrompt;
  try {
    const recovery = await rebuildRejectResumeRecoveryOrientation(ctx, item);
    if (recovery && recovery.length > 0) {
      prompt = `${recovery}\n\n${basePrompt}`;
    }
  } catch (rebuildErr) {
    const message =
      rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
    return {
      continued: false,
      error: message,
    };
  }
  try {
    try {
      await ctx.runtime.sendFollowUpPrompt(item.sessionId, prompt);
      return { continued: true };
    } catch (liveErr) {
      const liveMessage =
        liveErr instanceof Error ? liveErr.message : String(liveErr);
      // Live session without structured follow-up (e.g. fake process adapter):
      // leave pending for external poll — never call resumeSession on an alive
      // process (that would fail and mark the session failed).
      try {
        const liveProbe = await ctx.runtime.probe(item.sessionId);
        if (liveProbe.alive && SessionRegistry.isNonTerminal(liveProbe.state)) {
          return {
            continued: false,
            error:
              liveMessage ||
              "managed session live but does not support follow-up inject; external agent may poll taskInput.listPending / taskInput.get",
          };
        }
      } catch {
        // probe failed — fall through to resume path
      }
      if (!/not alive|does not support live follow-up/i.test(liveMessage)) {
        // Unexpected live error — still try resume if possible.
      }
    }

    const probe = await ctx.runtime.probe(item.sessionId);
    if (probe.alive && SessionRegistry.isNonTerminal(probe.state)) {
      return {
        continued: false,
        error:
          "managed session live but follow-up inject unavailable; external agent may poll taskInput.listPending / taskInput.get",
      };
    }
    if (!probe.resumeCapable) {
      return {
        continued: false,
        error:
          "managed session not live and not resume-capable; external agent may poll taskInput.listPending / taskInput.get",
      };
    }
    const rec = await ctx.runtime.registry.read(item.sessionId);
    const cwd = rec?.runtimeWorkspace?.cwd;
    await ctx.runtime.resumeSession({
      sessionId: item.sessionId,
      bootstrapPrompt: prompt,
      ...(cwd ? { runtimeWorkspace: { cwd } } : {}),
    });
    return { continued: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Input already persisted pending — continue failure is diagnostic only.
    // Do not cancel; later FIFO items must still run.
    ctx.events.emit(
      "session.state",
      item.workspaceId,
      {
        sessionId: item.sessionId,
        taskPath: item.taskPath,
        runtimeEvent: "taskInput.continue.failed",
        error: message,
        taskFailed: false,
      },
      "service"
    );
    return { continued: false, error: message };
  }
}

/** Test helper: reset per-task managed U2A FIFO tails (does not touch disk). */
export function resetManagedTaskInputQueueForTests(): void {
  // MutationBus has no public clear; replace by draining is unnecessary —
  // tests use fresh process state. Exported for symmetry / future use.
  void managedTaskInputQueue;
}

/**
 * Public task.deliver / task.requestReview must not publish a ready Delivery
 * while the bound managed session still has an in-flight turn. Auto-deliver
 * seals first (turnBusy → false) then calls core taskDeliver directly — it
 * never relies on this RPC gate. External / idle sessions pass through.
 */
async function assertManagedTurnIdleForPublicDeliver(
  ctx: HandlerContext,
  task: { sessionId?: string; path: string; state: string }
): Promise<void> {
  const sessionId = task.sessionId?.trim();
  if (!sessionId) return;
  const probe = await ctx.runtime.probe(sessionId);
  if (probe.turnBusy !== true) return;
  throw new RpcError(
    RPC_LIFECYCLE,
    `task.deliver refused: managed session ${sessionId} still has an in-flight turn (turnBusy); ` +
      `task remains ${task.state} with no ready Delivery until the turn settles`,
    {
      code: "TURN_BUSY",
      sessionId,
      taskPath: task.path,
      turnBusy: true,
    }
  );
}

/**
 * Resolve the exact task/role worktree path for dirtiness inspection only.
 * Prefer envelope.worktree when present; otherwise ensure the lane (same helpers
 * as startSession). Intentionally does **not** re-validate envelope workspace /
 * targetBranch / branch contract — that stays on accept/integrate so existing
 * mismatch fail-loud paths are unchanged.
 */
async function resolveTaskWorktreeForDirtyCheck(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<{ worktree: string; branch?: string } | undefined> {
  const hasRecordedLane = Boolean(
    task.workspace || task.worktree || task.branch || task.targetBranch
  );
  if (!hasRecordedLane) return undefined;
  if (!(await isGitWorkspace(workspaceRoot))) return undefined;

  const envelopeWt = task.worktree?.trim();
  if (envelopeWt) {
    return {
      worktree: nodePath.resolve(envelopeWt),
      branch: task.branch,
    };
  }

  // Lane recorded without worktree path: recreate via the same ensure* helpers.
  const mountedRoot = nodePath.resolve(workspaceRoot);
  const isProfile = taskAssigneeKind(task) === "agentProfile";
  let targetBranch = task.targetBranch?.trim();
  if (isProfile && taskAsSub(task)) {
    const dispatcher = (task.dispatchedBy || "").trim();
    if (dispatcher && dispatcher !== "user") {
      targetBranch = (await ensureRoleWorkspace(mountedRoot, dispatcher)).branch;
    }
  }
  const lane = isProfile
    ? await ensureTaskWorkspace(mountedRoot, task.id || task.path, {
        ...(targetBranch ? { targetBranch } : {}),
      })
    : await ensureRoleWorkspace(mountedRoot, task.role);
  return { worktree: lane.worktree, branch: lane.branch };
}

/**
 * Refuse ready Delivery when the authoritative task/role Git worktree still has
 * uncommitted tracked or untracked changes. Prevents publishing stale commits
 * while agent edits remain uncommitted. Non-Git / no-lane tasks pass through.
 * Checks only the task lane worktree — never main or sibling lanes.
 */
async function assertTaskWorktreeCleanForDeliver(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<void> {
  const lane = await resolveTaskWorktreeForDirtyCheck(workspaceRoot, task);
  if (!lane) return;
  const status = await inspectWorktreeDirtiness(lane.worktree);
  if (!status.dirty) return;
  throw new RpcError(
    RPC_LIFECYCLE,
    `task.deliver refused: task worktree has uncommitted changes at ${lane.worktree} ` +
      `(${status.changeCount} change(s); tracked=${status.trackedDirty} untracked=${status.untrackedDirty}); ` +
      `commit or discard them, then retry delivery (task remains ${task.state}, no ready Delivery)`,
    {
      code: "WORKTREE_DIRTY",
      taskPath: task.path,
      taskId: task.id,
      worktree: lane.worktree,
      ...(lane.branch ? { branch: lane.branch } : {}),
      trackedDirty: status.trackedDirty,
      untrackedDirty: status.untrackedDirty,
      changeCount: status.changeCount,
      dirtySample: status.sample,
    }
  );
}

async function taskDeliverRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const summary = requireString(p, "summary");
  const commits = optionalStringArray(p, "commits");
  const decision = optionalString(p, "decision") as DeliverDecision | undefined;
  const checks = Array.isArray(p.checks) ? (p.checks as import("../core/task-model.js").DeliveryCheck[]) : undefined;
  const artifactRefs = Array.isArray(p.artifactRefs)
    ? (p.artifactRefs as import("../core/task-model.js").ArtifactRef[])
    : undefined;

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
    // Fail-loud authority: do not honor caller "I'm done" while the managed
    // turn is still busy (tools/write/commit may still race). Task stays
    // running; no ready Delivery is published.
    await assertManagedTurnIdleForPublicDeliver(ctx, taskForIntegrate);
    // Same gate for public deliver: dirty task worktree must not publish stale commits.
    await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, taskForIntegrate);
    const integrate = makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate);

    const result = await taskDeliver(mount.env, taskPath, {
      summary,
      commits,
      checks,
      artifactRefs,
      decision,
      integrate,
    });
    emitTaskState(ctx, workspaceId, result.task, "task.deliver");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.deliver",
      },
      "self"
    );
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      autoIntegrated: result.autoIntegrated,
      state: result.task.state,
    };
  });
}

/** Explicit review-queue path (agent-decide chooses request-review). */
async function taskRequestReviewRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  return taskDeliverRpc(ctx, { ...p, decision: p.decision ?? "request-review" });
}

async function taskAcceptRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actor = requireString(p, "actor");
  const commits = optionalStringArray(p, "commits");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
    const result = await taskAccept(mount.env, taskPath, {
      actor,
      commits,
      // Core requires integrate whenever delivery commits are non-empty.
      // Failure must not reach accepted/done/occupation release (lifecycle orders integrate first).
      integrate: makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate),
    });
    emitTaskState(ctx, workspaceId, result.task, "task.accept");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.accept",
      },
      "self"
    );
    for (const claimId of result.task.claims) {
      if (claimId === "root") continue;
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        { id: claimId, reason: "task.accept-projection" },
        "self"
      );
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state,
    };
  });
}

/**
 * task.reject — reject delivery; default resume rework.
 *
 * resume:false (or --no-resume): terminal collaboration only; no session restore,
 * no review U2A. Same Delivery single-track as before.
 *
 * resume:true: same async accept contract as task.sendInput for the review note:
 *   1) core reject → running occupation
 *   2) durable review-feedback TaskInput (pending)
 *   3) managed session restore/bind when sessionId present (still on RPC path):
 *      alive rebind or native resume first (contextRestored=true); when native
 *      resume explicitly fails or prior is not resumeCapable, start an honest
 *      independent new Session with recovery bootstrap (contextRestored=false).
 *      Registry/profile identity failures still park waiting(external) and fail
 *      the RPC — never leave running with a dead managed process.
 *   4) return accepted/processing quickly — do **not** await the full Agent turn
 *   5) background per-task FIFO inject (## Review Feedback) exactly once;
 *      status/events queryable via taskInput.*; failed is retryable, uncertain
 *      is at-most-once; already processing/delivered/uncertain skips re-inject
 *
 * External / no sessionId: core rework + pending review-feedback for poll+ack.
 * Role/profile restore semantics and Delivery authority are unchanged.
 */
async function taskRejectRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actor = requireString(p, "actor");
  // Delivery record may use trimmed note; U2A review-feedback preserves exact text.
  const noteForDelivery = optionalString(p, "note");
  const noteExact = optionalStringExact(p, "note");
  const resume = p.resume !== false;

  // Core reject first (MutationBus). Managed session restore happens after so
  // runtime start/resume never nests inside the mutation lock.
  const result = await ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const rejected = await taskReject(mount.env, taskPath, {
      actor,
      note: noteForDelivery,
      resume,
    });
    emitTaskState(ctx, workspaceId, rejected.task, "task.reject");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: rejected.delivery.id,
        taskId: rejected.delivery.taskId,
        status: rejected.delivery.status,
        reason: "task.reject",
      },
      "self"
    );
    return rejected;
  });

  // Terminal reject: collaboration only; no session restore / no review U2A.
  if (!resume) {
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state,
    };
  }

  // Rework path: review note is a lifecycle-generated U2A TaskInput (not a second
  // prompt channel). Persist first so external poll/ack and restart survive even
  // when managed restore fails.
  const reviewInput = await createRejectResumeReviewFeedback(ctx, {
    workspaceId,
    taskPath,
    task: result.task,
    note: noteExact,
  });

  // Managed ACP session restore when bound; external/manual (no sessionId) stay
  // running with review feedback pending for scoped poll/get/ack.
  const boundSessionId = result.task.sessionId?.trim() || "";
  if (!boundSessionId) {
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state,
      input: projectTaskInput(reviewInput),
      /** Durable review-feedback accepted; no managed inject scheduled. */
      accepted: true,
      enqueued: false,
      /** Always false on accept — external agents poll taskInput.* */
      continued: false,
    };
  }

  // Prior managed delivery marks sessionId+taskPath delivered; clear dedup so a
  // successful rework prompt_complete can deliver again.
  clearManagedAutoDeliverDedup(boundSessionId, taskPath);

  // Tracks a freshly started independent Session so catch can stop orphans when
  // post-start rebind fails after startSession already succeeded.
  let fallbackOrphanSessionId: string | undefined;
  try {
    const restored = await restoreManagedSessionAfterRejectResume(ctx, {
      workspaceId,
      taskPath,
    });
    // review-feedback was created with the pre-restore sessionId (often stopped).
    // Rebind to the live restore target before enqueue so cancelSession(old) and
    // projections cannot strand feedback on a dead ss- while the task runs on new.
    const restoredSessionId = restored.session.sessionId;
    if (
      restored.session.contextRestored === false &&
      restoredSessionId !== boundSessionId
    ) {
      fallbackOrphanSessionId = restoredSessionId;
    }
    let boundReview = reviewInput;
    if ((reviewInput.sessionId?.trim() || "") !== restoredSessionId) {
      boundReview = await ctx.taskInputs.rebindSession(
        reviewInput.id,
        workspaceId,
        taskPath,
        restoredSessionId
      );
    }
    // Rebind + restore both succeeded — no longer an orphan candidate.
    fallbackOrphanSessionId = undefined;
    // Fast accept: durable pending + live session bind are the RPC contract.
    // Managed inject of ## Review Feedback runs on the per-task FIFO in the
    // background — same as task.sendInput. Recovery orientation (if any) is
    // rebuilt at inject time from durable task/session/delivery facts.
    // Do not await the full Agent turn (CLI/fetch headers timeout would otherwise
    // false-fail a still-running turn).
    enqueueManagedTaskInputBackground(ctx, boundReview, {
      sessionIdOverride: restoredSessionId,
    });
    return {
      workspaceId,
      taskPath,
      task: projectTask(restored.task),
      delivery: projectDelivery(result.delivery),
      state: restored.task.state,
      session: restored.session,
      input: projectTaskInput(boundReview),
      /** Durable row + restore accepted; does not mean provider turn finished. */
      accepted: true,
      /** Managed session restored and background inject scheduled. */
      enqueued: true,
      /** Always false on accept — poll taskInput.get / events for delivered|failed. */
      continued: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Close orphan window: fallback startSession may have succeeded while
    // context flag / task rebind failed — stop the new Session before parking.
    if (fallbackOrphanSessionId) {
      await stopOrphanRejectResumeSession(ctx, fallbackOrphanSessionId);
    }
    // Fail-loud: must not remain running while the managed process is dead.
    // Review TaskInput stays pending (not cancelled) for later poll / retry.
    await parkTaskAfterRejectResumeFailure(ctx, {
      workspaceId,
      taskPath,
      sessionId: fallbackOrphanSessionId || boundSessionId,
      message,
    });
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.reject resume failed to restore managed session: ${message}`,
      { taskPath, sessionId: boundSessionId, inputId: reviewInput.id }
    );
  }
}

/**
 * Persist reject-resume review note as a TaskInput (kind=review-feedback).
 * Exact note text (including empty); same task association; no chat transcript.
 */
async function createRejectResumeReviewFeedback(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    task: TaskEnvelope;
    note?: string;
  }
): Promise<TaskInputRecord> {
  const now = new Date().toISOString();
  // Preserve note exactly — do not trim. Undefined → empty string so payload is valid.
  const text = typeof input.note === "string" ? input.note : "";
  const record = await ctx.taskInputs.add({
    id: makeTaskInputId(),
    workspaceId: input.workspaceId,
    taskPath: input.taskPath,
    taskId: input.task.id || undefined,
    sessionId: input.task.sessionId || undefined,
    role: input.task.role || undefined,
    kind: "review-feedback",
    text,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  ctx.events.emit(
    "taskInput.pending",
    input.workspaceId,
    {
      inputId: record.id,
      taskPath: record.taskPath,
      taskId: record.taskId,
      sessionId: record.sessionId,
      role: record.role,
      kind: "review-feedback",
      text: record.text,
      createdAt: record.createdAt,
    },
    "self"
  );
  return record;
}

async function taskInterruptRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  return ctx.mutations.run(workspaceId, async () => {
    const before = await loadTaskEnvelope(mount.env.fs, taskPath).catch(() => null);
    const sessionId = before?.sessionId;
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskInterrupt(mount.env, taskPath);
    emitTaskState(ctx, workspaceId, task, "task.interrupt");
    await cancelUserAsksForTask(ctx, workspaceId, taskPath, "task.interrupt");
    await cancelTaskInputsForTask(ctx, workspaceId, taskPath, "task.interrupt");
    if (sessionId) {
      try {
        await ctx.toolApprovals.cancelSession(sessionId, "denied");
      } catch {
        // ignore
      }
      try {
        await cancelUserAsksForSession(ctx, workspaceId, sessionId, "task.interrupt");
      } catch {
        // ignore
      }
      try {
        await cancelTaskInputsForSession(
          ctx,
          workspaceId,
          sessionId,
          "task.interrupt"
        );
      } catch {
        // ignore
      }
      try {
        await ctx.runtime.stopSession(sessionId, "interrupt");
      } catch {
        // session may already be dead
      }
    }
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}

async function taskCancelRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    await taskCancel(mount.env, taskPath);
    ctx.events.emit(
      "task.state",
      workspaceId,
      { path: taskPath, state: "interrupted", reason: "task.cancel" },
      "self"
    );
    return { workspaceId, taskPath, state: "interrupted", cancelled: true };
  });
}

/**
 * A2A gate → AgentRuntimePort.startSession → bind task.sessionId only.
 * Clients never call AgentRuntimePort.* directly.
 */
async function taskStartSessionRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const profileId = requireProfileId(p);
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }
  const bootstrapPrompt = optionalString(p, "bootstrapPrompt");
  const approvalId = optionalString(p, "approvalId");

  // Resolve prior ask approval.
  // User approval may override the role profile whitelist (task-api §4).
  if (approvalId) {
    const approval = await ctx.a2a.get(approvalId);
    if (!approval || approval.status !== "approved") {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval is missing or not approved", {
        approvalId,
        status: approval?.status,
      });
    }
    if (approval.taskPath !== taskPath) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval taskPath mismatch", { approvalId });
    }
    if (approval.workspaceId !== workspaceId) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval workspace mismatch", { approvalId });
    }
    if (approval.profileId !== profileId) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval profile mismatch", {
        approvalId,
        approvedProfileId: approval.profileId,
        requestedProfileId: profileId,
      });
    }
  } else {
    const taskForPolicy = await loadTaskEnvelope(mount.env.fs, taskPath);
    // A2A authority: user is root. Role callers use dispatchedBy for sub tasks
    // (role or profile assignee) and for peer agentProfile tasks; peer role tasks
    // use task.role.
    const authorityRole = resolveA2AAuthorityRole(taskForPolicy, callerKind);
    const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
      callerKind,
      taskRole: authorityRole,
      requireRegisteredRole:
        callerKind === "role" &&
        (taskAsSub(taskForPolicy) || taskAssigneeKind(taskForPolicy) === "agentProfile"),
    });
    // User root bypasses policy + profile whitelist.
    // Role caller + registry allow: profileId must be in role.allowedProfiles.
    // Role caller + ask: enter user approval without checking whitelist (user grant may override).
    // Role caller + deny: A2A_DENIED (unchanged).
    // Profile assignee is never the authority role — authorityRole is dispatcher/durable role.
    const profileAllowed =
      callerKind === "user"
        ? true
        : await resolveRoleProfileAllowed(mount.env.fs, {
            taskRole: authorityRole,
            profileId,
            policy: a2aPolicy,
          });
    const decision = evaluateA2A({
      callerKind,
      policy: a2aPolicy,
      profileAllowed,
    });
    if (decision === "deny") {
      throw new RpcError(RPC_A2A_DENIED, "A2A policy denies starting a new runtime session", {
        policy: a2aPolicy,
        callerKind,
        role: authorityRole,
        profileId,
        profileAllowed,
      });
    }
    if (decision === "ask") {
      const task = taskForPolicy;
      const item = await ctx.a2a.add({
        id: makeApprovalId(),
        workspaceId,
        taskPath,
        taskId: task.id,
        role: authorityRole || task.role,
        profileId,
        policy: "ask",
        callerKind,
        bootstrapPrompt,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      ctx.events.emit(
        "a2a.ask",
        workspaceId,
        {
          approvalId: item.id,
          taskPath,
          role: authorityRole || task.role,
          profileId,
          summary: `Role ${authorityRole || task.role} requests startSession on profile ${profileId}`,
        },
        "service"
      );
      // Park task in waiting(a2a-approval) if running
      if (task.state === "running") {
        await ctx.mutations.run(workspaceId, async () => {
          ctx.host.markSelfWrite(workspaceId);
          const waited = await taskWait(mount.env, taskPath, {
            reason: "a2a-approval",
            summary: `Awaiting user A2A approval ${item.id}`,
          });
          emitTaskState(ctx, workspaceId, waited, "a2a.ask");
        });
      }
      throw new RpcError(RPC_A2A_ASK, "A2A policy requires user approval before startSession", {
        approvalId: item.id,
        policy: "ask",
      });
    }
  }

  let task = await loadTaskEnvelope(mount.env.fs, taskPath);

  // Managed startSession for agentProfile tasks must use exactly the envelope profileId.
  if (taskAssigneeKind(task) === "agentProfile" && task.role !== profileId) {
    throw new RpcError(
      -32602,
      `task.startSession profileId must match agentProfile task assignee (${task.role}); got ${profileId}`,
      { taskAssignee: task.role, profileId }
    );
  }

  if (task.state === "queued" && callerKind === "user") {
    // User-driven convenience: claim before start.
    await taskClaimRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }
  if (task.state !== "running" && task.state !== "waiting") {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.startSession requires running (or waiting after approval); got ${task.state}`
    );
  }

  // Any waiting (a2a-approval, external after restart, user-input, …) must resume to
  // running and clear wait *before* launching a new session. A2A ask path still parks
  // running→waiting earlier in this function when policy requires approval.
  if (task.state === "waiting") {
    await taskResumeRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }

  // Durable roles: only one managed ACP session in starting/live/waiting-user.
  // agentProfile tasks may run concurrently (even same profileId) — only same-task
  // idempotency reuses an existing binding.
  const isProfileTask = taskAssigneeKind(task) === "agentProfile";
  if (!isProfileTask) {
    const activeForRole = await findActiveManagedSessionForRole(ctx, workspaceId, task.role);
    if (activeForRole) {
      const boundToThisTask =
        task.sessionId === activeForRole.id ||
        (!!task.id && activeForRole.lastTaskId === task.id) ||
        activeForRole.lastTaskId === taskPath;
      if (boundToThisTask) {
        const boundTask =
          task.sessionId === activeForRole.id
            ? task
            : await ctx.mutations.run(workspaceId, async () => {
                ctx.host.markSelfWrite(workspaceId);
                return patchTaskEnvelope(mount.env.fs, taskPath, {
                  sessionId: activeForRole.id,
                  updatedAt: mount.env.clock.now(),
                });
              });
        return projectStartSessionResult(workspaceId, taskPath, boundTask, activeForRole, {
          cwd: boundTask.worktree || mount.workspaceRoot,
        });
      }
      throw new RpcError(
        RPC_LIFECYCLE,
        `Role "${task.role}" already has an active managed session: ${activeForRole.id}`,
        {
          role: task.role,
          existingSessionId: activeForRole.id,
          existingState: activeForRole.state,
          existingTaskId: activeForRole.lastTaskId,
        }
      );
    }
  } else if (task.sessionId) {
    // Profile task idempotency: same task already bound to an active session.
    const prior = await ctx.runtime.registry.read(task.sessionId);
    if (prior && SessionRegistry.isNonTerminal(prior.state) && prior.state !== "external") {
      return projectStartSessionResult(workspaceId, taskPath, task, prior, {
        cwd: task.worktree || mount.workspaceRoot,
      });
    }
  }

  // Capture lane + roleBranchBase only after the execution slot is acquired.
  // Role: durable tent-role lane. Profile: task-scoped tent-task/<taskId> lane.
  task = await ensureTaskWorkspaceLane(ctx, workspaceId, task);

  const cwd = task.worktree || mount.workspaceRoot;
  const workspaceLane =
    task.workspace || task.worktree || task.branch
      ? {
          workspace: task.workspace || mount.workspaceRoot,
          worktree: task.worktree || mount.workspaceRoot,
          branch: task.branch || "HEAD",
          targetBranch: task.targetBranch,
        }
      : undefined;

  // Managed ACP bootstrap: stable Context Card pointer + near-field user prompt.
  // Does not copy box/manifest bodies. Does not instruct claim/get/deliver CLI —
  // Local Service auto-delivers the final assistant response. External relay is separate.
  const sessionBootstrap =
    bootstrapPrompt?.trim() ||
    buildSessionBootstrapPrompt(task, {
      workspaceRoot: mount.workspaceRoot,
      systemRoot: mount.systemRoot,
    });

  // Ephemeral image path refs from task user prompt + claimed node bodies only.
  // Paths only — never base64; never written to task/session/profile disk.
  // ACP image blocks still require live initialize promptCapabilities.image === true.
  const bootstrapImageRefs = await collectTaskBootstrapImageRefs(mount.env.fs, task);
  const bootstrapImageSystemRoot =
    bootstrapImageRefs.length > 0 ? mount.systemRoot : undefined;

  // A durable role owns one provider session across tasks. Prefer the task's
  // historical binding, then the latest stopped role session with the same
  // profile and runtime cwd. agentProfile tasks remain task-scoped.
  const roleSession = isProfileTask
    ? undefined
    : await findResumableManagedSessionForRole(
        ctx,
        workspaceId,
        task.role,
        profileId,
        cwd
      );
  const priorSessionId = task.sessionId?.trim() || roleSession?.id || "";
  let resumePrior = false;
  if (priorSessionId) {
    try {
      const probe = await ctx.runtime.probe(priorSessionId);
      if (probe.resumeCapable && !probe.alive) {
        const prior = await ctx.runtime.registry.read(priorSessionId);
        const recordedCwd = prior?.runtimeWorkspace?.cwd?.trim() || "";
        const cwdMatches =
          !!recordedCwd &&
          isSameWorkspaceRoot(nodePath.resolve(recordedCwd), nodePath.resolve(cwd));
        const profileMatches = !prior?.profileId || prior.profileId === profileId;
        const workspaceMatches = prior?.workspace === workspaceId;
        const roleMatches = prior?.roleName === task.role;
        const assigneeKindMatches =
          (prior?.assigneeKind ?? "role") === taskAssigneeKind(task);
        const taskMatches =
          prior?.lastTaskId === taskPath ||
          (!!task.id && prior?.lastTaskId === task.id);
        resumePrior =
          cwdMatches &&
          profileMatches &&
          workspaceMatches &&
          roleMatches &&
          assigneeKindMatches &&
          (!isProfileTask || taskMatches);
      }
    } catch (err) {
      // A stale task.sessionId whose machine-local registry row was cleaned is
      // not a resume candidate. Preserve the established create-new behavior;
      // only unexpected probe failures are surfaced.
      if (!/Session not found/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    }
  }

  let handle;
  try {
    if (resumePrior) {
      handle = await ctx.runtime.resumeSession({
        sessionId: priorSessionId,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: sessionBootstrap,
        ...(bootstrapImageRefs.length > 0
          ? {
              bootstrapImageRefs,
              bootstrapImageSystemRoot,
            }
          : {}),
        lastTaskId: task.id || taskPath,
      });
    } else {
      handle = await ctx.runtime.startSession({
        sessionId: makeSessionId(),
        profileId,
        roleName: task.role,
        assigneeKind: taskAssigneeKind(task),
        workspaceLane,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: sessionBootstrap,
        ...(bootstrapImageRefs.length > 0
          ? {
              bootstrapImageRefs,
              bootstrapImageSystemRoot,
            }
          : {}),
        lastTaskId: task.id || taskPath,
        workspace: workspaceId,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Launch/process failure → taskFail (releases occupation) + no live session.
    await failTaskFromRuntime(ctx, {
      workspaceId,
      taskPath,
      sessionId: undefined,
      reason: "session.failed",
      summary: message,
    });
    throw new RpcError(-32000, message);
  }

  // Bind sessionId reference only on task (never PID/token).
  const bound = await ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
      sessionId: handle.sessionId,
      updatedAt: mount.env.clock.now(),
    });
    emitTaskState(ctx, workspaceId, next, "task.startSession");
    ctx.events.emit(
      "session.state",
      workspaceId,
      {
        sessionId: handle.sessionId,
        state: handle.state,
        profileId: handle.profileId,
        taskPath,
        reason: resumePrior ? "task.startSession.resume" : "task.startSession",
      },
      "self"
    );
    return next;
  });

  return projectStartSessionResult(workspaceId, taskPath, bound, {
    id: handle.sessionId,
    profileId: handle.profileId,
    adapterId: handle.adapterId,
    state: handle.state,
    roleName: handle.roleName,
    runtimeWorkspace: handle.runtimeWorkspace,
  }, { cwd });
}

async function taskList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  return {
    workspaceId,
    tasks: tasks.map(projectTask),
  };
}

async function taskGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const task = await loadTaskEnvelope(mount.env.fs, taskPath);
  return { workspaceId, task: projectTask(task) };
}

async function deliveryList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskId = optionalString(p, "taskId");
  const boxId = optionalString(p, "boxId");
  const role = optionalString(p, "role");
  let deliveries = await loadDeliveries(mount.env.fs, { taskId, boxId });
  if (role) deliveries = deliveries.filter((d) => d.role === role);
  return { workspaceId, deliveries: deliveries.map(projectDelivery) };
}

async function deliveryGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const id = requireString(p, "id");
  const deliveries = await loadDeliveries(mount.env.fs);
  const found = deliveries.find((d) => d.id === id);
  if (!found) throw new RpcError(-32004, `Delivery not found: ${id}`);
  return { workspaceId, delivery: projectDelivery(found) };
}

/**
 * Stable box collaboration projection (task-api §2.3).
 * Active task is authoritative (doing + assignee + activeTaskId).
 * With no active task: preserve done only when the box's persisted status is done;
 * stale doing/owner must not pretend occupation → todo with no assignee.
 */
async function boxProjectionRpc(ctx: HandlerContext, p: Record<string, unknown>): Promise<BoxProjection> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  // Same id/path/boxId resolver conventions as docs.get (missing/duplicate → -32004).
  const concept = resolveConcept(tent, p);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  return projectBoxCollaboration(workspaceId, concept, tasks);
}

/**
 * Batch box collaboration projection — same item semantics as box.projection.
 * Input `ids` order is preserved in `projections` (stable for UI working-set).
 * Loads tent + task envelopes once to avoid N+1.
 */
async function boxProjectionsRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<BoxProjectionsResult> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const idsRaw = p.ids;
  if (!Array.isArray(idsRaw)) {
    throw new RpcError(-32602, "box.projections requires ids: string[]");
  }
  const ids: string[] = [];
  for (let i = 0; i < idsRaw.length; i++) {
    const id = idsRaw[i];
    if (typeof id !== "string" || !id.trim()) {
      throw new RpcError(-32602, `box.projections ids[${i}] must be a non-empty string`);
    }
    ids.push(id);
  }

  const tent = await loadTent(mount.env.fs);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const projections: BoxProjection[] = [];
  for (const id of ids) {
    const concept = tent.byId.get(id);
    if (!concept) {
      throw new RpcError(-32004, `Concept not found: ${id}`);
    }
    projections.push(projectBoxCollaboration(workspaceId, concept, tasks));
  }
  return { workspaceId, projections };
}

/**
 * Workspace-level graph projection for Working-set Canvas.
 * Nodes: stable summaries only (no body). Edges: parent + markdown + wiki.
 * Unresolved concept links are retained with explicit unresolved payload.
 */
async function graphProjectionRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<GraphProjection> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  return buildGraphProjection(workspaceId, tent);
}

/**
 * Shared single-item box collaboration projection (box.projection item semantics).
 * `tasks` is the full envelope list so batch callers can reuse one load.
 */
function projectBoxCollaboration(
  workspaceId: string,
  concept: import("../core/types.js").Box,
  tasks: TaskEnvelope[]
): BoxProjection {
  if (concept.invalid) {
    throw new RpcError(
      -32004,
      `Concept is invalid and has no collaboration projection: ${concept.path}`,
      { boxId: concept.id, path: concept.path, detail: concept.invalidReason }
    );
  }
  const activeTask = tasks.find((t) => t.claims.includes(concept.id) && isActiveTaskState(t.state));
  if (activeTask) {
    const fromTask = boxProjectionOf(activeTask);
    const out: BoxProjection = {
      workspaceId,
      boxId: concept.id,
      status: fromTask.status,
    };
    if (fromTask.assignee) out.assignee = fromTask.assignee;
    if (fromTask.activeTaskId) out.activeTaskId = fromTask.activeTaskId;
    return out;
  }

  // No active task: only durable done survives; stale doing/owner → idle todo.
  const status: BoxProjection["status"] = concept.fm.status === "done" ? "done" : "todo";
  return {
    workspaceId,
    boxId: concept.id,
    status,
  };
}

/**
 * Build workspace graph projection from loaded tent.
 * Reuses markdown link parser + concept index (no ad-hoc regex).
 * Node order: depth-first tree walk (stable). Edge order: DFS source + extract order.
 */
function buildGraphProjection(workspaceId: string, tent: LoadedTent): GraphProjection {
  const nodes: GraphNodeSummary[] = [];
  const parentEdges: GraphParentEdge[] = [];
  const markdownEdges: GraphLinkEdge[] = [];
  const wikiEdges: GraphLinkEdge[] = [];

  // DFS over roots for stable node + parent edge order.
  const visit = (box: import("../core/types.js").Box, parentId: string | null): void => {
    nodes.push(projectGraphNodeSummary(box));
    parentEdges.push({ parentId, childId: box.id });
    for (const child of box.children) visit(child, box.id);
  };
  for (const root of tent.roots) visit(root, null);

  // Reuse markdown link parser + concept index (same as docs.backlinks / resolve path).
  // OkfConcept.id is notePath-stem; OkfConcept.boxId is the stable cx- handle.
  // Graph nodes are keyed by box.id (cx-), so resolved edges must map via boxId/path.
  const conceptIndex = indexFromBoxes(tent.byId.values());
  const emitLinks = (box: import("../core/types.js").Box): void => {
    const notePath = boxNotePath(box.path);
    for (const link of extractOutLinksDetailed(box.body)) {
      // Artifacts / external schemes are not concept graph edges (concept-model §6.1).
      if (link.kind === "artifact") continue;
      const resolved = resolveOutLink(conceptIndex, link, notePath);
      const edge: GraphLinkEdge = {
        fromId: box.id,
        raw: link.raw,
      };
      if (link.label) edge.label = link.label;

      // Prefer stable cx- via path/id lookup; never emit path-stem as node id.
      const targetBox =
        (resolved.targetPath ? tent.byPath.get(resolved.targetPath) : undefined) ??
        (resolved.targetCx ? tent.byId.get(resolved.targetCx) : undefined);

      if (resolved.kind === "unresolved" || !targetBox) {
        // Explicit unresolved — never silent-drop concept-link candidates.
        // If resolveOutLink thought it resolved but we cannot map to a tent box,
        // still surface unresolved rather than inventing a foreign id.
        const target =
          (link as { conceptTarget?: string }).conceptTarget ??
          resolved.targetPath ??
          (resolved.targetCx && resolved.targetCx !== link.raw ? resolved.targetCx : undefined);
        edge.unresolved = target ? { raw: link.raw, target } : { raw: link.raw };
      } else {
        edge.toId = targetBox.id;
      }
      if (link.kind === "wiki") wikiEdges.push(edge);
      else markdownEdges.push(edge);
    }
    for (const child of box.children) emitLinks(child);
  };
  for (const root of tent.roots) emitLinks(root);

  return {
    workspaceId,
    nodes,
    edges: {
      parent: parentEdges,
      markdown: markdownEdges,
      wiki: wikiEdges,
    },
  };
}

function projectGraphNodeSummary(box: import("../core/types.js").Box): GraphNodeSummary {
  const title = typeof box.fm.title === "string" ? box.fm.title : undefined;
  const node: GraphNodeSummary = {
    id: box.id,
    path: box.path,
    name: box.name,
    type: box.type,
    tags: box.tags,
    coordination: box.coordination,
    mode: box.mode,
    archived: box.archived,
    invalid: box.invalid,
  };
  if (title) node.title = title;
  return node;
}

// ---- proposal triage (separate from task delivery review) ----

async function proposalList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId");
  const statusRaw = optionalString(p, "status") ?? "pending";
  if (
    statusRaw !== "pending" &&
    statusRaw !== "accepted" &&
    statusRaw !== "rejected" &&
    statusRaw !== "all"
  ) {
    throw new RpcError(-32602, `Invalid proposal status filter: ${statusRaw}`);
  }

  let proposals = await loadProposals(mount.env.fs);
  if (boxId) proposals = proposals.filter((item) => item.boxId === boxId);
  if (statusRaw !== "all") {
    proposals = proposals.filter((item) => item.status === statusRaw);
  }
  return { proposals: proposals.map(projectProposal) };
}

async function proposalSubmit(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = requireString(p, "boxId");
  const role = requireString(p, "role");
  const body = requireString(p, "body");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const proposal = await submitProposal(mount.env.fs, mount.env.clock, role, boxId, body);
    emitProposalUpdated(ctx, workspaceId, proposal, "proposal.submit");
    return { proposal: projectProposal(proposal) };
  });
}

/**
 * User-only resolve for pending proposals (accept | reject).
 * Agent self-resolve is not accepted: actor must be "user" (or empty → user).
 * Emits proposal.updated only after a successful core transition.
 */
async function proposalResolve(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const proposalPath = requireString(p, "path");
  const decision = requireString(p, "decision");
  if (decision !== "accept" && decision !== "reject") {
    throw new RpcError(-32602, `Invalid proposal decision: ${decision}`);
  }
  const actorRaw = optionalString(p, "actor") ?? "user";
  // Hard user authority — roles/agents cannot resolve their own proposals.
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "proposal resolve is user-only; agent self-resolve is forbidden",
      { actor: actorRaw }
    );
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    if (decision === "accept") {
      await acceptProposal(mount.env.fs, proposalPath);
    } else {
      await rejectProposal(mount.env.fs, proposalPath);
    }
    const proposal = await loadProposal(mount.env.fs, proposalPath);
    emitProposalUpdated(
      ctx,
      workspaceId,
      proposal,
      decision === "accept" ? "proposal.accept" : "proposal.reject"
    );
    return { proposal: projectProposal(proposal) };
  });
}

function projectProposal(proposal: Proposal): ProposalProjection {
  return {
    path: proposal.path,
    boxId: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt,
    body: proposal.body,
  };
}

function emitProposalUpdated(
  ctx: HandlerContext,
  workspaceId: string,
  proposal: Proposal,
  reason: string
): void {
  ctx.events.emit(
    "proposal.updated",
    workspaceId,
    {
      path: proposal.path,
      boxId: proposal.boxId,
      role: proposal.role,
      status: proposal.status,
      reason,
    },
    "self"
  );
}

async function sessionList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  const all = await ctx.runtime.registry.list();
  const projections: SessionProjection[] = [];
  for (const rec of all) {
    if (workspaceId && rec.workspace && rec.workspace !== workspaceId) continue;
    const probe = await ctx.runtime.probe(rec.id);
    projections.push({
      sessionId: rec.id,
      profileId: rec.profileId,
      adapterId: rec.adapterId,
      state: probe.state,
      roleName: rec.roleName,
      assigneeKind: rec.assigneeKind ?? "role",
      alive: probe.alive,
      resumeCapable: probe.resumeCapable,
      ...(rec.contextRestored !== undefined
        ? { contextRestored: rec.contextRestored }
        : {}),
      turnBusy: probe.turnBusy === true,
      lastTaskId: rec.lastTaskId,
      workspace: rec.workspace,
      externalKey: recordExternalKey(rec),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    });
  }
  return { sessions: projections };
}

async function sessionGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const sessionId = requireString(p, "sessionId");
  const rec = await ctx.runtime.registry.read(sessionId);
  if (!rec) throw new RpcError(-32004, `Session not found: ${sessionId}`);
  const probe = await ctx.runtime.probe(sessionId);
  const projection: SessionProjection = {
    sessionId: rec.id,
    profileId: rec.profileId,
    adapterId: rec.adapterId,
    state: probe.state,
    roleName: rec.roleName,
    assigneeKind: rec.assigneeKind ?? "role",
    alive: probe.alive,
    resumeCapable: probe.resumeCapable,
    ...(rec.contextRestored !== undefined
      ? { contextRestored: rec.contextRestored }
      : {}),
    turnBusy: probe.turnBusy === true,
    lastTaskId: rec.lastTaskId,
    workspace: rec.workspace,
    externalKey: recordExternalKey(rec),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  return { session: projection };
}

/**
 * Register or reuse a pull-host external session (SessionRegistry state=external).
 * Does not start ACP / managed processes. Idempotent for sessionId / externalKey.
 */
async function sessionEnter(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  if (workspaceId) ctx.host.require(workspaceId);

  const sessionId = optionalString(p, "sessionId");
  const profileId = optionalString(p, "profileId");
  const roleName = optionalString(p, "roleName") || optionalString(p, "role");
  const externalKey = optionalString(p, "externalKey") || optionalString(p, "key");
  const lastTaskId = optionalString(p, "lastTaskId") || optionalString(p, "taskId");
  const cwd = optionalString(p, "cwd");
  const assigneeKindRaw = optionalString(p, "assigneeKind");
  const assigneeKind =
    assigneeKindRaw === "agentProfile" || assigneeKindRaw === "role"
      ? assigneeKindRaw
      : undefined;

  // Snapshot for idempotent "reused" reporting (same open external row).
  let priorExternalId: string | undefined;
  if (sessionId) {
    const prior = await ctx.runtime.registry.read(sessionId);
    if (prior?.state === "external") priorExternalId = prior.id;
  } else if (externalKey) {
    const hit = await findExternalSessionByKey(ctx, externalKey, workspaceId);
    if (hit) priorExternalId = hit.id;
  }

  let handle;
  try {
    handle = await ctx.runtime.enterExternalSession({
      sessionId: sessionId || undefined,
      profileId: profileId || undefined,
      roleName: roleName || undefined,
      assigneeKind,
      workspace: workspaceId || undefined,
      cwd: cwd || undefined,
      lastTaskId: lastTaskId || undefined,
      externalKey: externalKey || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already active as managed/i.test(message)) {
      throw new RpcError(RPC_LIFECYCLE, message);
    }
    throw new RpcError(-32602, message);
  }

  const rec = await ctx.runtime.registry.read(handle.sessionId);
  const probe = await ctx.runtime.probe(handle.sessionId);
  const session: SessionProjection = {
    sessionId: handle.sessionId,
    profileId: handle.profileId,
    adapterId: handle.adapterId,
    state: probe.state,
    roleName: handle.roleName,
    assigneeKind: handle.assigneeKind ?? "role",
    alive: probe.alive,
    resumeCapable: probe.resumeCapable,
    ...(rec?.contextRestored !== undefined
      ? { contextRestored: rec.contextRestored }
      : {}),
    lastTaskId: rec?.lastTaskId,
    workspace: rec?.workspace ?? workspaceId,
    externalKey: recordExternalKey(rec ?? {}) ?? externalKey,
    createdAt: handle.createdAt,
    updatedAt: handle.updatedAt,
  };

  return {
    session,
    reused: priorExternalId === handle.sessionId,
  };
}

/**
 * Probe an external/managed session and list incomplete task bindings (no mutation).
 * Resolves by sessionId **or** workspace-scoped externalKey.
 */
async function sessionStatus(ctx: HandlerContext, p: Record<string, unknown>) {
  const sessionIdArg = optionalString(p, "sessionId");
  const externalKey =
    optionalString(p, "externalKey") || optionalString(p, "key");
  const workspaceId = optionalString(p, "workspaceId");
  if (workspaceId) ctx.host.require(workspaceId);

  // Without sessionId or externalKey: list open external sessions for workspace (or all).
  if (!sessionIdArg && !externalKey) {
    const all = await ctx.runtime.registry.list();
    const sessions: SessionProjection[] = [];
    for (const rec of all) {
      if (rec.state !== "external") continue;
      if (workspaceId && rec.workspace && rec.workspace !== workspaceId) continue;
      const probe = await ctx.runtime.probe(rec.id);
      sessions.push({
        sessionId: rec.id,
        profileId: rec.profileId,
        adapterId: rec.adapterId,
        state: probe.state,
        roleName: rec.roleName,
        assigneeKind: rec.assigneeKind ?? "role",
        alive: probe.alive,
        resumeCapable: probe.resumeCapable,
        ...(rec.contextRestored !== undefined
          ? { contextRestored: rec.contextRestored }
          : {}),
        lastTaskId: rec.lastTaskId,
        workspace: rec.workspace,
        externalKey: recordExternalKey(rec),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      });
    }
    const incompleteTasks = workspaceId
      ? await listIncompleteTasksForSessions(
          ctx,
          workspaceId,
          sessions.map((s) => s.sessionId)
        )
      : [];
    return { sessions, incompleteTasks };
  }

  const resolved = await resolveExternalSessionRef(ctx, {
    sessionId: sessionIdArg,
    externalKey,
    workspaceId,
  });
  if (!resolved) {
    const label = sessionIdArg || externalKey || "?";
    throw new RpcError(-32004, `Session not found: ${label}`);
  }
  const { rec, sessionId } = resolved;
  const probe = await ctx.runtime.probe(sessionId);
  const session: SessionProjection = {
    sessionId: rec.id,
    profileId: rec.profileId,
    adapterId: rec.adapterId,
    state: probe.state,
    roleName: rec.roleName,
    assigneeKind: rec.assigneeKind ?? "role",
    alive: probe.alive,
    resumeCapable: probe.resumeCapable,
    ...(rec.contextRestored !== undefined
      ? { contextRestored: rec.contextRestored }
      : {}),
    lastTaskId: rec.lastTaskId,
    workspace: rec.workspace,
    externalKey: recordExternalKey(rec),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };

  const incompleteTasks = await listIncompleteTasksBoundToSession(
    ctx,
    rec.workspace || workspaceId,
    sessionId
  );

  return {
    session,
    incompleteTasks,
    /** Convenience: true while external is open or managed process is alive. */
    open: SessionRegistry.isOpen(probe.state as SessionRecord["state"]) || probe.alive,
  };
}

/**
 * End or unbind an external session. Never delivers or accepts tasks —
 * only stops the session registry binding and reports incomplete task state.
 * Resolves by sessionId **or** workspace-scoped externalKey.
 */
async function sessionLeave(ctx: HandlerContext, p: Record<string, unknown>) {
  const sessionIdArg = optionalString(p, "sessionId");
  const externalKey =
    optionalString(p, "externalKey") || optionalString(p, "key");
  const workspaceId = optionalString(p, "workspaceId");
  if (workspaceId) ctx.host.require(workspaceId);

  if (!sessionIdArg && !externalKey) {
    throw new RpcError(
      -32602,
      "session.leave requires sessionId or externalKey"
    );
  }

  const resolved = await resolveExternalSessionRef(ctx, {
    sessionId: sessionIdArg,
    externalKey,
    workspaceId,
  });
  if (!resolved) {
    // Idempotent leave: already gone (or never entered).
    return {
      sessionId: sessionIdArg || "",
      externalKey: externalKey || undefined,
      state: "stopped",
      left: false,
      alreadyLeft: true,
      incompleteTasks: [] as Array<{
        path: string;
        id?: string;
        state: string;
        role: string;
      }>,
      delivered: false,
      accepted: false,
    };
  }

  const { rec, sessionId } = resolved;

  // Snapshot incomplete tasks before unbinding (leave must not deliver/accept).
  const incompleteTasks = await listIncompleteTasksBoundToSession(
    ctx,
    rec.workspace || workspaceId,
    sessionId
  );

  // Managed open sessions: refuse leave via this surface (use task.interrupt / stop).
  // External leave only ends external binding; if already terminal, report idempotent.
  if (SessionRegistry.isNonTerminal(rec.state)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `session.leave is for external/pull-host sessions; managed session is ${rec.state}. Use task.interrupt or runtime stop.`,
      { sessionId, state: rec.state }
    );
  }

  let left = false;
  let state = rec.state;
  if (rec.state === "external") {
    await ctx.runtime.stopSession(sessionId, "user");
    left = true;
    const after = await ctx.runtime.registry.read(sessionId);
    state = after?.state ?? "stopped";
  } else {
    // Already stopped/failed — idempotent leave.
    state = rec.state === "failed" ? "failed" : "stopped";
  }

  return {
    sessionId,
    externalKey: recordExternalKey(rec) ?? externalKey,
    state,
    left,
    alreadyLeft: !left,
    incompleteTasks,
    /**
     * Explicit contract: leave never auto-delivers or accepts.
     * Callers must use task.deliver / task.accept separately.
     */
    delivered: false,
    accepted: false,
  };
}

/** First-class externalKey match, scoped to workspace when set. */
async function findExternalSessionByKey(
  ctx: HandlerContext,
  externalKey: string,
  workspaceId?: string
): Promise<SessionRecord | null> {
  const all = await ctx.runtime.registry.list();
  return (
    all.find(
      (rec) =>
        rec.state === "external" &&
        recordExternalKey(rec) === externalKey &&
        (!workspaceId || !rec.workspace || rec.workspace === workspaceId)
    ) ?? null
  );
}

/**
 * Resolve a session row by sessionId or externalKey.
 * sessionId wins when both are provided and the id exists.
 */
async function resolveExternalSessionRef(
  ctx: HandlerContext,
  ref: {
    sessionId?: string;
    externalKey?: string;
    workspaceId?: string;
  }
): Promise<{ rec: SessionRecord; sessionId: string } | null> {
  if (ref.sessionId) {
    if (!isSessionId(ref.sessionId)) {
      // May be a bare externalKey mistakenly passed as sessionId — try key path below.
    } else {
      const rec = await ctx.runtime.registry.read(ref.sessionId);
      if (rec) return { rec, sessionId: rec.id };
      // Fall through to externalKey when id not found (or only key provided).
    }
  }
  if (ref.externalKey) {
    const hit = await findExternalSessionByKey(ctx, ref.externalKey, ref.workspaceId);
    if (hit) return { rec: hit, sessionId: hit.id };
  }
  // sessionId that is not an ss- id: treat as externalKey lookup for convenience.
  if (ref.sessionId && !isSessionId(ref.sessionId)) {
    const hit = await findExternalSessionByKey(ctx, ref.sessionId, ref.workspaceId);
    if (hit) return { rec: hit, sessionId: hit.id };
  }
  return null;
}

/** Active (non-terminal) tasks in a workspace that reference sessionId. */
async function listIncompleteTasksBoundToSession(
  ctx: HandlerContext,
  workspaceId: string | undefined,
  sessionId: string
): Promise<Array<{ path: string; id?: string; state: string; role: string; sessionId?: string }>> {
  if (!workspaceId) return [];
  try {
    ctx.host.require(workspaceId);
  } catch {
    return [];
  }
  return listIncompleteTasksForSessions(ctx, workspaceId, [sessionId]);
}

async function listIncompleteTasksForSessions(
  ctx: HandlerContext,
  workspaceId: string,
  sessionIds: string[]
): Promise<Array<{ path: string; id?: string; state: string; role: string; sessionId?: string }>> {
  if (sessionIds.length === 0) return [];
  const idSet = new Set(sessionIds);
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const out: Array<{ path: string; id?: string; state: string; role: string; sessionId?: string }> =
    [];
  for (const task of tasks) {
    const sid = task.sessionId?.trim();
    if (!sid || !idSet.has(sid)) continue;
    if (!isActiveTaskState(task.state)) continue;
    out.push({
      path: task.path,
      id: task.id,
      state: task.state,
      role: task.role,
      sessionId: sid,
    });
  }
  return out;
}

async function a2aListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.a2a.listPending(workspaceId);
  return { approvals: pending };
}

async function a2aResolve(ctx: HandlerContext, p: Record<string, unknown>) {
  const approvalId = requireString(p, "approvalId");
  const decisionRaw = requireString(p, "decision");
  const actor = requireUserActor(p, "a2a.resolve");
  const decision =
    decisionRaw === "approve" || decisionRaw === "approved"
      ? "approved"
      : decisionRaw === "deny" || decisionRaw === "denied"
        ? "denied"
        : null;
  if (!decision) {
    throw new RpcError(-32602, "decision must be approve|deny");
  }

  const item = await ctx.a2a.resolve(approvalId, decision, actor);
  ctx.events.emit(
    "a2a.resolved",
    item.workspaceId,
    { approvalId, decision, actor, taskPath: item.taskPath },
    "self"
  );

  if (decision === "approved") {
    // Start session now with user authority (approval already recorded).
    const started = await taskStartSessionRpc(ctx, {
      workspaceId: item.workspaceId,
      taskPath: item.taskPath,
      profileId: item.profileId,
      callerKind: "user",
      bootstrapPrompt: item.bootstrapPrompt,
      approvalId: item.id,
    });
    return { approval: item, started };
  }

  return { approval: item, started: null };
}

// ---- ACP tool permission approvals (permissionPolicy=ask; not A2A spawn) ----

async function toolApprovalListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.toolApprovals.listPending(workspaceId);
  return { approvals: pending.map(projectToolApproval) };
}

async function toolApprovalGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const approvalId = requireString(p, "approvalId");
  const item = await ctx.toolApprovals.get(approvalId);
  if (!item) throw new RpcError(-32004, `Tool approval not found: ${approvalId}`);
  return { approval: projectToolApproval(item) };
}

/**
 * User-only resolve for ACP tool permission.
 * approveOnce → allow_once at adapter; deny → cancelled.
 * Agent self-approve is not accepted: actor must be "user" (or empty → user).
 */
async function toolApprovalResolve(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  decision: "approved" | "denied"
) {
  const approvalId = requireString(p, "approvalId");
  const actorRaw = optionalString(p, "actor") ?? "user";
  // Hard user authority — roles/agents cannot approve their own tool calls.
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "toolApproval resolve is user-only; agent self-approve is forbidden",
      { actor: actorRaw }
    );
  }

  const item = await ctx.toolApprovals.resolve(approvalId, decision, actorRaw);
  ctx.events.emit(
    "toolApproval.resolved",
    item.workspaceId,
    {
      approvalId: item.id,
      decision,
      actor: actorRaw,
      sessionId: item.sessionId,
      taskPath: item.taskPath,
      toolTitle: item.toolTitle,
    },
    "self"
  );

  const hasPendingForSession = await ctx.toolApprovals.hasPendingForSession(
    item.sessionId
  );

  // Resume task projection if it was parked on tool approval wait.
  // Adapter re-emits session.live after decision; service also resumes here for
  // approve path so UI does not wait solely on racey runtime events. Concurrent
  // tool requests keep the task waiting until the final pending request resolves.
  // Do not resume when a business UserAsk is still pending for this task.
  if (decision === "approved" && !hasPendingForSession && item.taskPath) {
    try {
      const pendingAsk = await ctx.userAsks.getPendingForTask(
        item.workspaceId,
        item.taskPath
      );
      if (!pendingAsk) {
        const mount = ctx.host.get(item.workspaceId);
        if (mount) {
          const task = await loadTaskEnvelope(mount.env.fs, item.taskPath);
          if (task.state === "waiting" && task.wait?.reason === "user-input") {
            await ctx.mutations.run(item.workspaceId, async () => {
              ctx.host.markSelfWrite(item.workspaceId);
              const resumed = await taskResume(mount.env, item.taskPath!);
              emitTaskState(ctx, item.workspaceId, resumed, "toolApproval.approveOnce");
            });
          }
        }
      }
    } catch {
      // resume is best-effort; adapter session.live also maps resume
    }
  }

  return { approval: projectToolApproval(item) };
}

function projectToolApproval(item: ToolPendingApproval) {
  // Never include secrets, stdout, tokens — only safe UI fields.
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    taskId: item.taskId,
    taskPath: item.taskPath,
    role: item.role,
    toolTitle: item.toolTitle,
    toolCallId: item.toolCallId,
    options: item.options,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    resolvedAt: item.resolvedAt,
    resolvedBy: item.resolvedBy,
  };
}

// ---- A2U UserAsk (business question; not tool permission; not chat) ----

async function userAskListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.userAsks.listPending(workspaceId);
  return { asks: pending.map(projectUserAsk) };
}

/**
 * Workspace-scoped unified A2U pending projection.
 * Aggregates four domain sources only — no new store, no resolve verbs, no
 * copied state events. Any source failure fails the whole RPC (fail-loud).
 */
async function interactionListPending(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<PendingInteractionListResult> {
  const workspaceId = requireWorkspaceId(ctx, p);
  // Ensure the workspace is mounted before any store/fs read so missing mounts
  // fail with the same contract as delivery.list rather than a partial inbox.
  const mount = ctx.host.require(workspaceId);

  let asks: Awaited<ReturnType<typeof ctx.userAsks.listPending>>;
  let a2aApprovals: Awaited<ReturnType<typeof ctx.a2a.listPending>>;
  let toolApprovals: Awaited<ReturnType<typeof ctx.toolApprovals.listPending>>;
  let deliveries: Awaited<ReturnType<typeof loadDeliveries>>;
  try {
    // Parallel reads are independent; reject if any source fails.
    const settled = await Promise.all([
      ctx.userAsks.listPending(workspaceId),
      ctx.a2a.listPending(workspaceId),
      ctx.toolApprovals.listPending(workspaceId),
      loadDeliveries(mount.env.fs),
    ]);
    asks = settled[0];
    a2aApprovals = settled[1];
    toolApprovals = settled[2];
    deliveries = settled[3];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(
      -32000,
      `interaction.listPending failed to load pending sources: ${message}`,
      { workspaceId }
    );
  }

  // Task envelopes supply optional boxId/sessionId pointers for rows that
  // only store taskPath / taskId. Missing envelopes leave pointers undefined.
  let tasksByPath = new Map<string, TaskEnvelope>();
  let tasksById = new Map<string, TaskEnvelope>();
  try {
    const tasks = await loadTaskEnvelopes(mount.env.fs);
    tasksByPath = new Map(tasks.map((t) => [t.path, t]));
    tasksById = new Map(
      tasks.filter((t): t is TaskEnvelope & { id: string } => !!t.id).map((t) => [t.id, t])
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(
      -32000,
      `interaction.listPending failed to load task envelopes: ${message}`,
      { workspaceId }
    );
  }

  const items: PendingInteractionItem[] = [];

  for (const ask of asks) {
    const task = tasksByPath.get(ask.taskPath) ?? (ask.taskId ? tasksById.get(ask.taskId) : undefined);
    const item: PendingUserAskInteraction = {
      kind: "userAsk",
      id: ask.id,
      workspaceId: ask.workspaceId,
      createdAt: ask.createdAt,
      taskPath: ask.taskPath,
      ...(ask.taskId ? { taskId: ask.taskId } : task?.id ? { taskId: task.id } : {}),
      ...(task?.claims?.[0] ? { boxId: task.claims[0] } : {}),
      ...(ask.role ?? task?.role ? { role: ask.role ?? task?.role } : {}),
      ...(ask.sessionId ?? task?.sessionId
        ? { sessionId: ask.sessionId ?? task?.sessionId }
        : {}),
      question: ask.question,
      ...(ask.choices?.length ? { choices: ask.choices.map((c) => ({ id: c.id, label: c.label })) } : {}),
    };
    items.push(item);
  }

  for (const approval of a2aApprovals) {
    const task =
      tasksByPath.get(approval.taskPath) ??
      (approval.taskId ? tasksById.get(approval.taskId) : undefined);
    const item: PendingA2AInteraction = {
      kind: "a2a",
      id: approval.id,
      workspaceId: approval.workspaceId,
      createdAt: approval.createdAt,
      taskPath: approval.taskPath,
      ...(approval.taskId ? { taskId: approval.taskId } : task?.id ? { taskId: task.id } : {}),
      ...(task?.claims?.[0] ? { boxId: task.claims[0] } : {}),
      role: approval.role,
      ...(task?.sessionId ? { sessionId: task.sessionId } : {}),
      profileId: approval.profileId,
      policy: approval.policy,
      callerKind: approval.callerKind,
    };
    items.push(item);
  }

  for (const approval of toolApprovals) {
    const task = approval.taskPath
      ? tasksByPath.get(approval.taskPath)
      : approval.taskId
        ? tasksById.get(approval.taskId)
        : undefined;
    // Safe fields only — projectToolApproval already omits raw tool args/secrets.
    const projected = projectToolApproval(approval);
    const item: PendingToolApprovalInteraction = {
      kind: "toolApproval",
      id: projected.id,
      workspaceId: projected.workspaceId,
      createdAt: projected.createdAt,
      sessionId: projected.sessionId,
      ...(projected.taskPath ? { taskPath: projected.taskPath } : {}),
      ...(projected.taskId
        ? { taskId: projected.taskId }
        : task?.id
          ? { taskId: task.id }
          : {}),
      ...(task?.claims?.[0] ? { boxId: task.claims[0] } : {}),
      ...(projected.role ?? task?.role ? { role: projected.role ?? task?.role } : {}),
      toolTitle: projected.toolTitle,
      options: projected.options.map((o) => ({
        optionId: o.optionId,
        ...(o.kind ? { kind: o.kind } : {}),
        ...(o.name ? { name: o.name } : {}),
      })),
      ...(projected.expiresAt ? { expiresAt: projected.expiresAt } : {}),
    };
    items.push(item);
  }

  for (const delivery of deliveries) {
    if (delivery.status !== "ready") continue;
    const task = tasksById.get(delivery.taskId);
    const item: PendingDeliveryInteraction = {
      kind: "delivery",
      id: delivery.id,
      workspaceId,
      createdAt: delivery.createdAt ?? delivery.updatedAt ?? "",
      taskId: delivery.taskId,
      boxId: delivery.boxId,
      role: delivery.role,
      path: delivery.path,
      status: "ready",
      ...(task?.path ? { taskPath: task.path } : {}),
      ...(task?.sessionId ? { sessionId: task.sessionId } : {}),
    };
    items.push(item);
  }

  items.sort(comparePendingInteraction);

  const counts = {
    userAsk: 0,
    a2a: 0,
    toolApproval: 0,
    delivery: 0,
    total: items.length,
  };
  for (const item of items) {
    counts[item.kind] += 1;
  }

  return { workspaceId, items, counts };
}

/** Stable sort: createdAt ASC, then kind, then id. */
function comparePendingInteraction(a: PendingInteractionItem, b: PendingInteractionItem): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;
  return a.id.localeCompare(b.id);
}

async function userAskGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const askId = requireString(p, "askId");
  const item = await ctx.userAsks.get(askId);
  if (!item) throw new RpcError(-32004, `UserAsk not found: ${askId}`);
  return { ask: projectUserAsk(item) };
}

/**
 * User-only reply. Persist answer first, then resume task, then optional managed
 * follow-up prompt. Answer is never lost if follow-up fails.
 */
async function userAskReplyRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const askId = requireString(p, "askId");
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "userAsk.reply is user-only; agent self-reply is forbidden",
      { actor: actorRaw }
    );
  }
  const answer = optionalString(p, "answer");
  const choiceId = optionalString(p, "choiceId");
  if (!(answer?.trim() || choiceId?.trim())) {
    throw new RpcError(-32602, "userAsk.reply requires answer and/or choiceId");
  }

  const item = await ctx.userAsks.reply(askId, {
    answer,
    choiceId,
    resolvedBy: actorRaw,
  });

  ctx.events.emit(
    "userAsk.resolved",
    item.workspaceId,
    {
      askId: item.id,
      decision: "reply",
      actor: actorRaw,
      taskPath: item.taskPath,
      sessionId: item.sessionId,
      choiceId: item.choiceId,
      answer: item.answer,
    },
    "self"
  );

  const resume = await resumeTaskAfterUserAsk(ctx, item, "userAsk.reply");
  const continueResult = await continueManagedAfterUserAsk(ctx, item);

  return {
    ask: projectUserAsk(item),
    task: resume.task,
    state: resume.state,
    continued: continueResult.continued,
    continueError: continueResult.error,
  };
}

/** User-only deny: cancel the business ask and resume the task for rework/decision. */
async function userAskDenyRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const askId = requireString(p, "askId");
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "userAsk.deny is user-only; agent self-deny is forbidden",
      { actor: actorRaw }
    );
  }

  const item = await ctx.userAsks.deny(askId, actorRaw);
  ctx.events.emit(
    "userAsk.resolved",
    item.workspaceId,
    {
      askId: item.id,
      decision: "deny",
      actor: actorRaw,
      taskPath: item.taskPath,
      sessionId: item.sessionId,
    },
    "self"
  );

  // Deny still resumes task occupation so agent/external path can observe denial
  // and deliver/interrupt — not a silent hang.
  const resume = await resumeTaskAfterUserAsk(ctx, item, "userAsk.deny");
  const continueResult =
    item.sessionId != null
      ? await continueManagedAfterUserAsk(ctx, item)
      : { continued: false as const, error: undefined as string | undefined };

  return {
    ask: projectUserAsk(item),
    task: resume.task,
    state: resume.state,
    continued: continueResult.continued,
    continueError: continueResult.error,
  };
}

async function resumeTaskAfterUserAsk(
  ctx: HandlerContext,
  item: UserAskRecord,
  reason: string
): Promise<{ task: TaskProjection | null; state: string | null }> {
  try {
    const mount = ctx.host.get(item.workspaceId);
    if (!mount) return { task: null, state: null };
    return await ctx.mutations.run(item.workspaceId, async () => {
      ctx.host.markSelfWrite(item.workspaceId);
      const task = await loadTaskEnvelope(mount.env.fs, item.taskPath);
      if (task.state === "waiting" && task.wait?.reason === "user-input") {
        const resumed = await taskResume(mount.env, item.taskPath);
        emitTaskState(ctx, item.workspaceId, resumed, reason);
        return { task: projectTask(resumed), state: resumed.state };
      }
      return { task: projectTask(task), state: task.state };
    });
  } catch {
    return { task: null, state: null };
  }
}

/**
 * Managed ACP: after user answer, feed fixed-format prompt into the same session.
 * Prefer live sendFollowUpPrompt; else resumeSession with bootstrapPrompt when capable.
 * External agents query userAsk.get — no auto chat.
 */
async function continueManagedAfterUserAsk(
  ctx: HandlerContext,
  item: UserAskRecord
): Promise<{ continued: boolean; error?: string }> {
  if (!item.sessionId) return { continued: false };
  const prompt = formatUserAskAnswerPrompt(item);
  try {
    // Live follow-up path (same process still holding the managed ACP session).
    try {
      await ctx.runtime.sendFollowUpPrompt(item.sessionId, prompt);
      return { continued: true };
    } catch (liveErr) {
      const liveMessage =
        liveErr instanceof Error ? liveErr.message : String(liveErr);
      // Fall through to provider-native resume when live follow-up is unavailable.
      if (!/not alive|does not support live follow-up/i.test(liveMessage)) {
        // Unexpected live error — still try resume if possible.
      }
    }

    const probe = await ctx.runtime.probe(item.sessionId);
    if (!probe.resumeCapable) {
      return {
        continued: false,
        error:
          "managed session not live and not resume-capable; external agent may poll userAsk.get",
      };
    }
    const rec = await ctx.runtime.registry.read(item.sessionId);
    const cwd = rec?.runtimeWorkspace?.cwd;
    await ctx.runtime.resumeSession({
      sessionId: item.sessionId,
      bootstrapPrompt: prompt,
      ...(cwd ? { runtimeWorkspace: { cwd } } : {}),
    });
    return { continued: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Answer already persisted + task already resumed — continue failure is diagnostic only.
    ctx.events.emit(
      "session.state",
      item.workspaceId,
      {
        sessionId: item.sessionId,
        taskPath: item.taskPath,
        runtimeEvent: "userAsk.continue.failed",
        error: message,
        taskFailed: false,
      },
      "service"
    );
    return { continued: false, error: message };
  }
}

function projectUserAsk(item: UserAskRecord) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    taskPath: item.taskPath,
    taskId: item.taskId,
    sessionId: item.sessionId,
    role: item.role,
    question: item.question,
    choices: item.choices,
    status: item.status,
    answer: item.answer,
    choiceId: item.choiceId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    resolvedAt: item.resolvedAt,
    resolvedBy: item.resolvedBy,
  };
}

/** Best-effort: cancel pending business asks when task occupation ends. */
async function cancelUserAsksForTask(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  resolvedBy: string
): Promise<void> {
  try {
    const cancelled = await ctx.userAsks.cancelTask(
      workspaceId,
      taskPath,
      resolvedBy
    );
    for (const ask of cancelled) {
      ctx.events.emit(
        "userAsk.resolved",
        workspaceId,
        {
          askId: ask.id,
          decision: "cancelled",
          actor: resolvedBy,
          taskPath: ask.taskPath,
          sessionId: ask.sessionId,
        },
        "service"
      );
    }
  } catch {
    // cleanup must not block interrupt/fail
  }
}

async function cancelUserAsksForSession(
  ctx: HandlerContext,
  workspaceId: string,
  sessionId: string,
  resolvedBy: string
): Promise<void> {
  try {
    const cancelled = await ctx.userAsks.cancelSession(sessionId, resolvedBy);
    for (const ask of cancelled) {
      ctx.events.emit(
        "userAsk.resolved",
        workspaceId || ask.workspaceId,
        {
          askId: ask.id,
          decision: "cancelled",
          actor: resolvedBy,
          taskPath: ask.taskPath,
          sessionId: ask.sessionId,
        },
        "service"
      );
    }
  } catch {
    // cleanup must not block session teardown
  }
}

// ---- U2A task input (one-shot append; not chat; not UserAsk) ----

/**
 * Explicit workspaceId (no foreground fallback) + taskPath.
 * taskInput list/get/ack must never behave like a machine-global inbox.
 */
function requireTaskInputScope(p: Record<string, unknown>): {
  workspaceId: string;
  taskPath: string;
} {
  const workspaceId = optionalString(p, "workspaceId");
  if (!workspaceId) {
    throw new RpcError(
      -32602,
      "taskInput.* requires explicit workspaceId (no global inbox / no foreground fallback)"
    );
  }
  const taskPath = requireString(p, "taskPath");
  return { workspaceId, taskPath };
}

/**
 * External poll of pending one-shot inputs.
 * Always requires workspaceId + taskPath — no machine-global inbox.
 */
async function taskInputListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const { workspaceId, taskPath } = requireTaskInputScope(p);
  // Touch mount so unknown workspace fails loud before store read.
  ctx.host.require(workspaceId);
  try {
    const pending = await ctx.taskInputs.listPending(workspaceId, taskPath);
    return { inputs: pending.map(projectTaskInput) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
}

/**
 * Scoped get: workspaceId + taskPath + inputId. Id-only lookup is rejected.
 * Cross-workspace / wrong-task returns not found (no leak).
 */
async function taskInputGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const { workspaceId, taskPath } = requireTaskInputScope(p);
  const inputId = requireString(p, "inputId");
  ctx.host.require(workspaceId);
  let item: TaskInputRecord | undefined;
  try {
    item = await ctx.taskInputs.get(inputId, workspaceId, taskPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
  if (!item) throw new RpcError(-32004, `TaskInput not found: ${inputId}`);
  return { input: projectTaskInput(item) };
}

/**
 * External agent formal ack after observing one-shot input.
 * Requires workspaceId+taskPath; actor must match stored task role or
 * a service-verified live session bound to the same task (not an arbitrary string).
 * pending|delivered → consumed. Fail-loud on missing/terminal/scope/actor mismatch.
 */
async function taskInputAckRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const { workspaceId, taskPath } = requireTaskInputScope(p);
  const inputId = requireString(p, "inputId");
  const actorRaw = optionalString(p, "actor");
  if (!actorRaw?.trim()) {
    throw new RpcError(
      -32602,
      "taskInput.ack requires actor matching the task role or a verified session binding"
    );
  }
  const actor = actorRaw.trim();
  ctx.host.require(workspaceId);

  let existing: TaskInputRecord | undefined;
  try {
    existing = await ctx.taskInputs.get(inputId, workspaceId, taskPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
  if (!existing) throw new RpcError(-32004, `TaskInput not found: ${inputId}`);

  const allowed = await isTaskInputAckActorAllowed(ctx, existing, actor);
  if (!allowed) {
    throw new RpcError(
      -32001,
      "taskInput.ack actor must match the stored task role or a service-verified session binding",
      {
        inputId,
        actor,
        expectedRole: existing.role,
        sessionId: existing.sessionId,
        workspaceId,
        taskPath,
      }
    );
  }

  let item: TaskInputRecord;
  try {
    item = await ctx.taskInputs.ack(inputId, workspaceId, taskPath, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      throw new RpcError(-32004, message);
    }
    if (/already /i.test(message)) {
      throw new RpcError(RPC_LIFECYCLE, message, { inputId });
    }
    throw new RpcError(-32603, message);
  }
  ctx.events.emit(
    "taskInput.consumed",
    item.workspaceId,
    {
      inputId: item.id,
      taskPath: item.taskPath,
      sessionId: item.sessionId,
      actor,
      status: item.status,
    },
    "self"
  );
  return { input: projectTaskInput(item) };
}

/**
 * Ack actor binding: stored task role, or live registry session whose
 * sessionId + workspace + lastTaskId/path bind to this input's task.
 * Caller-supplied arbitrary actor strings are insufficient.
 */
async function isTaskInputAckActorAllowed(
  ctx: HandlerContext,
  item: TaskInputRecord,
  actor: string
): Promise<boolean> {
  if (item.role && actor === item.role) return true;

  // Service-verified session binding: actor may be the bound sessionId when
  // the registry row still points at the same workspace + task.
  if (!item.sessionId) return false;
  if (actor !== item.sessionId) return false;
  try {
    const rec = await ctx.runtime.registry.read(item.sessionId);
    if (!rec) return false;
    if (rec.workspace && rec.workspace !== item.workspaceId) return false;
    if (rec.lastTaskId) {
      if (
        rec.lastTaskId === item.taskId ||
        rec.lastTaskId === item.taskPath
      ) {
        return true;
      }
    }
    // Fall back: session id match alone is not enough without task binding.
    // When lastTaskId is absent, require envelope sessionId still matches.
    const mount = ctx.host.get(item.workspaceId);
    if (!mount) return false;
    const task = await loadTaskEnvelope(mount.env.fs, item.taskPath).catch(
      () => null
    );
    return !!task && task.sessionId === item.sessionId;
  } catch {
    return false;
  }
}

function projectTaskInput(item: TaskInputRecord) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    taskPath: item.taskPath,
    taskId: item.taskId,
    sessionId: item.sessionId,
    role: item.role,
    kind: normalizeTaskInputKind(item.kind),
    text: item.text,
    contextRefs: item.contextRefs,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deliveredAt: item.deliveredAt,
    consumedAt: item.consumedAt,
    cancelledAt: item.cancelledAt,
    lastError: item.lastError,
    failedAt: item.failedAt,
    uncertainAt: item.uncertainAt,
    resolvedBy: item.resolvedBy,
  };
}

/** Best-effort: cancel only pending task inputs when task occupation ends. */
async function cancelTaskInputsForTask(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  resolvedBy: string
): Promise<void> {
  try {
    const cancelled = await ctx.taskInputs.cancelTask(
      workspaceId,
      taskPath,
      resolvedBy
    );
    for (const input of cancelled) {
      ctx.events.emit(
        "taskInput.cancelled",
        workspaceId,
        {
          inputId: input.id,
          decision: "cancelled",
          actor: resolvedBy,
          taskPath: input.taskPath,
          sessionId: input.sessionId,
        },
        "service"
      );
    }
  } catch {
    // cleanup must not block interrupt/fail
  }
}

async function cancelTaskInputsForSession(
  ctx: HandlerContext,
  workspaceId: string,
  sessionId: string,
  resolvedBy: string
): Promise<void> {
  try {
    const cancelled = await ctx.taskInputs.cancelSession(sessionId, resolvedBy);
    for (const input of cancelled) {
      ctx.events.emit(
        "taskInput.cancelled",
        workspaceId || input.workspaceId,
        {
          inputId: input.id,
          decision: "cancelled",
          actor: resolvedBy,
          taskPath: input.taskPath,
          sessionId: input.sessionId,
        },
        "service"
      );
    }
  } catch {
    // cleanup must not block session teardown
  }
}

// ---- operational retention (task-api §6; user-only) ----

/**
 * User-only dry-run of terminal operational cleanup.
 * Never mutates; does not accept free-form paths (scan is under temp/ via FsAdapter).
 */
async function operationalRetentionPreviewRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
) {
  requireUserActor(p, "operationalRetention.preview");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const keepTerminalTasksDays = parseKeepTerminalTasksDays(p);
  const preview = await previewOperationalRetention(mount.env.fs, {
    keepTerminalTasksDays,
    now: mount.env.clock.now(),
  });
  return { workspaceId, ...preview };
}

/**
 * User-only purge of terminal tasks / non-ready deliveries past retention.
 * Serialized on MutationBus. Emits exactly one retention.purged when files are deleted.
 */
async function operationalRetentionPurgeRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
) {
  requireUserActor(p, "operationalRetention.purge");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const keepTerminalTasksDays = parseKeepTerminalTasksDays(p);

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await purgeOperationalRetention(mount.env.fs, {
      keepTerminalTasksDays,
      now: mount.env.clock.now(),
    });
    if (result.deletedCount > 0) {
      emitRetentionPurged(ctx, workspaceId, result);
    }
    return { workspaceId, ...result };
  });
}

function requireUserActor(p: Record<string, unknown>, surface: string): string {
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      `${surface} is user-only; non-user actor is forbidden`,
      { actor: actorRaw }
    );
  }
  return actorRaw;
}

// ---- annotation.* (Node Markdown 划线注释; workspace-first-class; user-only) ----

function annotationErrorToRpc(error: AnnotationError): RpcError {
  switch (error.code) {
    case "NOT_FOUND":
      return new RpcError(-32004, error.message, { code: error.code });
    case "RANGE":
    case "QUOTE_MISMATCH":
    case "INVALID_INPUT":
    case "INVALID_STATUS":
      return new RpcError(-32602, error.message, { code: error.code });
    default:
      return new RpcError(-32602, error.message, { code: error.code });
  }
}

function projectAnnotationWire(
  record: AnnotationRecord,
  documentBody: string | null
): AnnotationProjection {
  return projectAnnotation(record, documentBody);
}

async function readConceptBody(
  mount: { env: { fs: import("../core/adapter.js").FsAdapter } },
  concept: { path: string; body?: string }
): Promise<{ body: string; raw: string; etag: string }> {
  const notePath = boxNotePath(concept.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { body } = parseFrontmatter(raw);
  return { body, raw, etag: contentEtag(raw) };
}

/**
 * List annotations for a Node (required nodeId / id / boxId).
 * Projection relocates by quote against live body; missing Node → orphan/missing-node.
 * Does not rewrite stored anchors.
 */
async function annotationListRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const nodeId =
    optionalString(p, "nodeId") ??
    optionalString(p, "id") ??
    optionalString(p, "boxId");
  if (!nodeId) {
    throw new RpcError(-32602, "annotation.list requires nodeId (or id / boxId)");
  }

  const tent = await loadTent(mount.env.fs);
  const concept = tent.byId.get(nodeId) ?? null;
  let documentBody: string | null = null;
  if (concept) {
    const note = await readConceptBody(mount, concept);
    documentBody = note.body;
  }

  const records = await listAnnotationRecords(mount.env.fs, nodeId);
  const annotations = records.map((r) => projectAnnotationWire(r, documentBody));
  return { workspaceId, nodeId, annotations };
}

/**
 * User-only create. Validates range/quote against authoritative Node body.
 * Rejects empty quote/body, OOB range, etag conflict. MutationBus; event invalidation only.
 */
async function annotationCreateRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  requireUserActor(p, "annotation.create");

  const nodeId =
    optionalString(p, "nodeId") ??
    optionalString(p, "id") ??
    optionalString(p, "boxId");
  if (!nodeId) {
    throw new RpcError(-32602, "annotation.create requires nodeId (or id / boxId)");
  }

  const quote = typeof p.quote === "string" ? p.quote : undefined;
  const body = typeof p.body === "string" ? p.body : undefined;
  if (quote === undefined || quote.length === 0) {
    throw new RpcError(-32602, "annotation.create requires non-empty quote");
  }
  if (body === undefined || body.trim().length === 0) {
    throw new RpcError(-32602, "annotation.create requires non-empty body");
  }

  const start = p.start;
  const end = p.end;
  if (typeof start !== "number" || !Number.isInteger(start)) {
    throw new RpcError(-32602, "annotation.create requires integer start");
  }
  if (typeof end !== "number" || !Number.isInteger(end)) {
    throw new RpcError(-32602, "annotation.create requires integer end");
  }

  const baseEtag =
    optionalString(p, "documentEtag") ??
    optionalString(p, "baseEtag") ??
    optionalString(p, "etag");
  if (!baseEtag) {
    throw new RpcError(-32602, "annotation.create requires documentEtag (or baseEtag)");
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = tent.byId.get(nodeId);
    if (!concept) {
      throw new RpcError(-32004, `Concept not found: ${nodeId}`);
    }
    const note = await readConceptBody(mount, concept);
    if (baseEtag !== note.etag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag: note.etag,
        baseEtag,
        path: concept.path,
        nodeId,
      });
    }

    try {
      const record = await createAnnotation(mount.env.fs, {
        nodeId: concept.id,
        quote,
        start,
        end,
        documentEtag: note.etag,
        body,
        documentBody: note.body,
      });
      const projection = projectAnnotationWire(record, note.body);
      ctx.events.emit(
        "annotation.changed",
        workspaceId,
        {
          action: "create",
          id: record.id,
          nodeId: record.nodeId,
        },
        "self"
      );
      return { workspaceId, annotation: projection };
    } catch (error) {
      if (error instanceof AnnotationError) throw annotationErrorToRpc(error);
      throw error;
    }
  });
}

async function annotationResolveRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  requireUserActor(p, "annotation.resolve");
  const id = requireString(p, "id");

  return ctx.mutations.run(workspaceId, async () => {
    try {
      const record = await resolveAnnotation(mount.env.fs, id);
      const tent = await loadTent(mount.env.fs);
      const concept = tent.byId.get(record.nodeId) ?? null;
      let documentBody: string | null = null;
      if (concept) {
        documentBody = (await readConceptBody(mount, concept)).body;
      }
      const projection = projectAnnotationWire(record, documentBody);
      ctx.events.emit(
        "annotation.changed",
        workspaceId,
        {
          action: "resolve",
          id: record.id,
          nodeId: record.nodeId,
        },
        "self"
      );
      return { workspaceId, annotation: projection };
    } catch (error) {
      if (error instanceof AnnotationError) throw annotationErrorToRpc(error);
      throw error;
    }
  });
}

async function annotationReopenRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  requireUserActor(p, "annotation.reopen");
  const id = requireString(p, "id");

  return ctx.mutations.run(workspaceId, async () => {
    try {
      const record = await reopenAnnotation(mount.env.fs, id);
      const tent = await loadTent(mount.env.fs);
      const concept = tent.byId.get(record.nodeId) ?? null;
      let documentBody: string | null = null;
      if (concept) {
        documentBody = (await readConceptBody(mount, concept)).body;
      }
      const projection = projectAnnotationWire(record, documentBody);
      ctx.events.emit(
        "annotation.changed",
        workspaceId,
        {
          action: "reopen",
          id: record.id,
          nodeId: record.nodeId,
        },
        "self"
      );
      return { workspaceId, annotation: projection };
    } catch (error) {
      if (error instanceof AnnotationError) throw annotationErrorToRpc(error);
      throw error;
    }
  });
}

async function annotationDeleteRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  requireUserActor(p, "annotation.delete");
  const id = requireString(p, "id");

  return ctx.mutations.run(workspaceId, async () => {
    try {
      const removed = await deleteAnnotation(mount.env.fs, id);
      if (!removed) {
        throw new RpcError(-32004, `Annotation not found: ${id}`);
      }
      ctx.events.emit(
        "annotation.changed",
        workspaceId,
        {
          action: "delete",
          id: removed.id,
          nodeId: removed.nodeId,
        },
        "self"
      );
      return { workspaceId, deleted: true, id: removed.id, nodeId: removed.nodeId };
    } catch (error) {
      if (error instanceof AnnotationError) throw annotationErrorToRpc(error);
      throw error;
    }
  });
}

/** Validate keepTerminalTasksDays at the RPC boundary (default applied in core if omitted). */
function parseKeepTerminalTasksDays(p: Record<string, unknown>): number {
  const v = p.keepTerminalTasksDays;
  try {
    return normalizeKeepTerminalTasksDays(v);
  } catch (error) {
    if (error instanceof RetentionError || (error instanceof Error && error.name === "RetentionError")) {
      throw new RpcError(-32602, error.message, {
        code: error instanceof RetentionError ? error.code : "INVALID_KEEP_DAYS",
      });
    }
    throw error;
  }
}

function emitRetentionPurged(
  ctx: HandlerContext,
  workspaceId: string,
  result: RetentionPurgeResult
): void {
  ctx.events.emit(
    "retention.purged",
    workspaceId,
    {
      keepTerminalTasksDays: result.keepTerminalTasksDays,
      cutoff: result.cutoff,
      deletedCount: result.deletedCount,
      taskPaths: result.purged.taskPaths,
      deliveryPaths: result.purged.deliveryPaths,
      candidateTaskCount: result.candidateTaskCount,
      candidateDeliveryCount: result.candidateDeliveryCount,
      warnings: result.warnings,
    },
    "self"
  );
}

// ---- runtime event bridge (called from service bootstrap) ----

/**
 * Dedup keys for managed auto-delivery: one successful prompt_complete per
 * sessionId+taskPath must not create two deliveries (reconnect / double emit).
 * Authority remains task lifecycle (ready delivery / non-running state also blocks).
 */
const managedAutoDeliverInFlight = new Set<string>();
const managedAutoDeliverDone = new Set<string>();

/**
 * Session ids currently inside reject-resume native resumeSession.
 * A failed resume emits session.failed while the rework task is already running;
 * projection must not terminally task.fail that occupation — park/fail-loud owns it.
 */
const rejectResumeNativeInFlight = new Set<string>();

/**
 * Per-session projection queue (key = sessionId). Different sessions proceed
 * independently; failures do not poison later events for the same session.
 * Reuses MutationBus bookkeeping (bounded tails, catch-through).
 */
const runtimeProjectionQueue = new MutationBus();

/** Single bounded retry delay for a failed projection (deterministic, short). */
const PROJECTION_RETRY_DELAY_MS = 40;

type RuntimeProjectionTestHooks = {
  /** Runs at the start of each projection attempt (including retries). */
  beforeProject?: (ev: RuntimeEvent, attempt: number) => Promise<void> | void;
  /**
   * Fail this many projection attempts (decremented across events/retries),
   * then succeed. Used to simulate transient vs permanent mutation failures.
   */
  failAttemptsRemaining?: number;
  /** Override retry delay (default PROJECTION_RETRY_DELAY_MS). */
  retryDelayMs?: number;
};

let runtimeProjectionTestHooks: RuntimeProjectionTestHooks | null = null;

/** Test helper: inject delay / transient failures into runtime projection. */
export function setRuntimeProjectionTestHooksForTests(
  hooks: RuntimeProjectionTestHooks | null
): void {
  runtimeProjectionTestHooks = hooks;
}

/** Test helper: clear projection test hooks (queue drains via MutationBus). */
export function resetRuntimeProjectionForTests(): void {
  runtimeProjectionTestHooks = null;
}

function managedDeliverKey(sessionId: string, taskPath: string): string {
  return `${sessionId}::${taskPath}`;
}

/** True while seal-before-deliver holds the in-flight lock for this session+task. */
function isManagedAutoDeliverSealing(
  sessionId: string,
  taskPath: string,
  taskId?: string
): boolean {
  if (managedAutoDeliverInFlight.has(managedDeliverKey(sessionId, taskPath))) {
    return true;
  }
  if (taskId && managedAutoDeliverInFlight.has(managedDeliverKey(sessionId, taskId))) {
    return true;
  }
  return false;
}

function projectionRetryDelayMs(): number {
  return runtimeProjectionTestHooks?.retryDelayMs ?? PROJECTION_RETRY_DELAY_MS;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyProjectionError(err: unknown): {
  errorClass: string;
  errorCode?: string | number;
} {
  if (err instanceof TaskLifecycleError) {
    return { errorClass: "TaskLifecycleError", errorCode: err.code };
  }
  if (err instanceof RpcError) {
    return { errorClass: "RpcError", errorCode: err.code };
  }
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } };
    const errorClass =
      (typeof e.name === "string" && e.name) ||
      e.constructor?.name ||
      "Error";
    const errorCode =
      typeof e.code === "string" || typeof e.code === "number" ? e.code : undefined;
    return errorCode !== undefined ? { errorClass, errorCode } : { errorClass };
  }
  return { errorClass: "UnknownError" };
}

/**
 * Bridge RuntimeEvent → session registry / task lifecycle / client events.
 *
 * Returns a Promise callers may ignore. Projection is serialized per sessionId
 * (not process-wide). On failure: one bounded retry; after exhaustion emit a
 * safe service.health diagnostic and resolve without throwing (no unhandled rejection).
 */
export function mapRuntimeEventToService(
  ctx: HandlerContext,
  ev: RuntimeEvent
): Promise<void> {
  return runtimeProjectionQueue.run(ev.sessionId, async () => {
    try {
      await projectRuntimeEventWithRetry(ctx, ev);
    } catch (err) {
      await reportRuntimeProjectionFailure(ctx, ev, err);
      // Exhausted retry: do not throw — later events for this session must still run.
    }
  });
}

async function projectRuntimeEventWithRetry(
  ctx: HandlerContext,
  ev: RuntimeEvent
): Promise<void> {
  try {
    await projectRuntimeEventOnce(ctx, ev, 1);
  } catch {
    await sleepMs(projectionRetryDelayMs());
    await projectRuntimeEventOnce(ctx, ev, 2);
  }
}

async function reportRuntimeProjectionFailure(
  ctx: HandlerContext,
  ev: RuntimeEvent,
  err: unknown
): Promise<void> {
  const classified = classifyProjectionError(err);
  let workspaceId = "";
  try {
    const rec = await ctx.runtime.registry.read(ev.sessionId);
    workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
  } catch {
    workspaceId = ctx.host.getForegroundId() ?? "";
  }

  // Safe diagnostic only — no stdout tails, prompts, tokens, or full error objects.
  console.error(
    `[tent-service] runtime projection failed sessionId=${ev.sessionId} event=${ev.type}` +
      ` class=${classified.errorClass}` +
      (classified.errorCode !== undefined ? ` code=${classified.errorCode}` : "")
  );

  ctx.events.emit(
    "service.health",
    workspaceId,
    {
      action: "runtime-projection-failed",
      sessionId: ev.sessionId,
      runtimeEvent: ev.type,
      errorClass: classified.errorClass,
      ...(classified.errorCode !== undefined ? { errorCode: classified.errorCode } : {}),
    },
    "service"
  );
}

/**
 * Single projection attempt. Emits client-visible session.state only after
 * internal session projection succeeds (stdout_tail remains diagnostics-only).
 */
async function projectRuntimeEventOnce(
  ctx: HandlerContext,
  ev: RuntimeEvent,
  attempt: number
): Promise<void> {
  if (runtimeProjectionTestHooks?.beforeProject) {
    await runtimeProjectionTestHooks.beforeProject(ev, attempt);
  }
  if (
    runtimeProjectionTestHooks &&
    typeof runtimeProjectionTestHooks.failAttemptsRemaining === "number" &&
    runtimeProjectionTestHooks.failAttemptsRemaining > 0
  ) {
    runtimeProjectionTestHooks.failAttemptsRemaining -= 1;
    const injected = new Error("injected runtime projection failure");
    injected.name = "ProjectionInjectedError";
    (injected as Error & { code: string }).code = "PROJECTION_INJECTED";
    throw injected;
  }

  const rec = await ctx.runtime.registry.read(ev.sessionId);
  if (ev.type === "session.prompt_complete" && !rec?.lastTaskId) {
    throw new Error(
      `Managed prompt completion has no task binding: ${ev.sessionId}`
    );
  }
  const workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
  if (ev.type === "session.stdout_tail") {
    // Diagnostics only — never product chat; optional quiet emit.
    return;
  }

  const hasPendingToolApproval =
    ev.type === "session.live"
      ? await ctx.toolApprovals.hasPendingForSession(ev.sessionId)
      : false;

  // Reflect waiting-user on session row for probe honesty (no chat).
  if (ev.type === "session.waiting_user") {
    if (rec && SessionRegistry.isNonTerminal(rec.state)) {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user",
      });
    }
  } else if (ev.type === "session.live") {
    const current = await ctx.runtime.registry.read(ev.sessionId);
    if (current && SessionRegistry.isNonTerminal(current.state) && hasPendingToolApproval) {
      // One of several concurrent tool asks resolved; the session is still blocked.
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user",
      });
    } else if (current && current.state === "waiting-user") {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "live",
        ...(ev.pid != null ? { pid: ev.pid } : {}),
      });
    }
  } else if (ev.type === "session.failed" || ev.type === "session.exited") {
    // Pending tool approvals must not hang after process death.
    await ctx.toolApprovals.cancelSession(ev.sessionId, "denied");
    // Session terminal is diagnostic for inputs when:
    // - intentional seal/post-deliver stop (stopReason=user) — adapter may emit
    //   session.failed ("interrupted") rather than session.exited;
    // - native reject-resume in flight or already parked waiting(external);
    // - bound task already published a Delivery / is otherwise collaboration-terminal.
    // Late terminal events must not cancel durable review-feedback or demote Delivery.
    const boundTaskForTerminal = await loadBoundTaskForSessionTerminal(
      ctx,
      rec,
      ev.sessionId
    );
    const retainInputsOnTerminal = shouldRetainInputsOnSessionTerminal({
      sessionId: ev.sessionId,
      stopReason: rec?.stopReason,
      task: boundTaskForTerminal,
    });
    if (!retainInputsOnTerminal && !boundTaskForTerminal) {
      // Unbound session: no task mutation can own cleanup, so cancel by session.
      // Pending business UserAsks bound to this session are cancelled (not answered).
      await cancelUserAsksForSession(
        ctx,
        workspaceId,
        ev.sessionId,
        ev.type === "session.failed" ? "session.failed" : "session.exited"
      );
      // Only pending U2A inputs; delivered remains delivered after cleanup.
      await cancelTaskInputsForSession(
        ctx,
        workspaceId,
        ev.sessionId,
        ev.type === "session.failed" ? "session.failed" : "session.exited"
      );
    }
  }

  // Map waiting_user / failed / prompt_complete onto bound task when lastTaskId known.
  // Task lifecycle ops are idempotent; failures throw so the outer retry can re-run.
  if (rec?.lastTaskId) {
    const mountInfos = ctx.host.list();
    for (const info of mountInfos) {
      if (rec.workspace && info.workspaceId !== rec.workspace) continue;
      const mount = ctx.host.get(info.workspaceId);
      if (!mount) continue;
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      // Prefer exact session binding. lastTaskId is a fallback only when the task
      // is still bound to this session (or has no sessionId yet). After reject-resume
      // rebinds to a new ss-, a late session.exited from the prior process must not
      // task.fail the rework occupation or cancel the review-feedback U2A item.
      const currentTask = tasks.find((t) => {
        if (t.id !== rec.lastTaskId && t.path !== rec.lastTaskId) return false;
        return !t.sessionId || t.sessionId === ev.sessionId;
      });
      const task = currentTask ?? tasks.find((t) => t.sessionId === ev.sessionId);
      if (!task) continue;
      if (ev.type === "session.waiting_user" && task.state === "running") {
        await ctx.mutations.run(mount.workspaceId, async () => {
          ctx.host.markSelfWrite(mount.workspaceId);
          const waited = await taskWait(mount.env, task.path, {
            reason: "user-input",
            summary: ev.summary,
          });
          emitTaskState(ctx, mount.workspaceId, waited, "session.waiting_user");
        });
      } else if (
        ev.type === "session.live" &&
        !hasPendingToolApproval &&
        task.state === "waiting" &&
        task.wait?.reason === "user-input"
      ) {
        // Tool approval resolved (or session resumed) → running again.
        // Keep waiting when a business UserAsk is still pending for this task.
        const pendingAsk = await ctx.userAsks.getPendingForTask(
          mount.workspaceId,
          task.path
        );
        if (!pendingAsk) {
          await ctx.mutations.run(mount.workspaceId, async () => {
            ctx.host.markSelfWrite(mount.workspaceId);
            const resumed = await taskResume(mount.env, task.path);
            emitTaskState(ctx, mount.workspaceId, resumed, "session.live");
          });
        }
      } else if (
        (ev.type === "session.failed" || ev.type === "session.exited") &&
        (task.state === "running" || task.state === "waiting")
      ) {
        // Session terminal → task.fail only while the task is still the active
        // pre-delivery occupation. Once Delivery is published, reject-resume has
        // parked waiting(external), or seal/post-deliver intentionally stopped
        // the process, session terminal is diagnostic only.
        if (
          shouldSkipTaskFailOnSessionTerminal({
            sessionId: ev.sessionId,
            eventType: ev.type,
            stopReason: rec?.stopReason,
            task,
          })
        ) {
          continue;
        }
        await failTaskFromRuntime(ctx, {
          workspaceId: mount.workspaceId,
          taskPath: task.path,
          sessionId: ev.sessionId,
          reason: ev.type,
          summary:
            ev.type === "session.failed"
              ? ev.error
              : `Managed session exited before delivery (code=${ev.exitCode ?? "unknown"})`,
        });
      } else if (ev.type === "session.prompt_complete") {
        await tryManagedAutoDeliver(ctx, {
          workspaceId: mount.workspaceId,
          taskPath: task.path,
          sessionId: ev.sessionId,
          assistantText: ev.assistantText,
        });
      }
    }
  }

  // Client-visible session.state only after full internal projection succeeds.
  // Failed attempts never reach here, so a single retry does not duplicate this event.
  ctx.events.emit(
    "session.state",
    workspaceId,
    {
      sessionId: ev.sessionId,
      runtimeEvent: ev.type,
      ...("pid" in ev ? { pid: ev.pid } : {}),
      ...("exitCode" in ev ? { exitCode: ev.exitCode } : {}),
      ...("error" in ev ? { error: ev.error } : {}),
      ...("summary" in ev ? { summary: ev.summary } : {}),
      ...(ev.type === "session.prompt_complete"
        ? { assistantChars: ev.assistantText.length, stopReason: ev.stopReason }
        : {}),
    },
    "service"
  );
}

/**
 * Single core path for runtime→task failed: taskFail (occupation release) +
 * idempotent session stop. Duplicate failure/exit events are safe.
 *
 * Re-reads and mutates under one workspace lock so a late session.failed cannot
 * cancel durable review-feedback after reject-resume park, or demote a task
 * that has already left the active pre-delivery occupation.
 */
async function failTaskFromRuntime(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId?: string;
    reason: string;
    summary?: string;
  }
): Promise<void> {
  const mount = ctx.host.get(input.workspaceId);
  if (!mount) return;

  let appliedFailure = false;
  await ctx.mutations.run(input.workspaceId, async () => {
    ctx.host.markSelfWrite(input.workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
    if (current.state !== "running" && current.state !== "waiting" && current.state !== "failed") {
      // delivered / terminal other — do not force fail
      return;
    }
    if (current.state === "waiting" && isRejectResumeParkedWait(current)) {
      return;
    }
    if (input.sessionId && current.sessionId && current.sessionId !== input.sessionId) {
      return;
    }
    // The authority check and all durable cleanup share the same mutation
    // boundary. Delivery/reject-resume cannot interleave between this read and
    // cancellation of TaskInputs/UserAsks.
    await cancelUserAsksForTask(ctx, input.workspaceId, input.taskPath, "task.fail");
    await cancelTaskInputsForTask(ctx, input.workspaceId, input.taskPath, "task.fail");
    if (input.sessionId) {
      await cancelUserAsksForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "task.fail"
      );
      await cancelTaskInputsForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "task.fail"
      );
    }
    const failed = await taskFail(mount.env, input.taskPath, {
      summary: input.summary,
    });
    emitTaskState(ctx, input.workspaceId, failed, input.reason);
    appliedFailure = true;
  });

  if (!appliedFailure || !input.sessionId) return;
  try {
    await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
  } catch {
    // ignore
  }
  try {
    const probe = await ctx.runtime.probe(input.sessionId);
    if (probe.alive || SessionRegistry.isNonTerminal(probe.state)) {
      await ctx.runtime.stopSession(input.sessionId, "interrupt");
    }
  } catch {
    // already dead / already stopped
  }
}

/** True when reject-resume park owns this waiting(external) occupation. */
function isRejectResumeParkedWait(task: TaskEnvelope): boolean {
  return (
    task.state === "waiting" &&
    task.wait?.reason === "external" &&
    typeof task.wait.summary === "string" &&
    task.wait.summary.includes(REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY)
  );
}

/**
 * Collaboration-terminal task states: Session death is diagnostic only.
 * Includes published Delivery (`delivered`) and post-review terminals.
 */
function isTaskCollaborationTerminal(task: TaskEnvelope): boolean {
  return (
    task.state === "delivered" ||
    task.state === "accepted" ||
    task.state === "rejected" ||
    task.state === "interrupted" ||
    task.state === "failed"
  );
}

/**
 * Load the task still bound to this session for terminal input-retain decisions.
 * Best-effort: missing mount/row → undefined (caller falls back to cancel).
 */
async function loadBoundTaskForSessionTerminal(
  ctx: HandlerContext,
  rec: { lastTaskId?: string; workspace?: string } | null | undefined,
  sessionId: string
): Promise<TaskEnvelope | undefined> {
  if (!rec?.lastTaskId) return undefined;
  try {
    const mountInfos = ctx.host.list();
    for (const info of mountInfos) {
      if (rec.workspace && info.workspaceId !== rec.workspace) continue;
      const mount = ctx.host.get(info.workspaceId);
      if (!mount) continue;
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      const currentTask = tasks.find((t) => {
        if (t.id !== rec.lastTaskId && t.path !== rec.lastTaskId) return false;
        return !t.sessionId || t.sessionId === sessionId;
      });
      return currentTask ?? tasks.find((t) => t.sessionId === sessionId);
    }
  } catch {
    // best-effort
  }
  return undefined;
}

/**
 * Whether session terminal cleanup must retain durable TaskInputs / UserAsks.
 * stopReason=user covers seal-before-deliver and post-deliver stop even when the
 * adapter reports session.failed ("interrupted") instead of session.exited.
 */
function shouldRetainInputsOnSessionTerminal(input: {
  sessionId: string;
  stopReason?: string;
  task?: TaskEnvelope;
}): boolean {
  if (input.stopReason === "user") return true;
  if (rejectResumeNativeInFlight.has(input.sessionId)) return true;
  if (!input.task) return false;
  if (isRejectResumeParkedWait(input.task)) return true;
  // Published Delivery / post-review terminal: session death is diagnostic.
  if (isTaskCollaborationTerminal(input.task) && input.task.state !== "failed") {
    return true;
  }
  // Already-failed task: still cancel leftover pending rows (cleanup), unless
  // this was a reject-resume park (handled above).
  return false;
}

/**
 * Whether runtime terminal must skip task.fail for this bound task.
 * Preserves legitimate running/waiting (non-park) failure behavior.
 */
function shouldSkipTaskFailOnSessionTerminal(input: {
  sessionId: string;
  eventType: "session.failed" | "session.exited";
  stopReason?: string;
  task: TaskEnvelope;
}): boolean {
  // Intentional seal / post-deliver stop — adapter may emit failed or exited.
  if (input.stopReason === "user") return true;
  // In-flight auto-deliver seal: stopReason may race child exit.
  if (
    input.eventType === "session.exited" &&
    isManagedAutoDeliverSealing(input.sessionId, input.task.path, input.task.id)
  ) {
    return true;
  }
  if (
    input.eventType === "session.failed" &&
    isManagedAutoDeliverSealing(input.sessionId, input.task.path, input.task.id)
  ) {
    return true;
  }
  if (rejectResumeNativeInFlight.has(input.sessionId)) return true;
  if (isRejectResumeParkedWait(input.task)) return true;
  // Defensive: collaboration-terminal tasks never enter the fail branch via
  // the outer state filter, but keep the invariant local and explicit.
  if (isTaskCollaborationTerminal(input.task) && input.task.state !== "failed") {
    return true;
  }
  return false;
}

/**
 * Managed ACP path: capture final assistant response → same task.deliver lifecycle.
 * - summary/report = assistant final reply
 * - never auto-accept; manual → pending review; bypass/agent-decide use existing policy
 * - empty/error already filtered by adapter; still refuse empty here
 * - duplicate completion / already-delivered / terminal → ignore (no second delivery)
 * - production auto-collects pending commits from the task's authoritative role lane
 * - **Atomic boundary:** seal the managed turn (stop process / cancel tool asks)
 *   *before* publishing Delivery so post-response tool/write/commit cannot race
 *   dispatcher rebase or user accept. turn busy/idle is an internal fact; session
 *   live alone is not "turn done".
 */
async function tryManagedAutoDeliver(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId: string;
    assistantText: string;
    /**
     * Optional explicit commits for tests (e.g. integrate-conflict fixtures).
     * Production prompt_complete omits this and auto-collects from the role lane.
     */
    commits?: string[];
  }
): Promise<void> {
  // Prefer explicit assistantText; empty callers may recover a durable draft
  // (service restart / idempotent retry without re-prompting the Agent).
  let summary = input.assistantText.trim();
  let sessionId = input.sessionId.trim();
  if (!summary) {
    try {
      const draft = await ctx.managedDeliveryReportDrafts.get(
        input.workspaceId,
        input.taskPath
      );
      if (draft?.assistantText?.trim()) {
        summary = draft.assistantText.trim();
        if (!sessionId && draft.sessionId) {
          sessionId = draft.sessionId;
        }
      }
    } catch {
      // Draft lookup failure must not invent a delivery.
    }
  }
  if (!summary || !sessionId) {
    // Adapter should have failed already; do not invent a delivery.
    return;
  }

  const key = managedDeliverKey(sessionId, input.taskPath);
  if (managedAutoDeliverDone.has(key) || managedAutoDeliverInFlight.has(key)) {
    return;
  }
  managedAutoDeliverInFlight.add(key);

  let draftPreserved = false;
  try {
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;

    // Preflight: only seal/deliver while the task is still the active occupation
    // for this session. Avoid killing an already-rebound reject-resume session.
    const pre = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
    if (!pre || pre.state !== "running") {
      return;
    }
    if (pre.sessionId && pre.sessionId !== sessionId) {
      return;
    }
    const existingReady = await loadDeliveries(mount.env.fs, {
      taskId: pre.id || input.taskPath,
    });
    if (existingReady.some((d) => d.status === "ready")) {
      managedAutoDeliverDone.add(key);
      // Ready Delivery already published — drop any leftover draft.
      try {
        await ctx.managedDeliveryReportDrafts.clear(input.workspaceId, input.taskPath);
      } catch {
        // ignore
      }
      return;
    }

    // Durable preserve BEFORE seal/dirty/collect/integrate/publish so a later
    // failure can retry without re-running the Agent turn. Operational only —
    // not a ready Delivery, does not change task state.
    await ctx.managedDeliveryReportDrafts.preserve({
      workspaceId: input.workspaceId,
      taskPath: input.taskPath,
      taskId: pre.id || input.taskPath,
      sessionId,
      assistantText: summary,
    });
    draftPreserved = true;

    // Outside the mutation bus: capture-once baseline for legacy Git-lane tasks
    // missing roleBranchBase. Nested mutations.run would deadlock.
    if (input.commits === undefined) {
      await ensureTaskWorkspaceLane(ctx, input.workspaceId, pre);
    }

    // Seal turn BEFORE Delivery: process must not keep mutating the worktree
    // after the task enters delivered. stop-after-deliver semantics preserved
    // (role slot freed; registry resume metadata retained) but ordered first.
    const sealed = await sealManagedSessionBeforeDelivery(ctx, {
      workspaceId: input.workspaceId,
      sessionId,
      taskPath: input.taskPath,
    });
    if (!sealed) {
      // Leave task running for retry; do not publish a Delivery while the
      // agent process may still write/commit.
      throw new Error(
        "managed session could not be sealed before auto-deliver (process still mutable)"
      );
    }

    // Re-load authority state under mutation bus after seal.
    let published = false;
    await ctx.mutations.run(input.workspaceId, async () => {
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);

      // Only deliver from active running managed session for this sessionId.
      if (task.state !== "running") {
        // Already delivered / review / terminal / interrupted — ignore duplicate.
        return;
      }
      if (task.sessionId && task.sessionId !== sessionId) {
        return;
      }

      // Ready delivery already present → lifecycle forbids double ready.
      const existing = await loadDeliveries(mount.env.fs, {
        taskId: task.id || input.taskPath,
      });
      if (existing.some((d) => d.status === "ready")) {
        managedAutoDeliverDone.add(key);
        published = true;
        return;
      }

      // Seal-after, publish-before: refuse dirty task worktree so uncommitted
      // agent edits cannot be skipped in favor of stale already-committed SHAs.
      // Fail-loud keeps task running for commit-then-retry (same as public deliver).
      await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, task);

      // Collect pending role-lane commits unless the caller supplied an explicit list
      // (tests only). Production always auto-collects via the authoritative lane contract.
      // Collection runs after seal so tail commits after end_turn cannot appear.
      let commits = input.commits;
      if (commits === undefined) {
        commits = await collectManagedDeliveryCommits(mount.workspaceRoot, task);
      }

      ctx.host.markSelfWrite(input.workspaceId);
      const integrate = makeCommitIntegrator(ctx, mount.workspaceRoot, task);

      // agent-decide without an explicit agent decision: request-review (never auto-accept).
      const policy = task.deliveryPolicy ?? "manual";
      const decision =
        policy === "agent-decide" ? ("request-review" as const) : undefined;

      const result = await taskDeliver(mount.env, input.taskPath, {
        summary,
        decision,
        integrate,
        ...(commits.length > 0 ? { commits } : {}),
      });

      managedAutoDeliverDone.add(key);
      published = true;
      emitTaskState(ctx, input.workspaceId, result.task, "session.prompt_complete");
      ctx.events.emit(
        "delivery.updated",
        input.workspaceId,
        {
          id: result.delivery.id,
          taskId: result.delivery.taskId,
          status: result.delivery.status,
          reason: "session.prompt_complete",
          managedAuto: true,
        },
        "self"
      );
    });

    // Successful publish (or ready already present) → clear operational draft.
    if (published) {
      try {
        await ctx.managedDeliveryReportDrafts.clear(input.workspaceId, input.taskPath);
      } catch {
        // Delivery already committed; draft cleanup is best-effort (retry clears again).
      }
    }

    // Idempotent safety: seal already stopped; re-run cleanup if a race left
    // the process alive (must not roll back a successful Delivery).
    await stopManagedSessionAfterDelivery(ctx, {
      workspaceId: input.workspaceId,
      sessionId,
      taskPath: input.taskPath,
    });
  } catch (err) {
    // Deliver / integrate / collection / seal / dirty-worktree failure must NOT
    // terminal-fail the task. Keep running/occupation so the user can retry;
    // expose via session diagnostics/event. Only session.failed (launch/process)
    // maps task → failed. Report draft stays on disk for idempotent retry.
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof RpcError &&
      err.data &&
      typeof err.data === "object" &&
      typeof (err.data as { code?: unknown }).code === "string"
        ? (err.data as { code: string }).code
        : err instanceof TaskLifecycleError
          ? err.code
          : undefined;
    if (draftPreserved) {
      try {
        await ctx.managedDeliveryReportDrafts.markFailed(
          input.workspaceId,
          input.taskPath,
          message
        );
      } catch {
        // Draft body already durable; annotation is best-effort.
      }
    }
    try {
      const mount = ctx.host.get(input.workspaceId);
      if (!mount) return;
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (task.state === "running" || task.state === "waiting") {
        // Clear in-flight so a later prompt_complete / retry can attempt again.
        // Do not add to managedAutoDeliverDone — failure is not success.
        try {
          await ctx.runtime.registry.update(sessionId, {
            lastError: `managed auto-deliver failed: ${message}`,
          });
        } catch {
          // Session row may be gone; still emit diagnostics.
        }
        ctx.events.emit(
          "session.state",
          input.workspaceId,
          {
            sessionId,
            taskPath: input.taskPath,
            taskState: task.state,
            runtimeEvent: "session.prompt_complete.failed",
            error: message,
            ...(errorCode ? { errorCode } : {}),
            // Explicit: task remains non-terminal for retry.
            taskFailed: false,
            reportDraftPreserved: draftPreserved,
          },
          "service"
        );
      }
    } catch {
      // ignore nested mapping failures
    }
  } finally {
    managedAutoDeliverInFlight.delete(key);
  }
}

/**
 * Collect full SHAs still pending on this task's role lane since roleBranchBase.
 * - Non-Git / pure-docs (no recorded lane) → [] (legal zero-commit delivery).
 * - Recorded Git lane requires a baseline; never falls back to all pending role commits.
 * - Git / baseline / listing errors fail loud (caller keeps task/session retryable).
 */
async function collectManagedDeliveryCommits(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<string[]> {
  const hasRecordedLane = Boolean(
    task.workspace || task.worktree || task.branch || task.targetBranch
  );
  if (!hasRecordedLane) {
    // Legitimate non-Git / pure-docs task: no lane, zero commits.
    return [];
  }
  const base = task.roleBranchBase?.trim();
  if (!base) {
    throw new Error(
      `Managed delivery collection requires roleBranchBase on task ${task.id || task.path}; ` +
        `baseline must be captured at first Git lane bind (never fall back to all role commits).`
    );
  }
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  const pending = await listPendingRoleCommits(contract, base);
  return pending.map((commit) => commit.ref);
}

/**
 * Seal the managed turn before publishing Delivery.
 * Stops the process (and cancels pending tool asks / U2A rows) so post-response
 * worktree mutations cannot land after the task enters delivered.
 * Returns true when the session is no longer able to mutate (dead / terminal).
 * Returns false only when a stop was required and the process is still alive.
 *
 * Registry resume metadata is retained (stopReason=user). Managed-inject pins
 * keep in-flight TaskInput rows non-cancelable across this window.
 */
async function sealManagedSessionBeforeDelivery(
  ctx: HandlerContext,
  input: { workspaceId: string; sessionId: string; taskPath: string }
): Promise<boolean> {
  try {
    try {
      await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
    } catch {
      // ignore
    }
    try {
      await cancelUserAsksForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "session.stop_after_deliver"
      );
    } catch {
      // ignore
    }
    try {
      // Only pending inputs cancel; managed-inject pin / delivered stay.
      await cancelTaskInputsForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "session.stop_after_deliver"
      );
    } catch {
      // ignore
    }
    const probe = await ctx.runtime.probe(input.sessionId);
    if (probe.alive || SessionRegistry.isNonTerminal(probe.state)) {
      await ctx.runtime.stopSession(input.sessionId, "user");
    }
    const after = await ctx.runtime.probe(input.sessionId);
    // Sealed when process is dead. turnBusy must also be false when handle remains.
    return !after.alive && !after.turnBusy;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await ctx.runtime.registry.update(input.sessionId, {
        lastError: `managed session seal before deliver failed: ${message}`,
      });
    } catch {
      // registry row may already be gone
    }
    ctx.events.emit(
      "session.state",
      input.workspaceId,
      {
        sessionId: input.sessionId,
        taskPath: input.taskPath,
        runtimeEvent: "session.seal_before_deliver.failed",
        error: message,
        taskFailed: false,
      },
      "service"
    );
    try {
      const after = await ctx.runtime.probe(input.sessionId);
      return !after.alive && !after.turnBusy;
    } catch {
      // No probe: treat as sealed only when session is gone entirely.
      return true;
    }
  }
}

/**
 * After successful managed delivery, ensure the runtime session is stopped so
 * the same role can accept a new task. Usually a no-op after seal-before-deliver.
 * Registry row stays (resume metadata). Stop errors are diagnostic-only —
 * delivery already committed and must not roll back.
 */
async function stopManagedSessionAfterDelivery(
  ctx: HandlerContext,
  input: { workspaceId: string; sessionId: string; taskPath: string }
): Promise<void> {
  try {
    try {
      await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
    } catch {
      // ignore
    }
    try {
      await cancelUserAsksForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "session.stop_after_deliver"
      );
    } catch {
      // ignore
    }
    try {
      // Only pending inputs cancel; managed-delivered rows stay delivered.
      await cancelTaskInputsForSession(
        ctx,
        input.workspaceId,
        input.sessionId,
        "session.stop_after_deliver"
      );
    } catch {
      // ignore
    }
    const probe = await ctx.runtime.probe(input.sessionId);
    if (probe.alive || SessionRegistry.isNonTerminal(probe.state)) {
      await ctx.runtime.stopSession(input.sessionId, "user");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await ctx.runtime.registry.update(input.sessionId, {
        lastError: `managed session stop after deliver failed: ${message}`,
      });
    } catch {
      // registry row may already be gone
    }
    ctx.events.emit(
      "session.state",
      input.workspaceId,
      {
        sessionId: input.sessionId,
        taskPath: input.taskPath,
        runtimeEvent: "session.stop_after_deliver.failed",
        error: message,
        // Delivery already succeeded; task must not be failed for stop issues.
        taskFailed: false,
      },
      "service"
    );
  }
}

/**
 * Test-only: throw after fallback startSession succeeds, before context flag /
 * task rebind completes. Exercises orphan stop + park without losing occupation.
 * Production never sets this.
 */
let rejectResumePostStartFailureForTests: (() => Error) | null = null;

export function setRejectResumePostStartFailureForTests(
  fn: (() => Error) | null
): void {
  rejectResumePostStartFailureForTests = fn;
}

/** Test helper: clear in-process managed deliver dedup (does not touch disk). */
export function resetManagedAutoDeliverDedupForTests(): void {
  managedAutoDeliverInFlight.clear();
  managedAutoDeliverDone.clear();
  rejectResumeNativeInFlight.clear();
  rejectResumePostStartFailureForTests = null;
}

/**
 * Test helper: invoke managed U2A deliver (sendInput / reject-resume review).
 * Used to simulate post-restart retry of a durable pending TaskInput without
 * relying on in-memory enqueue state from the original RPC.
 */
export async function invokeDeliverManagedTaskInputForTests(
  ctx: HandlerContext,
  item: TaskInputRecord,
  opts?: { sessionIdOverride?: string }
): Promise<ManagedTaskInputDelivery> {
  return deliverManagedTaskInput(ctx, item, opts);
}

/** Drop managed auto-deliver success/in-flight markers for one session+task pair. */
function clearManagedAutoDeliverDedup(sessionId: string, taskPath: string): void {
  const key = managedDeliverKey(sessionId, taskPath);
  managedAutoDeliverDone.delete(key);
  managedAutoDeliverInFlight.delete(key);
}

/**
 * Chinese summary when reject-resume could not restore a live managed session.
 * Task stays occupied (waiting) so the user can retry startSession or interrupt.
 * Used when registry/profile identity is missing or independent new-session start fails.
 */
export const REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY =
  "驳回续跑未能恢复 managed session。可重新 startSession，或 interrupt 任务；occupation 保持。";

/** Restore provenance for reject-resume managed session recovery. */
export type RejectResumeRestoreReason =
  | "task.reject.resume.alive"
  | "task.reject.resume.native"
  | "task.reject.resume.new-session"
  | "task.reject.resume.native-fallback";

type RejectResumeRestoredSession = {
  sessionId: string;
  profileId: string;
  adapterId: string;
  state: string;
  cwd?: string;
  /**
   * true = provider-native same-context path; false = independent recovery Session.
   * Never omit on reject-resume projections — callers must not invent continuity.
   */
  contextRestored: boolean;
  /** Why this session was chosen (alive / native / new / native-fallback). */
  restoreReason: RejectResumeRestoreReason;
};

/**
 * Compact recovery orientation for independent reject-resume Sessions.
 * Built from durable Task / Delivery / session facts only.
 * Review note is NEVER included here — it appears solely under ## Review Feedback.
 */
function buildRejectResumeRecoveryOrientation(
  task: TaskEnvelope,
  roots: { workspaceRoot: string; systemRoot: string },
  opts: {
    priorSessionId?: string;
    nativeResumeFailed: boolean;
    nativeResumeError?: string;
    rejectedDelivery?: { id: string; summary: string };
    workspaceLane?: {
      workspace: string;
      worktree: string;
      branch: string;
      targetBranch?: string;
    };
  }
): string {
  const base = buildSessionBootstrapPrompt(task, roots);
  const lines: string[] = [
    "--- Tent reject-resume recovery ---",
    "contextRestored: false",
    "Native provider Session continuity was not restored. This is an independent managed Session on the same task/workspace lane.",
    "Do not invent prior chat/cache continuity. Use Task/Node refs below; review note appears only under ## Review Feedback.",
  ];
  if (opts.priorSessionId) {
    lines.push(`priorSessionId: ${opts.priorSessionId}`);
  }
  lines.push(
    opts.nativeResumeFailed
      ? "restorePath: native-resume-failed-fallback"
      : "restorePath: not-resume-capable-new-session"
  );
  if (opts.nativeResumeError?.trim()) {
    lines.push(`nativeResumeError: ${opts.nativeResumeError.trim()}`);
  }
  lines.push(`Task envelope: ${task.path}`);
  if (task.id) lines.push(`Task id: ${task.id}`);
  if (task.manifest) lines.push(`Manifest: ${task.manifest}`);
  if (task.claims?.length) {
    lines.push(`claims (Node refs): ${task.claims.join(", ")}`);
  }
  if (opts.workspaceLane) {
    lines.push("workspace lane:");
    lines.push(`  workspace: ${opts.workspaceLane.workspace}`);
    lines.push(`  worktree: ${opts.workspaceLane.worktree}`);
    lines.push(`  branch: ${opts.workspaceLane.branch}`);
    if (opts.workspaceLane.targetBranch) {
      lines.push(`  targetBranch: ${opts.workspaceLane.targetBranch}`);
    }
  }
  if (opts.rejectedDelivery) {
    // Delivery summary only — never re-copy review note (solely under ## Review Feedback).
    lines.push("rejected Delivery:");
    lines.push(`  id: ${opts.rejectedDelivery.id}`);
    lines.push(`  summary: ${opts.rejectedDelivery.summary}`);
  }
  lines.push(
    "Final report still goes through Delivery only. Feedback delivery remains exactly once via TaskInput."
  );
  return `${base}\n\n${lines.join("\n")}\n`;
}

async function loadRejectedDeliveryForRejectResume(
  fs: import("../core/adapter.js").FsAdapter,
  task: TaskEnvelope
): Promise<{ id: string; summary: string } | undefined> {
  const taskId = task.id?.trim();
  if (!taskId) return undefined;
  try {
    const deliveries = await loadDeliveries(fs, { taskId });
    const rejected = deliveries.find((d) => d.status === "rejected");
    if (!rejected) return undefined;
    return {
      id: rejected.id,
      summary: rejected.summary,
    };
  } catch {
    return undefined;
  }
}

/**
 * Rebuild recovery orientation at inject time from durable facts so restart/retry
 * does not depend on in-memory enqueue options.
 *
 * - Same-context / ordinary Sessions (contextRestored !== false): return undefined
 *   (no recovery prefix).
 * - Independent recovery Sessions (contextRestored === false): orientation is
 *   **mandatory** because the process was started with an empty bootstrap.
 *   Registry / mount / task-load failures throw so managed inject fails and
 *   TaskInput stays failed/retryable — never silently send bare ## Review Feedback.
 */
async function rebuildRejectResumeRecoveryOrientation(
  ctx: HandlerContext,
  item: TaskInputRecord
): Promise<string | undefined> {
  if (normalizeTaskInputKind(item.kind) !== "review-feedback") return undefined;
  const sessionId = item.sessionId?.trim();
  if (!sessionId) return undefined;

  let rec: SessionRecord | null;
  try {
    rec = await ctx.runtime.registry.read(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `reject-resume recovery orientation required but session registry read failed for ${sessionId}: ${message}`
    );
  }
  if (!rec) {
    throw new Error(
      `reject-resume recovery orientation required but session registry row missing for ${sessionId}`
    );
  }
  // Only independent recovery Sessions claim contextRestored=false.
  // Missing/undefined/true → same-context or ordinary start; no recovery prefix.
  if (rec.contextRestored !== false) return undefined;

  const mount = ctx.host.get(item.workspaceId);
  if (!mount) {
    throw new Error(
      `reject-resume recovery orientation required (contextRestored=false) but workspace mount missing: ${item.workspaceId}`
    );
  }

  let task: TaskEnvelope;
  try {
    task = await loadTaskEnvelope(mount.env.fs, item.taskPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `reject-resume recovery orientation required (contextRestored=false) but task load failed for ${item.taskPath}: ${message}`
    );
  }

  const workspaceLane = {
    workspace: task.workspace || mount.workspaceRoot,
    worktree: task.worktree || mount.workspaceRoot,
    branch: task.branch || "HEAD",
    targetBranch: task.targetBranch,
  };
  // Delivery lookup is best-effort content — missing rejected delivery still
  // yields orientation with task/lane facts (does not invent review note).
  const rejectedDelivery = await loadRejectedDeliveryForRejectResume(
    mount.env.fs,
    task
  );
  // lastError may retain "native resume failed: …" from fallback start.
  // Prefer restorePath from contextRestored=false; treat lastError as native-fail
  // provenance when present (best-effort, no new domain fields).
  const lastError = rec.lastError?.trim() || "";
  const nativeResumeFailed = /native resume failed/i.test(lastError);
  const nativeResumeError = nativeResumeFailed
    ? lastError.replace(/^reject-resume restore failed:\s*/i, "").trim() ||
      lastError
    : undefined;

  const orientation = buildRejectResumeRecoveryOrientation(
    task,
    {
      workspaceRoot: mount.workspaceRoot,
      systemRoot: mount.systemRoot,
    },
    {
      // No durable priorSessionId field — omit rather than invent.
      nativeResumeFailed,
      nativeResumeError,
      rejectedDelivery,
      workspaceLane,
    }
  );
  if (!orientation.trim()) {
    throw new Error(
      `reject-resume recovery orientation required (contextRestored=false) but builder returned empty for ${sessionId}`
    );
  }
  return orientation;
}

/** Best-effort stop of an orphan managed Session (fallback start succeeded mid-failure). */
async function stopOrphanRejectResumeSession(
  ctx: HandlerContext,
  sessionId: string
): Promise<void> {
  try {
    await ctx.runtime.stopSession(sessionId, "interrupt");
  } catch {
    // already dead / unknown
  }
  try {
    await ctx.runtime.registry.update(sessionId, {
      lastError: "reject-resume fallback orphan stopped after rebind/context failure",
      contextRestored: false,
    });
  } catch {
    // registry row may be gone
  }
}

/**
 * After core reject(resume) for a managed task:
 * - alive → rebind the same Tent sessionId (contextRestored=true)
 * - stopped + resumeCapable → native runtime.resumeSession first (contextRestored=true)
 * - native resume **explicitly fails** → honest new ss- (contextRestored=false);
 *   never silently claim cache continuity
 * - not resumeCapable → trackable new ss- (contextRestored=false)
 * Registry/profile identity failures still park waiting(external).
 * If fallback startSession succeeds but context flag / task rebind fails, best-effort
 * stop the new Session before parking (no orphan live process).
 * Review feedback is injected once after restore; recovery orientation is rebuilt
 * at inject time from durable task/session/delivery facts.
 */
async function restoreManagedSessionAfterRejectResume(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
  }
): Promise<{
  task: TaskEnvelope;
  session: RejectResumeRestoredSession;
}> {
  const mount = ctx.host.require(input.workspaceId);
  let task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
  if (task.state !== "running") {
    throw new Error(
      `reject-resume restore requires task state running; got ${task.state}`
    );
  }

  const priorSessionId = task.sessionId?.trim() || "";
  if (!priorSessionId) {
    throw new Error("reject-resume restore requires task.sessionId");
  }

  // Lane + baseline must already exist for managed tasks that delivered once.
  task = await ensureTaskWorkspaceLane(ctx, input.workspaceId, task);
  const cwd = task.worktree || mount.workspaceRoot;
  // Always project a workspace lane for recovery honesty (even when Git lane
  // fields are sparse — fall back to mount roots so the agent sees the cwd).
  const workspaceLane = {
    workspace: task.workspace || mount.workspaceRoot,
    worktree: task.worktree || mount.workspaceRoot,
    branch: task.branch || "HEAD",
    targetBranch: task.targetBranch,
  };

  const prior = await ctx.runtime.registry.read(priorSessionId);
  if (!prior) {
    throw new Error(
      `Managed session registry row missing for ${priorSessionId}; cannot restore after reject-resume`
    );
  }

  const profileId = prior.profileId?.trim();
  if (!profileId) {
    throw new Error(
      `Managed session ${priorSessionId} has no profileId for reject-resume restore`
    );
  }
  if (taskAssigneeKind(task) === "agentProfile" && task.role !== profileId) {
    throw new Error(
      `reject-resume profileId must match agentProfile assignee (${task.role}); session has ${profileId}`
    );
  }

  // Durable role: another live managed session for the same role blocks restore
  // (same rule as startSession) unless it is already this task's binding.
  if (taskAssigneeKind(task) !== "agentProfile") {
    const activeForRole = await findActiveManagedSessionForRole(
      ctx,
      input.workspaceId,
      task.role
    );
    if (activeForRole) {
      const boundToThisTask =
        (!!task.id && activeForRole.lastTaskId === task.id) ||
        activeForRole.lastTaskId === input.taskPath;
      if (!boundToThisTask) {
        throw new Error(
          `Role "${task.role}" already has an active managed session: ${activeForRole.id}`
        );
      }
    }
  }

  // Empty bootstrap: go live without first session/prompt so auto-deliver cannot
  // race seal before the single ## Review Feedback inject.
  const emptyBootstrap = "";

  let probe: Awaited<ReturnType<typeof ctx.runtime.probe>> | undefined;
  try {
    probe = await ctx.runtime.probe(priorSessionId);
    if (probe.alive && SessionRegistry.isNonTerminal(probe.state)) {
      // Still live (unusual after managed deliver stop) — rebind only.
      await ctx.runtime.registry.update(priorSessionId, {
        contextRestored: true,
      });
      const bound = await ctx.mutations.run(input.workspaceId, async () => {
        ctx.host.markSelfWrite(input.workspaceId);
        return patchTaskEnvelope(mount.env.fs, input.taskPath, {
          sessionId: priorSessionId,
          updatedAt: mount.env.clock.now(),
        });
      });
      emitTaskState(ctx, input.workspaceId, bound, "task.reject.resume");
      ctx.events.emit(
        "session.state",
        input.workspaceId,
        {
          sessionId: priorSessionId,
          state: probe.state,
          profileId,
          taskPath: input.taskPath,
          reason: "task.reject.resume.alive",
          contextRestored: true,
        },
        "self"
      );
      return {
        task: bound,
        session: {
          sessionId: priorSessionId,
          profileId,
          adapterId: prior.adapterId,
          state: probe.state,
          cwd,
          contextRestored: true,
          restoreReason: "task.reject.resume.alive",
        },
      };
    }
  } catch (err) {
    if (!/Session not found/i.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
  }

  // Stopped / not live: prefer native resume when the prior row is resume-capable.
  // Explicit native failure → honest independent new Session (contextRestored=false).
  // Never claim cache continuity on the fallback path.
  let nativeResumeError: string | undefined;
  if (probe?.resumeCapable) {
    // Hold until native success return or fallback new-session so a racing
    // session.failed cannot terminally fail the rework task mid-restore.
    rejectResumeNativeInFlight.add(priorSessionId);
    try {
      const handle = await ctx.runtime.resumeSession({
        sessionId: priorSessionId,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: emptyBootstrap,
        lastTaskId: task.id || input.taskPath,
      });
      // Same ss- after rework: clear deliver dedup so the next prompt_complete can deliver.
      clearManagedAutoDeliverDedup(handle.sessionId, input.taskPath);

      const bound = await ctx.mutations.run(input.workspaceId, async () => {
        ctx.host.markSelfWrite(input.workspaceId);
        const next = await patchTaskEnvelope(mount.env.fs, input.taskPath, {
          sessionId: handle.sessionId,
          updatedAt: mount.env.clock.now(),
        });
        emitTaskState(ctx, input.workspaceId, next, "task.reject.resume");
        ctx.events.emit(
          "session.state",
          input.workspaceId,
          {
            sessionId: handle.sessionId,
            state: handle.state,
            profileId: handle.profileId,
            taskPath: input.taskPath,
            reason: "task.reject.resume.native",
            contextRestored: true,
          },
          "self"
        );
        return next;
      });

      rejectResumeNativeInFlight.delete(priorSessionId);
      return {
        task: bound,
        session: {
          sessionId: handle.sessionId,
          profileId: handle.profileId,
          adapterId: handle.adapterId,
          state: handle.state,
          cwd,
          contextRestored: true,
          restoreReason: "task.reject.resume.native",
        },
      };
    } catch (err) {
      nativeResumeError = err instanceof Error ? err.message : String(err);
      // Fall through to honest new-session recovery (not silent cache claim).
      // Keep rejectResumeNativeInFlight until fallback start settles or parks.
    }
  }

  // Independent new Session: not resumeCapable, or native resume explicitly failed.
  // Process start uses empty bootstrap; recovery orientation is rebuilt at inject
  // time from durable facts (not passed as in-memory enqueue options).
  const restoreReason: RejectResumeRestoreReason = nativeResumeError
    ? "task.reject.resume.native-fallback"
    : "task.reject.resume.new-session";

  let startedSessionId: string | undefined;
  try {
    const handle = await ctx.runtime.startSession({
      sessionId: makeSessionId(),
      profileId,
      roleName: task.role,
      assigneeKind: taskAssigneeKind(task),
      workspaceLane,
      runtimeWorkspace: { cwd },
      cwd,
      // Empty: go live without first session/prompt (same as native resume path).
      bootstrapPrompt: emptyBootstrap,
      lastTaskId: task.id || input.taskPath,
      workspace: input.workspaceId,
    });
    startedSessionId = handle.sessionId;
    // Test-only: simulate post-start context-update / rebind failure after the
    // new Session already exists — production never sets this hook.
    if (rejectResumePostStartFailureForTests) {
      throw rejectResumePostStartFailureForTests();
    }
    // Honest independent context — never claim native continuity on new ss-.
    // Persist native-fail diagnostic on the new row so inject-time rebuild can
    // distinguish native-fallback vs not-resume-capable without new domain fields.
    await ctx.runtime.registry.update(handle.sessionId, {
      contextRestored: false,
      ...(nativeResumeError
        ? {
            lastError: `native resume failed: ${nativeResumeError}`,
          }
        : {}),
    });
    // New ss- must also clear deliver dedup under the new key.
    clearManagedAutoDeliverDedup(handle.sessionId, input.taskPath);

    const bound = await ctx.mutations.run(input.workspaceId, async () => {
      ctx.host.markSelfWrite(input.workspaceId);
      const next = await patchTaskEnvelope(mount.env.fs, input.taskPath, {
        sessionId: handle.sessionId,
        updatedAt: mount.env.clock.now(),
      });
      emitTaskState(ctx, input.workspaceId, next, "task.reject.resume");
      ctx.events.emit(
        "session.state",
        input.workspaceId,
        {
          sessionId: handle.sessionId,
          state: handle.state,
          profileId: handle.profileId,
          taskPath: input.taskPath,
          reason: restoreReason,
          contextRestored: false,
          priorSessionId,
          ...(nativeResumeError ? { nativeResumeError } : {}),
        },
        "self"
      );
      return next;
    });

    rejectResumeNativeInFlight.delete(priorSessionId);
    return {
      task: bound,
      session: {
        sessionId: handle.sessionId,
        profileId: handle.profileId,
        adapterId: handle.adapterId,
        state: handle.state,
        cwd,
        contextRestored: false,
        restoreReason,
      },
    };
  } catch (err) {
    // Close orphan window: startSession may have succeeded while context flag
    // or task rebind failed — best-effort stop the new Session before parking.
    if (startedSessionId) {
      await stopOrphanRejectResumeSession(ctx, startedSessionId);
    }
    // Leave rejectResumeNativeInFlight set; parkTaskAfterRejectResumeFailure clears it.
    if (nativeResumeError) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `native resume failed (${nativeResumeError}); independent recovery session also failed: ${message}`
      );
    }
    throw err;
  }
}

/**
 * Fail-loud companion for reject-resume: park task in waiting(external) with a
 * diagnostic summary. Does not release occupation; does not leave state=running.
 */
async function parkTaskAfterRejectResumeFailure(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId?: string;
    message: string;
  }
): Promise<void> {
  const mount = ctx.host.get(input.workspaceId);
  if (!mount) {
    if (input.sessionId) rejectResumeNativeInFlight.delete(input.sessionId);
    return;
  }

  try {
    if (input.sessionId) {
      try {
        await ctx.runtime.registry.update(input.sessionId, {
          lastError: `reject-resume restore failed: ${input.message}`,
        });
      } catch {
        // registry row may be gone
      }
    }

    await ctx.mutations.run(input.workspaceId, async () => {
      ctx.host.markSelfWrite(input.workspaceId);
      const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (current.state !== "running" && current.state !== "waiting") return;

      const summary = `${REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY} (${input.message})`;
      let next = current;
      if (current.state === "running") {
        next = await taskWait(mount.env, input.taskPath, {
          reason: "external",
          summary,
        });
      } else {
        next = await patchTaskEnvelope(mount.env.fs, input.taskPath, {
          state: "waiting",
          wait: { reason: "external", summary },
          updatedAt: mount.env.clock.now(),
        });
      }
      emitTaskState(ctx, input.workspaceId, next, "task.reject.resume.failed");
      ctx.events.emit(
        "session.state",
        input.workspaceId,
        {
          sessionId: input.sessionId,
          taskPath: input.taskPath,
          taskState: next.state,
          runtimeEvent: "task.reject.resume.failed",
          error: input.message,
          taskFailed: false,
        },
        "service"
      );
    });
  } finally {
    // Clear after park so late session.failed projections see waiting summary
    // skip (or still hit this marker if they race the park mutation).
    if (input.sessionId) rejectResumeNativeInFlight.delete(input.sessionId);
  }
}

/**
 * Test helper: invoke managed auto-deliver.
 * Optional explicit commits override production auto-collection (conflict tests).
 */
export async function invokeManagedAutoDeliverForTests(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId: string;
    /**
     * Final report body. Empty string recovers a durable draft for the task
     * (restart / idempotent retry without re-prompting the Agent).
     */
    assistantText: string;
    commits?: string[];
  }
): Promise<void> {
  return tryManagedAutoDeliver(ctx, input);
}

// ---- helpers ----

function emitTaskState(
  ctx: HandlerContext,
  workspaceId: string,
  task: import("../core/task.js").TaskEnvelope,
  reason: string
): void {
  ctx.events.emit(
    "task.state",
    workspaceId,
    {
      path: task.path,
      id: task.id,
      state: task.state,
      role: task.role,
      claims: task.claims,
      sessionId: task.sessionId,
      reason,
    },
    "self"
  );
}

function requireWorkspaceId(ctx: HandlerContext, p: Record<string, unknown>): string {
  const explicit = optionalString(p, "workspaceId");
  if (explicit) return explicit;
  const fg = ctx.host.getForegroundId();
  if (fg) return fg;
  throw new RpcError(-32602, "workspaceId is required when no foreground workspace is set");
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new RpcError(-32602, `Missing or invalid string param: ${key}`);
  }
  return v.trim();
}

function optionalString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RpcError(-32602, `Invalid string param: ${key}`);
  const t = v.trim();
  return t || undefined;
}

/** Optional string without trim — used for exact review-note preservation. */
function optionalStringExact(
  p: Record<string, unknown>,
  key: string
): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RpcError(-32602, `Invalid string param: ${key}`);
  return v;
}

function optionalStringArray(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new RpcError(-32602, `Invalid string[] param: ${key}`);
  }
  return v as string[];
}

function parseDeliveryPolicy(raw: string | undefined): DeliveryPolicy | undefined {
  if (!raw) return undefined;
  if (raw === "manual" || raw === "bypass" || raw === "agent-decide") return raw;
  throw new RpcError(-32602, `Invalid deliveryPolicy: ${raw}`);
}

function parseOptionalA2APolicy(raw: string | undefined): A2APolicy | undefined {
  if (!raw) return undefined;
  if (raw === "allow" || raw === "ask" || raw === "deny") return raw;
  throw new RpcError(-32602, `Invalid a2aPolicy: ${raw}`);
}

function requireProfileId(p: Record<string, unknown>): string {
  const profileId = optionalString(p, "profileId");
  if (!profileId) {
    throw new RpcError(
      -32602,
      "task.startSession requires explicit profileId (no fake-default or product-profile fallback)"
    );
  }
  return profileId;
}

/**
 * Resolve A2A policy for startSession.
 * - user caller → always allow (root authority; registry unused)
 * - role caller → load role.a2aPolicy from registry (default deny when missing)
 * Ordinary client `a2aPolicy` params are not applied here.
 * agentProfile authority roles are validated separately (must exist in registry).
 */
async function resolveStartSessionA2APolicy(
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    callerKind: "user" | "role";
    taskRole: string;
    /** When true, missing registry role fails loud (profile dispatcher path). */
    requireRegisteredRole?: boolean;
  }
): Promise<A2APolicy> {
  if (input.callerKind === "user") return "allow";
  const registry = await loadRolesRegistry(fs);
  // Compat: taskRole may be operational name or roleId (never displayName).
  const role = resolveRole(registry.roles, input.taskRole);
  if (input.requireRegisteredRole && !role) {
    throw new RpcError(
      -32602,
      `A2A authority role not found in registry: ${input.taskRole}`,
      { role: input.taskRole }
    );
  }
  return roleA2APolicy(role);
}

/**
 * Profile whitelist for ordinary role-caller startSession when effective policy is allow.
 * - policy ask/deny: whitelist not applied here (ask parks; deny already denied)
 * - policy allow: profileId must be in role.allowedProfiles
 */
async function resolveRoleProfileAllowed(
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    taskRole: string;
    profileId: string;
    policy: A2APolicy;
  }
): Promise<boolean> {
  if (input.policy !== "allow") return true;
  const registry = await loadRolesRegistry(fs);
  const role = resolveRole(registry.roles, input.taskRole);
  return roleAllowsProfile(role, input.profileId);
}

function parseCallerKind(raw: string): "user" | "role" {
  if (raw === "user" || raw === "role") return raw;
  throw new RpcError(-32602, `Invalid callerKind: ${raw}`);
}

function resolveConcept(tent: LoadedTent, p: Record<string, unknown>) {
  const id = optionalString(p, "id") ?? optionalString(p, "boxId");
  const path = optionalString(p, "path");
  if (id) {
    const byId = tent.byId.get(id);
    if (byId) return byId;
    throw new RpcError(-32004, `Concept not found: ${id}`);
  }
  if (path) {
    const byPath = tent.byPath.get(path);
    if (byPath) return byPath;
    throw new RpcError(-32004, `Concept not found: ${path}`);
  }
  throw new RpcError(-32602, "Concept lookup requires id, boxId, or path");
}

function projectConcept(
  box: import("../core/types.js").Box,
  includeBody: boolean,
  withChildren: boolean
): ConceptProjection {
  const title = typeof box.fm.title === "string" ? box.fm.title : undefined;
  const proj: ConceptProjection = {
    id: box.id,
    path: box.path,
    name: box.name,
    type: box.type,
    tags: box.tags,
    coordination: box.coordination,
    status: box.fm.status,
    assignee: typeof box.fm.owner === "string" ? box.fm.owner : undefined,
    mode: box.mode,
    archived: box.archived,
    invalid: box.invalid,
  };
  if (title) (proj as ConceptProjection & { title?: string }).title = title;
  if (includeBody) {
    proj.bodyPreview = box.body.slice(0, 500);
  }
  if (withChildren) {
    proj.children = box.children.map((c) => projectConcept(c, includeBody, true));
  }
  return proj;
}

function parseArtifactRefs(data: Record<string, unknown>): ArtifactRef[] {
  const raw = data.artifactRefs;
  if (!Array.isArray(raw)) return [];
  const out: ArtifactRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const target = rec.target;
    if (
      (kind === "path" || kind === "dir" || kind === "commit" || kind === "url" || kind === "other") &&
      typeof target === "string"
    ) {
      out.push({
        kind,
        target,
        label: typeof rec.label === "string" ? rec.label : undefined,
      });
    }
  }
  return out;
}

/**
 * P0-2: integrate delivery commits into the real workspace Git main/target branch.
 * Reuses core ensureRoleWorkspace + integrateWorkspaceCommits (idempotent).
 * Failures propagate so accept/bypass cannot mark accepted/done or release occupation.
 */
function makeCommitIntegrator(
  ctx: HandlerContext,
  workspaceRoot: string,
  task: TaskEnvelope
): (commits: string[]) => Promise<void> {
  return async (commits: string[]) => {
    const refs = [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
    if (refs.length === 0) return;
    if (ctx.integrateCommits) {
      await ctx.integrateCommits(workspaceRoot, refs, task.role);
      return;
    }
    await integrateWorkspaceCommitsForTask(workspaceRoot, task, refs);
  };
}

async function integrateWorkspaceCommitsForTask(
  workspaceRoot: string,
  task: TaskEnvelope,
  commits: string[]
): Promise<void> {
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  await integrateWorkspaceCommits(contract, commits);
}

/**
 * Resolve the lane contract for integration.
 * Role tasks re-validate against ensureRoleWorkspace(role).
 * Profile tasks re-validate against ensureTaskWorkspace(taskId) (tent-task/<id>).
 * Sub tasks keep envelope targetBranch (dispatcher role branch) as first-class —
 * do not overwrite with peer mainline from ensure*Workspace.
 */
async function resolveIntegrationContract(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<RoleWorkspaceContract> {
  const mountedRoot = nodePath.resolve(workspaceRoot);
  if (task.workspace) {
    const claimed = nodePath.resolve(task.workspace);
    if (!isSameWorkspaceRoot(claimed, mountedRoot)) {
      throw new Error(
        `Task envelope workspace mismatch: envelope=${task.workspace} mounted=${workspaceRoot}`
      );
    }
  }

  const isProfile = taskAssigneeKind(task) === "agentProfile";
  let dispatcherLane: RoleWorkspaceContract | undefined;
  if (taskAsSub(task)) {
    const dispatcher = (task.dispatchedBy || "").trim();
    const label = isProfile ? `task ${task.id || task.path}` : `role ${task.role}`;
    if (!dispatcher || dispatcher === "user") {
      throw new Error(
        `Sub task envelope missing durable dispatchedBy for ${label}; cannot resolve targetBranch`
      );
    }
    dispatcherLane = await ensureRoleWorkspace(mountedRoot, dispatcher);
    if (task.targetBranch && task.targetBranch !== dispatcherLane.branch) {
      throw new Error(
        `Task envelope targetBranch mismatch for ${label}: envelope=${task.targetBranch} expected=${dispatcherLane.branch}`
      );
    }
  }

  const real = isProfile
    ? await ensureTaskWorkspace(mountedRoot, task.id || task.path, {
        ...(dispatcherLane ? { targetBranch: dispatcherLane.branch } : {}),
      })
    : await ensureRoleWorkspace(mountedRoot, task.role);

  const label = isProfile ? `task ${task.id || task.path}` : `role ${task.role}`;
  if (task.branch && task.branch !== real.branch) {
    throw new Error(
      `Task envelope branch mismatch for ${label}: envelope=${task.branch} expected=${real.branch}`
    );
  }
  if (task.worktree) {
    const claimedWt = nodePath.resolve(task.worktree);
    const realWt = nodePath.resolve(real.worktree);
    if (!isSameWorkspaceRoot(claimedWt, realWt)) {
      throw new Error(
        `Task envelope worktree mismatch for ${label}: envelope=${task.worktree} expected=${real.worktree}`
      );
    }
  }

  // Sub: targetBranch is dispatcher tent-role/<dispatcher>, not mainline.
  // Re-validate against the real dispatcher lane; never trust a corrupted envelope.
  if (taskAsSub(task)) {
    if (dispatcherLane!.branch === real.branch) {
      throw new Error(
        `Sub task targetBranch must not equal assignee branch for ${label}: ${dispatcherLane!.branch}`
      );
    }
    return { ...real, targetBranch: dispatcherLane!.branch };
  }

  if (task.targetBranch && task.targetBranch !== real.targetBranch) {
    throw new Error(
      `Task envelope targetBranch mismatch for ${label}: envelope=${task.targetBranch} expected=${real.targetBranch}`
    );
  }

  // Prefer real contract paths (normalized realpath) over envelope strings.
  return real;
}

/**
 * Ensure task envelope carries WorkspaceLane before managed startSession.
 * - Role: create/reuse durable tent-role/<role> worktree.
 * - agentProfile: create unique tent-task/<taskId> worktree (never tent-role/<profile>).
 * Also backfills roleBranchBase once when missing; never overwrites an existing baseline.
 * Non-Git / pure docs → leave unset (cwd falls back to workspace root).
 */
async function ensureTaskWorkspaceLane(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<TaskEnvelope> {
  const laneComplete = Boolean(
    task.worktree && task.branch && task.workspace && task.targetBranch
  );
  if (laneComplete && task.roleBranchBase?.trim()) {
    return task;
  }
  const mount = ctx.host.require(workspaceId);
  return ctx.mutations.run(workspaceId, async () => {
    // Re-load under the bus so concurrent bind cannot double-write baseline.
    const current = await loadTaskEnvelope(mount.env.fs, task.path);
    const currentLaneComplete = Boolean(
      current.worktree && current.branch && current.workspace && current.targetBranch
    );
    if (currentLaneComplete && current.roleBranchBase?.trim()) {
      return current;
    }

    const isProfile = taskAssigneeKind(current) === "agentProfile";
    let taskTargetBranch: string | undefined;
    if (isProfile && taskAsSub(current)) {
      const dispatcher = (current.dispatchedBy || "").trim();
      if (!dispatcher || dispatcher === "user") {
        throw new Error(
          `Sub task ${current.id || current.path} is missing a durable dispatcher role.`
        );
      }
      const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, dispatcher);
      taskTargetBranch = dispatcherLane.branch;
      const recordedTarget = current.targetBranch?.trim();
      if (recordedTarget && recordedTarget !== taskTargetBranch) {
        throw new Error(
          `Task envelope targetBranch mismatch: envelope=${recordedTarget} expected=${taskTargetBranch}`
        );
      }
    }
    const lane =
      currentLaneComplete
        ? {
            workspace: current.workspace!,
            worktree: current.worktree!,
            branch: current.branch!,
            targetBranch: current.targetBranch!,
          }
        : isProfile
          ? await ensureTaskWorkspaceIfGit(
              mount.workspaceRoot,
              current.id || current.path,
              { ...(taskTargetBranch ? { targetBranch: taskTargetBranch } : {}) }
            )
          : await ensureRoleWorkspaceIfGit(mount.workspaceRoot, current.role);
    if (!lane) return current;

    // Sub tasks keep dispatcher tent-role/* as targetBranch; never rewrite to mainline
    // when backfilling an incomplete lane (peer profile still defers lane creation).
    let targetBranch = lane.targetBranch;
    if (taskAsSub(current)) {
      targetBranch = taskTargetBranch || (current.targetBranch || "").trim() || lane.targetBranch;
    }

    const patch: Parameters<typeof patchTaskEnvelope>[2] = {
      updatedAt: mount.env.clock.now(),
    };
    if (!currentLaneComplete) {
      patch.workspace = lane.workspace;
      patch.worktree = lane.worktree;
      patch.branch = lane.branch;
      patch.targetBranch = targetBranch;
    }
    // Capture-once: only set when still missing. Never rewrite on restart/resume.
    if (!current.roleBranchBase?.trim()) {
      patch.roleBranchBase = await readRoleBranchTip(lane.workspace, lane.branch);
    }
    ctx.host.markSelfWrite(workspaceId);
    return patchTaskEnvelope(mount.env.fs, current.path, patch);
  });
}

/**
 * Active managed ACP session for a durable role (starting/live/waiting-user).
 * External sessions and agentProfile sessions are excluded — profile sessions
 * must not block role delete or one-live-session-per-role rules.
 */
async function findActiveManagedSessionForRole(
  ctx: HandlerContext,
  workspaceId: string,
  roleName: string
): Promise<SessionRecord | undefined> {
  if (!roleName) return undefined;
  const all = await ctx.runtime.registry.list();
  return all.find(
    (rec) =>
      rec.workspace === workspaceId &&
      rec.roleName === roleName &&
      (rec.assigneeKind ?? "role") !== "agentProfile" &&
      SessionRegistry.isNonTerminal(rec.state) &&
      rec.state !== "external"
  );
}

/**
 * Latest stopped provider session that belongs to this durable role lane.
 * Provider capability is confirmed through probe; no session/new fallback is
 * hidden behind this lookup.
 */
async function findResumableManagedSessionForRole(
  ctx: HandlerContext,
  workspaceId: string,
  roleName: string,
  profileId: string,
  cwd: string
): Promise<SessionRecord | undefined> {
  if (!roleName) return undefined;
  const candidates = (await ctx.runtime.registry.list())
    .filter(
      (rec) =>
        rec.workspace === workspaceId &&
        rec.roleName === roleName &&
        (rec.assigneeKind ?? "role") !== "agentProfile" &&
        rec.profileId === profileId &&
        rec.state === "stopped" &&
        !!rec.resumeToken &&
        !!rec.runtimeWorkspace?.cwd &&
        isSameWorkspaceRoot(
          nodePath.resolve(rec.runtimeWorkspace.cwd),
          nodePath.resolve(cwd)
        )
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const candidate of candidates) {
    const probe = await ctx.runtime.probe(candidate.id);
    if (!probe.alive && probe.resumeCapable) return candidate;
  }
  return undefined;
}

/**
 * Resolve the durable role whose a2aPolicy/allowedProfiles govern startSession.
 * - user caller: unused (root authority)
 * - sub task (asSub) + role caller: authority = dispatchedBy (role or profile assignee)
 * - peer role task: authority = task.role
 * - peer agentProfile task + role caller: dispatchedBy must name a real role (not the profile)
 */
function resolveA2AAuthorityRole(
  task: TaskEnvelope,
  callerKind: "user" | "role"
): string {
  if (callerKind === "user") return task.role;
  if (taskAsSub(task) || taskAssigneeKind(task) === "agentProfile") {
    const dispatcher = (task.dispatchedBy || "").trim();
    if (!dispatcher || dispatcher === "user") {
      throw new RpcError(
        -32602,
        taskAsSub(task)
          ? "callerKind=role startSession on sub task requires dispatchedBy to name a real dispatcher role"
          : "callerKind=role startSession on agentProfile task requires dispatchedBy to name a real dispatcher role",
        { dispatchedBy: task.dispatchedBy, assignee: task.role, asSub: taskAsSub(task) }
      );
    }
    if (dispatcher === task.role) {
      throw new RpcError(
        -32602,
        "callerKind=role startSession must not use the assignee label as dispatcher role",
        { dispatchedBy: dispatcher, assignee: task.role }
      );
    }
    return dispatcher;
  }
  return task.role;
}

function projectStartSessionResult(
  workspaceId: string,
  taskPath: string,
  task: TaskEnvelope,
  session: Pick<
    SessionRecord,
    "id" | "profileId" | "adapterId" | "state" | "roleName" | "runtimeWorkspace"
  >,
  extra?: { cwd?: string }
) {
  const cwd =
    extra?.cwd ??
    session.runtimeWorkspace?.cwd ??
    task.worktree ??
    undefined;
  return {
    workspaceId,
    taskPath,
    task: projectTask(task),
    session: {
      sessionId: session.id,
      profileId: session.profileId,
      adapterId: session.adapterId,
      state: session.state,
      cwd,
      // Do not expose pid in client projection by default — probe is internal.
    },
  };
}

/**
 * Build managed ACP bootstrap: Context Card pointer + near-field user prompt.
 * Path tutorial appears once on the Context Card. Dynamic task fields live in
 * sessionBootstrapPromptForTask only (no aux-block re-list of claims/manifest).
 * Never copies box/manifest bodies. Never instructs tent task claim/get/deliver.
 * Distinct from relayPromptForTask (external manual path still claim+deliver).
 */
function buildSessionBootstrapPrompt(
  task: TaskEnvelope,
  roots: { workspaceRoot: string; systemRoot: string }
): string {
  const systemRoot = roots.systemRoot || systemRootFromWorkspace(roots.workspaceRoot);
  const kind = taskAssigneeKind(task);
  const card = taskContextCard(task.id || task.path, {
    path: task.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
    label: kind === "agentProfile" ? `task:profile:${task.role}` : `task:${task.role}`,
  });
  const sessionSteps = sessionBootstrapPromptForTask(task, {
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
  });
  return (
    `${card.prompt}\n\n` +
    `--- Tent managed session bootstrap ---\n` +
    `${sessionSteps}\n`
  );
}

/**
 * Collect local image path refs from task user prompt + claimed concept bodies.
 * Explicit sources only — no workspace scan. Missing claims/files are skipped.
 * Returns paths only (never base64).
 */
async function collectTaskBootstrapImageRefs(
  fs: import("../core/adapter.js").FsAdapter,
  task: TaskEnvelope
): Promise<BootstrapImageRef[]> {
  const userPrompt = extractTaskUserPrompt(task);
  const claimBodies: Array<{ body: string; notePath?: string }> = [];
  try {
    const tent = await loadTent(fs);
    for (const claimId of task.claims ?? []) {
      if (!claimId || claimId === "root") continue;
      const box = tent.byId.get(claimId);
      if (!box || typeof box.body !== "string") continue;
      claimBodies.push({
        body: box.body,
        notePath: boxNotePath(box.path),
      });
    }
  } catch {
    // Tree load failure must not block startSession — fall back to user prompt only.
  }
  return collectBootstrapImageRefsFromTask({ userPrompt, claimBodies });
}

function projectTask(task: import("../core/task.js").TaskEnvelope): TaskProjection {
  const lane =
    task.workspace || task.worktree || task.branch || task.targetBranch
      ? {
          workspace: task.workspace,
          worktree: task.worktree,
          branch: task.branch,
          targetBranch: task.targetBranch,
        }
      : undefined;
  return {
    path: task.path,
    id: task.id,
    role: task.role,
    claims: task.claims,
    status: task.status,
    state: task.state,
    manifest: task.manifest,
    dispatchedBy: task.dispatchedBy,
    // Missing asSub on disk reads as false (peer).
    asSub: taskAsSub(task),
    deliveryPolicy: task.deliveryPolicy,
    // Missing assigneeKind on disk reads as role (backward compatible).
    assigneeKind: taskAssigneeKind(task),
    sessionId: task.sessionId,
    wait: task.wait,
    activeDeliveryId: task.activeDeliveryId,
    workspaceLane: lane,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    prompt: task.prompt,
  };
}

function projectDelivery(d: import("../core/delivery.js").DeliveryRecord): DeliveryProjection {
  return {
    path: d.path,
    id: d.id,
    taskId: d.taskId,
    boxId: d.boxId,
    role: d.role,
    status: d.status,
    summary: d.summary,
    commits: d.commits,
    integrationMode: d.integrationMode,
    review: d.review,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function assertDocsWriteAllowed(
  tent: LoadedTent,
  conceptId: string,
  frontmatter: Record<string, unknown>,
  tasks: import("../core/task.js").TaskEnvelope[]
): void {
  const protectedHit = PROTECTED_COLLAB_FIELDS.filter((k) => k in frontmatter);
  if (protectedHit.length === 0) return;

  const concept = tent.byId.get(conceptId);
  if (!concept) return;

  // Occupation oracle = active task envelopes only (stale owner is not a write lock).
  const active = hasActiveTaskForConcept(tent, conceptId, concept.path, tasks);
  if (!active) return;

  throw new RpcError(
    -32010,
    `docs.write cannot change collaboration projection fields while box has an active task: ${protectedHit.join(", ")}. Use task.* transitions.`,
    { fields: protectedHit, conceptId }
  );
}

/** Hard gate: only explicit mode (+ invalid) blocks content writes — not type/self writable. */
function assertDocsModeMutable(
  concept: import("../core/types.js").Box,
  op: string
): void {
  if (isContentMutable(concept)) return;
  if (concept.invalid) {
    throw new RpcError(-32010, `${op} rejected: concept is invalid`, {
      conceptId: concept.id,
      mode: concept.mode,
    });
  }
  if (concept.mode === "archived" || concept.archived) {
    throw new RpcError(-32010, `${op} rejected: concept is archived`, {
      conceptId: concept.id,
      mode: concept.mode,
    });
  }
  if (concept.mode === "read-only") {
    throw new RpcError(-32010, `${op} rejected: concept is read-only`, {
      conceptId: concept.id,
      mode: concept.mode,
    });
  }
  throw new RpcError(-32010, `${op} rejected: concept is not mutable`, {
    conceptId: concept.id,
    mode: concept.mode,
  });
}

/** Structured frontmatter path: id/mode/archived never via docs.write (use docs.setMode). */
function assertReservedDocsWriteFields(frontmatter: Record<string, unknown>): void {
  const hard = (["id", "mode", "archived"] as const).filter((k) => k in frontmatter);
  if (hard.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot set reserved fields: ${hard.join(", ")}. Use docs.setMode for mode.`,
    { fields: hard }
  );
}

/**
 * Raw write may keep existing reserved values but must not introduce or change
 * id/mode/archived. Collaboration fields still use the active-task guard.
 */
function assertRawDocsWriteReserved(
  disk: Record<string, unknown>,
  next: Record<string, unknown>
): void {
  const hard = (["id", "mode", "archived"] as const).filter(
    (field) => String(next[field] ?? "") !== String(disk[field] ?? "")
  );
  if (hard.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot change reserved fields: ${hard.join(", ")}. Use docs.setMode for mode.`,
    { fields: hard }
  );
}

/** Best-effort tag list from raw frontmatter for Core registry sync (normalize in Core). */
function tagsFromFrontmatterData(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.tags)) return [];
  return data.tags.filter((item): item is string => typeof item === "string");
}

function hasActiveTaskForConcept(
  tent: LoadedTent,
  conceptId: string,
  conceptPath: string,
  tasks: import("../core/task.js").TaskEnvelope[]
): boolean {
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.claims.includes(conceptId) || task.claims.includes("root")) return true;
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath(claimed.path, conceptPath) || isAncestorPath(conceptPath, claimed.path)) {
        return true;
      }
    }
  }
  return false;
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}
