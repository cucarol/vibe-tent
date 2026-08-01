// Service command/query handlers — sole client mutation entry into core + runtime.

import { boxNotePath, loadTent, type LoadedTent } from "../core/tree.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import {
  createBox,
  dispatch,
  patchBody,
  patchBox,
  resolveDispatchNodeIds,
  setNodeMode,
} from "../core/ops.js";
import {
  addRegistryTag,
  addTag,
  loadTagRegistry,
  normalizeTagName,
  removeRegistryTag,
  removeTag,
  syncTagRegistryAfterBoxTagsChange,
} from "../core/tags.js";
import {
  createRelation,
  deleteRelation,
  listRelationsForNode,
  RelationError,
  updateRelation,
  type RelationIncomingView,
  type RelationOutgoingView,
} from "../core/relations.js";
import { isContentMutable } from "../core/tree.js";
import type { NodeMode, RelationRecord } from "../core/types.js";
import {
  createSecondaryType,
  deleteCustomType,
  inspectTypeDeletion,
} from "../core/typeManagement.js";
import { isValidConceptType } from "../core/typeRegistry.js";

import { forkNode } from "../core/forkOps.js";
import { renameNode } from "../core/renameOps.js";
import { moveNode, type MovePosition } from "../core/moveOps.js";
import {
  extractTaskUserPrompt,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  migrateParentReviewerEnvelopes,
  patchTaskEnvelope,
  primaryBoxId,
  sessionBootstrapPromptForTask,
  taskAssigneeKind,
  taskAsSub,
  taskParentIsRole,
  taskParentRoleId,
  type RoleWorkspaceContract,
  type TaskEnvelope,
  type TaskEnvelopePatch,
} from "../core/task.js";
import {
  mayElevateDeliveryPolicy,
  parseTaskActorRef,
  parseTaskOutcomeReport,
  resolveParentReviewerPair,
  type TaskActorRef,
  type TaskOutcome,
} from "../core/task-model.js";
import {
  assertRoleCheckpointRoleName,
  clearRoleCheckpoint,
  formatRoleCheckpointTail,
  readRoleCheckpoint,
  writeRoleCheckpoint,
  type RoleCheckpointPointers,
  type RoleCheckpointRecord,
} from "../core/role-checkpoint.js";
import { taskContextCard } from "../core/context-card.js";
import {
  assembleManagedPrompt,
  assertRefsResolved,
  deriveIntegrationAuthority,
  decideStablePrefixInjection,
  ExecutorLaneHistoryError,
  formatExecutionLanePrompt,
  projectExecutionLaneFromTask,
  shouldInjectStablePrefix,
  TaskContextCardError,
  type SessionReuseCompatibilityFacts,
  type TaskContextCardV1,
} from "../core/task-context-card.js";
import {
  assertDurableContextCardRefsResolved,
  buildSessionReuseRequestFacts,
  collectStableContextGeneration,
  evaluateCandidateSessionLeaseGates,
  evaluateTaskBlockingDelivery,
  appendCallerBootstrapSection,
  evaluateManagedSessionReuse,
  readTaskPurpose,
  type StableContextGenerationBundle,
} from "./session-context-generation.js";
import { systemRootFromWorkspace, TEMP_DIR } from "../core/paths.js";
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
  OutputProvenanceError,
  resolveOutputProvenance,
  type OutputProvenance as CoreOutputProvenance,
} from "../core/output.js";
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
  ensureRolesRosterMigrated,
  loadRolesRegistry,
  normalizeAgentIdList,
  normalizeRoleDefinition,
  resolveRole,
  roleA2APolicy,
  roleAllowsAgent,
  roleRoster,
  updateRole,
  type RoleDefinition,
} from "../core/skillRoleRegistry.js";
import {
  assembleManagedSessionBootstrap,
  composeManagedSkillBootstrapPrefix,
} from "../core/managed-skill-compose.js";
import {
  ensureAgentDefinitionsForProfileIds,
  findAgentDefinition,
  loadAgentDefinitions,
  normalizeAgentDefinition,
  parseAgentDefinitionParams,
  projectAgentDefinition,
  resolveAgentIdForProfileOnRoster,
  resolveProfileIdForAgent,
  saveAgentDefinitions,
  type AgentDefinition,
} from "./agent-definitions.js";
import {
  boxProjectionOf,
  findActiveTaskForBox,
  finalizeTaskAccept,
  finalizeTaskDeliverAuto,
  prepareTaskAccept,
  prepareTaskDeliver,
  taskCancel,
  taskClaim,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
  type TaskDeliverResult,
} from "../core/task-lifecycle.js";
import { runTaskLifecycle } from "./task-lifecycle-flight.js";
import { runIntegrationTargetFlight } from "./integration-target-flight.js";
import {
  normalizeKeepTerminalTasksDays,
  previewOperationalRetention,
  purgeOperationalRetention,
  RetentionError,
  type RetentionPurgeResult,
} from "../core/retention.js";
import {
  evaluateTaskWorktreeReclaimForEnvelope,
  isTaskScopedWorktreeLane,
  isTaskWorktreeReclaimTerminalState,
  reclaimTaskWorktreeForEnvelope,
  type TaskWorktreeReclaimResult,
} from "../core/task-worktree-reclaim.js";
import {
  dequeueTaskWorktreeReclaimPending,
  enqueueTaskWorktreeReclaimPending,
  listTaskEnvelopePathsForReclaimScan,
  listTaskWorktreeReclaimPendingForWorkspace,
  persistHistoricalReclaimScanBatch,
  readTaskWorktreeReclaimHistoricalScan,
  recordHistoricalReclaimScanDiagnostic,
  recordTaskWorktreeReclaimNeedsAttention,
  type TaskWorktreeReclaimScanDecision,
  taskPathsAfterHistoricalCursor,
  TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE,
} from "../core/task-worktree-reclaim-queue.js";
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
import {
  listDirectActiveTasksForNode,
  taskDirectlyReferencesNode,
  taskReferencedNodeIds,
} from "../core/task-node-refs.js";
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
  assertDeliverCommitsInExecutorLane,
  assertOrdinaryExecutorLaneHistoryInGit,
  DeliverCommitLaneError,
  ensureRoleWorkspace,
  ensureRoleWorkspaceIfGit,
  ensureTaskWorkspace,
  ensureTaskWorkspaceIfGit,
  inspectWorktreeDirtiness,
  integrateWorkspaceCommits,
  isCommitAncestor,
  isGitWorkspace,
  isSameWorkspaceRoot,
  listPendingRoleCommits,
  readRoleBranchTip,
  resolveCommitSha,
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
  SEMANTIC_DOCS_WRITE_FIELDS,
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
  type GraphRelationEdge,
  type NodeCollaboration,
  type NodeCollaborationActiveTask,
  type NodeCollaborationDeliverySummary,
  type NodeCollaborationSessionSummary,
  type NodeCollaborationTaskSummary,
  type NodeCollaborationsResult,
  type OutputProvenance,
  type RelationDeleteResult,
  type RelationListResult,
  type RelationMutationResult,
  type RelationRecordWire,
  type PendingA2AInteraction,
  type PendingDeliveryInteraction,
  type PendingInteractionItem,
  type PendingInteractionListResult,
  type PendingToolApprovalInteraction,
  type PendingUserAskInteraction,
  type ProposalProjection,
  type ProviderCatalogProjection,
  type RoleRegistryEntryProjection,
  type RoleRosterEntryProjection,
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
  /**
   * CLI↔Service wire protocol version (independent of package version).
   * Advertised on service.health / GET /health for attach handshake.
   */
  protocolVersion: number;
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

/**
 * TaskLifecycleError may cross tsx dual-module boundaries where `instanceof` fails.
 * Match by class, name, or stable INVALID_TRANSITION message shape.
 */
function isTaskLifecycleErrorLike(
  error: unknown
): error is { message: string; code: string } {
  if (error instanceof TaskLifecycleError) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === "TaskLifecycleError") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0;
  }
  // Last-resort: core assertTransition message when class identity is split.
  if (/^Invalid task transition:/.test(error.message)) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return true;
    (error as { code?: string }).code = "INVALID_TRANSITION";
    return true;
  }
  return false;
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
      case "docs.fork":
        return docsFork(ctx, p);
      case "docs.rename":
        return docsRename(ctx, p);
      case "docs.move":
        return docsMove(ctx, p);
      case "docs.setMode":
        return docsSetMode(ctx, p);
      case "docs.search":
        return docsSearch(ctx, p);
      case "docs.backlinks":
        return docsBacklinks(ctx, p);
      case "docs.importAttachment":
        return docsImportAttachment(ctx, p);
      case "docs.setType":
        return docsSetType(ctx, p);
      case "docs.tags.set":
        return docsTagsSet(ctx, p);
      case "docs.tag.add":
        return docsTagAdd(ctx, p);
      case "docs.tag.remove":
        return docsTagRemove(ctx, p);
      case "relation.list":
        return relationList(ctx, p);
      case "relation.create":
        return relationCreate(ctx, p);
      case "relation.update":
        return relationUpdate(ctx, p);
      case "relation.delete":
        return relationDelete(ctx, p);
      case "registry.types":
        return registryTypes(ctx, p);
      case "registry.type.create":
        return registryTypeCreate(ctx, p);
      case "registry.type.delete":
        return registryTypeDelete(ctx, p);
      case "registry.tags":
        return registryTags(ctx, p);
      case "registry.tag.create":
        return registryTagCreate(ctx, p);
      case "registry.tag.delete":
        return registryTagDelete(ctx, p);
      case "registry.roles":
        return registryRoles(ctx, p);
      case "registry.role.create":
        return registryRoleCreate(ctx, p);
      case "registry.role.update":
        return registryRoleUpdate(ctx, p);
      case "registry.role.delete":
        return registryRoleDelete(ctx, p);
      case "agent.list":
        return agentList(ctx);
      case "agent.get":
        return agentGet(ctx, p);
      case "agent.create":
        return agentCreate(ctx, p);
      case "agent.update":
        return agentUpdate(ctx, p);
      case "agent.delete":
        return agentDelete(ctx, p);
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
      case "task.backfillWorkspaceLaneBase":
        return taskBackfillWorkspaceLaneBaseRpc(ctx, p);
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
      case "task.replaceSession":
        return taskReplaceSessionRpc(ctx, p);
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
      case "node.collaboration":
        return nodeCollaborationRpc(ctx, p);
      case "node.collaborations":
        return nodeCollaborationsRpc(ctx, p);
      case "output.provenance":
        return outputProvenanceRpc(ctx, p);
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
      case "role.checkpoint.get":
        return roleCheckpointGetRpc(ctx, p);
      case "role.checkpoint.set":
        return roleCheckpointSetRpc(ctx, p);
      case "role.checkpoint.clear":
        return roleCheckpointClearRpc(ctx, p);
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
      case "task.worktreeReclaim.preview":
        return taskWorktreeReclaimPreviewRpc(ctx, p);
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
    if (isTaskLifecycleErrorLike(error)) {
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
    /** Wire protocol contract — independent of package version (0.1.0). */
    protocolVersion: ctx.protocolVersion,
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
  // One-shot parentActor/reviewer wire rewrite (strip legacy dispatchedBy).
  // Runs under MutationBus; preserves accepted audit; idempotent.
  await migrateParentReviewerOnMount(ctx, info.workspaceId);
  // After SessionRegistry boot reconcile, each mount must re-bind tasks to live sessions.
  await reconcileTaskSessionsOnMount(ctx, info.workspaceId);
  // Register one Service-owned runner and return. Pending retries and the
  // historical pass both run in bounded background batches after mount.
  scheduleHistoricalTaskWorktreeReclaimAfterMount(ctx, info.workspaceId);
  return info;
}

/**
 * Deterministic one-time Task envelope migration on workspace.mount:
 * write parentActor/reviewer, strip dispatchedBy. No permanent dual-read.
 */
async function migrateParentReviewerOnMount(
  ctx: HandlerContext,
  workspaceId: string
): Promise<void> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return;
  try {
    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId, 200, TEMP_DIR);
      await migrateParentReviewerEnvelopes(mount.env.fs, mount.env.clock);
    });
  } catch (err) {
    // Migration failure must not block mount; log and continue. Load path still
    // derives actors in memory until a successful rewrite.
    console.error(
      `[workspace.mount] parent/reviewer migration failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
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
 * Stable wait summary when a bound managed Session is unintentionally unavailable
 * (live terminal exit/fail before Delivery, or dead after service restart / remount).
 * Kept as a constant so tests, recovery UX, and remount reconcile share one contract text.
 * Recovery: explicit `task.startSession` or explicit `task.replaceSession`; occupation held.
 */
export const SESSION_UNAVAILABLE_WAIT_SUMMARY =
  "Bound session unavailable (service restart or session ended). Restart the session or interrupt the task; occupation is held.";

/** Stable machine-facing code for session-unavailable recoverable park (wait.reason stays external). */
export const SESSION_UNAVAILABLE_WAIT_CODE = "session_unavailable" as const;

/** True when Task is recoverably parked for a dead/unavailable managed Session. */
export function isSessionUnavailableParkedWait(task: TaskEnvelope): boolean {
  if (task.state !== "waiting" || task.wait?.reason !== "external") return false;
  // Prefer durable waitCode; fall back to stable summary for rows written before code.
  if (task.wait.code === SESSION_UNAVAILABLE_WAIT_CODE) return true;
  return task.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
}

/**
 * Apply waiting(reason=external) + SESSION_UNAVAILABLE_WAIT_SUMMARY under the caller's
 * MutationBus critical section. Does not release occupation, cancel TaskInputs/UserAsks,
 * or clear report drafts / worktree. Idempotent when already parked with the same summary.
 * Returns the parked envelope, or null when no mutation was applied.
 */
async function applySessionUnavailablePark(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  emitReason: string
): Promise<TaskEnvelope | null> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return null;
  const current = await loadTaskEnvelope(mount.env.fs, taskPath);
  if (current.state !== "running" && current.state !== "waiting") return null;
  if (isSessionUnavailableParkedWait(current)) return null;
  // Reject-resume failure park keeps its own diagnostic summary; do not overwrite.
  if (isRejectResumeParkedWait(current)) return null;
  // running|waiting only reach here; collaboration-terminal states are filtered above.

  const wait = {
    reason: "external" as const,
    summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
    code: SESSION_UNAVAILABLE_WAIT_CODE,
  };
  let next: TaskEnvelope;
  if (current.state === "running") {
    next = await taskWait(mount.env, taskPath, {
      reason: wait.reason,
      summary: wait.summary,
      code: wait.code,
    });
  } else {
    // waiting with another reason (user-input / a2a-approval / …): overwrite wait.
    // taskWait only allows running→waiting; MutationBus already serializes this path.
    next = await patchTaskEnvelope(mount.env.fs, taskPath, {
      state: "waiting",
      wait,
      updatedAt: mount.env.clock.now(),
    });
  }
  emitTaskState(ctx, workspaceId, next, emitReason);
  return next;
}

/**
 * Shared recoverable park path for an unintentionally dead managed Session before Delivery.
 * Live runtime terminal projection and mount reconcile converge here.
 *
 * - Task → waiting(reason=external) with SESSION_UNAVAILABLE_WAIT_SUMMARY
 * - Preserves occupation, worktree, report draft, TaskInputs, UserAsks, audit facts
 * - Session registry may already be terminal/diagnostic; only Task is parked
 * - Same-session re-entry is idempotent; rebound sessionId mismatch is a no-op
 * - Does not auto-start or re-prompt; recovery is explicit task.startSession or task.replaceSession
 */
async function parkTaskForUnavailableSession(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId?: string;
    reason: string;
    /** Optional diagnostic only — never written into wait.summary (summary stays stable). */
    detail?: string;
  }
): Promise<boolean> {
  const mount = ctx.host.get(input.workspaceId);
  if (!mount) return false;

  let applied = false;
  let parked: TaskEnvelope | null = null;
  await ctx.mutations.run(input.workspaceId, async () => {
    ctx.host.markSelfWrite(input.workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
    if (current.state !== "running" && current.state !== "waiting") return;
    if (input.sessionId && current.sessionId && current.sessionId !== input.sessionId) {
      return;
    }
    parked = await applySessionUnavailablePark(
      ctx,
      input.workspaceId,
      input.taskPath,
      input.reason
    );
    applied = parked != null;
  });

  if (applied) {
    ctx.events.emit(
      "session.state",
      input.workspaceId,
      {
        sessionId: input.sessionId,
        taskPath: input.taskPath,
        taskState: "waiting",
        waitReason: "external",
        waitCode: SESSION_UNAVAILABLE_WAIT_CODE,
        runtimeEvent: input.reason,
        ...(input.detail ? { error: input.detail } : {}),
        taskFailed: false,
        recoverable: true,
      },
      "service"
    );
  }

  // Clear hanging tool-approval waiters. Do not cancel TaskInputs / UserAsks —
  // recovery may still need them. If the process is still alive (synthetic
  // terminal event / adapter race), stop it so probe is not a live orphan.
  // stopReason stays non-user so this is not treated as intentional seal.
  if (applied && input.sessionId) {
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
  return applied;
}

/**
 * After workspace mount (and SessionRegistry.reconcileOnBoot already ran on service start):
 * scan non-terminal running/waiting tasks with sessionId; decide via runtime.probe(sessionId)
 * (process truth), not SessionRecord.state alone. missing / terminal / dead → park the task in
 * waiting(reason=external) via the shared session-unavailable park helper. Keeps occupation;
 * never auto done/release. Truly alive managed sessions are left alone.
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

    if (isSessionUnavailableParkedWait(task)) continue;

    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId, 200, TEMP_DIR);
      // Re-load + re-probe inside the bus for races; only park when still non-terminal + dead.
      const current = await loadTaskEnvelope(mount.env.fs, task.path);
      if (current.state !== "running" && current.state !== "waiting") return;
      if (current.sessionId?.trim() !== sessionId) return;
      const probe2 = await ctx.runtime.probe(sessionId);
      if (probe2.alive) return;
      if (isSessionUnavailableParkedWait(current)) return;

      const parked = await applySessionUnavailablePark(
        ctx,
        workspaceId,
        task.path,
        "session.reconcile"
      );
      if (parked) reconciled.push(task.path);
    });
  }

  return { reconciled };
}

async function workspaceUnmount(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireString(p, "workspaceId");
  // Drain/cancel Service-owned historical reclaim before dropping the mount so
  // unmount does not leave uncontrolled background mutations.
  await cancelAndDrainHistoricalTaskWorktreeReclaim(workspaceId);
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
 * Missing file/field → defaultDeliveryPolicy=review (normalized in core).
 * Historical on-disk `manual` is normalized to `review` at the settings read boundary.
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
  // New writes reject historical `manual`; use `review`.
  if ("defaultDeliveryPolicy" in out) {
    const v = out.defaultDeliveryPolicy;
    if (v !== "review" && v !== "bypass" && v !== "agent-decide") {
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
      // Public type/tags mutations use dedicated RPCs — raw cannot change them.
      assertRawDocsWriteSemantic(diskParsed.data, nextParsed.data);
      assertRawDocsWriteCollaborationFields(nextParsed.data);
      ctx.host.markSelfWrite(workspaceId);
      await mount.env.fs.writeFile(notePath, rawInput);
      // Tags cannot change via docs.write (asserted above); keep sync as no-op safety.
      await syncTagRegistryAfterBoxTagsChange(
        mount.env.fs,
        concept.tags,
        tagsFromFrontmatterData(nextParsed.data)
      );
    } else {
      if (frontmatter) {
        assertReservedDocsWriteFields(frontmatter);
        assertSemanticDocsWriteFields(frontmatter);
        assertDocsWriteCollaborationFields(frontmatter);
      }

      ctx.host.markSelfWrite(workspaceId);
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        // patchBox for non-semantic frontmatter only (type/tags rejected above)
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
  if (modeRaw === "read-only") {
    throw new RpcError(
      -32602,
      'docs.setMode: "read-only" is retired in V0.2; use "editable" or "archived"'
    );
  }
  if (modeRaw !== "editable" && modeRaw !== "archived") {
    throw new RpcError(-32602, 'docs.setMode mode must be "editable" or "archived"');
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

/** Read-only type registry projection (V0.2: name + tier only). */
async function registryTypes(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadTypeRegistry(mount.env.fs);
  const types: TypeRegistryEntryProjection[] = Object.entries(registry)
    .map(([name, def]) => {
      const tier: "base" | "modifier" = def.tier === "modifier" ? "modifier" : "base";
      return { name, tier };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, types };
}

/**
 * User-only custom secondary type create (MutationBus).
 * Primaries / built-in secondaries fail loud. Emits registry.types.updated once.
 */
async function registryTypeCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.type.create");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  if ("tier" in p && p.tier !== undefined && p.tier !== "modifier") {
    throw new RpcError(
      -32602,
      "registry.type.create only accepts custom secondary (modifier) types"
    );
  }
  if ("rename" in p || "newName" in p || "update" in p) {
    throw new RpcError(
      -32602,
      "registry.type.create does not support rename/update; type identifiers are immutable"
    );
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await createSecondaryType(mount.env.fs, name, { tier: "modifier" });
    } catch (err) {
      throw mapTypeRegistryError(err, "registry.type.create");
    }
    emitRegistryTypesUpdated(ctx, workspaceId, {
      action: "create",
      name,
      tier: "modifier",
    });
    return { workspaceId, name, tier: "modifier" as const };
  });
}

/**
 * User-only custom secondary type delete (MutationBus).
 * Built-in and in-use types fail loud. confirmation must equal name.
 * Emits registry.types.updated once on success.
 */
async function registryTypeDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.type.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const confirmation = requireString(p, "confirmation");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      // Preflight for richer error payload (references / activeOwners).
      const inspection = await inspectTypeDeletion(mount.env.fs, "type", name);
      if (!inspection.exists) {
        throw new RpcError(-32004, `Type does not exist: ${name}`, {
          name,
          inspection,
        });
      }
      if (inspection.builtIn) {
        throw new RpcError(-32602, `Built-in types cannot be deleted: ${name}`, {
          name,
          inspection,
        });
      }
      if (inspection.references.length > 0) {
        throw new RpcError(
          -32602,
          `Type still in use by ${inspection.references.length} node(s); retype them first: ${inspection.references
            .map((x) => x.path)
            .join(", ")}.`,
          { name, inspection }
        );
      }
      await deleteCustomType(mount.env.fs, "type", name, confirmation);
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw mapTypeRegistryError(err, "registry.type.delete");
    }
    emitRegistryTypesUpdated(ctx, workspaceId, {
      action: "delete",
      name,
    });
    return { workspaceId, deleted: name };
  });
}

/** Read-only global tag vocabulary. */
async function registryTags(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadTagRegistry(mount.env.fs);
  return { workspaceId, tags: registry.tags };
}

/**
 * User-only ensure tag in global vocabulary (MutationBus).
 * Emits registry.tags.updated once on success.
 */
async function registryTagCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.tag.create");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const rawName = requireString(p, "name");
  let tag: string;
  try {
    tag = normalizeTagName(rawName);
  } catch (err) {
    throw mapTagRegistryError(err, "registry.tag.create");
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await addRegistryTag(mount.env.fs, tag);
    } catch (err) {
      throw mapTagRegistryError(err, "registry.tag.create");
    }
    emitRegistryTagsUpdated(ctx, workspaceId, {
      action: "create",
      name: tag,
    });
    return { workspaceId, name: tag };
  });
}

/**
 * User-only global tag delete + cascade off all Nodes (MutationBus).
 * Emits registry.tags.updated once on success (no per-Node concept.changed).
 * Clients must invalidate tag candidates and graph/node projections after cascade.
 */
async function registryTagDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "registry.tag.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const rawName = requireString(p, "name");
  let tag: string;
  try {
    tag = normalizeTagName(rawName);
  } catch (err) {
    throw mapTagRegistryError(err, "registry.tag.delete");
  }

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await removeRegistryTag(mount.env.fs, tag);
    } catch (err) {
      throw mapTagRegistryError(err, "registry.tag.delete");
    }
    emitRegistryTagsUpdated(ctx, workspaceId, {
      action: "delete",
      name: tag,
    });
    return { workspaceId, deleted: tag };
  });
}

/**
 * User-only Node type mutation (MutationBus + baseEtag).
 * Primary segment must remain canonical; compound type must validate after cutover.
 * Emits exactly one concept.changed with reason docs.setType.
 */
async function docsSetType(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.setType");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const type = requireString(p, "type");
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.setType");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "docs.setType");

    if (!isValidConceptType(type, tent.typeRegistry)) {
      throw new RpcError(
        -32602,
        `Invalid concept type: ${type}. Primary must be goal|prompt|output; secondary must be a registered modifier.`,
        { type }
      );
    }

    ctx.host.markSelfWrite(workspaceId);
    try {
      await patchBox(mount.env, concept.path, { type }, tent);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.setType");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.setType", type },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only replace Node tag list (MutationBus + baseEtag).
 * Empty clears Node tags; does not prune registry. Emits concept.changed reason docs.tags.set.
 */
async function docsTagsSet(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.tags.set");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  if (!Array.isArray(p.tags)) {
    throw new RpcError(-32602, "docs.tags.set requires tags: string[]");
  }
  const tagsRaw = p.tags as unknown[];
  for (const item of tagsRaw) {
    if (typeof item !== "string") {
      throw new RpcError(-32602, "docs.tags.set tags must be an array of strings");
    }
  }
  let tags: string[];
  try {
    tags = [...new Set(tagsRaw.map((t) => normalizeTagName(t as string)))].sort((a, b) =>
      a.localeCompare(b)
    );
  } catch (err) {
    throw mapDocsSemanticError(err, "docs.tags.set");
  }
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.tags.set");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "docs.tags.set");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await patchBox(mount.env, concept.path, { tags }, tent);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tags.set");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.tags.set" },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only attach one tag (MutationBus + baseEtag; idempotent).
 * Emits concept.changed reason docs.tag.add.
 */
async function docsTagAdd(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.tag.add");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const rawTag = requireString(p, "tag");
  let tag: string;
  try {
    tag = normalizeTagName(rawTag);
  } catch (err) {
    throw mapDocsSemanticError(err, "docs.tag.add");
  }
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.tag.add");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "docs.tag.add");

    ctx.host.markSelfWrite(workspaceId);
    try {
      // Core addTag holds withTentMutation; MutationBus serializes Service mutations only.
      await addTag(mount.env.fs, concept.id, tag);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tag.add");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.tag.add", tag },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only detach one tag from Node (MutationBus + baseEtag).
 * Registry is not pruned. Emits concept.changed reason docs.tag.remove.
 */
async function docsTagRemove(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.tag.remove");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const rawTag = requireString(p, "tag");
  let tag: string;
  try {
    tag = normalizeTagName(rawTag);
  } catch (err) {
    throw mapDocsSemanticError(err, "docs.tag.remove");
  }
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "docs.tag.remove");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "docs.tag.remove");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await removeTag(mount.env.fs, concept.id, tag);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tag.remove");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.tag.remove", tag },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
    };
  });
}

function projectRelationWire(record: RelationRecord | RelationOutgoingView): RelationRecordWire {
  const out: RelationRecordWire = {
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

function projectIncomingWire(view: RelationIncomingView) {
  return {
    ...projectRelationWire(view),
    sourceId: view.sourceId,
    sourcePath: view.sourcePath,
  };
}

/**
 * Read-only relation list by stable Node id (or path/boxId resolver).
 * Returns outgoing records owned by the Node plus derived incoming views.
 * Does not merge Markdown/wiki body links.
 */
async function relationList(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationListResult> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept(tent, p);
  try {
    const listed = listRelationsForNode(tent, concept.id);
    return {
      workspaceId,
      nodeId: listed.nodeId,
      path: listed.path,
      outgoing: listed.outgoing.map(projectRelationWire),
      incoming: listed.incoming.map(projectIncomingWire),
    };
  } catch (err) {
    throw mapRelationError(err, "relation.list");
  }
}

/**
 * User-only create semantic relation on source Node (MutationBus + baseEtag).
 * Emits exactly one concept.changed reason relation.create for the source.
 */
async function relationCreate(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationMutationResult> {
  requireUserActor(p, "relation.create");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const kind = requireString(p, "kind");
  const direction = requireString(p, "direction");
  const label = optionalString(p, "label");
  if (!isRecord(p.target)) {
    throw new RpcError(-32602, "relation.create requires target: { nodeId } | { unresolved }");
  }
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "relation.create");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "relation.create");

    ctx.host.markSelfWrite(workspaceId);
    let record: RelationRecord;
    try {
      record = await createRelation(
        mount.env.fs,
        concept.id,
        {
          kind,
          direction: direction as "directed" | "bidirectional",
          ...(label !== undefined ? { label } : {}),
          target: p.target as { nodeId: string } | { unresolved: string },
        },
        Math.random,
        tent
      );
    } catch (err) {
      throw mapRelationError(err, "relation.create");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      {
        id: concept.id,
        path: concept.path,
        reason: "relation.create",
        relationId: record.id,
      },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
      relation: projectRelationWire(record),
    };
  });
}

/**
 * User-only update semantic relation on source Node (MutationBus + baseEtag).
 * Cannot change relation id or source. Emits concept.changed reason relation.update.
 */
async function relationUpdate(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationMutationResult> {
  requireUserActor(p, "relation.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const relationId = requireString(p, "relationId");
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  const patch: {
    kind?: string;
    direction?: "directed" | "bidirectional";
    label?: string | null;
    target?: { nodeId: string } | { unresolved: string };
  } = {};
  if (Object.prototype.hasOwnProperty.call(p, "kind")) {
    patch.kind = requireString(p, "kind");
  }
  if (Object.prototype.hasOwnProperty.call(p, "direction")) {
    patch.direction = requireString(p, "direction") as "directed" | "bidirectional";
  }
  if (Object.prototype.hasOwnProperty.call(p, "label")) {
    const rawLabel = p.label;
    if (rawLabel === null) patch.label = null;
    else if (typeof rawLabel === "string") patch.label = rawLabel;
    else throw new RpcError(-32602, "relation.update label must be string or null");
  }
  if (Object.prototype.hasOwnProperty.call(p, "target")) {
    if (!isRecord(p.target)) {
      throw new RpcError(-32602, "relation.update target must be { nodeId } | { unresolved }");
    }
    patch.target = p.target as { nodeId: string } | { unresolved: string };
  }
  if (Object.keys(patch).length === 0) {
    throw new RpcError(
      -32602,
      "relation.update requires at least one of kind, direction, label, target"
    );
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "relation.update");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "relation.update");

    ctx.host.markSelfWrite(workspaceId);
    let record: RelationRecord;
    try {
      record = await updateRelation(mount.env.fs, concept.id, relationId, patch, tent);
    } catch (err) {
      throw mapRelationError(err, "relation.update");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      {
        id: concept.id,
        path: concept.path,
        reason: "relation.update",
        relationId: record.id,
      },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
      relation: projectRelationWire(record),
    };
  });
}

/**
 * User-only delete semantic relation on source Node (MutationBus + baseEtag).
 * Missing relation id fails loudly. Emits concept.changed reason relation.delete.
 */
async function relationDelete(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationDeleteResult> {
  requireUserActor(p, "relation.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const relationId = requireString(p, "relationId");
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    assertDocsModeMutable(concept, "relation.delete");
    const notePath = boxNotePath(concept.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, concept, baseEtag, "relation.delete");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await deleteRelation(mount.env.fs, concept.id, relationId, tent);
    } catch (err) {
      throw mapRelationError(err, "relation.delete");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      {
        id: concept.id,
        path: concept.path,
        reason: "relation.delete",
        relationId,
      },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
      deleted: relationId,
    };
  });
}

function mapRelationError(err: unknown, surface: string): RpcError {
  if (err instanceof RpcError) return err;
  if (err instanceof RelationError) {
    if (err.code === "NOT_FOUND") return new RpcError(-32004, err.message);
    if (err.code === "ARCHIVED" || err.code === "INVALID") {
      return new RpcError(-32010, `${surface} rejected: ${err.message}`, { code: err.code });
    }
    // CORRUPT: raw relations cannot all round-trip; refuse mutation (disk unchanged).
    if (err.code === "CORRUPT") {
      return new RpcError(-32602, err.message, {
        code: "relations_corrupt",
        reason: err.code,
      });
    }
    if (err.code === "TARGET" || err.code === "INVALID_INPUT") {
      return new RpcError(-32602, err.message, { code: err.code });
    }
    return new RpcError(-32000, err.message, { code: err.code });
  }
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (/not found|Box not found|Concept not found|Relation not found/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (/archived|invalid/i.test(message)) {
    return new RpcError(-32010, message);
  }
  if (/corrupt|non-canonical|unrecognized field|duplicate id/i.test(message)) {
    return new RpcError(-32602, message, { code: "relations_corrupt" });
  }
  return new RpcError(-32000, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitRegistryTypesUpdated(
  ctx: HandlerContext,
  workspaceId: string,
  payload: { action: "create" | "delete"; name: string; tier?: "modifier" | "base" }
): void {
  ctx.events.emit(
    "registry.types.updated",
    workspaceId,
    {
      action: payload.action,
      name: payload.name,
      ...(payload.tier ? { tier: payload.tier } : {}),
    },
    "self"
  );
}

function emitRegistryTagsUpdated(
  ctx: HandlerContext,
  workspaceId: string,
  payload: { action: "create" | "delete"; name: string }
): void {
  ctx.events.emit(
    "registry.tags.updated",
    workspaceId,
    { action: payload.action, name: payload.name },
    "self"
  );
}

/** Missing → -32008 with currentEtag; stale → -32009 with currentEtag only (no body). */
async function assertDocsSemanticBaseEtag(
  fs: import("../core/adapter.js").FsAdapter,
  notePath: string,
  concept: import("../core/types.js").Box,
  baseEtag: string | undefined,
  surface: string
): Promise<void> {
  const diskRaw = await fs.readFile(notePath);
  const currentEtag = contentEtag(diskRaw);
  if (!baseEtag) {
    throw new RpcError(-32008, `${surface} requires baseEtag`, {
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
}

function mapTypeRegistryError(err: unknown, surface: string): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (/does not exist/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (
    /Built-in|cannot be created|cannot be deleted|already exists|Confirmation mismatch|still in use|active task|cannot contain|cannot be empty|temp\/|Primary types are fixed|only allows creating/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

function mapTagRegistryError(err: unknown, surface: string): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (/cannot be empty|path separators|newlines/i.test(message)) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

function mapDocsSemanticError(err: unknown, surface: string): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (/not found|Box not found/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (
    /Unknown type|Primary type|Invalid or archived|cannot be tagged|cannot be empty|path separators|newlines|Reserved or retired|Archived boxes|Invalid subtrees/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

/** Read-only role registry projection (dispatch target picker + roster readiness). */
async function registryRoles(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  // One-time allowedProfiles → roster write-forward (idempotent; no dual-write).
  const { registry } = await ensureRolesRosterMigrated(mount.env.fs);
  // Read-only projection: never auto-create AgentDefinitions or mutate machine files.
  const agentById = await loadAgentDefinitionIndex(ctx);
  const roles: RoleRegistryEntryProjection[] = registry.roles
    .map((role) => projectRoleRegistryEntry(role, agentById, ctx))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, roles };
}

async function loadAgentDefinitionIndex(
  ctx: HandlerContext
): Promise<Map<string, AgentDefinition>> {
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  return new Map(agents.map((a) => [a.id, a]));
}

/**
 * Project one Role row for clients. When agent index is provided, derive
 * per-roster readiness without inventing definitions or reading secrets.
 */
function projectRoleRegistryEntry(
  role: RoleDefinition,
  agentById?: Map<string, AgentDefinition>,
  ctx?: HandlerContext
): RoleRegistryEntryProjection {
  const proj: RoleRegistryEntryProjection = {
    roleId: role.id ?? "",
    name: role.name,
    displayName: role.displayName || role.name,
    description: role.description,
    color: role.color,
    prompt: role.prompt,
    a2aPolicy: roleA2APolicy(role),
  };
  const roster = roleRoster(role);
  if (roster.length > 0) {
    proj.roster = roster;
    if (agentById && ctx) {
      proj.rosterEntries = roster.map((agentId) =>
        projectRoleRosterEntry(agentId, agentById, ctx)
      );
    }
  }
  return proj;
}

/**
 * Derive readiness for one persisted roster agentId.
 * ready | missing-definition | missing-profile — never credentials or full profile.
 */
function projectRoleRosterEntry(
  agentId: string,
  agentById: Map<string, AgentDefinition>,
  ctx: HandlerContext
): RoleRosterEntryProjection {
  const def = agentById.get(agentId);
  if (!def) {
    return { agentId, readiness: "missing-definition" };
  }
  const entry: RoleRosterEntryProjection = {
    agentId,
    profileId: def.profileId,
    readiness: ctx.profileCatalog.get(def.profileId)
      ? "ready"
      : "missing-profile",
  };
  if (def.displayName) {
    entry.displayName = def.displayName;
  }
  return entry;
}

async function projectRoleRegistryEntryLive(
  ctx: HandlerContext,
  role: RoleDefinition
): Promise<RoleRegistryEntryProjection> {
  const agentById = await loadAgentDefinitionIndex(ctx);
  return projectRoleRegistryEntry(role, agentById, ctx);
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
    return {
      workspaceId,
      role: await projectRoleRegistryEntryLive(ctx, role),
    };
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
  if ("roster" in p) {
    updatePatch.roster = normalizeAgentIdList(
      Array.isArray(p.roster) ? p.roster : []
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
    return {
      workspaceId,
      role: await projectRoleRegistryEntryLive(ctx, role),
    };
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
    throw new RpcError(
      -32602,
      "registry.role.* no longer accepts allowedProfiles; use roster (agentIds). Legacy allowedProfiles is migrated once from disk only."
    );
  }
  if ("roster" in p) {
    if (p.roster === null) {
      raw.roster = [];
    } else if (!Array.isArray(p.roster)) {
      throw new RpcError(-32602, "roster must be an array of agentId strings");
    } else {
      for (const item of p.roster) {
        if (typeof item !== "string") {
          throw new RpcError(-32602, "roster must be an array of agentId strings");
        }
      }
      raw.roster = normalizeAgentIdList(p.roster) ?? [];
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
    // For update with roster: [] we need to pass empty to clear — core normalize
    // drops empty, so re-attach when caller explicitly set the field.
    if ("roster" in p) {
      const normalized = normalizeAgentIdList(Array.isArray(p.roster) ? p.roster : []);
      if (normalized) role.roster = normalized;
      else delete role.roster;
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
    /already exists|does not exist|Confirmation mismatch|cannot be empty|cli\.|immutable|cannot be renamed|no longer accept|allowedProfiles/i.test(
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

// ---- agent.* (machine-local AgentDefinition catalog) ----

async function agentList(ctx: HandlerContext) {
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  const profiles = new Set(ctx.profileCatalog.list().map((p) => p.id));
  return {
    agents: agents
      .map((a) =>
        projectAgentDefinition(a, { profileExists: profiles.has(a.profileId) })
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function agentGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const id = requireString(p, "id");
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  const agent = findAgentDefinition(agents, id);
  if (!agent) {
    throw new RpcError(-32004, `AgentDefinition not found: ${id}`);
  }
  const profileExists = !!ctx.profileCatalog.get(agent.profileId);
  return { agent: projectAgentDefinition(agent, { profileExists }) };
}

async function agentCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "agent.create");
  if ("agent" in p && typeof p.agent === "object" && p.agent !== null) {
    throw new RpcError(
      -32602,
      "agent.create does not accept nested agent; pass fields at the top level"
    );
  }
  let parsed: ReturnType<typeof parseAgentDefinitionParams>;
  try {
    parsed = parseAgentDefinitionParams(p, { requireId: true });
  } catch (err) {
    throw new RpcError(-32602, err instanceof Error ? err.message : "Invalid agent definition");
  }
  if (!parsed.id || !parsed.profileId) {
    throw new RpcError(-32602, "agent.create requires id and profileId");
  }
  if (!ctx.profileCatalog.get(parsed.profileId)) {
    throw new RpcError(-32004, `Profile not found: ${parsed.profileId}`);
  }
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  if (findAgentDefinition(agents, parsed.id)) {
    throw new RpcError(-32602, `AgentDefinition already exists: ${parsed.id}`);
  }
  const created = normalizeAgentDefinition({
    id: parsed.id,
    profileId: parsed.profileId,
    displayName: parsed.displayName,
    description: parsed.description,
  });
  const next = [...agents, created].sort((a, b) => a.id.localeCompare(b.id));
  await saveAgentDefinitions(ctx.dataDir, next);
  const projection = projectAgentDefinition(created, { profileExists: true });
  ctx.events.emit(
    "agent.changed",
    "",
    { action: "create", id: created.id, agent: projection },
    "self"
  );
  return { agent: projection };
}

async function agentUpdate(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "agent.update");
  if ("agent" in p && typeof p.agent === "object" && p.agent !== null) {
    throw new RpcError(
      -32602,
      "agent.update does not accept nested agent; pass { id, ...patch }"
    );
  }
  const id = requireString(p, "id");
  let parsed: ReturnType<typeof parseAgentDefinitionParams>;
  try {
    parsed = parseAgentDefinitionParams({ ...p, id }, { forUpdate: true });
  } catch (err) {
    throw new RpcError(-32602, err instanceof Error ? err.message : "Invalid agent definition");
  }
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  const index = agents.findIndex((a) => a.id === id);
  if (index === -1) {
    throw new RpcError(-32004, `AgentDefinition not found: ${id}`);
  }
  const current = agents[index]!;
  if (parsed.profileId && !ctx.profileCatalog.get(parsed.profileId)) {
    throw new RpcError(-32004, `Profile not found: ${parsed.profileId}`);
  }
  const nextRow: AgentDefinition = normalizeAgentDefinition({
    id: current.id,
    profileId: parsed.profileId ?? current.profileId,
    displayName:
      "displayName" in p
        ? parsed.displayName
        : current.displayName,
    description:
      "description" in p
        ? parsed.description
        : current.description,
  });
  // Explicit clear of optional text fields.
  if ("displayName" in p && (p.displayName === null || p.displayName === "")) {
    delete nextRow.displayName;
  }
  if ("description" in p && (p.description === null || p.description === "")) {
    delete nextRow.description;
  }
  const next = [...agents];
  next[index] = nextRow;
  await saveAgentDefinitions(ctx.dataDir, next);
  const profileExists = !!ctx.profileCatalog.get(nextRow.profileId);
  const projection = projectAgentDefinition(nextRow, { profileExists });
  ctx.events.emit(
    "agent.changed",
    "",
    { action: "update", id: nextRow.id, agent: projection },
    "self"
  );
  return { agent: projection };
}

async function agentDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "agent.delete");
  const id = requireString(p, "id");
  const confirmation = requireString(p, "confirmation");
  if (confirmation !== id) {
    throw new RpcError(-32602, `Confirmation mismatch; enter the agent id ${id}.`);
  }
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  const index = agents.findIndex((a) => a.id === id);
  if (index === -1) {
    throw new RpcError(-32004, `AgentDefinition not found: ${id}`);
  }
  const next = agents.filter((a) => a.id !== id);
  await saveAgentDefinitions(ctx.dataDir, next);
  ctx.events.emit("agent.changed", "", { action: "delete", id }, "self");
  return { id, deleted: true };
}

/**
 * Ensure AgentDefinitions exist for every roster agentId (and legacy profile ids).
 * Deterministic agentId === former profileId when auto-creating.
 */
async function ensureAgentDefsForRosterIds(
  ctx: HandlerContext,
  agentIds: readonly string[]
): Promise<AgentDefinition[]> {
  const { agents } = await loadAgentDefinitions(ctx.dataDir);
  const { agents: next, added } = ensureAgentDefinitionsForProfileIds(agents, agentIds);
  if (added) {
    await saveAgentDefinitions(ctx.dataDir, next);
  }
  return next;
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
  // V0.2 default primary for ordinary notes is prompt (Core 数据与权威边界审计).
  const type = optionalString(p, "type") ?? "prompt";
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

/**
 * User-only structural move / reparent.
 * MutationBus; resolve by cx-; require expectedPath; placeBox occupation; rename-style link rewrite on parent change.
 * Success emits exactly one concept.changed (reason docs.move) with oldPath/path/pathMap.
 */
async function docsMove(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.move");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const id = requireString(p, "id");
  const expectedPath = requireString(p, "expectedPath");
  if ("newId" in p) {
    throw new RpcError(-32602, "docs.move cannot change concept id; cx- is immutable");
  }
  // newParentId: null/undefined/"" = tent root; must be string or null when present.
  if (
    "newParentId" in p &&
    p.newParentId !== null &&
    p.newParentId !== undefined &&
    typeof p.newParentId !== "string"
  ) {
    throw new RpcError(-32602, "docs.move newParentId must be a string or null");
  }
  const newParentId =
    p.newParentId === null || p.newParentId === undefined || p.newParentId === ""
      ? null
      : String(p.newParentId);
  const position = parseMovePosition(p.position);

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = tent.byId.get(id);
    if (!concept) {
      throw new RpcError(-32004, `Concept not found: ${id}`);
    }
    // Tree identity concurrency: path must match client's expectedPath (not body etag).
    const normalizedExpected = expectedPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const currentPath = concept.path;
    if (currentPath !== normalizedExpected) {
      throw new RpcError(-32009, "path stale", {
        code: "path_stale",
        currentPath,
        expectedPath: normalizedExpected,
        id: concept.id,
      });
    }
    // Destination parent must resolve by id when non-null (stable cx-, not path).
    if (newParentId !== null) {
      const parent = tent.byId.get(newParentId);
      if (!parent) {
        throw new RpcError(-32004, `Target parent not found: ${newParentId}`);
      }
    }
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await moveNode(mount.env, concept.id, newParentId, position);
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        {
          id: result.id,
          path: result.path,
          oldPath: result.oldPath,
          reason: "docs.move",
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
        pathMap: result.pathMap,
        rewrittenNotes: result.rewrittenNotes,
      };
    } catch (err) {
      throw mapDocsMoveError(err);
    }
  });
}

function parseMovePosition(raw: unknown): MovePosition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(-32602, "docs.move position must be an object");
  }
  const pos = raw as Record<string, unknown>;
  const mode = pos.mode;
  if (mode === "inside") {
    return { mode: "inside" };
  }
  if (mode === "before" || mode === "after") {
    const siblingId = pos.siblingId;
    if (typeof siblingId !== "string" || !siblingId.trim()) {
      throw new RpcError(-32602, `docs.move position.${mode} requires siblingId`);
    }
    return { mode, siblingId: siblingId.trim() };
  }
  throw new RpcError(-32602, "docs.move position.mode must be inside, before, or after");
}

function mapDocsMoveError(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : "docs.move failed";
  if (/not found/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (
    /already exists|Invalid or archived|Cannot move|active task|System directories|system pipelines|sibling concept|id drift|immutable|own subtree|relative to itself|destination parent|Concept id is required/i.test(
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
  // Authoritative public Node selection is nodeIds[] only.
  const dispatchSelection = resolveTaskDispatchNodeSelection(p, mount.env.tentName);
  const primaryNodeId = dispatchSelection.primaryId;
  const nodeIds = dispatchSelection.nodeIds;
  const assigneeKindRaw = optionalString(p, "assigneeKind");
  const assigneeKind =
    assigneeKindRaw === "agentProfile" ? "agentProfile" : assigneeKindRaw === "role" || !assigneeKindRaw
      ? "role"
      : (() => {
          throw new RpcError(-32602, `Invalid assigneeKind: ${assigneeKindRaw}`);
        })();
  const role = optionalString(p, "role");
  const agentIdParam = optionalString(p, "agentId");
  let profileId = optionalString(p, "profileId");
  const prompt = requireString(p, "prompt");
  const asSub = p.asSub === true;
  // Legacy dispatchedBy is migration-only; refuse permanent new-write support.
  if ("dispatchedBy" in p && p.dispatchedBy !== undefined && p.dispatchedBy !== null) {
    throw new RpcError(
      -32602,
      "task.dispatch dispatchedBy is retired; pass explicit parentActor and reviewer " +
        "({ kind: user|role, id }). Legacy envelopes migrate once on workspace.mount."
    );
  }
  const explicitParentActor = parseOptionalTaskActor(p.parentActor, "parentActor");
  const explicitReviewer = parseOptionalTaskActor(p.reviewer, "reviewer");
  const explicitDeliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }

  // New create requires explicit parentActor + reviewer (no dispatchedBy fallback).
  const resolvedActors = resolveDispatchActorsFromRpc({
    parentActor: explicitParentActor,
    reviewer: explicitReviewer,
  });

  if (assigneeKind === "role" && !role) {
    throw new RpcError(-32602, "task.dispatch with assigneeKind=role requires role");
  }
  // agentId path: always resolve AgentDefinition → machine-local profileId and
  // verify any explicit profileId matches. Actor authority is strict:
  // callerKind=role iff parentActor.kind=role (reviewer already equals parent).
  // Role pair → standing roster auth. User pair → root, no roster; persist
  // agentId, launch managed ACP, review-to-user. ProfileId one-shot without
  // agentId remains a separate user-direct path (no logical agentId).
  let resolvedAgentId: string | undefined;
  if (agentIdParam) {
    if (assigneeKind !== "agentProfile") {
      throw new RpcError(
        -32602,
        "task.dispatch with agentId requires assigneeKind=agentProfile (logical agent → profile launch)"
      );
    }
    const { agents } = await loadAgentDefinitions(ctx.dataDir);
    try {
      const resolved = resolveProfileIdForAgent(agents, agentIdParam);
      if (profileId && profileId !== resolved) {
        throw new RpcError(
          -32602,
          `task.dispatch agentId ${agentIdParam} binds profileId ${resolved}; got conflicting profileId ${profileId}`
        );
      }
      profileId = resolved;
      resolvedAgentId = agentIdParam.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        throw new RpcError(-32004, message);
      }
      throw new RpcError(-32602, message);
    }
    // Explicit invariant: callerKind and parentActor kind must agree for agentId.
    // Do not silently pass roster when callerKind=user + parentActor=role (or the reverse).
    const parentIsRole = resolvedActors.parentActor.kind === "role";
    const callerIsRole = callerKind === "role";
    if (callerIsRole !== parentIsRole) {
      throw new RpcError(
        -32602,
        callerIsRole
          ? "task.dispatch with agentId: callerKind=role requires parentActor kind=role (got user)"
          : "task.dispatch with agentId: callerKind=user requires parentActor kind=user (got role)",
        {
          callerKind,
          parentActor: resolvedActors.parentActor,
          reviewer: resolvedActors.reviewer,
        }
      );
    }
    if (parentIsRole) {
      // Role/role pair → standing roster gate (out-of-roster fails loud).
      await assertRoleRosterStandingAuth(ctx, mount.env.fs, {
        dispatcher: resolvedActors.parentActor.id,
        agentId: resolvedAgentId,
        profileId,
      });
    }
    // else: user/user pair — no Role/roster; agentId + managed ACP + review-to-user.
  }
  if (assigneeKind === "agentProfile" && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with assigneeKind=agentProfile requires profileId or agentId"
    );
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
      "task.dispatch with startSession requires explicit profileId or agentId (no fake-default fallback)"
    );
  }

  // P0-1: role worktree create/reuse + envelope dispatch share the workspace MutationBus
  // critical section so concurrent role worktree add cannot race. Git ops stay inside the
  // bus action (never nested mutations.run).
  // Peer profile tasks: lane deferred until startSession (tent-task/<taskId>).
  // Sub profile tasks: allocate taskId + create task lane at dispatch (target = dispatcher).
  // Role assignee (peer + asSub): ensure durable Role/parent worktrees for validation only;
  // do NOT persist execution workspaceLane/baseCommit/roleBranchBase at queue — first claim
  // captures the real Role tip in the same lifecycle + workspace mutation boundary.
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
        parentActor: resolvedActors.parentActor,
        assigneeKind,
        assigneeLabel,
      });
    }
    let workspaceLane: RoleWorkspaceContract | undefined;
    let preallocatedTaskId: string | undefined;

    if (asSub) {
      // Parent Role lane must exist so asSub target can be validated / later bound at claim.
      const parentRole = resolvedActors.parentActor.id;
      const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, parentRole);
      if (assigneeKind === "role") {
        // Ensure assignee Role worktree exists; leave envelope without execution lane/base.
        await ensureRoleWorkspace(mount.workspaceRoot, assigneeLabel);
        // Delay entire Role execution lane until first claim (do not freeze Git tip).
        workspaceLane = undefined;
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
      // Peer role: ensure durable tent-role worktree when Git (validation only).
      // Execution lane + baseCommit are captured at first claim, not queue.
      await ensureRoleWorkspaceIfGit(mount.workspaceRoot, assigneeLabel);
      workspaceLane = undefined;
    }
    // Peer profile: no lane at dispatch (deferred to startSession).

    ctx.host.markSelfWrite(workspaceId);
    let deliveryPolicy = explicitDeliveryPolicy;
    if (deliveryPolicy === undefined) {
      const settings = await loadWorkspaceSettings(mount.env.fs);
      deliveryPolicy = settings.defaultDeliveryPolicy;
    }
    // Downstream Task Agent → parent: force review (no bypass/agent-decide).
    // Elevated policies only for durable Role user-facing delivery.
    if (
      deliveryPolicy !== "review" &&
      !mayElevateDeliveryPolicy({
        parentActor: resolvedActors.parentActor,
        assigneeKind,
      })
    ) {
      if (explicitDeliveryPolicy !== undefined) {
        throw new RpcError(
          -32602,
          `deliveryPolicy=${deliveryPolicy} is only legal for a durable Role's user-facing delivery; ` +
            `Task Agent → parent must use review (parent=${resolvedActors.parentActor.kind}:${resolvedActors.parentActor.id})`,
          {
            deliveryPolicy,
            parentActor: resolvedActors.parentActor,
            assigneeKind,
          }
        );
      }
      // Workspace default elevated while dispatching a downstream Task Agent → clamp to review.
      deliveryPolicy = "review";
    }
    // Real stable contextGeneration at dispatch when launch profile is known.
    // agentProfile: profile/adapter known → compute immediately (fail loud).
    // Role without profileId: defer generation until startSession chooses the profile
    // (do not freeze role-name/unknown-adapter placeholders).
    const purposeParam =
      typeof p.purpose === "string" && p.purpose.trim() ? p.purpose.trim() : undefined;
    let dispatchContextGeneration: string | undefined;
    let dispatchContextFacts:
      | import("../core/task.js").TaskEnvelopeInput["contextGenerationFacts"]
      | undefined;
    if (assigneeKind === "agentProfile") {
      const dispatchProfileId = profileId!;
      const dispatchProfile = ctx.profileCatalog.get(dispatchProfileId);
      if (!dispatchProfile?.adapterId) {
        throw new RpcError(
          -32602,
          `task.dispatch cannot compute contextGeneration: profile ${dispatchProfileId} missing or has no adapterId`,
          { profileId: dispatchProfileId }
        );
      }
      const parentRoleIdForGen =
        resolvedActors.parentActor.kind === "role"
          ? resolvedActors.parentActor.id
          : undefined;
      try {
        const bundle = await collectStableContextGeneration({
          workspaceRoot: mount.workspaceRoot,
          workspaceIdentity: workspaceId,
          packageRoot: ctx.packageRoot,
          packageVersion: ctx.version,
          assigneeKind,
          assigneeLabel,
          agentId: resolvedAgentId,
          profileId: dispatchProfileId,
          adapterId: dispatchProfile.adapterId,
          parentRoleId: parentRoleIdForGen,
          purpose: purposeParam,
          roleFs: mount.env.fs,
        profile: dispatchProfile,
        });
        dispatchContextGeneration = bundle.contextGeneration;
        dispatchContextFacts = {
          agentsPointerDigest: bundle.agentsPointerDigest,
          tentRoleDigest: bundle.tentRoleDigest || undefined,
          tentRoleVersion: bundle.tentRoleVersion || undefined,
          tentTaskDigest: bundle.tentTaskDigest || undefined,
          tentTaskVersion: bundle.tentTaskVersion || undefined,
          rolePrompt: bundle.rolePrompt || undefined,
          rosterAgentIds: bundle.rosterAgentIds,
          profileId: bundle.profileId,
          adapterId: bundle.adapterId,
          purpose: bundle.purpose || undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError(
          -32000,
          `task.dispatch contextGeneration collection failed: ${message}`,
          { code: "CONTEXT_GENERATION_COLLECT_FAILED" }
        );
      }
    } else if (profileId) {
      // Role dispatch with explicit launch profile: compute real generation now.
      const dispatchProfile = ctx.profileCatalog.get(profileId);
      if (!dispatchProfile?.adapterId) {
        throw new RpcError(
          -32602,
          `task.dispatch cannot compute contextGeneration: profile ${profileId} missing or has no adapterId`,
          { profileId }
        );
      }
      const parentRoleIdForGen =
        resolvedActors.parentActor.kind === "role"
          ? resolvedActors.parentActor.id
          : undefined;
      try {
        const bundle = await collectStableContextGeneration({
          workspaceRoot: mount.workspaceRoot,
          workspaceIdentity: workspaceId,
          packageRoot: ctx.packageRoot,
          packageVersion: ctx.version,
          assigneeKind,
          assigneeLabel,
          agentId: resolvedAgentId,
          profileId,
          adapterId: dispatchProfile.adapterId,
          parentRoleId: parentRoleIdForGen,
          purpose: purposeParam,
          roleFs: mount.env.fs,
        profile: dispatchProfile,
        });
        dispatchContextGeneration = bundle.contextGeneration;
        dispatchContextFacts = {
          agentsPointerDigest: bundle.agentsPointerDigest,
          tentRoleDigest: bundle.tentRoleDigest || undefined,
          tentRoleVersion: bundle.tentRoleVersion || undefined,
          tentTaskDigest: bundle.tentTaskDigest || undefined,
          tentTaskVersion: bundle.tentTaskVersion || undefined,
          rolePrompt: bundle.rolePrompt || undefined,
          rosterAgentIds: bundle.rosterAgentIds,
          profileId: bundle.profileId,
          adapterId: bundle.adapterId,
          purpose: bundle.purpose || undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError(
          -32000,
          `task.dispatch contextGeneration collection failed: ${message}`,
          { code: "CONTEXT_GENERATION_COLLECT_FAILED" }
        );
      }
    }
    // else: Role without profile — generation finalized at startSession.

    const dispatched = await dispatch(mount.env, primaryNodeId, assigneeKind === "role" ? role : undefined, {
      userPrompt: prompt,
      parentActor: resolvedActors.parentActor,
      reviewer: resolvedActors.reviewer,
      asSub,
      deliveryPolicy,
      // Only profile-asSub (and similar) may bind a Git lane at dispatch.
      // Role assignee never freezes workspaceLane/baseCommit here.
      workspace: workspaceLane,
      assigneeKind,
      profileId: assigneeKind === "agentProfile" ? profileId : undefined,
      // Persist logical agentId for agentId dispatch (Role-agent and user-direct).
      // User-direct profileId one-shot without agentId leaves this undefined.
      agentId: resolvedAgentId,
      // Authoritative ordered Node refs (transient). Core writes Context Card only.
      nodeIds,
      ...(preallocatedTaskId ? { taskId: preallocatedTaskId } : {}),
      ...(purposeParam ? { purpose: purposeParam } : {}),
      ...(dispatchContextGeneration
        ? { contextGeneration: dispatchContextGeneration }
        : {}),
      ...(dispatchContextFacts ? { contextGenerationFacts: dispatchContextFacts } : {}),
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched.taskPath,
        state: "queued",
        role: dispatched.assignee,
        assigneeKind: dispatched.assigneeKind,
        nodeIds,
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
    // Combined convenience only: if startSession fails before any Session bind while the
    // Task is still running without sessionId, release via the existing interrupt path
    // (preserve audit; no deletion of non-queued Tasks). Separate claim/startSession APIs
    // are unchanged. Do not overwrite honest waiting/failed from A2A ask or provider launch.
    // Role first claim also captures execution lane + baseCommit in that same claim boundary.
    await taskClaimRpc(ctx, {
      workspaceId,
      taskPath: dispatched.taskPath,
    });
    try {
      session = await taskStartSessionRpc(ctx, {
        workspaceId,
        taskPath: dispatched.taskPath,
        profileId,
        callerKind,
      });
    } catch (err) {
      await compensateCombinedDispatchStartSessionFailure(ctx, {
        workspaceId,
        taskPath: dispatched.taskPath,
      });
      throw err;
    }
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
    parentActor: taskAfter?.parentActor ?? resolvedActors.parentActor,
    reviewer: taskAfter?.reviewer ?? resolvedActors.reviewer,
    // Prefer durable envelope state so success/failure projections stay honest.
    state: taskAfter?.state ?? (startSession ? "running" : "queued"),
    session,
    // Prefer envelope projection (Role baseCommit only after claim; profile-asSub may
    // still carry dispatch-time lane). Fall back to in-memory lane only when present.
    workspaceLane: taskAfter
      ? projectTask(taskAfter).workspaceLane
      : workspaceLane
        ? {
            workspace: workspaceLane.workspace,
            worktree: workspaceLane.worktree,
            branch: workspaceLane.branch,
            targetBranch: workspaceLane.targetBranch,
            ...(workspaceLane.baseCommit
              ? { baseCommit: workspaceLane.baseCommit }
              : {}),
          }
        : undefined,
  };
}

/**
 * Combined task.dispatch(startSession=true) compensation only.
 * When startSession rejects before binding a Session and the Task is still
 * running without sessionId, transition through task.interrupt (preserve Task
 * audit; no deletion of claimed Tasks). Leaves waiting(a2a-approval) and failed
 * (provider launch/recovery) alone.
 *
 * Atomicity: running/no-session precondition and interrupt share one workspace
 * MutationBus section so a concurrent Session bind cannot be interrupted or stopped.
 * Best-effort: always rethrow the original RPC error from the caller.
 */
async function compensateCombinedDispatchStartSessionFailure(
  ctx: HandlerContext,
  input: { workspaceId: string; taskPath: string }
): Promise<void> {
  try {
    // Test-only pause point: runs before the MutationBus section so a concurrent
    // Session bind can complete; production never sets this hook.
    if (beforeCombinedDispatchCompensateForTests) {
      await beforeCombinedDispatchCompensateForTests(input);
    }
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;
    await ctx.mutations.run(input.workspaceId, async () => {
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
      if (!task) return;
      if (task.state !== "running") return;
      // Concurrent startSession bind: never interrupt or stop that Session.
      if (task.sessionId) return;
      // No sessionId on this path — same side-effects as task.interrupt without stopSession.
      ctx.host.markSelfWrite(input.workspaceId);
      const interrupted = await taskInterrupt(mount.env, input.taskPath);
      emitTaskState(ctx, input.workspaceId, interrupted, "task.interrupt");
      await cancelUserAsksForTask(
        ctx,
        input.workspaceId,
        input.taskPath,
        "task.interrupt"
      );
      await cancelTaskInputsForTask(
        ctx,
        input.workspaceId,
        input.taskPath,
        "task.interrupt"
      );
    });
  } catch {
    // Best-effort only; the original startSession RpcError is rethrown by the caller.
  }
}

/**
 * Fail before lane/envelope creation for asSub (Git-lane sub) dispatch.
 * Requires durable registry parent Role (not user, not the assignee itself),
 * and a real Git workspace. Soft policy only — not cryptographic auth.
 */
async function assertSubDispatchPreconditions(
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    workspaceRoot: string;
    parentActor: TaskActorRef;
    assigneeKind: "role" | "agentProfile";
    assigneeLabel: string;
  }
): Promise<void> {
  if (input.parentActor.kind !== "role") {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires parentActor kind=role naming a real durable registry role (not user)",
      { parentActor: input.parentActor }
    );
  }
  const dispatcher = input.parentActor.id.trim();
  if (!dispatcher || dispatcher === "user") {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires parentActor naming a real durable registry role (not user)"
    );
  }
  if (dispatcher === input.assigneeLabel) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub parentActor must not equal the assignee itself",
      { parentActor: input.parentActor, assignee: input.assigneeLabel }
    );
  }
  const registry = await loadRolesRegistry(fs);
  const role = resolveRole(registry.roles, dispatcher);
  if (!role) {
    throw new RpcError(
      -32602,
      `task.dispatch asSub parentActor role not found in registry: ${dispatcher}`,
      { parentActor: input.parentActor }
    );
  }
  if (!(await isGitWorkspace(input.workspaceRoot))) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires a real Git workspace lane; pure Tent / non-Git workspaces cannot host sub dispatch"
    );
  }
}

function parseOptionalTaskActor(
  value: unknown,
  label: "parentActor" | "reviewer"
): TaskActorRef | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return parseTaskActorRef(value, label);
  } catch (err) {
    throw new RpcError(
      -32602,
      err instanceof Error ? err.message : `Invalid ${label}`,
      { field: label }
    );
  }
}

/**
 * Resolve authoritative Node selection for task.dispatch.
 * Accept only transient `nodeIds` (ordered, deduped). The old
 * boxId/id/claimId dispatch grammar is retired rather than silently translated.
 * Fail loud before MutationBus Task/manifest writes for malformed input.
 * Node existence/archive gates run inside Core under the same workspace lock.
 */
function resolveTaskDispatchNodeSelection(
  p: Record<string, unknown>,
  tentName: string
): { nodeIds: string[]; primaryId: string } {
  for (const retired of ["boxId", "id", "claimId"] as const) {
    if (p[retired] !== undefined && p[retired] !== null) {
      throw new RpcError(
        -32602,
        `task.dispatch ${retired} is retired; pass non-empty nodeIds[]`,
        { field: retired }
      );
    }
  }
  // Refuse non-array / non-string-element nodeIds fail-loud (not silent ignore).
  if ("nodeIds" in p && p.nodeIds !== undefined && p.nodeIds !== null) {
    if (!Array.isArray(p.nodeIds)) {
      throw new RpcError(-32602, "Invalid string[] param: nodeIds");
    }
    if (!p.nodeIds.every((x) => typeof x === "string")) {
      throw new RpcError(-32602, "Invalid string[] param: nodeIds");
    }
  }
  const rawNodeIds = optionalStringArray(p, "nodeIds");
  try {
    const nodeIds = resolveDispatchNodeIds({
      nodeIds: rawNodeIds,
      primaryNodeId: rawNodeIds?.[0] ?? "",
      tentName,
    });
    return { nodeIds, primaryId: nodeIds[0]! };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message, { field: "nodeIds" });
  }
}

/**
 * Resolve parent/reviewer at dispatch RPC.
 * Requires explicit parentActor. Reviewer may be omitted (derived equal to
 * parent); when present must match exactly — no Role A → reviewer Role B.
 * Equality is enforced only via resolveParentReviewerPair (same as Core write/load).
 * Legacy dispatchedBy is rejected at the RPC boundary (migration/load only).
 */
function resolveDispatchActorsFromRpc(input: {
  parentActor?: TaskActorRef;
  reviewer?: TaskActorRef;
}): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  if (!input.parentActor) {
    throw new RpcError(
      -32602,
      "task.dispatch requires explicit parentActor { kind: user|role, id }"
    );
  }
  try {
    return resolveParentReviewerPair({
      parentActor: input.parentActor,
      reviewer: input.reviewer,
    });
  } catch (err) {
    throw new RpcError(
      -32602,
      err instanceof Error
        ? err.message
        : "task.dispatch reviewer must equal parentActor",
      {
        parentActor: input.parentActor,
        reviewer: input.reviewer,
      }
    );
  }
}

async function taskClaimRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const sessionId = optionalString(p, "sessionId");

  // Per-Task lifecycle flight + workspace mutation: claim must not race deliver/backfill.
  return runTaskLifecycle(workspaceId, taskPath, () =>
    ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      // Prepare Role lane/base BEFORE Core claim transition so a failed prepare
      // leaves the Task queued (no intermediate running without base).
      const pre = await loadTaskEnvelope(mount.env.fs, taskPath);
      let claimWrite: TaskEnvelopePatch | undefined;
      if (!(pre.state === "running" && pre.status === "taken")) {
        // First claim only: prepare lane/base (no disk write) then single-patch claim.
        claimWrite = await prepareRoleClaimWrite(ctx, workspaceId, pre);
        if (beforeTaskClaimCoreForTests) {
          await beforeTaskClaimCoreForTests({ workspaceId, taskPath, task: pre });
        }
      }
      const task = await taskClaim(mount.env, taskPath, {
        sessionId,
        ...(claimWrite ? { claimWrite } : {}),
      });
      emitTaskState(ctx, workspaceId, task, "task.claim");
      const nodeIds =
        task.contextCard != null ? taskReferencedNodeIds(task) : [];
      for (const nodeId of nodeIds) {
        if (nodeId === "root") continue;
        ctx.events.emit(
          "concept.changed",
          workspaceId,
          { id: nodeId, reason: "task.claim-projection" },
          "self"
        );
      }
      return {
        workspaceId,
        taskPath,
        task: projectTask(task),
        state: task.state,
        role: task.role,
        referencedNodeIds: nodeIds,
        sessionId: task.sessionId,
      };
    })
  );
}

/**
 * Explicit legacy backfill of workspaceLane.baseCommit for running/waiting Tasks
 * whose lane exists but base is missing. Authorized only by exact persisted
 * parent/reviewer. Never infers from roleBranchBase/cwd/current tip.
 * Same SHA is idempotent (original audit unchanged); different SHA fails loud.
 * Wrapped by per-Task lifecycle flight so it cannot race deliver/accept.
 */
async function taskBackfillWorkspaceLaneBaseRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const baseCommitRaw = requireString(p, "baseCommit");
  const actor = parseBackfillActor(p.actor);

  return runTaskLifecycle(workspaceId, taskPath, () =>
    ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      if (beforeTaskBackfillWorkspaceLaneBaseForTests) {
        await beforeTaskBackfillWorkspaceLaneBaseForTests({
          workspaceId,
          taskPath,
        });
      }
      // Re-read under task lifecycle + workspace mutation lock.
      const current = await loadTaskEnvelope(mount.env.fs, taskPath);

      if (current.state !== "running" && current.state !== "waiting") {
        throw new RpcError(
          RPC_LIFECYCLE,
          `task.backfillWorkspaceLaneBase requires running|waiting task (state=${current.state})`,
          { taskPath, state: current.state, code: "BASE_BACKFILL_STATE" }
        );
      }

      if (!current.parentActor || !current.reviewer) {
        throw new RpcError(
          RPC_LIFECYCLE,
          "task.backfillWorkspaceLaneBase requires exact persisted parentActor/reviewer",
          { taskPath, code: "BASE_BACKFILL_ACTOR" }
        );
      }
      // Only exact persisted parent/reviewer may authorize (they are equal by invariant).
      const authorized =
        (actor.kind === current.parentActor.kind &&
          actor.id === current.parentActor.id) ||
        (actor.kind === current.reviewer.kind && actor.id === current.reviewer.id);
      if (!authorized) {
        throw new RpcError(
          RPC_LIFECYCLE,
          `task.backfillWorkspaceLaneBase unauthorized actor ${actor.kind}:${actor.id}; ` +
            `requires exact parent/reviewer ${current.parentActor.kind}:${current.parentActor.id}`,
          {
            taskPath,
            actor,
            parentActor: current.parentActor,
            reviewer: current.reviewer,
            code: "BASE_BACKFILL_UNAUTHORIZED",
          }
        );
      }

      const laneComplete = Boolean(
        current.workspace && current.worktree && current.branch && current.targetBranch
      );
      if (!laneComplete) {
        throw new RpcError(
          RPC_LIFECYCLE,
          "task.backfillWorkspaceLaneBase requires recorded workspace/worktree/branch/targetBranch " +
            "(legacy lane must already exist; never invent lane facts)",
          { taskPath, code: "BASE_BACKFILL_LANE_INCOMPLETE" }
        );
      }

      // Validate recorded lane against real Role/Task integration contract.
      let real: RoleWorkspaceContract;
      try {
        real = await resolveIntegrationContract(mount.workspaceRoot, current);
      } catch (err) {
        throw new RpcError(
          RPC_LIFECYCLE,
          err instanceof Error
            ? err.message
            : "task.backfillWorkspaceLaneBase lane/workspace mismatch",
          { taskPath, code: "BASE_BACKFILL_LANE_MISMATCH" }
        );
      }
      // Target branch must exist in the same repo (resolveIntegrationContract already
      // cross-checks envelope vs real; re-verify tip resolvable for fail-loud clarity).
      try {
        await readRoleBranchTip(real.workspace, real.targetBranch);
      } catch (err) {
        throw new RpcError(
          RPC_LIFECYCLE,
          err instanceof Error
            ? `task.backfillWorkspaceLaneBase targetBranch invalid: ${err.message}`
            : "task.backfillWorkspaceLaneBase targetBranch invalid",
          {
            taskPath,
            targetBranch: real.targetBranch,
            code: "BASE_BACKFILL_TARGET",
          }
        );
      }

      // Supplied SHA must be a commit in this repo — never infer from tip/cwd/roleBranchBase.
      let fullBase: string;
      try {
        fullBase = await resolveCommitSha(real.workspace, baseCommitRaw);
      } catch (err) {
        throw new RpcError(
          RPC_LIFECYCLE,
          err instanceof Error
            ? `task.backfillWorkspaceLaneBase baseCommit rejected: ${err.message}`
            : "task.backfillWorkspaceLaneBase baseCommit rejected (foreign/unreachable)",
          {
            taskPath,
            baseCommit: baseCommitRaw,
            code: "BASE_BACKFILL_FOREIGN",
          }
        );
      }

      // Capture-once: when base already exists, same SHA is idempotent; any other
      // resolvable SHA conflicts immediately (do not re-run ancestry as a substitute).
      const existingBase = current.baseCommit?.trim() || "";
      if (existingBase) {
        let existingFull = existingBase;
        try {
          existingFull = await resolveCommitSha(real.workspace, existingBase);
        } catch {
          // Compare raw when existing cannot resolve (still conflict if different).
        }
        if (existingFull === fullBase || existingBase === fullBase) {
          return {
            workspaceId,
            taskPath,
            task: projectTask(current),
            state: current.state,
            baseCommit: existingFull || existingBase,
            idempotent: true,
          };
        }
        throw new RpcError(
          RPC_LIFECYCLE,
          `task.backfillWorkspaceLaneBase conflicts with recorded baseCommit ` +
            `${existingFull || existingBase}; supplied ${fullBase} (capture-once immutable)`,
          {
            taskPath,
            recorded: existingFull || existingBase,
            supplied: fullBase,
            code: "BASE_BACKFILL_CONFLICT",
          }
        );
      }

      // Ancestor of recorded Task branch tip (inclusive: tip itself is legal).
      const branchTip = await readRoleBranchTip(real.workspace, real.branch);
      const isAncestor = await isCommitAncestor(real.workspace, fullBase, branchTip);
      if (!isAncestor) {
        throw new RpcError(
          RPC_LIFECYCLE,
          `task.backfillWorkspaceLaneBase baseCommit ${fullBase} is not an ancestor of ` +
            `recorded Task branch ${real.branch} tip ${branchTip}`,
          {
            taskPath,
            baseCommit: fullBase,
            branch: real.branch,
            branchTip,
            code: "BASE_BACKFILL_NOT_ANCESTOR",
          }
        );
      }
      // Also legal for the recorded target/Role integration lane: must be an ancestor
      // of the resolved targetBranch tip (not only Task branch). A tip exclusive to the
      // executor lane is not a valid workspaceLane.baseCommit for Delivery history.
      const targetTip = await readRoleBranchTip(real.workspace, real.targetBranch);
      const isTargetAncestor = await isCommitAncestor(
        real.workspace,
        fullBase,
        targetTip
      );
      if (!isTargetAncestor) {
        throw new RpcError(
          RPC_LIFECYCLE,
          `task.backfillWorkspaceLaneBase baseCommit ${fullBase} is not an ancestor of ` +
            `recorded targetBranch ${real.targetBranch} tip ${targetTip} ` +
            `(Task-lane-only / foreign to target ancestry)`,
          {
            taskPath,
            baseCommit: fullBase,
            targetBranch: real.targetBranch,
            targetTip,
            branch: real.branch,
            branchTip,
            code: "BASE_BACKFILL_NOT_TARGET_ANCESTOR",
          }
        );
      }

      const now = mount.env.clock.now();
      const patched = await patchTaskEnvelope(mount.env.fs, current.path, {
        baseCommit: fullBase,
        // Keep managed collection baseline once when missing; do not invent from tip.
        ...(current.roleBranchBase?.trim()
          ? {}
          : { roleBranchBase: fullBase }),
        baseCommitCapture: {
          source: "explicit-backfill",
          baseCommit: fullBase,
          actor,
          capturedAt: now,
        },
        updatedAt: now,
      });
      emitTaskState(ctx, workspaceId, patched, "task.backfillWorkspaceLaneBase");
      return {
        workspaceId,
        taskPath,
        task: projectTask(patched),
        state: patched.state,
        baseCommit: fullBase,
        idempotent: false,
      };
    })
  );
}

/**
 * Parse backfill actor: explicit TaskActorRef `{ kind, id }` only.
 * Bare strings are rejected — authority must not be inferred.
 */
function parseBackfillActor(raw: unknown): TaskActorRef {
  if (typeof raw === "string") {
    throw new RpcError(
      -32602,
      "task.backfillWorkspaceLaneBase actor must be { kind, id } (bare string rejected; no kind inference)",
      { code: "BASE_BACKFILL_ACTOR" }
    );
  }
  try {
    return parseTaskActorRef(raw, "parentActor");
  } catch (err) {
    throw new RpcError(
      -32602,
      err instanceof Error
        ? `task.backfillWorkspaceLaneBase actor: ${err.message}`
        : "task.backfillWorkspaceLaneBase requires actor { kind, id }",
      { code: "BASE_BACKFILL_ACTOR" }
    );
  }
}

/**
 * Prepare Role-assignee claim write payload without mutating the envelope.
 * Returns undefined when no lane/base fields need to be written (non-Git / profile /
 * already complete). Throws before Core claim so the Task stays queued on failure.
 * Never writes intermediate lane-only patches.
 */
async function prepareRoleClaimWrite(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<TaskEnvelopePatch | undefined> {
  if (taskAssigneeKind(task) !== "role") return undefined;

  const mount = ctx.host.require(workspaceId);
  if (!(await isGitWorkspace(mount.workspaceRoot))) return undefined;

  // Immutable base already fully audited — nothing extra to write with claim.
  if (task.baseCommit?.trim() && task.baseCommitCapture) return undefined;

  if (!task.parentActor || !task.reviewer) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.claim Role capture requires exact persisted parentActor/reviewer ` +
        `(task ${task.id || task.path})`,
      { taskPath: task.path, code: "BASE_CAPTURE_ACTOR" }
    );
  }

  // Resolve real Role lane (and asSub dispatcher target) without envelope writes.
  let real: RoleWorkspaceContract;
  try {
    let targetBranchHint: string | undefined;
    if (taskAsSub(task)) {
      const dispatcher = taskParentRoleId(task);
      if (!dispatcher) {
        throw new Error(
          `Sub task ${task.id || task.path} is missing a durable parent Role for claim lane bind.`
        );
      }
      const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, dispatcher);
      targetBranchHint = dispatcherLane.branch;
      const recordedTarget = task.targetBranch?.trim();
      if (recordedTarget && recordedTarget !== targetBranchHint) {
        throw new Error(
          `Task envelope targetBranch mismatch for role ${task.role}: ` +
            `envelope=${recordedTarget} expected=${targetBranchHint}`
        );
      }
    }
    // Ensure durable Role worktree/branch exists; do not patch envelope yet.
    const ensured = await ensureRoleWorkspace(mount.workspaceRoot, task.role);
    // Build a transient view for integration contract validation (no disk write).
    const view: TaskEnvelope = {
      ...task,
      workspace: task.workspace || ensured.workspace,
      worktree: task.worktree || ensured.worktree,
      branch: task.branch || ensured.branch,
      targetBranch: task.targetBranch || targetBranchHint || ensured.targetBranch,
    };
    real = await resolveIntegrationContract(mount.workspaceRoot, view);
  } catch (err) {
    throw new RpcError(
      RPC_LIFECYCLE,
      err instanceof Error
        ? `task.claim Role lane prepare failed: ${err.message}`
        : "task.claim Role lane prepare failed",
      { taskPath: task.path, code: "BASE_CAPTURE_LANE" }
    );
  }

  const now = mount.env.clock.now();
  const patch: TaskEnvelopePatch = {
    workspace: real.workspace,
    worktree: real.worktree,
    branch: real.branch,
    targetBranch: real.targetBranch,
    updatedAt: now,
  };

  // Existing base is immutable: never re-read tip. Only attach missing audit.
  // Must resolve as a real commit in the lane repo — never persist raw unverified
  // SHA under first-claim audit.
  const existingBase = task.baseCommit?.trim() || "";
  if (existingBase) {
    let fullExisting: string;
    try {
      fullExisting = await resolveCommitSha(real.workspace, existingBase);
    } catch (err) {
      throw new RpcError(
        RPC_LIFECYCLE,
        err instanceof Error
          ? `task.claim Role baseCommit unresolvable in lane repo: ${err.message}`
          : "task.claim Role baseCommit unresolvable in lane repo",
        {
          taskPath: task.path,
          baseCommit: existingBase,
          code: "BASE_CAPTURE_UNRESOLVED",
        }
      );
    }
    patch.baseCommit = fullExisting;
    if (!task.baseCommitCapture) {
      patch.baseCommitCapture = {
        source: "first-claim",
        baseCommit: fullExisting,
        actor: task.parentActor,
        capturedAt: now,
      };
    }
    return patch;
  }

  // Capture-once tip of the real Role branch at claim prepare — never rewrite later.
  const tip =
    typeof real.baseCommit === "string" && real.baseCommit.trim()
      ? real.baseCommit.trim()
      : await readRoleBranchTip(real.workspace, real.branch);
  const fullTip = await resolveCommitSha(real.workspace, tip);
  patch.baseCommit = fullTip;
  if (!task.roleBranchBase?.trim()) {
    patch.roleBranchBase = fullTip;
  }
  patch.baseCommitCapture = {
    source: "first-claim",
    baseCommit: fullTip,
    actor: task.parentActor,
    capturedAt: now,
  };
  if (!task.integrationAuthority) {
    patch.integrationAuthority = deriveIntegrationAuthority({
      parentActor: task.parentActor,
      reviewer: task.reviewer,
    });
  }
  return patch;
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
 *
 * **Ordering with Delivery:** task-state validation + durable TaskInput.add run on
 * the same workspace MutationBus as task.deliver publish. Honest either-way races:
 * input first → Delivery gate blocks; Delivery first → sendInput rechecks state and
 * refuses (cannot slip a pending row between final gate and taskDeliver). Background
 * inject is scheduled only after durable accept, outside the mutation.
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
  // Outside the mutation bus (machine-local ask store; not Delivery publish authority).
  const pendingAsk = await ctx.userAsks.getPendingForTask(workspaceId, taskPath);
  if (pendingAsk) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Task has a pending UserAsk (${pendingAsk.id}); use userAsk.reply instead of task.sendInput`,
      { askId: pendingAsk.id, workspaceId, taskPath }
    );
  }

  // Per-Task lifecycle flight + MutationBus: wait out same-Task accept/auto-deliver
  // Git windows, then re-read state so sendInput cannot slip past auto-deliver.
  const { current, input } = await runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
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
    return { current, input };
  }));

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
  // per-task FIFO in the background — outside the mutation after durable add.
  // RPC must not await the full Agent turn (CLI false timeouts).
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

/** Test-only hold gate for managed U2A FIFO race coverage (replaceSession). */
const managedTaskInputQueueHoldForTests = new Map<
  string,
  { wait: Promise<void>; notifyEntered: () => void }
>();

/** Prefer Task binding, then row, then override — never a stale pre-replace capture. */
async function resolveManagedInjectSessionId(
  ctx: HandlerContext,
  latest: TaskInputRecord,
  opts?: { sessionIdOverride?: string }
): Promise<string | undefined> {
  try {
    const mount = ctx.host.get(latest.workspaceId);
    if (mount) {
      const bound = (await loadTaskEnvelope(mount.env.fs, latest.taskPath)).sessionId?.trim();
      if (bound) return bound;
    }
  } catch { /* fall through */ }
  return latest.sessionId?.trim() || opts?.sessionIdOverride?.trim() || undefined;
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
 * Shared U2A delivery for managed ACP / external pending.
 * Authoritative inject session is derived inside the per-task FIFO (Task binding
 * wins). Pre-replace workers must never rebind/inject a retired session.
 */
async function deliverManagedTaskInput(
  ctx: HandlerContext,
  item: TaskInputRecord,
  opts?: { sessionIdOverride?: string }
): Promise<ManagedTaskInputDelivery> {
  const queueKey = managedTaskInputQueueKey(item.workspaceId, item.taskPath);
  return managedTaskInputQueue.run(queueKey, async () => {
    const hold = managedTaskInputQueueHoldForTests.get(queueKey);
    if (hold) {
      hold.notifyEntered();
      await hold.wait;
    }

    let latest = await ctx.taskInputs.get(item.id, item.workspaceId, item.taskPath);
    if (!latest) {
      return {
        input: item,
        continued: false,
        continueError: `TaskInput disappeared before managed inject: ${item.id}`,
      };
    }
    if (latest.status !== "pending" && latest.status !== "failed") {
      return {
        input: latest,
        continued: latest.status === "delivered" || latest.status === "uncertain",
        continueError: `TaskInput already ${latest.status}; skip managed inject`,
      };
    }

    let sessionId = await resolveManagedInjectSessionId(ctx, latest, opts);
    if (!sessionId) return { input: latest, continued: false };

    const failRebind = async (prefix: string, err: unknown): Promise<ManagedTaskInputDelivery> => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        latest = await ctx.taskInputs.markFailed(latest!.id, `${prefix}: ${message}`, "service");
      } catch {
        /* keep prior */
      }
      return { input: latest!, continued: false, continueError: `${prefix}: ${message}` };
    };

    if ((latest.sessionId?.trim() || "") !== sessionId) {
      try {
        latest = await ctx.taskInputs.rebindSession(
          latest.id,
          latest.workspaceId,
          latest.taskPath,
          sessionId
        );
      } catch (err) {
        return failRebind("TaskInput rebind to inject session failed", err);
      }
    }

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

    // Re-derive after claim: replace may have rebound Task+row while we waited.
    latest =
      (await ctx.taskInputs.get(latest.id, latest.workspaceId, latest.taskPath)) ?? latest;
    sessionId = (await resolveManagedInjectSessionId(ctx, latest, opts)) || sessionId;
    if ((latest.sessionId?.trim() || "") && latest.sessionId!.trim() !== sessionId) {
      try {
        const rows = await ctx.taskInputs.rebindOpenSessions(
          latest.workspaceId,
          latest.taskPath,
          sessionId,
          [latest.id]
        );
        latest = rows[0] ?? latest;
      } catch (err) {
        return failRebind("TaskInput inject session drift rebind failed", err);
      }
    }

    const forInject: TaskInputRecord = { ...latest, sessionId };

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
          // prompt_complete is projected asynchronously. It may already have
          // preserved a report draft and failed its pre-seal gate while this row
          // was still processing. Retry from that durable draft after the input
          // is terminal; never prompt the provider a second time.
          try {
            await requestManagedAutoDeliverRetryFromDraft(ctx, {
              workspaceId: forInject.workspaceId,
              taskPath: forInject.taskPath,
              sessionId,
            });
          } catch {
            // TaskInput delivery is already authoritative. Auto-delivery keeps
            // its own durable draft + diagnostics and remains independently retryable.
          }
        } catch (err) {
          // Provider already accepted the inject — never markFailed (that would
          // re-open the retry source and risk a second inject).
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
            // Uncertain is at-most-once but now remains a Delivery blocker.
            // Keep the durable report draft parked until an authorized
            // taskInput.ack explicitly acknowledges the ambiguity.
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
  managedTaskInputQueueHoldForTests.clear();
  void managedTaskInputQueue;
}

/** Hold next managed U2A FIFO worker after queue entry (replaceSession race tests). */
export function holdManagedTaskInputQueueForTests(
  workspaceId: string,
  taskPath: string
): { entered: Promise<void>; release: () => void } {
  const key = managedTaskInputQueueKey(workspaceId, taskPath);
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  let notifyEntered!: () => void;
  const entered = new Promise<void>((r) => { notifyEntered = r; });
  managedTaskInputQueueHoldForTests.set(key, { wait, notifyEntered });
  return {
    entered,
    release: () => { managedTaskInputQueueHoldForTests.delete(key); release(); },
  };
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
 * Shared authority: any TaskInput still pending, processing, failed, or
 * uncertain on this task blocks a ready Delivery. Same check for public
 * task.deliver / task.requestReview and managed auto-deliver.
 *
 * Uncertain is at-most-once and never re-injected, but blocks until explicit
 * acknowledgement. delivered / consumed / cancelled rows do not block.
 * Does not invent a unified Pending domain — reads TaskInputStore only.
 */
async function assertNoBlockingTaskInputsForDeliver(
  ctx: HandlerContext,
  workspaceId: string,
  task: { path: string; id?: string; state: string }
): Promise<void> {
  const blockers = await ctx.taskInputs.listBlockingForDeliver(
    workspaceId,
    task.path
  );
  if (blockers.length === 0) return;
  // Stable order for UI invalidation (createdAt ASC, then id).
  const ordered = [...blockers].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  const first = ordered[0]!;
  throw new RpcError(
    RPC_LIFECYCLE,
    `task.deliver refused: task has ${ordered.length} open TaskInput(s) ` +
      `(first ${first.id} status=${first.status}); consume or resolve them before Delivery ` +
      `(task remains ${task.state}, no ready Delivery)`,
    {
      code: "PENDING_TASK_INPUT",
      taskPath: task.path,
      ...(task.id ? { taskId: task.id } : {}),
      count: ordered.length,
      inputIds: ordered.map((i) => i.id),
      statuses: ordered.map((i) => i.status),
      firstInputId: first.id,
      firstStatus: first.status,
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
    const parentRole = taskParentRoleId(task);
    if (parentRole) {
      targetBranch = (await ensureRoleWorkspace(mountedRoot, parentRole)).branch;
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

/**
 * Pre-ready Delivery history gate for ordinary executor lanes (cx-5q6za6).
 *
 * Under the Task lifecycle boundary (public deliver / managed auto-deliver),
 * Service obtains actual `git rev-list --parents --reverse base..tip` and
 * invokes the pure Core assert. Commit facts never come from executor/prompt.
 *
 * recorded workspaceLane.baseCommit (exact) must be first parent of first Task
 * commit; base..tip single-parent linear. Unauthorized merge/foreign ancestry
 * fails loud while preserving lane/audit — no ready Delivery.
 * No generic allowMerge; parent accept + Service integration only.
 *
 * - Docs-only / non-Git / no recorded executor branch → pass through.
 * - Ordinary code-task lane (branch recorded) without exact baseCommit → fail
 *   loud (never silently substitute roleBranchBase at Delivery).
 */
async function assertOrdinaryExecutorLaneHistoryForDeliver(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<void> {
  const branch = task.branch?.trim() || "";
  const hasExecutorLane = Boolean(
    branch || task.worktree?.trim() || task.workspace?.trim()
  );
  // No executor Git lane recorded → not an ordinary code-task Delivery path.
  if (!hasExecutorLane) return;
  if (!(await isGitWorkspace(workspaceRoot))) return;

  const base = task.baseCommit?.trim() || "";
  // Exact baseCommit required for ordinary code-task Delivery. No roleBranchBase
  // silent substitution — legacy envelopes need explicit migration / re-bind.
  if (!base) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.deliver refused: ordinary executor lane requires exact workspaceLane.baseCommit ` +
        `(recorded at Task worktree creation); roleBranchBase is not a Delivery substitute ` +
        `(task remains ${task.state}, no ready Delivery; lane/audit preserved)`,
      {
        code: "EXECUTOR_LANE_HISTORY",
        historyCode: "MISSING_BASE",
        taskPath: task.path,
        taskId: task.id,
        branch: branch || undefined,
      }
    );
  }
  if (!branch) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.deliver refused: ordinary executor lane missing branch for history tip ` +
        `(task remains ${task.state}, no ready Delivery; lane/audit preserved)`,
      {
        code: "EXECUTOR_LANE_HISTORY",
        historyCode: "MISSING_TIP",
        taskPath: task.path,
        taskId: task.id,
        baseCommit: base,
      }
    );
  }
  try {
    // Service-side git rev-list --parents --reverse under lifecycle boundary.
    await assertOrdinaryExecutorLaneHistoryInGit({
      workspace: workspaceRoot,
      baseCommit: base,
      branch,
    });
  } catch (err) {
    if (err instanceof ExecutorLaneHistoryError) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.deliver refused: ordinary executor lane history gate failed (${err.code}): ${err.message} ` +
          `(task remains ${task.state}, no ready Delivery; lane/audit preserved)`,
        {
          code: "EXECUTOR_LANE_HISTORY",
          historyCode: err.code,
          taskPath: task.path,
          taskId: task.id,
          baseCommit: base,
          branch,
          ...(err.details ?? {}),
        }
      );
    }
    throw err;
  }
}

/**
 * Public task.deliver commits[] membership: each SHA must resolve as a commit
 * object in exact recorded baseCommit..refs/heads/<task branch> and be reachable
 * from that branch. Empty commits[] is a no-op (docs / managed auto-collect).
 * Fail-loud before ready Delivery; Git untouched.
 */
async function assertDeliverCommitsBelongToExecutorLane(
  workspaceRoot: string,
  task: TaskEnvelope,
  commits: string[] | undefined
): Promise<void> {
  const refs = uniqueCommitRefs(commits);
  if (refs.length === 0) return;

  const branch = task.branch?.trim() || "";
  const hasExecutorLane = Boolean(
    branch || task.worktree?.trim() || task.workspace?.trim()
  );
  // No executor Git lane → not an ordinary code-task Delivery path; membership N/A.
  if (!hasExecutorLane) return;
  if (!(await isGitWorkspace(workspaceRoot))) return;

  const base = task.baseCommit?.trim() || "";
  if (!base) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.deliver refused: commits[] require exact workspaceLane.baseCommit ` +
        `(task remains ${task.state}, no ready Delivery; lane/audit preserved; Git untouched)`,
      {
        code: "DELIVER_COMMIT_LANE",
        laneCode: "MISSING_BASE",
        taskPath: task.path,
        taskId: task.id,
        branch: branch || undefined,
      }
    );
  }
  if (!branch) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.deliver refused: commits[] require recorded executor branch ` +
        `(task remains ${task.state}, no ready Delivery; lane/audit preserved; Git untouched)`,
      {
        code: "DELIVER_COMMIT_LANE",
        laneCode: "MISSING_BRANCH",
        taskPath: task.path,
        taskId: task.id,
        baseCommit: base,
      }
    );
  }

  try {
    await assertDeliverCommitsInExecutorLane({
      workspace: workspaceRoot,
      baseCommit: base,
      branch,
      commits: refs,
    });
  } catch (err) {
    if (err instanceof DeliverCommitLaneError) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.deliver refused: commits[] not in executor lane (${err.code}): ${err.message} ` +
          `(task remains ${task.state}, no ready Delivery; Git untouched)`,
        {
          code: "DELIVER_COMMIT_LANE",
          laneCode: err.code,
          taskPath: task.path,
          taskId: task.id,
          baseCommit: base,
          branch,
          ...(err.details ?? {}),
        }
      );
    }
    throw err;
  }
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

  // Per-Task flight spans prepare → Git → finalize; MutationBus only around prepare/finalize.
  const result = await runTaskLifecycle(workspaceId, taskPath, async () => {
    let targetHead: string | undefined;
    const prepared = await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
      // Fail-loud authority: do not honor caller "I'm done" while the managed
      // turn is still busy (tools/write/commit may still race). Task stays
      // running; no ready Delivery is published.
      await assertManagedTurnIdleForPublicDeliver(ctx, taskForIntegrate);
      // Open TaskInput (pending/processing/retryable failed) must be consumed first.
      await assertNoBlockingTaskInputsForDeliver(ctx, workspaceId, taskForIntegrate);
      // Same gate for public deliver: dirty task worktree must not publish stale commits.
      await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, taskForIntegrate);
      // Ordinary executor lane: linear single-parent history from recorded base (cx-5q6za6).
      await assertOrdinaryExecutorLaneHistoryForDeliver(mount.workspaceRoot, taskForIntegrate);
      // Public commits[] must resolve as commit objects in exact base..task-branch range.
      await assertDeliverCommitsBelongToExecutorLane(
        mount.workspaceRoot,
        taskForIntegrate,
        commits
      );
      const pendingCommits = uniqueCommitRefs(commits);
      // Commit-bearing Deliveries durably snapshot resolved target HEAD at review time.
      targetHead =
        pendingCommits.length > 0
          ? await snapshotIntegrationTargetHead(mount.workspaceRoot, taskForIntegrate)
          : undefined;
      if (targetHead && afterTargetHeadSnapshotForTests) {
        await afterTargetHeadSnapshotForTests(mount.workspaceRoot);
      }
      return prepareTaskDeliver(mount.env, taskPath, {
        summary,
        commits,
        ...(targetHead ? { targetHead } : {}),
        checks,
        artifactRefs,
        decision,
      });
    });
    if (prepared.kind === "done") return prepared.result;
    const pendingCommits = uniqueCommitRefs(commits);
    if (pendingCommits.length > 0) {
      const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
      await makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate, {
        expectedTargetHead: targetHead,
        action: "task.deliver",
        taskPath,
      })(pendingCommits);
    }
    return ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      return finalizeTaskDeliverAuto(
        mount.env,
        taskPath,
        {
          summary,
          commits,
          ...(targetHead ? { targetHead } : {}),
          checks,
          artifactRefs,
          decision,
        },
        prepared
      );
    });
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
  // Auto-integrate policies land in accepted; reclaim only after session settle.
  if (result.task.state === "accepted") {
    await maybeAutoReclaimTaskWorktree(ctx, workspaceId, result.task, "task.deliver");
  }
  return {
    workspaceId,
    taskPath,
    task: projectTask(result.task),
    delivery: projectDelivery(result.delivery),
    autoIntegrated: result.autoIntegrated,
    state: result.task.state,
  };
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
  const outputNodeIds = optionalStringArray(p, "outputNodeIds");

  const acceptOptions = { actor, commits, outputNodeIds };
  // Per-Task flight spans prepare → Git → finalize; MutationBus only around prepare/finalize.
  const result = await runTaskLifecycle(workspaceId, taskPath, async () => {
    let prepared: Awaited<ReturnType<typeof prepareTaskAccept>>;
    let expectedTargetHead: string | undefined;
    try {
      prepared = await ctx.mutations.run(workspaceId, async () => {
        ctx.host.markSelfWrite(workspaceId);
        const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
        // Review-time target HEAD lives on the ready Delivery; missing → TARGET_MOVED at integrate.
        expectedTargetHead = await loadReadyDeliveryTargetHead(
          mount.env.fs,
          taskForIntegrate
        );
        return prepareTaskAccept(mount.env, taskPath, acceptOptions);
      });
    } catch (err) {
      if (err instanceof OutputProvenanceError) throw outputProvenanceErrorToRpc(err);
      throw err;
    }
    if (prepared.commits.length > 0) {
      // Core requires integrate whenever delivery commits are non-empty.
      // Failure must not reach accepted/done/occupation release (lifecycle orders integrate first).
      // Integrator re-resolves target HEAD vs Delivery.targetHead before any Git write.
      const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
      await makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate, {
        expectedTargetHead,
        action: "task.accept",
        taskPath,
      })(prepared.commits);
    }
    try {
      return await ctx.mutations.run(workspaceId, async () => {
        ctx.host.markSelfWrite(workspaceId);
        return finalizeTaskAccept(mount.env, taskPath, acceptOptions, prepared);
      });
    } catch (err) {
      if (err instanceof OutputProvenanceError) throw outputProvenanceErrorToRpc(err);
      throw err;
    }
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
  const acceptNodeIds =
    result.task.contextCard != null ? taskReferencedNodeIds(result.task) : [];
  for (const nodeId of acceptNodeIds) {
    if (nodeId === "root") continue;
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: nodeId, reason: "task.accept-projection" },
      "self"
    );
  }
  // Output provenance bind invalidation: only Outputs that newly wrote deliveryId.
  for (const outputId of result.changedOutputIds) {
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: outputId, reason: "output.provenance-bind" },
      "self"
    );
  }
  // Terminal accepted + integrate complete → best-effort Task worktree reclaim.
  await maybeAutoReclaimTaskWorktree(ctx, workspaceId, result.task, "task.accept");
  return {
    workspaceId,
    taskPath,
    task: projectTask(result.task),
    delivery: projectDelivery(result.delivery),
    state: result.task.state,
    boundOutputIds: result.boundOutputIds,
    changedOutputIds: result.changedOutputIds,
  };
}

/**
 * V0.2 Output provenance read: Output → Delivery → Task → sourceNode by id.
 * Unbound type=output is legal (bound:false). Archived Output still readable.
 */
async function outputProvenanceRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<OutputProvenance> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const id =
    optionalString(p, "id") ?? optionalString(p, "outputId") ?? optionalString(p, "boxId");
  const path = optionalString(p, "path");
  if (!id && !path) {
    throw new RpcError(-32602, "output.provenance requires id, outputId, or path");
  }
  try {
    const projected = await resolveOutputProvenance(mount.env.fs, { id, path, outputId: id });
    return projectOutputProvenanceWire(workspaceId, projected);
  } catch (err) {
    if (err instanceof OutputProvenanceError) throw outputProvenanceErrorToRpc(err);
    throw err;
  }
}

function projectOutputProvenanceWire(
  workspaceId: string,
  core: CoreOutputProvenance
): OutputProvenance {
  return {
    workspaceId,
    outputId: core.outputId,
    path: core.path,
    bound: core.bound,
    deliveryId: core.deliveryId,
    delivery: core.delivery,
    task: core.task,
    sourceNode: core.sourceNode,
    incomplete: core.incomplete,
  };
}

function outputProvenanceErrorToRpc(err: OutputProvenanceError): RpcError {
  switch (err.code) {
    case "OUTPUT_NOT_FOUND":
      return new RpcError(-32004, err.message, err.details);
    case "INVALID_SELECTOR":
      return new RpcError(-32602, err.message, err.details);
    case "OUTPUT_INVALID":
    case "OUTPUT_ARCHIVED":
    case "OUTPUT_NOT_OUTPUT_TYPE":
    case "OUTPUT_ALREADY_BOUND":
    case "INVALID_DELIVERY_ID":
    case "BIND_ROLLBACK_FAILED":
      return new RpcError(-32010, err.message, { code: err.code, ...err.details });
    default:
      return new RpcError(-32010, err.message, { code: err.code, ...err.details });
  }
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

  // Per-Task lifecycle flight + MutationBus: wait out same-Task accept mid-Git.
  // Managed session restore happens after so runtime never nests inside either lock.
  const result = await runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
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
  }));

  // Terminal reject: collaboration only; no session restore / no review U2A.
  if (!resume) {
    await maybeAutoReclaimTaskWorktree(ctx, workspaceId, result.task, "task.reject");
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

  const result = await runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
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
    return {
      workspaceId,
      taskPath,
      task: projectTask(task),
      state: task.state,
      /** Pre-interrupt envelope for worktree reclaim when file was deleted (queued). */
      reclaimSource: before ?? task,
    };
  }));
  // interrupted is terminal: reclaim temporary Task lanes when clean/unambiguous.
  if (result.reclaimSource) {
    await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      { ...result.reclaimSource, state: "interrupted" },
      "task.interrupt"
    );
  }
  return {
    workspaceId: result.workspaceId,
    taskPath: result.taskPath,
    task: result.task,
    state: result.state,
  };
}

async function taskCancelRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  const result = await runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
    const before = await loadTaskEnvelope(mount.env.fs, taskPath).catch(() => null);
    ctx.host.markSelfWrite(workspaceId);
    await taskCancel(mount.env, taskPath);
    ctx.events.emit(
      "task.state",
      workspaceId,
      { path: taskPath, state: "interrupted", reason: "task.cancel" },
      "self"
    );
    return {
      workspaceId,
      taskPath,
      state: "interrupted" as const,
      cancelled: true as const,
      before,
    };
  }));
  if (result.before) {
    await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      { ...result.before, state: "interrupted" },
      "task.cancel"
    );
  }
  return {
    workspaceId: result.workspaceId,
    taskPath: result.taskPath,
    state: result.state,
    cancelled: result.cancelled,
  };
}

/**
 * A2A gate → AgentRuntimePort.startSession → bind task.sessionId only.
 * Shares authorized per-Task managed-session flight with task.replaceSession.
 * Usable bound Session reuses without launch unless a flight is already held.
 */
async function taskStartSessionRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const taskPath = requireString(p, "taskPath");
  const profileId = requireProfileId(p);
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }

  const prepared = await prepareAuthorizedTaskStartSession(
    ctx,
    p,
    workspaceId,
    taskPath,
    profileId,
    callerKind
  );
  if (prepared.kind === "reuse") {
    const existing = managedSessionInFlight.get(managedSessionFlightKey(workspaceId, taskPath));
    if (existing) {
      return joinOrConflictManagedSessionFlight(existing, profileId, "startSession", taskPath);
    }
    return runTaskLifecycle(workspaceId, taskPath, async () => {
      const mount = ctx.host.require(workspaceId);
      const current = await loadTaskEnvelope(mount.env.fs, taskPath);
      const sessionId = prepared.result.session.sessionId;
      if (
        (current.state !== "running" && current.state !== "waiting") ||
        current.sessionId !== sessionId
      ) {
        throw new RpcError(
          RPC_LIFECYCLE,
          "task.startSession: Task changed before same-Task Session reuse could return",
          {
            code: "TASK_SESSION_BIND_CAS_FAILED",
            taskPath,
            sessionId,
            state: current.state,
            currentSessionId: current.sessionId,
          }
        );
      }
      const session = await ctx.runtime.registry.read(sessionId);
      if (!session) {
        throw new RpcError(RPC_LIFECYCLE, `task.startSession: bound Session ${sessionId} disappeared`, {
          code: "BOUND_SESSION_MISSING",
          taskPath,
          sessionId,
        });
      }
      return projectStartSessionResult(workspaceId, taskPath, current, session, {
        cwd: current.worktree || mount.workspaceRoot,
      });
    });
  }

  return runManagedSessionFlight(workspaceId, taskPath, profileId, "startSession", () =>
    launchAndBindTaskStartSession(ctx, prepared)
  );
}

type TaskSessionBindSnapshot = {
  taskId: string | undefined;
  state: TaskEnvelope["state"];
  sessionId: string;
  updatedAt: string | undefined;
  role: string;
  assigneeKind: ReturnType<typeof taskAssigneeKind>;
};

function captureTaskSessionBindSnapshot(task: TaskEnvelope): TaskSessionBindSnapshot {
  return {
    taskId: task.id,
    state: task.state,
    sessionId: task.sessionId?.trim() || "",
    updatedAt: task.updatedAt,
    role: task.role,
    assigneeKind: taskAssigneeKind(task),
  };
}

function assertTaskSessionBindSnapshot(
  operation: "task.startSession" | "task.replaceSession",
  taskPath: string,
  current: TaskEnvelope,
  expected: TaskSessionBindSnapshot
): void {
  const actual = captureTaskSessionBindSnapshot(current);
  const unchanged =
    actual.taskId === expected.taskId &&
    actual.state === expected.state &&
    actual.sessionId === expected.sessionId &&
    actual.updatedAt === expected.updatedAt &&
    actual.role === expected.role &&
    actual.assigneeKind === expected.assigneeKind;
  if (unchanged && current.state === "running") return;
  throw new RpcError(
    RPC_LIFECYCLE,
    `${operation}: Task changed while the managed Session was starting; refusing late bind`,
    {
      code: "TASK_SESSION_BIND_CAS_FAILED",
      taskPath,
      expected,
      actual,
    }
  );
}

function isTaskSessionBindCasError(err: unknown): boolean {
  return (
    err instanceof RpcError &&
    (err.data as { code?: string } | undefined)?.code === "TASK_SESSION_BIND_CAS_FAILED"
  );
}

async function stopUnboundManagedSession(
  ctx: HandlerContext,
  sessionId: string,
  operation: "task.startSession" | "task.replaceSession",
  detail: string
): Promise<boolean> {
  let stopped = true;
  try {
    await ctx.runtime.stopSession(sessionId, "interrupt");
  } catch {
    stopped = false;
  }
  try {
    await ctx.runtime.registry.update(sessionId, {
      lastError: `${operation} unbound Session cleanup: ${detail}`,
      ...(stopped ? { state: "stopped", stopReason: "interrupt" } : {}),
    });
  } catch {
    // Registry cleanup projection is best-effort; mount reconciliation remains authoritative.
  }
  return stopped;
}

type PreparedTaskStartSession =
  | { kind: "reuse"; result: ReturnType<typeof projectStartSessionResult> }
  | {
      kind: "launch";
      workspaceId: string;
      taskPath: string;
      profileId: string;
      task: TaskEnvelope;
      isProfileTask: boolean;
      bootstrapPrompt?: string;
    };

/**
 * Per-caller authorization + task-state preparation for startSession.
 * Must run before any provider-launch flight join/coalesce.
 */
async function prepareAuthorizedTaskStartSession(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  workspaceId: string,
  taskPath: string,
  profileId: string,
  callerKind: "user" | "role",
  opts?: {
    operation?: "startSession" | "replaceSession";
    /** A2A/approval only — no claim, wait-resume, or session reuse (replaceSession). */
    skipReuseAndLaunchPrep?: boolean;
  }
): Promise<PreparedTaskStartSession> {
  const mount = ctx.host.require(workspaceId);
  const bootstrapPrompt = optionalString(p, "bootstrapPrompt");
  const approvalId = optionalString(p, "approvalId");
  const operation = opts?.operation ?? "startSession";
  const verbLabel = operation === "replaceSession" ? "replaceSession" : "startSession";

  // Resolve prior ask approval.
  // User approval may override ordinary a2aPolicy gates (task-api §4).
  // Role-agent standing roster paths never enter this approval branch.
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
    const taskAgentId =
      typeof taskForPolicy.agentId === "string" ? taskForPolicy.agentId.trim() : "";
    // Role-agent Tasks (persisted agentId): roster membership is standing authorization.
    // Out-of-roster fails loud; in-roster proceeds. Never create A2A ask approvals.
    // Do not re-infer Role authorization from profileId history.
    if (callerKind === "role" && taskAgentId) {
      const authorityRole = resolveA2AAuthorityRole(taskForPolicy, callerKind);
      await assertRoleRosterStandingAuth(ctx, mount.env.fs, {
        dispatcher: authorityRole,
        agentId: taskAgentId,
        profileId,
        requireBoundProfileMatch: true,
      });
      // Standing auth satisfied — skip a2aPolicy ask/deny for this path.
    } else {
      // A2A authority: user is root. Role callers without Task.agentId use parent Role
      // for sub tasks (role or profile assignee) and for peer agentProfile tasks;
      // peer role tasks use task.role. Durable Role self-launch and user-direct
      // profile one-shots still consult a2aPolicy.
      const authorityRole = resolveA2AAuthorityRole(taskForPolicy, callerKind);
      const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
        callerKind,
        taskRole: authorityRole,
        requireRegisteredRole:
          callerKind === "role" &&
          (taskParentIsRole(taskForPolicy) ||
            taskAsSub(taskForPolicy) ||
            taskAssigneeKind(taskForPolicy) === "agentProfile"),
      });
      // User root bypasses policy + roster.
      // Role + allow: explicit agentId param or unique roster binding for profileId.
      // Role + ask: park for user approval (no roster check).
      // Role + deny: A2A_DENIED.
      const profileAllowed =
        callerKind === "user"
          ? true
          : await resolveRoleLaunchAllowed(ctx, mount.env.fs, {
              taskRole: authorityRole,
              profileId,
              agentId: optionalString(p, "agentId"),
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
          agentId: optionalString(p, "agentId") || taskForPolicy.agentId,
          profileAllowed,
          reason: profileAllowed ? "a2a_policy" : "out_of_roster",
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
            summary: `Role ${authorityRole || task.role} requests ${verbLabel} on profile ${profileId}`,
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
        throw new RpcError(
          RPC_A2A_ASK,
          `A2A policy requires user approval before ${verbLabel}`,
          {
            approvalId: item.id,
            policy: "ask",
          }
        );
      }
    } // end non-Role-agent A2A path
  }

  let task = await loadTaskEnvelope(mount.env.fs, taskPath);

  // replaceSession: A2A only — eligibility/launch owned by executeTaskReplaceSession.
  if (opts?.skipReuseAndLaunchPrep) {
    return {
      kind: "launch",
      workspaceId,
      taskPath,
      profileId,
      task,
      isProfileTask: taskAssigneeKind(task) === "agentProfile",
      bootstrapPrompt,
    };
  }

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

  // Same-Task alive idempotency only — NOT cross-Task continuity.
  // When an active Session is already bound to this Task, return it only if live
  // contextGeneration still matches; otherwise fail loud (cannot safely start fresh
  // while the turn/session is active).
  const isProfileTask = taskAssigneeKind(task) === "agentProfile";
  const callerBootstrapAppend = bootstrapPrompt; // never replaces managed bootstrap

  async function assertAliveSessionLiveGenerationOrFail(
    activeRec: import("../runtime/types.js").SessionRecord
  ): Promise<void> {
    const profile = ctx.profileCatalog.get(profileId);
    if (!profile?.adapterId) {
      throw new RpcError(
        -32602,
        `task.startSession cannot verify live contextGeneration: profile ${profileId} missing or has no adapterId`,
        { profileId, code: "CONTEXT_GENERATION_COLLECT_FAILED" }
      );
    }
    let live: StableContextGenerationBundle;
    try {
      live = await collectStableContextGeneration({
        workspaceRoot: mount.workspaceRoot,
        workspaceIdentity: workspaceId,
        packageRoot: ctx.packageRoot,
        packageVersion: ctx.version,
        assigneeKind: taskAssigneeKind(task),
        assigneeLabel: task.role,
        agentId: typeof task.agentId === "string" ? task.agentId : undefined,
        profileId,
        adapterId: profile.adapterId,
        parentRoleId:
          task.parentActor?.kind === "role" ? task.parentActor.id : undefined,
        purpose: readTaskPurpose(task) || undefined,
        roleFs: mount.env.fs,
        profile,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(
        -32000,
        `task.startSession live contextGeneration collection failed: ${message}`,
        { code: "CONTEXT_GENERATION_COLLECT_FAILED", taskPath, profileId }
      );
    }
    // Empty/legacy generation does not prove continuity — only non-empty exact match.
    const sessionGen = activeRec.contextGeneration?.trim() || "";
    if (!sessionGen || sessionGen !== live.contextGeneration) {
      const emptyOrLegacy = !sessionGen;
      throw new RpcError(
        RPC_LIFECYCLE,
        emptyOrLegacy
          ? `Active managed session ${activeRec.id} has empty/legacy contextGeneration; ` +
              `cannot prove continuity with live stable facts (live=${live.contextGeneration}). ` +
              `Stop/replace the Session first.`
          : `Active managed session ${activeRec.id} contextGeneration drifted from live stable facts ` +
              `(session=${sessionGen}, live=${live.contextGeneration}); cannot safely start a fresh ` +
              `Session while the prior turn/session is active. Stop/replace the Session first.`,
        {
          code: emptyOrLegacy
            ? "CONTEXT_GENERATION_EMPTY_ACTIVE"
            : "CONTEXT_GENERATION_LIVE_DRIFT_ACTIVE",
          sessionId: activeRec.id,
          sessionContextGeneration: sessionGen || null,
          liveContextGeneration: live.contextGeneration,
          taskPath,
        }
      );
    }
  }

  if (!isProfileTask) {
    const activeForRole = await findActiveManagedSessionForRole(ctx, workspaceId, task.role);
    if (activeForRole) {
      const boundToThisTask =
        task.sessionId === activeForRole.id ||
        (!!task.id && activeForRole.lastTaskId === task.id) ||
        activeForRole.lastTaskId === taskPath;
      if (boundToThisTask) {
        await assertAliveSessionLiveGenerationOrFail(activeForRole);
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
        return {
          kind: "reuse",
          result: projectStartSessionResult(workspaceId, taskPath, boundTask, activeForRole, {
            cwd: boundTask.worktree || mount.workspaceRoot,
          }),
        };
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
    // Profile task same-Task alive idempotency only.
    const prior = await ctx.runtime.registry.read(task.sessionId);
    if (prior && SessionRegistry.isNonTerminal(prior.state) && prior.state !== "external") {
      await assertAliveSessionLiveGenerationOrFail(prior);
      return {
        kind: "reuse",
        result: projectStartSessionResult(workspaceId, taskPath, task, prior, {
          cwd: task.worktree || mount.workspaceRoot,
        }),
      };
    }
  }

  return {
    kind: "launch",
    workspaceId,
    taskPath,
    profileId,
    task,
    isProfileTask,
    // Caller text is an optional dynamic append only — never the managed bootstrap itself.
    bootstrapPrompt: callerBootstrapAppend,
  };
}

/**
 * Provider launch + envelope sessionId bind. Only reached after per-caller
 * authorization and (for concurrent callers) after joining the task flight.
 */
async function launchAndBindTaskStartSession(
  ctx: HandlerContext,
  prepared: Extract<PreparedTaskStartSession, { kind: "launch" }>
) {
  const { workspaceId, taskPath, profileId } = prepared;
  let isProfileTask = prepared.isProfileTask;
  const mount = ctx.host.require(workspaceId);
  let task = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const current = await loadTaskEnvelope(mount.env.fs, taskPath);
    if (current.state !== "running") {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.startSession requires running at provider launch; got ${current.state}`,
        { code: "INVALID_TASK_STATE", state: current.state, taskPath }
      );
    }
    if (taskAssigneeKind(current) === "agentProfile" && current.role !== profileId) {
      throw new RpcError(
        -32602,
        `task.startSession profileId must match agentProfile task assignee (${current.role}); got ${profileId}`,
        { taskAssignee: current.role, profileId }
      );
    }
    const withLane = await ensureTaskWorkspaceLane(ctx, workspaceId, current);
    isProfileTask = taskAssigneeKind(withLane) === "agentProfile";
    return withLane;
  });

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

  // Before managed start: validate every declared durable Node/Task/Delivery ref
  // against persisted workspace facts — fail loud to parent (never invent).
  if (task.contextCard) {
    try {
      await assertDurableContextCardRefsResolved(mount.env.fs, task.contextCard);
    } catch (err) {
      if (err instanceof TaskContextCardError) {
        throw new RpcError(-32000, err.message, {
          code: err.code,
          details: err.details,
          taskPath,
          taskId: task.id,
        });
      }
      throw err;
    }
  }

  // Live authoritative contextGeneration: always recompute from current AGENTS /
  // Skill body+version / Role prompt+roster / profile launch snapshot. Persisted
  // Task/card generation never overrides live facts. Collector failure is fail-loud
  // (never yields reusable fallback facts).
  const profile = ctx.profileCatalog.get(profileId);
  if (!profile?.adapterId) {
    throw new RpcError(
      -32602,
      `task.startSession cannot compute contextGeneration: profile ${profileId} missing or has no adapterId`,
      { profileId, code: "CONTEXT_GENERATION_COLLECT_FAILED" }
    );
  }
  const adapterId = profile.adapterId;
  const parentRoleId =
    task.parentActor?.kind === "role" ? task.parentActor.id : undefined;
  const assigneeKind = taskAssigneeKind(task);
  const taskPurpose = readTaskPurpose(task);
  let stableBundle: StableContextGenerationBundle;
  try {
    stableBundle = await collectStableContextGeneration({
      workspaceRoot: mount.workspaceRoot,
      workspaceIdentity: workspaceId,
      packageRoot: ctx.packageRoot,
      packageVersion: ctx.version,
      assigneeKind,
      assigneeLabel: task.role,
      agentId: typeof task.agentId === "string" ? task.agentId : undefined,
      profileId,
      adapterId,
      parentRoleId,
      purpose: taskPurpose || undefined,
      roleFs: mount.env.fs,
      profile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(
      -32000,
      `task.startSession contextGeneration collection failed: ${message}`,
      { code: "CONTEXT_GENERATION_COLLECT_FAILED", taskPath, profileId }
    );
  }

  const liveGeneration = stableBundle.contextGeneration;
  if (!liveGeneration) {
    throw new RpcError(
      -32000,
      "task.startSession produced empty contextGeneration (fail closed)",
      { code: "CONTEXT_GENERATION_EMPTY", taskPath }
    );
  }
  const priorPersistedGeneration =
    task.contextGeneration?.trim() ||
    task.contextCard?.contextGeneration?.trim() ||
    "";
  // Live id is always authoritative for this prompt. Refresh Task/card when drifted.
  if (priorPersistedGeneration !== liveGeneration) {
    task = await runTaskLifecycle(workspaceId, taskPath, () =>
      ctx.mutations.run(workspaceId, async () => {
        const current = await loadTaskEnvelope(mount.env.fs, taskPath);
        if (current.state !== "running") {
          throw new RpcError(
            RPC_LIFECYCLE,
            `task.startSession cannot refresh context on ${current.state} Task`,
            { code: "INVALID_TASK_STATE", state: current.state, taskPath }
          );
        }
        ctx.host.markSelfWrite(workspaceId);
        if (current.contextCard) {
          const nextCard = {
            ...current.contextCard,
            contextGeneration: liveGeneration,
          };
          return patchTaskEnvelope(mount.env.fs, taskPath, {
            contextCard: nextCard,
            contextGeneration: liveGeneration,
            ...(taskPurpose ? { purpose: taskPurpose } : {}),
            updatedAt: mount.env.clock.now(),
          });
        }
        return patchTaskEnvelope(mount.env.fs, taskPath, {
          contextGeneration: liveGeneration,
          ...(taskPurpose ? { purpose: taskPurpose } : {}),
          updatedAt: mount.env.clock.now(),
        });
      })
    );
  }

  const requestFacts = buildSessionReuseRequestFacts({
    workspaceId,
    bundle: {
      ...stableBundle,
      contextGeneration: liveGeneration,
      purpose: taskPurpose || stableBundle.purpose,
    },
    contextGeneration: liveGeneration,
    worktree: cwd,
  });

  // Candidate selection: task binding first, then Role/profile stopped sessions.
  // Reuse only after Core gate + prior-Task lease + live generation match on candidate.
  const candidateIds: string[] = [];
  if (task.sessionId?.trim()) candidateIds.push(task.sessionId.trim());
  if (!isProfileTask) {
    const roleSession = await findResumableManagedSessionForRole(
      ctx,
      workspaceId,
      task.role,
      profileId,
      cwd
    );
    if (roleSession?.id && !candidateIds.includes(roleSession.id)) {
      candidateIds.push(roleSession.id);
    }
  } else {
    const profileCandidates = await findResumableManagedSessionsForProfile(
      ctx,
      workspaceId,
      profileId,
      cwd
    );
    for (const c of profileCandidates) {
      if (c.id && !candidateIds.includes(c.id)) candidateIds.push(c.id);
    }
  }

  let resumePrior = false;
  let priorSessionId = "";
  let continuityProven = false;

  const allTasks = await loadTaskEnvelopes(mount.env.fs);
  let deliveriesCache: Awaited<ReturnType<typeof loadDeliveries>> | null = null;
  // Delivery truth: accepted/rejected activeDeliveryId is historical and does not
  // block. ready/draft, task.state delivered, missing/foreign pointer, or unreadable
  // store fail closed (never prove noPendingDelivery).
  const hasBlockingDelivery = async (
    t: import("../core/task.js").TaskEnvelope
  ): Promise<boolean> => {
    if (!deliveriesCache) {
      try {
        deliveriesCache = await loadDeliveries(mount.env.fs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError(
          -32000,
          `task.startSession cannot load Deliveries to prove noPendingDelivery: ${message}`,
          { code: "DELIVERY_STORE_UNREADABLE", taskPath }
        );
      }
    }
    try {
      const evaluation = evaluateTaskBlockingDelivery({
        task: t,
        deliveries: deliveriesCache,
      });
      return evaluation.blocking;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(
        -32000,
        `task.startSession cannot prove noPendingDelivery: ${message}`,
        {
          code: "DELIVERY_POINTER_UNRESOLVED",
          taskPath,
          priorTaskPath: t.path,
          activeDeliveryId: t.activeDeliveryId,
        }
      );
    }
  };

  for (const candidateId of candidateIds) {
    try {
      const probe = await ctx.runtime.probe(candidateId);
      const prior = await ctx.runtime.registry.read(candidateId);
      if (!prior || !probe.resumeCapable || probe.alive) continue;

      // Live generation must match Session-recorded generation — never label a live
      // prompt with an old id. Drift forces fresh Session + full stable prefix.
      const priorGen = prior.contextGeneration?.trim() || "";
      if (!priorGen || priorGen !== liveGeneration) {
        continue;
      }

      const lease = await evaluateCandidateSessionLeaseGates({
        allTasks,
        candidate: prior,
        requestTaskPath: taskPath,
        requestTaskId: task.id,
        turnBusy: probe.turnBusy === true,
        workspaceId,
        listPendingInputs: (ws, tp) =>
          ctx.taskInputs.listRetryableForTask(ws, tp),
        hasPendingUserAsk: (ws, tp) => ctx.userAsks.hasPendingForTask(ws, tp),
        hasBlockingDelivery,
      });

      const evaluation = evaluateManagedSessionReuse({
        request: requestFacts,
        candidate: prior,
        runtime: {
          previousTurnSettled: lease.previousTurnSettled,
          noPendingInput: lease.noPendingInput,
          noPendingDelivery: lease.noPendingDelivery,
          exclusiveLease: lease.exclusiveLease,
        },
      });

      if (evaluation.allowed) {
        resumePrior = true;
        priorSessionId = candidateId;
        continuityProven = true;
        break;
      }
    } catch (err) {
      if (
        !/Session not found/i.test(err instanceof Error ? err.message : String(err))
      ) {
        throw err;
      }
    }
  }
  // No allowed candidate → fail closed to fresh Session generation.

  // Official managed bootstrap is always Service-owned (stable + delta).
  // Public bootstrapPrompt is an appended dynamic section only — never a replacement.
  // Stable prefix omitted only when Core proved continuity (live gen === session gen
  // and full reuse gate passed).
  const sessionContextGeneration = continuityProven ? liveGeneration : undefined;
  let sessionBootstrap = await buildSessionBootstrapPrompt(
    ctx,
    task,
    {
      workspaceRoot: mount.workspaceRoot,
      systemRoot: mount.systemRoot,
      sessionContextGeneration,
    },
    mount.env.fs
  );
  sessionBootstrap = appendCallerBootstrapSection(
    sessionBootstrap,
    prepared.bootstrapPrompt
  );

  // Ephemeral image path refs from task user prompt + claimed node bodies only.
  // Paths only — never base64; never written to task/session/profile disk.
  // ACP image blocks still require live initialize promptCapabilities.image === true.
  const bootstrapImageRefs = await collectTaskBootstrapImageRefs(mount.env.fs, task);
  const bootstrapImageSystemRoot =
    bootstrapImageRefs.length > 0 ? mount.systemRoot : undefined;

  const bindSnapshot = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const current = await loadTaskEnvelope(mount.env.fs, taskPath);
    assertTaskSessionBindSnapshot(
      "task.startSession",
      taskPath,
      current,
      captureTaskSessionBindSnapshot(task)
    );
    task = current;
    return captureTaskSessionBindSnapshot(current);
  });

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
  // Persist full compatibility facts needed for later evaluateSessionReuseCompatibility.
  let bound: TaskEnvelope;
  try {
    bound = await runTaskLifecycle(workspaceId, taskPath, () =>
      ctx.mutations.run(workspaceId, async () => {
        const current = await loadTaskEnvelope(mount.env.fs, taskPath);
        assertTaskSessionBindSnapshot("task.startSession", taskPath, current, bindSnapshot);
        ctx.host.markSelfWrite(workspaceId);
        const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: handle.sessionId,
          updatedAt: mount.env.clock.now(),
        });
        const generation = liveGeneration;
        try {
          const parentRoleIdBound =
            next.parentActor?.kind === "role" ? next.parentActor.id : undefined;
          const agentId =
            stableBundle.agentId ||
            (typeof next.agentId === "string" && next.agentId.trim()) ||
            next.role;
          const purposeBound = readTaskPurpose(next) || stableBundle.purpose || "";
          await ctx.runtime.registry.update(handle.sessionId, {
            contextGeneration: generation,
            ...(next.taskDeltaDigest
              ? { taskDeltaDigest: next.taskDeltaDigest }
              : {}),
            agentId,
            ...(parentRoleIdBound ? { parentRoleId: parentRoleIdBound } : {}),
            skillsDigest: stableBundle.skillSetDigest || stableBundle.skillsDigest,
            purpose: purposeBound,
          });
        } catch {
          // Session row projection is best-effort; Task remains authoritative.
        }
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
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stopped = await stopUnboundManagedSession(
      ctx,
      handle.sessionId,
      "task.startSession",
      message
    );
    if (isTaskSessionBindCasError(err)) {
      const data = (err as RpcError).data as Record<string, unknown>;
      throw new RpcError(RPC_LIFECYCLE, message, {
        ...data,
        orphanSessionId: handle.sessionId,
        cleanupStopped: stopped,
      });
    }
    throw new RpcError(RPC_LIFECYCLE, `task.startSession failed to bind managed Session: ${message}`, {
      code: "TASK_SESSION_BIND_FAILED",
      taskPath,
      orphanSessionId: handle.sessionId,
      cleanupStopped: stopped,
    });
  }

  return projectStartSessionResult(workspaceId, taskPath, bound, {
    id: handle.sessionId,
    profileId: handle.profileId,
    adapterId: handle.adapterId,
    state: handle.state,
    roleName: handle.roleName,
    runtimeWorkspace: handle.runtimeWorkspace,
  }, { cwd });
}

/** Stable restoreReason for explicit same-Task fresh Session replacement. */
export const REPLACE_SESSION_RESTORE_REASON = "task.replaceSession.fresh" as const;

/** Explicit fresh managed Session on the same Task (unusable provider context). */
async function taskReplaceSessionRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const taskPath = requireString(p, "taskPath");
  const profileId = requireProfileId(p, "task.replaceSession");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }
  if ("force" in p && p.force !== undefined && p.force !== false) {
    throw new RpcError(-32602, "task.replaceSession does not support force; wait for turnBusy=false and retry", {
      code: "FORCE_NOT_SUPPORTED",
    });
  }
  await prepareAuthorizedTaskStartSession(ctx, p, workspaceId, taskPath, profileId, callerKind, {
    operation: "replaceSession",
    skipReuseAndLaunchPrep: true,
  });
  // Outer managed-session flight: concurrent same-profile replace/start still join/coalesce.
  // Exact-Task lifecycle stages are acquired only for authoritative prepare/CAS bind;
  // provider startup stays outside the coordinator so terminal transitions can win.
  return runManagedSessionFlight(workspaceId, taskPath, profileId, "replaceSession", () =>
    executeTaskReplaceSession(ctx, workspaceId, taskPath, profileId)
  );
}

async function assertReplaceSessionEligible(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  profileId: string
): Promise<void> {
  const mount = ctx.host.require(workspaceId);
  const task = await loadTaskEnvelope(mount.env.fs, taskPath);
  if (taskAssigneeKind(task) === "agentProfile" && task.role !== profileId) {
    throw new RpcError(
      -32602,
      `task.replaceSession profileId must match agentProfile task assignee (${task.role}); got ${profileId}`,
      { taskAssignee: task.role, profileId }
    );
  }
  if (task.state !== "running" && task.state !== "waiting") {
    throw new RpcError(RPC_LIFECYCLE, `task.replaceSession requires running or waiting; got ${task.state}`, {
      code: "INVALID_TASK_STATE",
      state: task.state,
    });
  }
  if (task.state === "waiting" && !isSessionUnavailableParkedWait(task)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "task.replaceSession allows waiting only with durable waitCode=session_unavailable; resolve user-input / a2a / tool waits first",
      {
        code: "REPLACE_SESSION_WAIT_NOT_ELIGIBLE",
        state: task.state,
        waitReason: task.wait?.reason,
        waitCode: task.wait?.code,
      }
    );
  }
  const priorSessionId = task.sessionId?.trim() || "";
  if (!priorSessionId) {
    throw new RpcError(RPC_LIFECYCLE, "task.replaceSession requires a bound managed sessionId on the task", {
      code: "NO_BOUND_SESSION",
      taskPath,
    });
  }
  try {
    if ((await ctx.runtime.probe(priorSessionId)).turnBusy === true) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.replaceSession refused: managed session ${priorSessionId} still has an in-flight turn (turnBusy); retry when the turn settles`,
        { code: "TURN_BUSY", sessionId: priorSessionId, taskPath, turnBusy: true }
      );
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (!/Session not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

async function executeTaskReplaceSession(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  profileId: string
) {
  const mount = ctx.host.require(workspaceId);
  let task = await runTaskLifecycle(workspaceId, taskPath, async () => {
    await assertReplaceSessionEligible(ctx, workspaceId, taskPath, profileId);
    let current = await loadTaskEnvelope(mount.env.fs, taskPath);
    if (current.state === "waiting") {
      await taskResumeRpc(ctx, { workspaceId, taskPath });
      current = await loadTaskEnvelope(mount.env.fs, taskPath);
    }
    return ensureTaskWorkspaceLane(ctx, workspaceId, current);
  });
  const priorSessionId = task.sessionId!.trim();
  const preserved = {
    taskId: task.id,
    nodeIds: task.contextCard != null ? [...taskReferencedNodeIds(task)] : [],
    worktree: task.worktree,
    branch: task.branch,
    deliveryPolicy: task.deliveryPolicy,
    role: task.role,
  };
  let retirementBegun = false;
  let startedSessionId: string | undefined;
  const parkAfterRetirement = async (detail: string): Promise<void> => {
    try {
      const current = await loadTaskEnvelope(mount.env.fs, taskPath);
      if (startedSessionId && current.sessionId === startedSessionId && current.sessionId !== priorSessionId) {
        await ctx.mutations.run(workspaceId, async () => {
          ctx.host.markSelfWrite(workspaceId);
          await patchTaskEnvelope(mount.env.fs, taskPath, {
            sessionId: priorSessionId,
            updatedAt: mount.env.clock.now(),
          });
        });
      }
    } catch {
      // still park on prior
    }
    await parkTaskForUnavailableSession(ctx, {
      workspaceId,
      taskPath,
      sessionId: priorSessionId,
      reason: "task.replaceSession.failed",
      detail,
    });
  };

  try {
    try {
      await ctx.toolApprovals.cancelSession(priorSessionId, "denied");
    } catch {
      /* ignore */
    }
    try {
      const priorProbe = await ctx.runtime.probe(priorSessionId);
      if (priorProbe.alive || SessionRegistry.isNonTerminal(priorProbe.state)) {
        await ctx.runtime.stopSession(priorSessionId, "user");
      } else {
        try {
          await ctx.runtime.registry.update(priorSessionId, {
            stopReason: "user",
            state:
              priorProbe.state === "failed" || priorProbe.state === "stopped"
                ? priorProbe.state
                : "stopped",
          });
        } catch {
          /* gone */
        }
      }
    } catch (err) {
      if (!/Session not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    retirementBegun = true;
    clearManagedAutoDeliverDedup(priorSessionId, taskPath);

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
    const bootstrapImageRefs = await collectTaskBootstrapImageRefs(mount.env.fs, task);
    const bindSnapshot = await runTaskLifecycle(workspaceId, taskPath, async () => {
      let current = await loadTaskEnvelope(mount.env.fs, taskPath);
      // Stopping the prior managed Session legitimately projects this exact Task to
      // waiting(session_unavailable). Resume that replace-owned projection before
      // taking the final pre-launch snapshot; every other drift remains fail-closed.
      if (
        current.state === "waiting" &&
        current.sessionId === priorSessionId &&
        isSessionUnavailableParkedWait(current)
      ) {
        await taskResumeRpc(ctx, { workspaceId, taskPath });
        current = await loadTaskEnvelope(mount.env.fs, taskPath);
      }
      if (
        current.state !== "running" ||
        current.id !== preserved.taskId ||
        current.sessionId !== priorSessionId ||
        current.role !== preserved.role ||
        current.deliveryPolicy !== preserved.deliveryPolicy
      ) {
        assertTaskSessionBindSnapshot(
          "task.replaceSession",
          taskPath,
          current,
          captureTaskSessionBindSnapshot(task)
        );
      }
      task = current;
      return captureTaskSessionBindSnapshot(current);
    });
    const handle = await ctx.runtime.startSession({
      sessionId: makeSessionId(),
      profileId,
      roleName: task.role,
      assigneeKind: taskAssigneeKind(task),
      workspaceLane,
      runtimeWorkspace: { cwd },
      cwd,
      bootstrapPrompt: await buildFreshReplaceSessionBootstrap(ctx, task, {
        workspaceRoot: mount.workspaceRoot,
        systemRoot: mount.systemRoot,
        priorSessionId,
        roleFs: mount.env.fs,
      }),
      ...(bootstrapImageRefs.length > 0
        ? { bootstrapImageRefs, bootstrapImageSystemRoot: mount.systemRoot }
        : {}),
      lastTaskId: task.id || taskPath,
      workspace: workspaceId,
    });
    startedSessionId = handle.sessionId;

    const bound = await runTaskLifecycle(workspaceId, taskPath, () =>
      ctx.mutations.run(workspaceId, async () => {
        const current = await loadTaskEnvelope(mount.env.fs, taskPath);
        assertTaskSessionBindSnapshot("task.replaceSession", taskPath, current, bindSnapshot);
        ctx.host.markSelfWrite(workspaceId);
        const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: handle.sessionId,
          state: "running",
          wait: null,
          updatedAt: mount.env.clock.now(),
        });
        emitTaskState(ctx, workspaceId, next, "task.replaceSession");
        ctx.events.emit(
          "session.state",
          workspaceId,
          {
            sessionId: handle.sessionId,
            state: handle.state,
            profileId: handle.profileId,
            taskPath,
            reason: REPLACE_SESSION_RESTORE_REASON,
            contextRestored: false,
            priorSessionId,
            replacedSessionId: priorSessionId,
          },
          "self"
        );
        return next;
      })
    );

    await ctx.runtime.registry.update(handle.sessionId, {
      contextRestored: false,
      restoreReason: REPLACE_SESSION_RESTORE_REASON,
      replacedSessionId: priorSessionId,
    });
    try {
      const priorRow = await ctx.runtime.registry.read(priorSessionId);
      if (priorRow) {
        const { lastTaskId: _detach, ...rest } = priorRow;
        await ctx.runtime.registry.write({
          ...rest,
          replacedBySessionId: handle.sessionId,
          lastError: `replaced by ${handle.sessionId} (${REPLACE_SESSION_RESTORE_REASON})`,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* ignore */
    }
    clearManagedAutoDeliverDedup(handle.sessionId, taskPath);

    const nodeIds =
      bound.contextCard != null ? taskReferencedNodeIds(bound) : [];
    if (
      bound.id !== preserved.taskId ||
      bound.role !== preserved.role ||
      bound.deliveryPolicy !== preserved.deliveryPolicy ||
      bound.worktree !== preserved.worktree ||
      bound.branch !== preserved.branch ||
      nodeIds.length !== preserved.nodeIds.length ||
      nodeIds.some((id, i) => id !== preserved.nodeIds[i])
    ) {
      throw new RpcError(RPC_LIFECYCLE, "task.replaceSession mutated task lane/nodeRefs/identity", {
        code: "TASK_IDENTITY_DRIFT",
      });
    }

    try {
      await ctx.taskInputs.rebindOpenSessions(workspaceId, taskPath, handle.sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(RPC_LIFECYCLE, `task.replaceSession TaskInput rebind failed: ${message}`, {
        code: "REPLACE_SESSION_TASK_INPUT_REBIND_FAILED",
        taskPath,
        priorSessionId,
        newSessionId: handle.sessionId,
      });
    }

    return {
      workspaceId,
      taskPath,
      task: projectTask(bound),
      session: {
        sessionId: handle.sessionId,
        profileId: handle.profileId,
        adapterId: handle.adapterId,
        state: handle.state,
        cwd,
        contextRestored: false as const,
        restoreReason: REPLACE_SESSION_RESTORE_REASON,
        replacedSessionId: priorSessionId,
      },
      priorSessionId,
      replaced: true as const,
    };
  } catch (err) {
    let cleanupStopped: boolean | undefined;
    if (startedSessionId) {
      cleanupStopped = await stopUnboundManagedSession(
        ctx,
        startedSessionId,
        "task.replaceSession",
        err instanceof Error ? err.message : String(err)
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (retirementBegun && !isTaskSessionBindCasError(err)) await parkAfterRetirement(message);
    if (isTaskSessionBindCasError(err)) {
      const data = (err as RpcError).data as Record<string, unknown>;
      throw new RpcError(RPC_LIFECYCLE, message, {
        ...data,
        ...(startedSessionId ? { orphanSessionId: startedSessionId } : {}),
        ...(cleanupStopped !== undefined ? { cleanupStopped } : {}),
      });
    }
    if (err instanceof RpcError) throw err;
    throw new RpcError(RPC_LIFECYCLE, `task.replaceSession failed to start replacement session: ${message}`, {
      code: "REPLACE_SESSION_LAUNCH_FAILED",
      taskPath,
      priorSessionId,
      ...(startedSessionId ? { orphanSessionId: startedSessionId } : {}),
    });
  }
}

async function buildFreshReplaceSessionBootstrap(
  ctx: HandlerContext,
  task: TaskEnvelope,
  roots: {
    workspaceRoot: string;
    systemRoot: string;
    priorSessionId: string;
    roleFs?: import("../core/adapter.js").FsAdapter;
  }
): Promise<string> {
  const base = await buildSessionBootstrapPrompt(
    ctx,
    task,
    {
      workspaceRoot: roots.workspaceRoot,
      systemRoot: roots.systemRoot,
    },
    roots.roleFs
  );
  const tail = [
    "--- Tent replace-session recovery ---",
    "contextRestored: false",
    "restoreReason: task.replaceSession.fresh",
    "Provider context was replaced explicitly. This is an independent managed Session on the same task/workspace lane.",
    "Do not invent prior chat/cache continuity. Use Task/Node refs below.",
    `priorSessionId: ${roots.priorSessionId}`,
    `Task envelope: ${task.path}`,
    ...(task.id ? [`Task id: ${task.id}`] : []),
    ...(task.manifest ? [`Manifest: ${task.manifest}`] : []),
    ...(task.contextCard != null && taskReferencedNodeIds(task).length
      ? [`Node refs: ${taskReferencedNodeIds(task).join(", ")}`]
      : []),
    "Pending TaskInputs and delivery policy are preserved on this Task. Final report still goes through Delivery only.",
  ].join("\n");
  return `${base}\n\n${tail}\n`;
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
 * @deprecated Prefer node.collaboration (V0.2). Migration-only.
 * Stable box collaboration projection (legacy task-api §2.3).
 * Active task is authoritative (doing + assignee + activeTaskId).
 * With no active task: accepted Task/Delivery history may project done;
 * Node FM owner/status is never consulted.
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
 * @deprecated Prefer node.collaborations (V0.2). Migration-only.
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
 * V0.2 Node-keyed collaboration projection (task-api §2.3 / cx-tsw53f).
 * Multi-Task: all directly-referencing active Tasks; Session/Delivery via explicit ids.
 * No universal todo/doing/done; idle → activeTasks: [] / activeTaskCount: 0.
 * No singular task/session/delivery wire. Deterministic order: createdAt/id/path.
 */
async function nodeCollaborationRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<NodeCollaboration> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept(tent, p);
  if (concept.invalid) {
    throw new RpcError(
      -32004,
      `Concept is invalid and has no collaboration projection: ${concept.path}`,
      { nodeId: concept.id, path: concept.path, detail: concept.invalidReason }
    );
  }
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const deliveries = await loadDeliveries(mount.env.fs);
  const selected = listDirectActiveTasksForNode(concept.id, tasks);
  const sessionsById = await loadSessionSummariesForCollaboration(
    ctx,
    collectExplicitSessionIds(selected)
  );
  return projectNodeCollaborationMulti(
    workspaceId,
    concept.id,
    selected,
    deliveries,
    sessionsById
  );
}

/**
 * V0.2 batch Node collaboration projection — same item semantics as node.collaboration.
 * Input `ids` order is preserved in `items`. Empty ids → empty items.
 * Loads tent + tasks + deliveries once; probes only unique explicit sessionIds (no N+1 by node).
 */
async function nodeCollaborationsRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<NodeCollaborationsResult> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const idsRaw = p.ids;
  if (!Array.isArray(idsRaw)) {
    throw new RpcError(-32602, "node.collaborations requires ids: string[]");
  }
  const ids: string[] = [];
  for (let i = 0; i < idsRaw.length; i++) {
    const id = idsRaw[i];
    if (typeof id !== "string" || !id.trim()) {
      throw new RpcError(-32602, `node.collaborations ids[${i}] must be a non-empty string`);
    }
    ids.push(id.trim());
  }

  if (ids.length === 0) {
    return { workspaceId, items: [] };
  }

  const tent = await loadTent(mount.env.fs);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const deliveries = await loadDeliveries(mount.env.fs);

  const selectedByNodeId = new Map<string, TaskEnvelope[]>();
  for (const id of ids) {
    if (selectedByNodeId.has(id)) continue; // duplicate ids share one resolution
    const concept = tent.byId.get(id);
    if (!concept) {
      throw new RpcError(-32004, `Concept not found: ${id}`);
    }
    if (concept.invalid) {
      throw new RpcError(
        -32004,
        `Concept is invalid and has no collaboration projection: ${concept.path}`,
        { nodeId: concept.id, path: concept.path, detail: concept.invalidReason }
      );
    }
    selectedByNodeId.set(id, listDirectActiveTasksForNode(id, tasks));
  }

  const allSelected = [...selectedByNodeId.values()].flat();
  const sessionsById = await loadSessionSummariesForCollaboration(
    ctx,
    collectExplicitSessionIds(allSelected)
  );

  const items: NodeCollaboration[] = [];
  for (const id of ids) {
    items.push(
      projectNodeCollaborationMulti(
        workspaceId,
        id,
        selectedByNodeId.get(id) ?? [],
        deliveries,
        sessionsById
      )
    );
  }
  return { workspaceId, items };
}

/**
 * Probe only the given session ids (unique). Idle / unrelated sessions incur no probe.
 * Missing registry rows are omitted (stale task.sessionId → session: null).
 */
async function loadSessionSummariesForCollaboration(
  ctx: HandlerContext,
  sessionIds: readonly string[]
): Promise<Map<string, NodeCollaborationSessionSummary>> {
  const byId = new Map<string, NodeCollaborationSessionSummary>();
  for (const sessionId of sessionIds) {
    if (byId.has(sessionId)) continue;
    const rec = await ctx.runtime.registry.read(sessionId);
    if (!rec) continue;
    const probe = await ctx.runtime.probe(sessionId);
    byId.set(sessionId, {
      id: sessionId,
      state: probe.state,
      alive: probe.alive,
      turnBusy: probe.turnBusy === true,
    });
  }
  return byId;
}

/** Unique non-empty sessionIds from selected active tasks only. */
function collectExplicitSessionIds(
  selected: ReadonlyArray<TaskEnvelope | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const task of selected) {
    const sid = task?.sessionId?.trim();
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}

/**
 * Build multi-Task V0.2 Node collaboration item.
 * Session/Delivery only when Task carries explicit sessionId / activeDeliveryId that resolve.
 * No singular task/session/delivery fields.
 * activeTaskCount is projection-only: always entries.length (unpaginated; no totalCount).
 */
function projectNodeCollaborationMulti(
  workspaceId: string,
  nodeId: string,
  activeTasks: readonly TaskEnvelope[],
  deliveries: import("../core/delivery.js").DeliveryRecord[],
  sessionsById: ReadonlyMap<string, NodeCollaborationSessionSummary>
): NodeCollaboration {
  const entries: NodeCollaborationActiveTask[] = activeTasks.map((activeTask) => {
    const assigneeKind = taskAssigneeKind(activeTask);
    const taskSummary: NodeCollaborationTaskSummary = {
      id: activeTask.id || activeTask.path,
      state: activeTask.state,
      assigneeKind,
    };
    if (assigneeKind === "agentProfile") {
      taskSummary.profileId = activeTask.role;
    } else {
      taskSummary.role = activeTask.role;
    }
    if (activeTask.sessionId) taskSummary.sessionId = activeTask.sessionId;
    if (activeTask.activeDeliveryId) taskSummary.activeDeliveryId = activeTask.activeDeliveryId;
    if (activeTask.createdAt) taskSummary.createdAt = activeTask.createdAt;
    if (activeTask.path) taskSummary.path = activeTask.path;

    let session: NodeCollaborationSessionSummary | null = null;
    if (activeTask.sessionId) {
      session = sessionsById.get(activeTask.sessionId) ?? null;
    }

    let delivery: NodeCollaborationDeliverySummary | null = null;
    if (activeTask.activeDeliveryId) {
      const found = deliveries.find((d) => d.id === activeTask.activeDeliveryId);
      if (found) {
        delivery = { id: found.id, status: found.status };
      }
    }

    return { task: taskSummary, session, delivery };
  });

  // Projection-only derived count — never a second fact source; never paginated total.
  return {
    workspaceId,
    nodeId,
    activeTasks: entries,
    activeTaskCount: entries.length,
  };
}

/**
 * Workspace-level graph projection for Working-set Canvas.
 * Nodes: stable summaries only (no body). Edges: parent + markdown + wiki + relation.
 * Unresolved concept links / relation targets are retained with explicit unresolved payload.
 * Semantic relations are never merged into parent/markdown/wiki collections.
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
 * Truth sources: Task envelopes (+ Delivery via task state after accept). No Node FM.
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
  // Legacy box.projection: first direct active Task (multi-Task truth is node.collaboration).
  const activeTask = listDirectActiveTasksForNode(concept.id, tasks)[0];
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

  // Historical accepted work (task.accept / auto-integrate) → done; no assignee/activeTaskId.
  // Prefer Task state=accepted (Delivery is accepted in the same mutation).
  const acceptedTask = tasks.find(
    (t) => taskDirectlyReferencesNode(t, concept.id) && t.state === "accepted"
  );
  if (acceptedTask) {
    const fromTask = boxProjectionOf(acceptedTask);
    return {
      workspaceId,
      boxId: concept.id,
      status: fromTask.status,
    };
  }

  // Interrupted / failed / rejected / never tasked → idle todo. Stale Node FM ignored.
  return {
    workspaceId,
    boxId: concept.id,
    status: "todo",
  };
}

/**
 * Build workspace graph projection from loaded tent.
 * Reuses markdown link parser + concept index (no ad-hoc regex).
 * Node order: depth-first tree walk (stable). Edge order: DFS source + extract order.
 * Semantic relations are a separate edge collection (source frontmatter only).
 */
function buildGraphProjection(workspaceId: string, tent: LoadedTent): GraphProjection {
  const nodes: GraphNodeSummary[] = [];
  const parentEdges: GraphParentEdge[] = [];
  const markdownEdges: GraphLinkEdge[] = [];
  const wikiEdges: GraphLinkEdge[] = [];
  const relationEdges: GraphRelationEdge[] = [];

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

  // Semantic relations: DFS source order + source frontmatter array order.
  // Never fold into markdown/wiki even when targets look similar.
  const emitRelations = (box: import("../core/types.js").Box): void => {
    for (const rel of box.relations) {
      const edge: GraphRelationEdge = {
        id: rel.id,
        fromId: box.id,
        kind: rel.kind,
        direction: rel.direction,
      };
      if (rel.label !== undefined) edge.label = rel.label;
      if ("nodeId" in rel.target) {
        // Project stored nodeId honestly; do not re-resolve or drop missing targets here.
        edge.toId = rel.target.nodeId;
      } else {
        edge.unresolved = rel.target.unresolved;
      }
      relationEdges.push(edge);
    }
    for (const child of box.children) emitRelations(child);
  };
  for (const root of tent.roots) emitRelations(root);

  return {
    workspaceId,
    nodes,
    edges: {
      parent: parentEdges,
      markdown: markdownEdges,
      wiki: wikiEdges,
      relation: relationEdges,
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
      ...(rec.contextRestored !== undefined ? { contextRestored: rec.contextRestored } : {}),
      ...sessionReplaceAuditFields(rec),
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
    ...(rec.contextRestored !== undefined ? { contextRestored: rec.contextRestored } : {}),
    ...sessionReplaceAuditFields(rec),
    turnBusy: probe.turnBusy === true,
    lastTaskId: rec.lastTaskId,
    workspace: rec.workspace,
    externalKey: recordExternalKey(rec),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  return { session: projection };
}

/** Optional replace/resume audit fields on Session projections. */
function sessionReplaceAuditFields(rec: {
  restoreReason?: string;
  replacedSessionId?: string;
  replacedBySessionId?: string;
}): Partial<SessionProjection> {
  return {
    ...(rec.restoreReason !== undefined ? { restoreReason: rec.restoreReason } : {}),
    ...(rec.replacedSessionId !== undefined ? { replacedSessionId: rec.replacedSessionId } : {}),
    ...(rec.replacedBySessionId !== undefined ? { replacedBySessionId: rec.replacedBySessionId } : {}),
  };
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

  const roleCheckpointTail =
    handle.roleName && (handle.assigneeKind ?? "role") !== "agentProfile"
      ? await loadRoleCheckpointTailSafe(ctx, workspaceId, handle.roleName)
      : "";

  return {
    session,
    reused: priorExternalId === handle.sessionId,
    /**
     * Optional cooperative Role Checkpoint tail for the durable Role just entered.
     * Dynamic only — callers append after stable Role init / bootstrap prefix.
     * Absent when no role, agentProfile, or no note on disk.
     */
    ...(roleCheckpointTail ? { roleCheckpointTail } : {}),
  };
}

/**
 * Optional Role Checkpoint RPCs — cooperative continuation note only.
 * Not Task/Delivery lifecycle; not required for crash recovery.
 *
 * Soft actor authority (set/clear): `user` (default) or the **exact target Role**
 * operational name. Unrelated Role actors are refused. Get is read-only and does
 * not require actor match, but still requires a path-safe durable Role.
 */
function projectRoleCheckpoint(record: RoleCheckpointRecord) {
  return {
    role: record.role,
    text: record.text,
    updatedAt: record.updatedAt,
    path: record.path,
    ...(record.sourceSessionId ? { sourceSessionId: record.sourceSessionId } : {}),
    ...(record.pointers ? { pointers: record.pointers } : {}),
  };
}

/**
 * Resolve operational Role name for checkpoint surfaces.
 * Path-safe name first; Service requires a durable registry Role (by name or rl- id).
 * Returns the Role's operational `name` (temp/<name>/ key), never displayName alone.
 */
async function resolveDurableCheckpointRole(
  ctx: HandlerContext,
  workspaceId: string,
  roleRef: string
): Promise<{ roleName: string; roleId?: string }> {
  let safe: string;
  try {
    // Path gate first so `.` / `..` never reach join/delete even before registry.
    safe = assertRoleCheckpointRoleName(roleRef);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message, { code: "INVALID_ROLE_NAME", role: roleRef });
  }
  const mount = ctx.host.require(workspaceId);
  const registry = await loadRolesRegistry(mount.env.fs);
  // Accept operational name or rl- id; resolveRole never uses displayName.
  const found = resolveRole(registry.roles, safe) ?? resolveRole(registry.roles, roleRef.trim());
  if (!found?.name) {
    throw new RpcError(-32602, `Unknown durable Role for checkpoint: ${roleRef.trim()}`, {
      code: "UNKNOWN_ROLE",
      role: roleRef.trim(),
    });
  }
  // Re-validate the resolved operational name (id lookup may yield a different string).
  let roleName: string;
  try {
    roleName = assertRoleCheckpointRoleName(found.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message, { code: "INVALID_ROLE_NAME", role: found.name });
  }
  return { roleName, roleId: found.id };
}

/**
 * Soft actor gate: user (default) or exact target Role operational name only.
 * Loopback token does not distinguish human vs role — same convention as other soft surfaces.
 */
function requireRoleCheckpointActor(
  p: Record<string, unknown>,
  targetRoleName: string,
  surface: string
): string {
  const actorRaw = (optionalString(p, "actor") ?? "user").trim();
  if (!actorRaw) {
    throw new RpcError(-32001, `${surface} actor cannot be empty`, { code: "ACTOR_FORBIDDEN" });
  }
  if (actorRaw === "user") return actorRaw;
  if (actorRaw === targetRoleName) return actorRaw;
  throw new RpcError(
    -32001,
    `${surface} allows actor "user" or the exact target Role "${targetRoleName}"; got "${actorRaw}"`,
    { code: "ACTOR_FORBIDDEN", actor: actorRaw, role: targetRoleName }
  );
}

/**
 * Optional sourceSessionId audit: keep only when the persisted Session row has
 * exact workspace === this workspaceId AND roleName === the checkpoint Role.
 * Missing or mismatched workspace/role (including unscoped legacy rows) drop
 * attribution — never invent continuity from an unrelated Session.
 */
async function resolveRoleCheckpointSourceSessionId(
  ctx: HandlerContext,
  workspaceId: string,
  roleName: string,
  raw?: string
): Promise<string | undefined> {
  const sessionId = raw?.trim();
  if (!sessionId) return undefined;
  try {
    const rec = await ctx.runtime.registry.read(sessionId);
    if (!rec) return undefined;
    // Exact workspace match required (unscoped / missing → drop).
    if (!rec.workspace || rec.workspace !== workspaceId) return undefined;
    // Exact Role match required (unscoped / missing → drop).
    const recRole = rec.roleName?.trim() || "";
    if (!recRole || recRole !== roleName) return undefined;
    return sessionId;
  } catch {
    return undefined;
  }
}

async function roleCheckpointGetRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const roleRef = requireString(p, "role");
  const { roleName } = await resolveDurableCheckpointRole(ctx, workspaceId, roleRef);
  try {
    const record = await readRoleCheckpoint(mount.env.fs, roleName);
    return {
      workspaceId,
      role: roleName,
      checkpoint: record ? projectRoleCheckpoint(record) : null,
      tail: formatRoleCheckpointTail(record),
    };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
}

async function roleCheckpointSetRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const roleRef = requireString(p, "role");
  const { roleName } = await resolveDurableCheckpointRole(ctx, workspaceId, roleRef);
  const actor = requireRoleCheckpointActor(p, roleName, "role.checkpoint.set");
  const text = requireString(p, "text");
  const rawSource =
    optionalString(p, "sourceSessionId") || optionalString(p, "sessionId") || undefined;
  const sourceSessionId = await resolveRoleCheckpointSourceSessionId(
    ctx,
    workspaceId,
    roleName,
    rawSource
  );
  const pointersRaw = p.pointers;
  let pointers: RoleCheckpointPointers | undefined;
  if (pointersRaw !== undefined && pointersRaw !== null) {
    if (typeof pointersRaw !== "object" || Array.isArray(pointersRaw)) {
      throw new RpcError(-32602, "role.checkpoint.set pointers must be an object");
    }
    pointers = pointersRaw as RoleCheckpointPointers;
  } else {
    // Flat convenience: nodes/tasks/deliveries/git at top level.
    const nodes = optionalStringArray(p, "nodes");
    const tasks = optionalStringArray(p, "tasks");
    const deliveries = optionalStringArray(p, "deliveries");
    const git = optionalStringArray(p, "git");
    if (nodes || tasks || deliveries || git) {
      pointers = {
        ...(nodes ? { nodes } : {}),
        ...(tasks ? { tasks } : {}),
        ...(deliveries ? { deliveries } : {}),
        ...(git ? { git } : {}),
      };
    }
  }

  try {
    // MutationBus-serialized with other workspace writes (sole mutation entry).
    const record = await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      return writeRoleCheckpoint(mount.env.fs, {
        role: roleName,
        text,
        updatedAt: mount.env.clock.now(),
        sourceSessionId,
        pointers,
      });
    });
    return {
      workspaceId,
      role: roleName,
      actor,
      checkpoint: projectRoleCheckpoint(record),
      tail: formatRoleCheckpointTail(record),
      // Echo whether caller-supplied sourceSessionId was kept (audit honesty).
      sourceSessionIdAccepted: Boolean(sourceSessionId),
    };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
}

async function roleCheckpointClearRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const roleRef = requireString(p, "role");
  const { roleName } = await resolveDurableCheckpointRole(ctx, workspaceId, roleRef);
  const actor = requireRoleCheckpointActor(p, roleName, "role.checkpoint.clear");
  try {
    const cleared = await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      return clearRoleCheckpoint(mount.env.fs, roleName);
    });
    return { workspaceId, role: roleName, actor, cleared };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
}

/** Best-effort tail load for enter/bootstrap; missing is fine, parse errors omit tail. */
async function loadRoleCheckpointTailSafe(
  ctx: HandlerContext,
  workspaceId: string | undefined,
  roleName: string
): Promise<string> {
  if (!workspaceId || !roleName.trim()) return "";
  try {
    // Path-safe only here — bootstrap must not fail the Session on unknown Role.
    const safe = assertRoleCheckpointRoleName(roleName);
    const mount = ctx.host.require(workspaceId);
    const record = await readRoleCheckpoint(mount.env.fs, safe);
    return formatRoleCheckpointTail(record);
  } catch {
    return "";
  }
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

  // External leave is a supported settle trigger: retry pending Task worktree reclaim
  // for collaboration-terminal tasks that were blocked on SESSION_ACTIVE.
  const leaveWorkspaceId = rec.workspace || workspaceId;
  if (leaveWorkspaceId) {
    await retryPendingWorktreeReclaimAfterSessionSettle(
      ctx,
      leaveWorkspaceId,
      {
        sessionId,
        lastTaskId: rec.lastTaskId,
        trigger: "session.leave",
      }
    );
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
      ...(task && primaryBoxId(task) ? { boxId: primaryBoxId(task) } : {}),
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
      ...(task && primaryBoxId(task) ? { boxId: primaryBoxId(task) } : {}),
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
      ...(task && primaryBoxId(task) ? { boxId: primaryBoxId(task) } : {}),
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
  // and deliver/interrupt — not a silent hang. Continuation targets the Task's
  // current bound session when rebound (see continueManagedAfterUserAsk).
  const resume = await resumeTaskAfterUserAsk(ctx, item, "userAsk.deny");
  const continueResult = await continueManagedAfterUserAsk(ctx, item);

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
 * Resolve which managed Session should receive a UserAsk answer continuation.
 * Prefer the Task's current bound sessionId when it has changed after recovery
 * rebind (item.sessionId stays as audit origin of the ask). Fall back to the
 * origin sessionId when the Task has no binding or the task row is missing.
 */
async function resolveUserAskContinueSessionId(
  ctx: HandlerContext,
  item: UserAskRecord
): Promise<string | undefined> {
  const origin = item.sessionId?.trim() || "";
  try {
    const mount = ctx.host.get(item.workspaceId);
    if (mount) {
      const task = await loadTaskEnvelope(mount.env.fs, item.taskPath).catch(
        () => null
      );
      const bound = task?.sessionId?.trim() || "";
      if (bound) return bound;
    }
  } catch {
    // best-effort: fall back to origin
  }
  return origin || undefined;
}

/**
 * Managed ACP: after user answer, feed fixed-format prompt into the live bound session.
 * Prefer Task.current sessionId when rebound after recoverable park; item.sessionId
 * remains audit origin only. Prefer live sendFollowUpPrompt; else resumeSession when capable.
 * External agents query userAsk.get — no auto chat.
 */
async function continueManagedAfterUserAsk(
  ctx: HandlerContext,
  item: UserAskRecord
): Promise<{ continued: boolean; error?: string }> {
  const sessionId = await resolveUserAskContinueSessionId(ctx, item);
  if (!sessionId) return { continued: false };
  const prompt = formatUserAskAnswerPrompt(item);
  try {
    // Live follow-up path (prefer current bound process after replacement rebind).
    try {
      await ctx.runtime.sendFollowUpPrompt(sessionId, prompt);
      return { continued: true };
    } catch (liveErr) {
      const liveMessage =
        liveErr instanceof Error ? liveErr.message : String(liveErr);
      // Live session without structured follow-up (e.g. fake process adapter):
      // do not call resumeSession on an alive process.
      try {
        const liveProbe = await ctx.runtime.probe(sessionId);
        if (liveProbe.alive && SessionRegistry.isNonTerminal(liveProbe.state)) {
          return {
            continued: false,
            error:
              liveMessage ||
              "managed session live but does not support follow-up inject; external agent may poll userAsk.get",
          };
        }
      } catch {
        // probe failed — fall through to resume path
      }
      // Fall through to provider-native resume when live follow-up is unavailable.
      if (!/not alive|does not support live follow-up/i.test(liveMessage)) {
        // Unexpected live error — still try resume if possible.
      }
    }

    const probe = await ctx.runtime.probe(sessionId);
    if (!probe.resumeCapable) {
      return {
        continued: false,
        error:
          "managed session not live and not resume-capable; external agent may poll userAsk.get",
      };
    }
    const rec = await ctx.runtime.registry.read(sessionId);
    const cwd = rec?.runtimeWorkspace?.cwd;
    await ctx.runtime.resumeSession({
      sessionId,
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
        sessionId,
        originSessionId: item.sessionId,
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
 * Exact-task attention projection for one-shot inputs.
 * Always requires workspaceId + taskPath — no machine-global inbox.
 * Includes pending|failed|uncertain. This read model is never an inject source.
 */
async function taskInputListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const { workspaceId, taskPath } = requireTaskInputScope(p);
  // Touch mount so unknown workspace fails loud before store read.
  ctx.host.require(workspaceId);
  try {
    const attention = await ctx.taskInputs.listAttentionForTask(
      workspaceId,
      taskPath
    );
    return { inputs: attention.map(projectTaskInput) };
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
 * Formal ack after observing one-shot input. Omitted actor is the user-only
 * Local Service path and is allowed only for a persisted user parent/reviewer.
 * Explicit actor must be the exact Task role, persisted parent/reviewer Role,
 * or a service-verified Session bound to this Task. Explicit "user" text is
 * never authority. pending|delivered|uncertain → consumed.
 */
async function taskInputAckRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const { workspaceId, taskPath } = requireTaskInputScope(p);
  const inputId = requireString(p, "inputId");
  const actorRaw = optionalString(p, "actor")?.trim();
  ctx.host.require(workspaceId);

  let existing: TaskInputRecord | undefined;
  try {
    existing = await ctx.taskInputs.get(inputId, workspaceId, taskPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message);
  }
  if (!existing) throw new RpcError(-32004, `TaskInput not found: ${inputId}`);

  const authority = await resolveTaskInputAckAuthority(ctx, existing, actorRaw);
  const actor = authority.actor;

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
  if (existing.status === "uncertain") {
    const sessionId = existing.sessionId ?? authority.task.sessionId;
    if (sessionId) {
      // Ack is already durable and must return immediately. Git/integration or
      // Service latency in the draft-only retry cannot turn a successful ack
      // into a client timeout followed by "already consumed" on retry.
      trackManagedTaskInputBackground(
        requestManagedAutoDeliverRetryFromDraft(ctx, {
          workspaceId,
          taskPath,
          sessionId,
        })
      );
    }
  }
  return { input: projectTaskInput(item) };
}

/**
 * Resolve ack authority from the exact persisted Task plus Service registry.
 * The Local Service token is the current user trust boundary; this is not a
 * claim of cryptographic user identity.
 */
async function resolveTaskInputAckAuthority(
  ctx: HandlerContext,
  item: TaskInputRecord,
  actorRaw: string | undefined
): Promise<{ actor: string; task: TaskEnvelope }> {
  const mount = ctx.host.get(item.workspaceId);
  if (!mount) {
    throw new RpcError(-32000, `Workspace not mounted: ${item.workspaceId}`);
  }
  const task = await loadTaskEnvelope(mount.env.fs, item.taskPath).catch(
    (error) => {
      throw new RpcError(
        -32000,
        `taskInput.ack cannot read exact Task: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  );

  if (!actorRaw) {
    if (
      task.parentActor?.kind === "user" &&
      task.reviewer?.kind === "user"
    ) {
      return { actor: "user", task };
    }
    throw new RpcError(
      -32001,
      "taskInput.ack user path requires the exact persisted parent/reviewer to be user",
      { inputId: item.id, workspaceId: item.workspaceId, taskPath: item.taskPath }
    );
  }

  if (actorRaw === "user") {
    throw new RpcError(
      -32001,
      'taskInput.ack rejects caller-supplied actor "user"; omit actor for the Local Service user path',
      { inputId: item.id, workspaceId: item.workspaceId, taskPath: item.taskPath }
    );
  }

  if (actorRaw === task.role) return { actor: actorRaw, task };
  if (
    (task.parentActor?.kind === "role" && task.parentActor.id === actorRaw) ||
    (task.reviewer?.kind === "role" && task.reviewer.id === actorRaw)
  ) {
    return { actor: actorRaw, task };
  }

  // Service-verified session binding: actor may be the bound sessionId when
  // the registry row still points at the same workspace + task.
  if (item.sessionId && actorRaw === item.sessionId) {
    try {
      const rec = await ctx.runtime.registry.read(item.sessionId);
      if (rec) {
        const workspaceMatches =
          !rec.workspace || rec.workspace === item.workspaceId;
        const taskMatches =
          rec.lastTaskId === item.taskId ||
          rec.lastTaskId === item.taskPath ||
          task.sessionId === item.sessionId;
        if (workspaceMatches && taskMatches) {
          return { actor: actorRaw, task };
        }
      }
    } catch {
      // Fall through to one uniform unauthorized error.
    }
  }

  throw new RpcError(
    -32001,
    "taskInput.ack actor must match the exact Task role, persisted parent/reviewer Role, or a service-verified Session binding",
    {
      inputId: item.id,
      actor: actorRaw,
      expectedRole: task.role,
      parentActor: task.parentActor,
      reviewer: task.reviewer,
      sessionId: item.sessionId,
      workspaceId: item.workspaceId,
      taskPath: item.taskPath,
    }
  );
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
 * Read-only diagnostic for one Task's temporary Git worktree reclaim eligibility.
 * Does not mass-scan historical inventory; requires taskPath (or taskId via get).
 * Safe auto-reclaim still runs without this RPC — preview is for operators/tests.
 */
async function taskWorktreeReclaimPreviewRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const task = await loadTaskEnvelope(mount.env.fs, taskPath);
  const diagnostic = await evaluateTaskWorktreeReclaimForEnvelope(
    mount.env.fs,
    mount.workspaceRoot,
    task
  );
  return {
    workspaceId,
    taskPath,
    ...diagnostic,
  };
}

/**
 * Authoritative Service gate: no live/busy/external execution still bound to this Task
 * may hold the Task worktree as cwd. Fail-closed → SESSION_ACTIVE (enqueue + retry later).
 */
async function assertTaskExecutionSettledForWorktreeReclaim(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<{ ok: true } | { ok: false; reason: string; details?: Record<string, unknown> }> {
  const sessionId = task.sessionId?.trim();
  if (!sessionId) {
    // No bound session on the envelope — still scan registry for lastTaskId matches
    // that remain non-terminal (external leave may not have cleared envelope yet).
    return assertNoLiveRegistryExecutionForTask(ctx, workspaceId, task);
  }
  try {
    // Registry row is authoritative for pull-host external (may report alive=false
    // while state is still `external` / open). Do not trust probe.alive alone.
    const rec = await ctx.runtime.registry.read(sessionId);
    if (rec) {
      if (rec.state === "external" || SessionRegistry.isOpen(rec.state)) {
        return {
          ok: false,
          reason: `Bound session ${sessionId} is still open (state=${rec.state}); stop or session.leave before reclaim.`,
          details: { sessionId, state: rec.state, lastTaskId: rec.lastTaskId },
        };
      }
      if (SessionRegistry.isNonTerminal(rec.state)) {
        return {
          ok: false,
          reason: `Bound session ${sessionId} is still non-terminal (state=${rec.state}); stop before reclaim.`,
          details: { sessionId, state: rec.state },
        };
      }
    }
    const probe = await ctx.runtime.probe(sessionId);
    if (probe.turnBusy === true) {
      return {
        ok: false,
        reason: `Bound session ${sessionId} still has turnBusy=true; refuse worktree reclaim until the turn settles.`,
        details: { sessionId, turnBusy: true, state: probe.state },
      };
    }
    if (probe.alive || SessionRegistry.isNonTerminal(probe.state) || probe.state === "external") {
      return {
        ok: false,
        reason: `Bound session ${sessionId} is still live/open (state=${probe.state}, alive=${probe.alive}); stop or leave before reclaim.`,
        details: { sessionId, state: probe.state, alive: probe.alive },
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to probe bound session ${sessionId} for reclaim settle: ${err instanceof Error ? err.message : String(err)}`,
      details: { sessionId },
    };
  }
  return assertNoLiveRegistryExecutionForTask(ctx, workspaceId, task);
}

async function assertNoLiveRegistryExecutionForTask(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<{ ok: true } | { ok: false; reason: string; details?: Record<string, unknown> }> {
  const taskId = task.id?.trim();
  const taskPath = task.path;
  try {
    const all = await ctx.runtime.registry.list();
    for (const rec of all) {
      if (rec.workspace && rec.workspace !== workspaceId) continue;
      const boundById = taskId && rec.lastTaskId === taskId;
      const boundByPath =
        typeof (rec as { lastTaskPath?: string }).lastTaskPath === "string" &&
        (rec as { lastTaskPath?: string }).lastTaskPath === taskPath;
      // Prefer explicit task binding; also treat envelope sessionId match.
      const boundBySession =
        task.sessionId?.trim() && rec.id === task.sessionId.trim();
      if (!boundById && !boundByPath && !boundBySession) continue;
      // Open collaboration: managed non-terminal OR pull-host external.
      if (!SessionRegistry.isOpen(rec.state) && !SessionRegistry.isNonTerminal(rec.state)) {
        continue;
      }
      if (rec.state === "external" || SessionRegistry.isOpen(rec.state)) {
        return {
          ok: false,
          reason: `Registry session ${rec.id} still open for task (state=${rec.state}); refuse worktree reclaim until leave/stop.`,
          details: {
            sessionId: rec.id,
            state: rec.state,
            lastTaskId: rec.lastTaskId,
          },
        };
      }
      if (SessionRegistry.isNonTerminal(rec.state)) {
        try {
          const probe = await ctx.runtime.probe(rec.id);
          if (
            probe.turnBusy === true ||
            probe.alive ||
            SessionRegistry.isNonTerminal(probe.state)
          ) {
            return {
              ok: false,
              reason: `Registry session ${rec.id} still active for task (state=${rec.state}, turnBusy=${probe.turnBusy === true}); refuse worktree reclaim.`,
              details: {
                sessionId: rec.id,
                state: rec.state,
                turnBusy: probe.turnBusy === true,
                lastTaskId: rec.lastTaskId,
              },
            };
          }
        } catch {
          return {
            ok: false,
            reason: `Registry session ${rec.id} could not be probed while non-terminal; refuse worktree reclaim.`,
            details: { sessionId: rec.id, state: rec.state },
          };
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to scan session registry for task settle: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

/**
 * After session leave / exit / fail: retry reclaim for ONLY the exact pending
 * entry tied to this session's lastTaskId / bound Task. Unrelated pending
 * queue rows stay untouched. Does not scan historical terminal inventory.
 * leave/exit never deliver or accept.
 */
async function retryPendingWorktreeReclaimAfterSessionSettle(
  ctx: HandlerContext,
  workspaceId: string,
  input: {
    sessionId: string;
    lastTaskId?: string;
    task?: TaskEnvelope;
    trigger: string;
  }
): Promise<void> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return;
  try {
    const pending = await listTaskWorktreeReclaimPendingForWorkspace(
      mount.env.fs,
      mount.workspaceRoot,
      (a, b) => isSameWorkspaceRoot(nodePath.resolve(a), nodePath.resolve(b))
    );
    if (pending.length === 0) return;

    const needle = (input.lastTaskId || "").trim();
    let task = input.task;
    if (!task) {
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      // Prefer exact lastTaskId / id / path; fall back to envelope sessionId bind.
      task =
        tasks.find(
          (t) =>
            (needle && (t.id === needle || t.path === needle)) ||
            t.sessionId === input.sessionId
        ) ?? undefined;
    }
    if (!task) {
      // Pending may key by taskId equal to lastTaskId even if envelope load path differs.
      if (!needle) return;
      const entry = pending.find(
        (e) => e.taskId === needle || e.taskPath === needle
      );
      if (!entry) return;
      try {
        task = await loadTaskEnvelope(mount.env.fs, entry.taskPath);
      } catch {
        return;
      }
    }
    if (!isTaskWorktreeReclaimTerminalState(task.state)) return;
    if (!isTaskScopedWorktreeLane(task)) return;
    const taskId = task.id?.trim();
    if (!taskId) return;

    // Exact queue row only — never reclaim sibling pending tasks on this leave.
    const exactPending = pending.find(
      (e) =>
        e.taskId === taskId ||
        e.taskPath === task!.path ||
        (needle && (e.taskId === needle || e.taskPath === needle))
    );
    if (!exactPending) return;
    if (exactPending.taskId !== taskId && task.id && exactPending.taskId !== task.id) {
      // Path matched a different id — refuse cross-task reclaim.
      return;
    }

    await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      task,
      `session.settle:${input.trigger}`
    );
  } catch {
    // Best-effort settle retry; mount recovery remains the durable backstop.
  }
}

/**
 * Test-only TOCTOU hook for Service auto-reclaim: runs after evaluate eligibility
 * succeeds and before pre-remove Session re-probe / git worktree remove.
 * Production never sets this.
 */
let beforeTaskWorktreeReclaimRemoveForTests:
  | (() => void | Promise<void>)
  | undefined;
let beforeTaskWorktreeReclaimReloadForTests:
  | (() => void | Promise<void>)
  | undefined;

/** Install/clear the Service reclaim pre-remove TOCTOU hook (tests only). */
export function setBeforeTaskWorktreeReclaimRemoveForTests(
  hook: (() => void | Promise<void>) | undefined
): void {
  beforeTaskWorktreeReclaimRemoveForTests = hook;
}

/** Test-only hook immediately before the exact envelope reload under lock. */
export function setBeforeTaskWorktreeReclaimReloadForTests(
  hook: (() => void | Promise<void>) | undefined
): void {
  beforeTaskWorktreeReclaimReloadForTests = hook;
}

/**
 * Best-effort auto-reclaim of a terminal agentProfile Task worktree.
 * Never throws into the lifecycle RPC: fail-closed diagnostics are events only.
 * Does not touch Role worktrees, commits, branches, or operational records.
 *
 * On terminal transitions observed by this feature, enqueues a narrow pending
 * marker so restart recovery retries only those entries (no historical mass-clean).
 *
 * Critical section (P0): final Session settle re-probe + clean/ownership
 * revalidation + exact remove run under the same per-Task lifecycle lock as
 * accept/reject/interrupt/rebind, so restart/rebind cannot race the remove.
 * Bound Session is re-probed immediately before git worktree remove; terminal
 * + turnBusy/alive or a late dirty write fails closed (SESSION_ACTIVE/DIRTY)
 * and retries after session settle / mount recovery.
 */
async function maybeAutoReclaimTaskWorktree(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope,
  reason: string
): Promise<TaskWorktreeReclaimResult | undefined> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return undefined;

  // Only agentProfile lanes with a recorded Git path participate.
  if (!isTaskScopedWorktreeLane(task)) return undefined;
  if (!isTaskWorktreeReclaimTerminalState(task.state)) return undefined;
  if (!task.worktree && !task.branch) return undefined;
  const taskId = task.id?.trim();
  if (!taskId) return undefined;
  const taskPath = task.path;

  // Always record pending for this feature's terminal observation (restart-safe).
  // Enqueue is outside the lifecycle critical section so concurrent lifecycle
  // ops still leave a durable retry marker.
  try {
    await enqueueTaskWorktreeReclaimPending(mount.env.fs, {
      taskId,
      taskPath,
      workspaceRoot: mount.workspaceRoot,
      enqueuedAt: mount.env.clock.now(),
      trigger: reason,
    });
  } catch {
    // Queue write failure must not block diagnostics; mount may still miss retry.
  }

  try {
    // Serialize final settle check + ownership/clean revalidation + exact remove
    // against Task lifecycle / restart / rebind for this taskPath.
    return await runTaskLifecycle(workspaceId, taskPath, async () => {
      // Fresh envelope under the lock (rebind / resume may have mutated sessionId).
      let liveTask: TaskEnvelope;
      try {
        await beforeTaskWorktreeReclaimReloadForTests?.();
        liveTask = await loadTaskEnvelope(mount.env.fs, taskPath);
      } catch (error) {
        const blocked: TaskWorktreeReclaimResult = {
          eligible: false,
          code: "REMOVE_FAILED",
          reason: `Exact Task envelope is unreadable under reclaim critical section; refuse remove: ${
            error instanceof Error ? error.message : String(error)
          }`,
          taskId,
          taskPath,
          taskState: task.state,
          workspace: task.workspace,
          worktree: task.worktree,
          branch: task.branch,
          targetBranch: task.targetBranch,
          details: { stage: "reload-task-envelope" },
          reclaimed: false,
          alreadyGone: false,
        };
        try {
          await recordTaskWorktreeReclaimNeedsAttention(mount.env.fs, {
            taskId,
            taskPath,
            workspaceRoot: mount.workspaceRoot,
            code: "UNREADABLE_TASK",
            reason: blocked.reason,
            attemptedAt: mount.env.clock.now(),
            trigger: reason,
          });
        } catch {
          // The existing pending row remains the fail-closed retry authority.
        }
        ctx.events.emit(
          "task.worktreeReclaim",
          workspaceId,
          {
            taskId,
            taskPath,
            taskState: task.state,
            code: "UNREADABLE_TASK",
            eligible: false,
            reclaimed: false,
            alreadyGone: false,
            reason: blocked.reason,
            worktree: task.worktree,
            branch: task.branch,
            trigger: reason,
          },
          "self"
        );
        return blocked;
      }
      if (!isTaskWorktreeReclaimTerminalState(liveTask.state)) {
        const blocked: TaskWorktreeReclaimResult = {
          eligible: false,
          code: "NOT_TERMINAL",
          reason: `Task state=${liveTask.state} is no longer terminal under reclaim critical section; refuse remove.`,
          taskId,
          taskPath,
          taskState: liveTask.state,
          workspace: liveTask.workspace,
          worktree: liveTask.worktree,
          branch: liveTask.branch,
          targetBranch: liveTask.targetBranch,
          reclaimed: false,
          alreadyGone: false,
        };
        ctx.events.emit(
          "task.worktreeReclaim",
          workspaceId,
          {
            taskId,
            taskPath,
            taskState: liveTask.state,
            code: blocked.code,
            eligible: false,
            reclaimed: false,
            alreadyGone: false,
            reason: blocked.reason,
            worktree: liveTask.worktree,
            branch: liveTask.branch,
            trigger: reason,
          },
          "self"
        );
        return blocked;
      }

      const settled = await assertTaskExecutionSettledForWorktreeReclaim(
        ctx,
        workspaceId,
        liveTask
      );
      if (!settled.ok) {
        const blocked: TaskWorktreeReclaimResult = {
          eligible: false,
          code: "SESSION_ACTIVE",
          reason: settled.reason,
          taskId,
          taskPath: liveTask.path,
          taskState: liveTask.state,
          workspace: liveTask.workspace,
          worktree: liveTask.worktree,
          branch: liveTask.branch,
          targetBranch: liveTask.targetBranch,
          details: settled.details,
          reclaimed: false,
          alreadyGone: false,
        };
        ctx.events.emit(
          "task.worktreeReclaim",
          workspaceId,
          {
            taskId,
            taskPath: liveTask.path,
            taskState: liveTask.state,
            code: blocked.code,
            eligible: false,
            reclaimed: false,
            alreadyGone: false,
            reason: blocked.reason,
            worktree: liveTask.worktree,
            branch: liveTask.branch,
            trigger: reason,
            ...(blocked.details ? { details: blocked.details } : {}),
          },
          "self"
        );
        return blocked;
      }

      const result = await reclaimTaskWorktreeForEnvelope(
        mount.env.fs,
        mount.workspaceRoot,
        liveTask,
        {
          // Re-probe bound Session immediately before exact remove (inside same lock).
          assertSessionSettledBeforeRemove: () =>
            assertTaskExecutionSettledForWorktreeReclaim(
              ctx,
              workspaceId,
              liveTask
            ),
          beforeRemoveForTests: beforeTaskWorktreeReclaimRemoveForTests,
        }
      );
      if (result.reclaimed || result.code === "ALREADY_GONE") {
        try {
          await dequeueTaskWorktreeReclaimPending(mount.env.fs, taskId);
        } catch {
          // Idempotent retry will clear later.
        }
      } else if (result.code === "NOT_APPLICABLE") {
        // Permanent non-candidate — drop pending so mount does not spin.
        try {
          await dequeueTaskWorktreeReclaimPending(mount.env.fs, taskId);
        } catch {
          // ignore
        }
      } else if (!result.eligible) {
        // Refused (DIRTY / SESSION_ACTIVE / UNINTEGRATED / ownership / …):
        // persist diagnosable needs-attention; do not spin in the same boot.
        try {
          await recordTaskWorktreeReclaimNeedsAttention(mount.env.fs, {
            taskId,
            taskPath: liveTask.path,
            workspaceRoot: mount.workspaceRoot,
            code: result.code,
            reason: result.reason,
            attemptedAt: mount.env.clock.now(),
            trigger: reason,
          });
        } catch {
          // Diagnostic persistence is best-effort; entry may still be pending.
        }
      }
      if (result.reclaimed || !result.eligible) {
        ctx.events.emit(
          "task.worktreeReclaim",
          workspaceId,
          {
            taskId: result.taskId ?? liveTask.id,
            taskPath: result.taskPath ?? liveTask.path,
            taskState: result.taskState ?? liveTask.state,
            code: result.code,
            eligible: result.eligible,
            reclaimed: result.reclaimed,
            alreadyGone: result.alreadyGone,
            reason: result.reason,
            worktree: result.worktree,
            branch: result.branch,
            trigger: reason,
            ...(result.details ? { details: result.details } : {}),
          },
          "self"
        );
      }
      return result;
    });
  } catch (err) {
    ctx.events.emit(
      "task.worktreeReclaim",
      workspaceId,
      {
        taskId: task.id,
        taskPath: task.path,
        taskState: task.state,
        code: "REMOVE_FAILED",
        eligible: false,
        reclaimed: false,
        alreadyGone: false,
        reason: `Auto-reclaim threw: ${err instanceof Error ? err.message : String(err)}`,
        trigger: reason,
      },
      "self"
    );
    return undefined;
  }
}

/**
 * On workspace mount / Service restart: retry reclaim for queue entries for this
 * workspace (pending + needs-attention). One pass per call — dirty lanes cleaned
 * offline can recover on remount. Historical multi-batch loop must not re-spin
 * needs-attention in the same boot; that path only attempts newly discovered
 * candidates once.
 */
export async function recoverTerminalTaskWorktreesOnMount(
  ctx: HandlerContext,
  workspaceId: string
): Promise<{ attempted: number; reclaimed: number; refused: number }> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return { attempted: 0, reclaimed: 0, refused: 0 };
  if (!(await isGitWorkspace(mount.workspaceRoot))) {
    return { attempted: 0, reclaimed: 0, refused: 0 };
  }

  let attempted = 0;
  let reclaimed = 0;
  let refused = 0;
  const pending = await listTaskWorktreeReclaimPendingForWorkspace(
    mount.env.fs,
    mount.workspaceRoot,
    (a, b) => isSameWorkspaceRoot(nodePath.resolve(a), nodePath.resolve(b))
  );
  for (const entry of pending) {
    attempted += 1;
    let task: TaskEnvelope;
    try {
      task = await loadTaskEnvelope(mount.env.fs, entry.taskPath);
    } catch (error) {
      const exists = await mount.env.fs
        .exists(entry.taskPath)
        .catch(() => true);
      try {
        await recordTaskWorktreeReclaimNeedsAttention(mount.env.fs, {
          taskId: entry.taskId,
          taskPath: entry.taskPath,
          workspaceRoot: mount.workspaceRoot,
          code: exists ? "UNREADABLE_TASK" : "TASK_MISSING",
          reason: exists
            ? `Pending reclaim Task envelope is unreadable: ${
                error instanceof Error ? error.message : String(error)
              }`
            : "Pending reclaim Task envelope is missing; exact lane ownership cannot be proven",
          attemptedAt: mount.env.clock.now(),
          trigger: entry.trigger ?? "workspace.mount",
        });
      } catch {
        // Keep the pre-existing row when even diagnostic persistence fails.
      }
      refused += 1;
      continue;
    }
    // Identity drift: pending taskId must still match envelope.
    if (task.id && task.id !== entry.taskId) {
      refused += 1;
      continue;
    }
    const result = await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      task,
      entry.trigger ? `workspace.mount:${entry.trigger}` : "workspace.mount"
    );
    if (result?.reclaimed) reclaimed += 1;
    else if (result && !result.eligible) refused += 1;
  }
  return { attempted, reclaimed, refused };
}

async function recoverTerminalTaskWorktreeBatch(
  ctx: HandlerContext,
  workspaceId: string,
  attemptedTaskIds: Set<string>,
  shouldStop: () => boolean
): Promise<boolean> {
  const mount = ctx.host.get(workspaceId);
  if (!mount || shouldStop()) return false;
  if (!(await isGitWorkspace(mount.workspaceRoot))) return false;
  const pending = await listTaskWorktreeReclaimPendingForWorkspace(
    mount.env.fs,
    mount.workspaceRoot,
    (a, b) => isSameWorkspaceRoot(nodePath.resolve(a), nodePath.resolve(b))
  );
  const remaining = pending
    .filter((entry) => !attemptedTaskIds.has(entry.taskId))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const batch = remaining.slice(
    0,
    TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE
  );
  for (const entry of batch) {
    if (shouldStop()) return false;
    attemptedTaskIds.add(entry.taskId);
    let task: TaskEnvelope;
    try {
      task = await loadTaskEnvelope(mount.env.fs, entry.taskPath);
    } catch (error) {
      const exists = await mount.env.fs
        .exists(entry.taskPath)
        .catch(() => true);
      await recordTaskWorktreeReclaimNeedsAttention(mount.env.fs, {
        taskId: entry.taskId,
        taskPath: entry.taskPath,
        workspaceRoot: mount.workspaceRoot,
        code: exists ? "UNREADABLE_TASK" : "TASK_MISSING",
        reason: exists
          ? `Pending reclaim Task envelope is unreadable: ${
              error instanceof Error ? error.message : String(error)
            }`
          : "Pending reclaim Task envelope is missing; exact lane ownership cannot be proven",
        attemptedAt: mount.env.clock.now(),
        trigger: entry.trigger ?? "workspace.mount",
      });
      continue;
    }
    if (task.id !== entry.taskId) {
      await recordTaskWorktreeReclaimNeedsAttention(mount.env.fs, {
        taskId: entry.taskId,
        taskPath: entry.taskPath,
        workspaceRoot: mount.workspaceRoot,
        code: "TASK_ID_MISMATCH",
        reason: `Pending reclaim identity ${entry.taskId} does not match ${task.id ?? "missing"}`,
        attemptedAt: mount.env.clock.now(),
        trigger: entry.trigger ?? "workspace.mount",
      });
      continue;
    }
    await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      task,
      entry.trigger ? `workspace.mount:${entry.trigger}` : "workspace.mount"
    );
  }
  return remaining.length > batch.length;
}

// ---- Historical one-pass Task worktree reclaim (Service-owned, drainable) ----

type HistoricalReclaimJob = {
  workspaceId: string;
  fsKey: object;
  cancelled: boolean;
  phase: "pending" | "historical";
  pendingAttemptedTaskIds: Set<string>;
  /** In-flight batch promise (for drain on unmount/shutdown). */
  inflight: Promise<void> | null;
  /** setImmediate / setTimeout handle for the next batch tick. */
  timer: ReturnType<typeof setImmediate> | ReturnType<typeof setTimeout> | null;
};

const historicalReclaimJobs = new Map<string, HistoricalReclaimJob>();
const historicalReclaimJobsByFs = new WeakMap<object, HistoricalReclaimJob>();
/** Process-wide: refuse new historical work during Service stop. */
let historicalReclaimAccepting = true;

function deleteHistoricalReclaimJob(job: HistoricalReclaimJob): void {
  if (historicalReclaimJobs.get(job.workspaceId) === job) {
    historicalReclaimJobs.delete(job.workspaceId);
  }
  if (historicalReclaimJobsByFs.get(job.fsKey) === job) {
    historicalReclaimJobsByFs.delete(job.fsKey);
  }
}

/**
 * Test-only: hold the first historical batch until released so mount can return
 * while background work is still scheduled (proves non-blocking startup).
 */
let historicalReclaimBatchHoldForTests:
  | { promise: Promise<void>; release: () => void }
  | undefined;

/** Install/clear a gate that holds historical batch work (tests only). */
export function setHistoricalReclaimBatchHoldForTests(
  enabled: boolean
): { release: () => void } | undefined {
  if (!enabled) {
    historicalReclaimBatchHoldForTests?.release();
    historicalReclaimBatchHoldForTests = undefined;
    return undefined;
  }
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  historicalReclaimBatchHoldForTests = { promise, release };
  return { release };
}

/** Test helper: re-enable historical accept after in-process stop. */
export function enableHistoricalTaskWorktreeReclaimAccept(): void {
  historicalReclaimAccepting = true;
}

/**
 * Stop scheduling new historical batches (call before runtime teardown).
 * In-flight batches still run until drained or cancelled per workspace.
 */
export function stopHistoricalTaskWorktreeReclaimAccept(): void {
  historicalReclaimAccepting = false;
  for (const job of historicalReclaimJobs.values()) {
    job.cancelled = true;
    if (job.timer !== null) {
      clearTimeout(job.timer as ReturnType<typeof setTimeout>);
      clearImmediate(job.timer as ReturnType<typeof setImmediate>);
      job.timer = null;
    }
  }
}

/**
 * Cancel + bounded-drain historical reclaim for one workspace (unmount).
 * Waits for inflight batch to settle (or timeout) before returning.
 * Teardown callers must not dispose fs while inflight is still running.
 */
export async function cancelAndDrainHistoricalTaskWorktreeReclaim(
  workspaceId: string,
  timeoutMs = 5_000
): Promise<void> {
  const job = historicalReclaimJobs.get(workspaceId);
  if (!job) return;
  job.cancelled = true;
  if (job.timer !== null) {
    clearTimeout(job.timer as ReturnType<typeof setTimeout>);
    clearImmediate(job.timer as ReturnType<typeof setImmediate>);
    job.timer = null;
  }
  const inflight = job.inflight;
  if (!inflight) {
    deleteHistoricalReclaimJob(job);
    return;
  }
  const bound =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : 5_000;
  if (bound === 0) {
    await inflight;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      inflight,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Historical Task worktree reclaim drain timed out for ${workspaceId}`
              )
            ),
          bound
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  deleteHistoricalReclaimJob(job);
}

/**
 * Cancel all historical jobs and drain in-flight batches (Service shutdown).
 */
export async function drainHistoricalTaskWorktreeReclaimForShutdown(
  timeoutMs = 5_000
): Promise<void> {
  stopHistoricalTaskWorktreeReclaimAccept();
  const ids = [...historicalReclaimJobs.keys()];
  const results = await Promise.allSettled(
    ids.map((id) => cancelAndDrainHistoricalTaskWorktreeReclaim(id, timeoutMs))
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected) throw rejected.reason;
}

/**
 * After mount returns: schedule Service-owned bounded historical batches until
 * the one inventory pass completes. Does not block workspace.mount.
 */
export function scheduleHistoricalTaskWorktreeReclaimAfterMount(
  ctx: HandlerContext,
  workspaceId: string
): void {
  if (!historicalReclaimAccepting) return;
  const mount = ctx.host.get(workspaceId);
  if (!mount) return;
  const fsKey = mount.env.fs as object;
  // Duplicate mounts must share the exact mounted FsAdapter runner. Never
  // replace a live job without draining it first.
  const byFs = historicalReclaimJobsByFs.get(fsKey);
  // A cancelled runner still owns this FsAdapter until its in-flight batch
  // settles and deleteHistoricalReclaimJob releases the lease.
  if (byFs) return;
  const byWorkspace = historicalReclaimJobs.get(workspaceId);
  if (byWorkspace) return;
  const job: HistoricalReclaimJob = {
    workspaceId,
    fsKey,
    cancelled: false,
    phase: "pending",
    pendingAttemptedTaskIds: new Set<string>(),
    inflight: null,
    timer: null,
  };
  historicalReclaimJobs.set(workspaceId, job);
  historicalReclaimJobsByFs.set(fsKey, job);
  enqueueHistoricalReclaimBatchTick(ctx, job);
}

function enqueueHistoricalReclaimBatchTick(
  ctx: HandlerContext,
  job: HistoricalReclaimJob
): void {
  if (job.cancelled || !historicalReclaimAccepting) return;
  if (job.timer !== null) return;
  job.timer = setImmediate(() => {
    job.timer = null;
    if (job.cancelled || !historicalReclaimAccepting) return;
    const run = runOneHistoricalReclaimJobBatch(ctx, job)
      .then((cont) => {
        if (job.cancelled || !historicalReclaimAccepting) return;
        if (cont) enqueueHistoricalReclaimBatchTick(ctx, job);
        else deleteHistoricalReclaimJob(job);
      })
      .catch(() => {
        // Fail-closed: drop job; corrupt/incomplete scan stays incomplete on disk.
        deleteHistoricalReclaimJob(job);
      })
      .finally(() => {
        if (job.inflight === run) job.inflight = null;
        if (job.cancelled) deleteHistoricalReclaimJob(job);
      });
    job.inflight = run;
  });
}

async function runOneHistoricalReclaimJobBatch(
  ctx: HandlerContext,
  job: HistoricalReclaimJob
): Promise<boolean> {
  if (job.cancelled || !historicalReclaimAccepting) return false;
  if (job.phase === "pending") {
    const morePending = await recoverTerminalTaskWorktreeBatch(
      ctx,
      job.workspaceId,
      job.pendingAttemptedTaskIds,
      () => job.cancelled || !historicalReclaimAccepting
    );
    if (morePending) return true;
    job.phase = "historical";
    return true;
  }
  return runOneHistoricalTaskWorktreeReclaimBatch(
    ctx,
    job.workspaceId,
    () => job.cancelled || !historicalReclaimAccepting
  );
}

/**
 * One bounded historical scan batch: discover envelope paths after cursor,
 * enqueue eligible terminal agentProfile candidates, advance cursor atomically,
 * attempt maybeAutoReclaim once per newly enqueued candidate (no spin on refuse).
 * @returns true when another batch should be scheduled.
 */
export async function runOneHistoricalTaskWorktreeReclaimBatch(
  ctx: HandlerContext,
  workspaceId: string,
  shouldStop: () => boolean = () => false
): Promise<boolean> {
  if (historicalReclaimBatchHoldForTests) {
    await historicalReclaimBatchHoldForTests.promise;
  }
  if (shouldStop()) return false;
  const mount = ctx.host.get(workspaceId);
  if (!mount) return false;
  if (!(await isGitWorkspace(mount.workspaceRoot))) {
    // Nothing to reclaim; mark complete so we do not reschedule forever.
    try {
      await persistHistoricalReclaimScanBatch(mount.env.fs, {
        workspaceRoot: mount.workspaceRoot,
        examinedTaskPaths: [],
        newCandidates: [],
        scanComplete: true,
      });
    } catch {
      // ignore
    }
    return false;
  }

  const scan = await readTaskWorktreeReclaimHistoricalScan(mount.env.fs);
  if (scan?.complete === true) return false;

  const allPaths = await listTaskEnvelopePathsForReclaimScan(mount.env.fs);
  if (shouldStop()) return false;
  const remaining = taskPathsAfterHistoricalCursor(allPaths, scan?.nextTaskPath);
  if (remaining.length === 0) {
    await persistHistoricalReclaimScanBatch(mount.env.fs, {
      workspaceRoot: mount.workspaceRoot,
      examinedTaskPaths: [],
      newCandidates: [],
      scanComplete: true,
    });
    return false;
  }

  const batchSize = TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE;
  const examined = remaining.slice(0, batchSize);
  const newCandidates: Array<{
    taskId: string;
    taskPath: string;
    workspaceRoot: string;
    enqueuedAt?: string;
    trigger?: string;
  }> = [];
  const decisions: TaskWorktreeReclaimScanDecision[] = [];
  let blocked = false;
  let blockedDiagnostic:
    | { taskPath: string; reason: string; attemptedAt: string }
    | undefined;

  for (const taskPath of examined) {
    if (shouldStop()) return false;
    let task: TaskEnvelope;
    try {
      task = await loadTaskEnvelope(mount.env.fs, taskPath);
    } catch (error) {
      blockedDiagnostic = {
        taskPath,
        reason: `Historical scan could not read Task envelope: ${
          error instanceof Error ? error.message : String(error)
        }`,
        attemptedAt: mount.env.clock.now(),
      };
      blocked = true;
      break;
    }
    if (!isHistoricalReclaimScanCandidate(task, mount.workspaceRoot)) {
      decisions.push({
        taskPath,
        code: "NOT_APPLICABLE",
        reason:
          "Task is not a terminal agentProfile lane with exact recorded worktree ownership",
        attemptedAt: mount.env.clock.now(),
      });
      continue;
    }
    const taskId = task.id!.trim();
    newCandidates.push({
      taskId,
      taskPath: task.path,
      workspaceRoot: mount.workspaceRoot,
      enqueuedAt: mount.env.clock.now(),
      trigger: "historical.scan",
    });
  }

  const persistExamined = blocked
    ? examined.slice(0, newCandidates.length + decisions.length)
    : examined;
  if (persistExamined.length === 0 && blocked) {
    await recordHistoricalReclaimScanDiagnostic(mount.env.fs, {
      workspaceRoot: mount.workspaceRoot,
      taskPath: blockedDiagnostic!.taskPath,
      code: "UNREADABLE_TASK",
      reason: blockedDiagnostic!.reason,
      attemptedAt: blockedDiagnostic!.attemptedAt,
    });
    return false;
  }
  const scanComplete = !blocked && examined.length >= remaining.length;
  const persisted = await persistHistoricalReclaimScanBatch(mount.env.fs, {
    workspaceRoot: mount.workspaceRoot,
    examinedTaskPaths: persistExamined,
    newCandidates,
    decisions,
    scanComplete,
  });
  if (blockedDiagnostic) {
    await recordHistoricalReclaimScanDiagnostic(mount.env.fs, {
      workspaceRoot: mount.workspaceRoot,
      taskPath: blockedDiagnostic.taskPath,
      code: "UNREADABLE_TASK",
      reason: blockedDiagnostic.reason,
      attemptedAt: blockedDiagnostic.attemptedAt,
    });
  }

  // Attempt reclaim once for candidates this batch enqueued (or refreshed pending).
  // Refused → needs-attention via maybeAutoReclaim; do not re-loop them here.
  for (const c of persisted.enqueued) {
    if (!historicalReclaimAccepting || shouldStop()) break;
    if (!ctx.host.get(workspaceId)) break;
    let task: TaskEnvelope;
    try {
      task = await loadTaskEnvelope(mount.env.fs, c.taskPath);
    } catch {
      continue;
    }
    await maybeAutoReclaimTaskWorktree(
      ctx,
      workspaceId,
      task,
      "historical.scan"
    );
  }

  if (blocked) return false;
  return !persisted.historicalScan.complete;
}

/**
 * True when a loaded envelope is a historical cleanup candidate:
 * terminal agentProfile Task with recorded exact worktree/branch.
 * Role lanes and nonterminal/missing/ambiguous shapes are never enqueued.
 */
export function isHistoricalReclaimScanCandidate(
  task: TaskEnvelope,
  workspaceRoot: string
): boolean {
  if (!isTaskScopedWorktreeLane(task)) return false;
  if (!isTaskWorktreeReclaimTerminalState(task.state)) return false;
  const taskId = task.id?.trim();
  if (!taskId) return false;
  if (!task.path?.trim()) return false;
  const worktree = task.worktree?.trim();
  const branch = task.branch?.trim();
  // Exact recorded lane required — missing either shape is ambiguous / not a candidate.
  if (!worktree || !branch) return false;
  if (branch.startsWith("tent-role/")) return false;
  if (task.workspace?.trim()) {
    try {
      if (
        !isSameWorkspaceRoot(
          nodePath.resolve(task.workspace),
          nodePath.resolve(workspaceRoot)
        )
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Test helper: clear process-local historical job bookkeeping. */
export function resetHistoricalTaskWorktreeReclaimForTests(): void {
  historicalReclaimAccepting = true;
  for (const job of [...historicalReclaimJobs.values()]) {
    job.cancelled = true;
    if (job.timer !== null) {
      clearTimeout(job.timer as ReturnType<typeof setTimeout>);
      clearImmediate(job.timer as ReturnType<typeof setImmediate>);
      job.timer = null;
    }
    deleteHistoricalReclaimJob(job);
  }
  historicalReclaimBatchHoldForTests?.release();
  historicalReclaimBatchHoldForTests = undefined;
}

/** Test helper: process-local runner count (one per mounted FsAdapter). */
export function historicalTaskWorktreeReclaimJobCountForTests(): number {
  return historicalReclaimJobs.size;
}

/** Test helper: whether a workspace runner currently owns an in-flight batch. */
export function historicalTaskWorktreeReclaimInFlightForTests(
  workspaceId: string
): boolean {
  return historicalReclaimJobs.get(workspaceId)?.inflight !== null &&
    historicalReclaimJobs.get(workspaceId)?.inflight !== undefined;
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
 * A TaskInput may settle while prompt_complete auto-delivery is still in flight.
 * Remember one durable-draft retry so the pre-seal TaskInput gate cannot swallow
 * an otherwise completed managed turn.
 */
const managedAutoDeliverRetryRequested = new Set<string>();

/**
 * Session ids currently inside reject-resume native resumeSession.
 * A failed resume emits session.failed while the rework task is already running;
 * projection must not terminally task.fail that occupation — park/fail-loud owns it.
 */
const rejectResumeNativeInFlight = new Set<string>();

/** Per-task flight for startSession/replaceSession (authorize first, then join). */
type ManagedSessionFlightOperation = "startSession" | "replaceSession";
type ManagedSessionInFlight = {
  profileId: string;
  operation: ManagedSessionFlightOperation;
  promise: Promise<unknown>;
};
const managedSessionInFlight = new Map<string, ManagedSessionInFlight>();
const MANAGED_SESSION_IN_PROGRESS_MESSAGE =
  "managed session operation already in progress for this task";

function managedSessionFlightKey(workspaceId: string, taskPath: string): string {
  return `${workspaceId}\0${taskPath}`;
}

export function isTaskStartSessionInFlightForTests(workspaceId: string, taskPath: string): boolean {
  return managedSessionInFlight.has(managedSessionFlightKey(workspaceId, taskPath));
}
export const isManagedSessionInFlightForTests = isTaskStartSessionInFlightForTests;

function joinOrConflictManagedSessionFlight(
  existing: ManagedSessionInFlight,
  profileId: string,
  operation: ManagedSessionFlightOperation,
  taskPath: string
): Promise<unknown> {
  if (existing.profileId !== profileId || existing.operation !== operation) {
    throw new RpcError(RPC_LIFECYCLE, MANAGED_SESSION_IN_PROGRESS_MESSAGE, {
      taskPath,
      profileId,
      operation,
      inFlightProfileId: existing.profileId,
      inFlightOperation: existing.operation,
      retryable: true,
    });
  }
  return existing.promise;
}

async function runManagedSessionFlight(
  workspaceId: string,
  taskPath: string,
  profileId: string,
  operation: ManagedSessionFlightOperation,
  run: () => Promise<unknown>
): Promise<unknown> {
  const flightKey = managedSessionFlightKey(workspaceId, taskPath);
  const existing = managedSessionInFlight.get(flightKey);
  if (existing) return joinOrConflictManagedSessionFlight(existing, profileId, operation, taskPath);

  let settle!: (value: unknown) => void;
  let rejectFlight!: (reason: unknown) => void;
  const flightPromise = new Promise<unknown>((resolve, reject) => {
    settle = resolve;
    rejectFlight = reject;
  });
  flightPromise.catch(() => undefined);
  managedSessionInFlight.set(flightKey, { profileId, operation, promise: flightPromise });
  try {
    const result = await run();
    settle(result);
    return result;
  } catch (err) {
    rejectFlight(err);
    throw err;
  } finally {
    if (managedSessionInFlight.get(flightKey)?.promise === flightPromise) {
      managedSessionInFlight.delete(flightKey);
    }
  }
}

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

/**
 * Retry a preserved managed report after its blocking TaskInput is durable.
 * If prompt_complete is still projecting, its finally block drains exactly one
 * retry after releasing the in-flight key. No timers or provider re-prompting.
 */
async function requestManagedAutoDeliverRetryFromDraft(
  ctx: HandlerContext,
  input: { workspaceId: string; taskPath: string; sessionId: string }
): Promise<void> {
  const key = managedDeliverKey(input.sessionId, input.taskPath);
  if (managedAutoDeliverDone.has(key)) return;
  if (managedAutoDeliverInFlight.has(key)) {
    managedAutoDeliverRetryRequested.add(key);
    return;
  }
  await tryManagedAutoDeliver(ctx, {
    ...input,
    assistantText: "",
  });
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
    // Session terminal input cleanup:
    // - intentional seal/post-deliver stop (stopReason=user);
    // - reject-resume park / in-flight native restore;
    // - recoverable session-unavailable park (pre-Delivery);
    // - published Delivery / collaboration-terminal Task
    // all retain durable TaskInputs / UserAsks. Unbound sessions still cancel by sessionId
    // (no Task mutation owns cleanup). Bound pre-Delivery tasks park recoverably and
    // preserve pending rows for explicit task.startSession recovery.
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
    // Bound pre-delivery running/waiting occupations park recoverably — retain inputs
    // even before the park mutation lands (same event tick).
    const boundPreDeliveryActive =
      !!boundTaskForTerminal &&
      (boundTaskForTerminal.state === "running" ||
        boundTaskForTerminal.state === "waiting") &&
      !isTaskCollaborationTerminal(boundTaskForTerminal);
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
    } else if (
      !retainInputsOnTerminal &&
      boundTaskForTerminal &&
      !boundPreDeliveryActive &&
      boundTaskForTerminal.state === "failed"
    ) {
      // Terminal failed Task (legacy/start-launch fail path): cancel leftover pending rows.
      await cancelUserAsksForTask(
        ctx,
        workspaceId,
        boundTaskForTerminal.path,
        ev.type === "session.failed" ? "session.failed" : "session.exited"
      );
      await cancelTaskInputsForTask(
        ctx,
        workspaceId,
        boundTaskForTerminal.path,
        ev.type === "session.failed" ? "session.failed" : "session.exited"
      );
    }

    // Session terminal is a supported settle trigger for pending Task worktree reclaim
    // (SESSION_ACTIVE may have deferred cleanup while cwd was still owned).
    if (boundTaskForTerminal && isTaskCollaborationTerminal(boundTaskForTerminal)) {
      await retryPendingWorktreeReclaimAfterSessionSettle(ctx, workspaceId, {
        sessionId: ev.sessionId,
        lastTaskId: boundTaskForTerminal.id || boundTaskForTerminal.path,
        task: boundTaskForTerminal,
        trigger: ev.type,
      });
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
        // Unintentional managed Session death before Delivery → recoverable park
        // waiting(external) (shared helper with remount reconcile). Diagnostic-only
        // once Delivery is published, reject-resume park owns the occupation, or
        // seal/post-deliver intentionally stopped the process (stopReason=user).
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
        await parkTaskForUnavailableSession(ctx, {
          workspaceId: mount.workspaceId,
          taskPath: task.path,
          sessionId: ev.sessionId,
          reason: ev.type,
          detail:
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
 * Terminal fail path for cases that still release occupation (e.g. startSession
 * launch failure with no recoverable managed Session binding). Live runtime
 * session.failed / session.exited before Delivery use parkTaskForUnavailableSession
 * instead — do not route those events here.
 *
 * Re-reads and mutates under one workspace lock so a late event cannot cancel
 * durable review-feedback after reject-resume park, or demote a task that has
 * already left the active pre-delivery occupation.
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
  let failedTask: TaskEnvelope | undefined;
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
    failedTask = failed;
  });

  // Git worktree remove must stay outside MutationBus (same rule as integrate).
  if (appliedFailure && failedTask) {
    await maybeAutoReclaimTaskWorktree(ctx, input.workspaceId, failedTask, input.reason);
  }

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
 * Recoverable session-unavailable park and reject-resume park also retain.
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
  if (isSessionUnavailableParkedWait(input.task)) return true;
  // Published Delivery / post-review terminal: session death is diagnostic.
  if (isTaskCollaborationTerminal(input.task) && input.task.state !== "failed") {
    return true;
  }
  // Already-failed task: still cancel leftover pending rows (cleanup), unless
  // this was a recoverable park (handled above).
  return false;
}

/**
 * Whether runtime terminal must skip Task mutation (recoverable park) for this
 * bound task. Diagnostic-only for intentional stop, seal races, reject-resume
 * parks, already session-unavailable parks, and published/collaboration terminals.
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
  // Already parked for session unavailability — idempotent; skip re-entry noise.
  if (isSessionUnavailableParkedWait(input.task)) return true;
  // Defensive: collaboration-terminal tasks never enter the park branch via
  // the outer state filter, but keep the invariant local and explicit.
  if (isTaskCollaborationTerminal(input.task) && input.task.state !== "failed") {
    return true;
  }
  return false;
}

/**
 * Managed ACP path: capture final assistant response → same task.deliver lifecycle
 * **only when explicit outcome=delivered**.
 * - summary/report = assistant final reply body after outcome wire
 * - outcome blocked|needs-input → park via existing wait/UserAsk paths; no ready Delivery
 * - never auto-accept; review → pending independent accept; bypass/agent-decide only when
 *   legal for Role user-facing delivery (downstream always review)
 * - empty/error already filtered by adapter; still refuse empty here
 * - duplicate completion / already-delivered / terminal → ignore (no second delivery)
 * - production auto-collects pending commits from the task's authoritative role lane
 * - **Atomic boundary:** seal the managed turn (stop process / cancel tool asks)
 *   *before* publishing Delivery so post-response tool/write/commit cannot race
 *   dispatcher rebase or user accept. turn busy/idle is an internal fact; session
 *   live alone is not "turn done".
 * - **TaskInput ordering:** assert open TaskInputs **before** seal so refusal leaves
 *   the managed Session live; re-assert under the final publish mutation (TOCTOU).
 *   Seal never cancels TaskInput blockers.
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
  let rawReport = input.assistantText.trim();
  let sessionId = input.sessionId.trim();
  if (!rawReport) {
    try {
      const draft = await ctx.managedDeliveryReportDrafts.get(
        input.workspaceId,
        input.taskPath
      );
      if (draft?.assistantText?.trim()) {
        rawReport = draft.assistantText.trim();
        if (!sessionId && draft.sessionId) {
          sessionId = draft.sessionId;
        }
      }
    } catch {
      // Draft lookup failure must not invent a delivery.
    }
  }
  if (!rawReport || !sessionId) {
    // Adapter should have failed already; do not invent a delivery.
    return;
  }

  // A non-empty natural final report is deliverable by default. A valid control
  // header may still select delivered/blocked/needs-input; malformed or absent
  // control text remains part of the delivered report instead of discarding it.
  let parsedOutcome = parseTaskOutcomeReport(rawReport);
  if (!parsedOutcome) {
    parsedOutcome = {
      outcome: "delivered" as const,
      report: rawReport,
    };
  }
  if (parsedOutcome.outcome !== "delivered") {
    await handleManagedNonDeliveredOutcome(ctx, {
      workspaceId: input.workspaceId,
      taskPath: input.taskPath,
      sessionId,
      outcome: parsedOutcome.outcome,
      report: parsedOutcome.report || rawReport,
    });
    return;
  }
  const summary = (parsedOutcome.report || rawReport).trim();
  if (!summary) {
    // delivered with empty body is not a usable Delivery.
    await handleManagedNonDeliveredOutcome(ctx, {
      workspaceId: input.workspaceId,
      taskPath: input.taskPath,
      sessionId,
      outcome: "delivered",
      report: "",
      emptyDeliveredBody: true,
    });
    return;
  }
  // Keep the full outcome wire in drafts so idempotent retry re-parses correctly.
  const draftText = rawReport;

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
      assistantText: draftText,
    });
    draftPreserved = true;

    // Outside the mutation bus: capture-once baseline for legacy Git-lane tasks
    // missing roleBranchBase. Nested mutations.run would deadlock.
    if (input.commits === undefined) {
      await ensureTaskWorkspaceLane(ctx, input.workspaceId, pre);
    }

    // Pre-seal TaskInput gate: refuse BEFORE stopping the managed session so
    // open blockers leave Session live and intact. Same authority code as public
    // deliver. Seal must not cancel TaskInput rows (see sealManagedSessionBeforeDelivery).
    await assertNoBlockingTaskInputsForDeliver(ctx, input.workspaceId, pre);

    // Seal turn BEFORE Delivery: process must not keep mutating the worktree
    // after the task enters delivered. stop-after-deliver semantics preserved
    // (role slot freed; registry resume metadata retained) but ordered first.
    // Only reached when no open TaskInput blockers at pre-seal check.
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

    // Per-Task flight after seal: prepare → Git → finalize (MutationBus short).
    let published = false;
    await runTaskLifecycle(input.workspaceId, input.taskPath, async () => {
      type Phase =
        | { kind: "skip" }
        | { kind: "done"; result: TaskDeliverResult }
        | {
            kind: "auto";
            boxId: string;
            commits: string[];
            targetHead?: string;
            opts: {
              summary: string;
              decision?: DeliverDecision;
              commits?: string[];
              targetHead?: string;
              lastOutcome?: "delivered";
            };
          };
      const phase = await ctx.mutations.run(input.workspaceId, async (): Promise<Phase> => {
        const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);

        // Only deliver from active running managed session for this sessionId.
        if (task.state !== "running") {
          // Already delivered / review / terminal / interrupted — ignore duplicate.
          return { kind: "skip" };
        }
        if (task.sessionId && task.sessionId !== sessionId) {
          return { kind: "skip" };
        }

        // Ready delivery already present → lifecycle forbids double ready.
        const existing = await loadDeliveries(mount.env.fs, {
          taskId: task.id || input.taskPath,
        });
        if (existing.some((d) => d.status === "ready")) {
          managedAutoDeliverDone.add(key);
          published = true;
          return { kind: "skip" };
        }

        // TOCTOU revalidation: same TaskInput authority under the publish mutation
        // so a concurrent sendInput cannot slip a blocker past the pre-seal gate.
        // sendInput state+add is also on this MutationBus + lifecycle flight.
        await assertNoBlockingTaskInputsForDeliver(ctx, input.workspaceId, task);

        // Seal-after, publish-before: refuse dirty task worktree so uncommitted
        // agent edits cannot be skipped in favor of stale already-committed SHAs.
        // Fail-loud keeps task running for commit-then-retry (same as public deliver).
        await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, task);
        // Ordinary executor lane history gate (cx-5q6za6): no merge/foreign ancestry.
        await assertOrdinaryExecutorLaneHistoryForDeliver(mount.workspaceRoot, task);

        // Collect pending role-lane commits unless the caller supplied an explicit list
        // (tests only). Production always auto-collects via the authoritative lane contract.
        // Collection runs after seal so tail commits after end_turn cannot appear.
        let commits = input.commits;
        if (commits === undefined) {
          commits = await collectManagedDeliveryCommits(mount.workspaceRoot, task);
        }
        // Explicit or auto-collected commits[] must belong to the recorded executor lane.
        await assertDeliverCommitsBelongToExecutorLane(mount.workspaceRoot, task, commits);
        const pendingCommits = uniqueCommitRefs(commits);
        const targetHead =
          pendingCommits.length > 0
            ? await snapshotIntegrationTargetHead(mount.workspaceRoot, task)
            : undefined;
        if (targetHead && afterTargetHeadSnapshotForTests) {
          await afterTargetHeadSnapshotForTests(mount.workspaceRoot);
        }

        ctx.host.markSelfWrite(input.workspaceId);

        // agent-decide without an explicit agent decision: request-review (never auto-accept).
        // Downstream Task Agent → parent is always review (elevated policy already refused at dispatch).
        const policy = task.deliveryPolicy ?? "review";
        const decision =
          policy === "agent-decide" ? ("request-review" as const) : undefined;

        const opts = {
          summary,
          decision,
          lastOutcome: "delivered" as const,
          ...(pendingCommits.length > 0 ? { commits: pendingCommits } : {}),
          ...(targetHead ? { targetHead } : {}),
        };
        const prepared = await prepareTaskDeliver(mount.env, input.taskPath, opts);
        if (prepared.kind === "done") {
          return { kind: "done", result: prepared.result };
        }
        return {
          kind: "auto",
          boxId: prepared.boxId,
          commits: pendingCommits,
          ...(targetHead ? { targetHead } : {}),
          opts,
        };
      });

      if (phase.kind === "skip") return;
      let result: TaskDeliverResult;
      if (phase.kind === "done") {
        result = phase.result;
      } else {
        if (phase.commits.length > 0) {
          const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, input.taskPath);
          await makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate, {
            expectedTargetHead: phase.targetHead,
            action: "task.deliver",
            taskPath: input.taskPath,
          })(phase.commits);
        }
        result = await ctx.mutations.run(input.workspaceId, async () => {
          ctx.host.markSelfWrite(input.workspaceId);
          return finalizeTaskDeliverAuto(mount.env, input.taskPath, phase.opts, {
            kind: "auto",
            boxId: phase.boxId,
          });
        });
      }

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

    // Reclaim only AFTER managed session stop — cwd must not still own the worktree.
    if (published) {
      try {
        const mountAfter = ctx.host.get(input.workspaceId);
        if (mountAfter) {
          const terminalTask = await loadTaskEnvelope(mountAfter.env.fs, input.taskPath);
          if (terminalTask.state === "accepted") {
            await maybeAutoReclaimTaskWorktree(
              ctx,
              input.workspaceId,
              terminalTask,
              "session.prompt_complete"
            );
          }
        }
      } catch {
        // Best-effort; pending queue + mount recovery retry.
      }
    }
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
    const retryRequested = managedAutoDeliverRetryRequested.delete(key);
    if (retryRequested && !managedAutoDeliverDone.has(key)) {
      // Drain only after the first attempt releases its key. Awaiting keeps the
      // retry within Service lifecycle accounting without recursive overlap.
      await tryManagedAutoDeliver(ctx, {
        workspaceId: input.workspaceId,
        taskPath: input.taskPath,
        sessionId,
        assistantText: "",
      });
    }
  }
}

/**
 * Managed final report with outcome ≠ delivered (or missing/invalid/empty).
 * Never publishes a ready Delivery. Records lastOutcome when known; parks
 * needs-input / blocked via existing task.wait paths; leaves session diagnostic.
 */
async function handleManagedNonDeliveredOutcome(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId: string;
    outcome: TaskOutcome | null;
    report: string;
    emptyDeliveredBody?: boolean;
  }
): Promise<void> {
  const mount = ctx.host.get(input.workspaceId);
  if (!mount) return;
  const sessionId = input.sessionId.trim();
  const key = managedDeliverKey(sessionId, input.taskPath);
  // Do not mark done — a later turn may still deliver.
  try {
    const task = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
    if (!task) return;
    if (task.state !== "running" && task.state !== "waiting") return;
    if (task.sessionId && task.sessionId !== sessionId) return;

    const outcome = input.outcome;
    const report =
      input.report.trim() ||
      (input.emptyDeliveredBody
        ? "outcome=delivered but report body was empty"
        : outcome
          ? `outcome=${outcome}`
          : "managed final report missing explicit outcome: delivered|blocked|needs-input");

    if (outcome === "needs-input" || outcome === "blocked") {
      await runTaskLifecycle(input.workspaceId, input.taskPath, async () => {
        await ctx.mutations.run(input.workspaceId, async () => {
          ctx.host.markSelfWrite(input.workspaceId);
          const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
          if (current.state !== "running") return;
          await patchTaskEnvelope(mount.env.fs, input.taskPath, {
            lastOutcome: outcome,
            state: "waiting",
            wait: {
              reason: outcome === "needs-input" ? "user-input" : "external",
              summary: report.slice(0, 2000),
              code: outcome === "needs-input" ? "needs_input" : "blocked",
            },
            updatedAt: mount.env.clock.now(),
          });
        });
      });
      const after = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
      if (after) emitTaskState(ctx, input.workspaceId, after, "session.prompt_complete");
    }

    try {
      await ctx.runtime.registry.update(sessionId, {
        lastError: input.emptyDeliveredBody
          ? "managed outcome=delivered but empty report body (no Delivery)"
          : outcome
            ? `managed outcome=${outcome} (no ready Delivery)`
            : "managed final report missing explicit outcome (no ready Delivery)",
      });
    } catch {
      // Session row may be gone.
    }
    ctx.events.emit(
      "session.state",
      input.workspaceId,
      {
        sessionId,
        taskPath: input.taskPath,
        taskState: (await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null))
          ?.state,
        runtimeEvent: "session.prompt_complete.outcome",
        outcome: outcome ?? "missing",
        error: report.slice(0, 500),
        deliveryPublished: false,
        taskFailed: false,
      },
      "service"
    );
  } catch (err) {
    console.error(
      `[managed outcome] non-delivered handling failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    // Allow a later successful delivered turn for the same session+task.
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
 * Stops the process (and cancels pending tool asks / A2U UserAsks) so
 * post-response worktree mutations cannot land after the task enters delivered.
 * Returns true when the session is no longer able to mutate (dead / terminal).
 * Returns false only when a stop was required and the process is still alive.
 *
 * Registry resume metadata is retained (stopReason=user).
 *
 * **Must not cancel TaskInput rows.** Open pending/processing/failed inputs are
 * Delivery blockers; silently cancelling them on seal would let a ready Delivery
 * publish without consumption. Authority stays on assertNoBlockingTaskInputsForDeliver.
 * Post-success cleanup may still cancel leftover open rows in stopManagedSessionAfterDelivery.
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
    // Intentionally do NOT cancelTaskInputsForSession here — seal must not
    // rewrite open U2A rows that still block ready Delivery.
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
      // After a successful ready Delivery, open rows should already be terminal
      // (gate refused otherwise). Cancel only still-open pending/failed leftovers;
      // delivered / processing pin / uncertain stay.
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

/**
 * Test-only: pause combined-dispatch compensation before the atomic
 * running/no-session interrupt section. Lets tests bind a Session concurrently
 * and prove compensation skips. Production never sets this.
 */
let beforeCombinedDispatchCompensateForTests:
  | ((input: { workspaceId: string; taskPath: string }) => Promise<void>)
  | null = null;

export function setBeforeCombinedDispatchCompensateForTests(
  fn: ((input: { workspaceId: string; taskPath: string }) => Promise<void>) | null
): void {
  beforeCombinedDispatchCompensateForTests = fn;
}

/**
 * Test-only: after commit-bearing deliver snapshots targetHead and before
 * integrate/assert runs, invoke this hook (e.g. advance target branch).
 * Production never sets this.
 */
let afterTargetHeadSnapshotForTests:
  | ((workspaceRoot: string) => Promise<void>)
  | null = null;

export function setAfterTargetHeadSnapshotForTests(
  fn: ((workspaceRoot: string) => Promise<void>) | null
): void {
  afterTargetHeadSnapshotForTests = fn;
}

/**
 * Test-only: after Role claim prepare succeeds and before Core taskClaim write.
 * Production never sets this. Used to prove failed claim leaves Task queued.
 */
let beforeTaskClaimCoreForTests:
  | ((input: {
      workspaceId: string;
      taskPath: string;
      task: TaskEnvelope;
    }) => Promise<void>)
  | null = null;

export function setBeforeTaskClaimCoreForTests(
  fn:
    | ((input: {
        workspaceId: string;
        taskPath: string;
        task: TaskEnvelope;
      }) => Promise<void>)
    | null
): void {
  beforeTaskClaimCoreForTests = fn;
}

/**
 * Test-only: inside backfill lifecycle flight + mutation, before re-read/write.
 * Production never sets this. Used to prove backfill cannot interleave with deliver.
 */
let beforeTaskBackfillWorkspaceLaneBaseForTests:
  | ((input: { workspaceId: string; taskPath: string }) => Promise<void>)
  | null = null;

export function setBeforeTaskBackfillWorkspaceLaneBaseForTests(
  fn: ((input: { workspaceId: string; taskPath: string }) => Promise<void>) | null
): void {
  beforeTaskBackfillWorkspaceLaneBaseForTests = fn;
}

/** Test helper: clear in-process managed deliver dedup (does not touch disk). */
export function resetManagedAutoDeliverDedupForTests(): void {
  managedAutoDeliverInFlight.clear();
  managedAutoDeliverDone.clear();
  managedAutoDeliverRetryRequested.clear();
  rejectResumeNativeInFlight.clear();
  managedSessionInFlight.clear();
  rejectResumePostStartFailureForTests = null;
  beforeCombinedDispatchCompensateForTests = null;
  beforeTaskClaimCoreForTests = null;
  beforeTaskBackfillWorkspaceLaneBaseForTests = null;
}

/** Test helper: clear per-task managed-session single-flight slots. */
export function resetTaskStartSessionInFlightForTests(): void {
  managedSessionInFlight.clear();
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
  managedAutoDeliverRetryRequested.delete(key);
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
async function buildRejectResumeRecoveryOrientation(
  ctx: HandlerContext,
  task: TaskEnvelope,
  roots: {
    workspaceRoot: string;
    systemRoot: string;
    roleFs?: import("../core/adapter.js").FsAdapter;
  },
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
): Promise<string> {
  const base = await buildSessionBootstrapPrompt(ctx, task, roots, roots.roleFs);
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
  if (task.contextCard != null) {
    const nodeIds = taskReferencedNodeIds(task);
    if (nodeIds.length) lines.push(`Node refs: ${nodeIds.join(", ")}`);
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

  const orientation = await buildRejectResumeRecoveryOrientation(
    ctx,
    task,
    {
      workspaceRoot: mount.workspaceRoot,
      systemRoot: mount.systemRoot,
      roleFs: mount.env.fs,
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
      referencedNodeIds:
        task.contextCard != null ? taskReferencedNodeIds(task) : [],
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
  // New RPC writes reject historical `manual`; canonical value is `review`.
  if (raw === "review" || raw === "bypass" || raw === "agent-decide") return raw;
  throw new RpcError(-32602, `Invalid deliveryPolicy: ${raw}`);
}

function parseOptionalA2APolicy(raw: string | undefined): A2APolicy | undefined {
  if (!raw) return undefined;
  if (raw === "allow" || raw === "ask" || raw === "deny") return raw;
  throw new RpcError(-32602, `Invalid a2aPolicy: ${raw}`);
}

function requireProfileId(
  p: Record<string, unknown>,
  verb = "task.startSession"
): string {
  const profileId = optionalString(p, "profileId");
  if (!profileId) {
    throw new RpcError(
      -32602,
      `${verb} requires explicit profileId (no fake-default or product-profile fallback)`
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
 * a2aPolicy=allow gate for role callers that are NOT on the Role-agent standing path
 * (no Task.agentId). Uses roster agentIds; may resolve unique profileId→agentId binding
 * for durable Role self-launch. Never treats bare profileId as authorization history.
 */
async function resolveRoleLaunchAllowed(
  ctx: HandlerContext,
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    taskRole: string;
    profileId: string;
    agentId?: string;
    policy: A2APolicy;
  }
): Promise<boolean> {
  if (input.policy !== "allow") return true;
  await ensureRolesRosterMigrated(fs);
  const registry = await loadRolesRegistry(fs);
  const role = resolveRole(registry.roles, input.taskRole);
  const roster = roleRoster(role);
  if (roster.length === 0) return false;
  const agents = await ensureAgentDefsForRosterIds(ctx, roster);
  const explicit = input.agentId?.trim() || "";
  if (explicit) {
    if (!roleAllowsAgent(role, explicit)) return false;
    const def = findAgentDefinition(agents, explicit);
    if (def && def.profileId !== input.profileId) return false;
    return true;
  }
  try {
    const resolved = resolveAgentIdForProfileOnRoster(agents, roster, input.profileId);
    return roleAllowsAgent(role, resolved);
  } catch {
    return false;
  }
}

/**
 * Standing roster authorization for Role-agent dispatch / startSession.
 * - Requires durable dispatcher role and explicit agentId (never inferred from profileId).
 * - Out-of-roster → A2A_DENIED (fail loud).
 * - In-roster → proceed (does not consult a2aPolicy ask/deny; does not create approvals).
 * - Optionally verifies AgentDefinition.profileId matches the launch profileId.
 */
async function assertRoleRosterStandingAuth(
  ctx: HandlerContext,
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    dispatcher?: string;
    agentId: string;
    profileId: string;
    requireBoundProfileMatch?: boolean;
  }
): Promise<void> {
  const authorityRef = input.dispatcher?.trim();
  if (!authorityRef || authorityRef === "user") {
    throw new RpcError(
      -32602,
      "Role-agent dispatch requires parentActor kind=role naming a durable role (roster authority)",
      { parentActor: authorityRef || null }
    );
  }
  const agentId = input.agentId.trim();
  if (!agentId) {
    throw new RpcError(-32602, "Role-agent path requires non-empty agentId");
  }
  // Ensure disk migration ran so roster is current.
  await ensureRolesRosterMigrated(fs);
  const registry = await loadRolesRegistry(fs);
  const role = resolveRole(registry.roles, authorityRef);
  if (!role) {
    throw new RpcError(-32602, `A2A authority role not found in registry: ${authorityRef}`, {
      role: authorityRef,
    });
  }
  const roster = roleRoster(role);
  const agents = await ensureAgentDefsForRosterIds(ctx, roster);
  if (!roleAllowsAgent(role, agentId)) {
    throw new RpcError(
      RPC_A2A_DENIED,
      `Agent ${agentId} is not on role ${role.name} roster (standing authorization)`,
      {
        role: role.name,
        agentId,
        profileId: input.profileId,
        roster,
        reason: "out_of_roster",
      }
    );
  }
  if (input.requireBoundProfileMatch !== false) {
    const def = findAgentDefinition(agents, agentId);
    if (!def) {
      // ensureAgentDefsForRosterIds only seeds missing ids; explicit create may lag.
      const { agents: all } = await loadAgentDefinitions(ctx.dataDir);
      const found = findAgentDefinition(all, agentId);
      if (!found) {
        throw new RpcError(-32004, `AgentDefinition not found: ${agentId}`);
      }
      if (found.profileId !== input.profileId) {
        throw new RpcError(
          -32602,
          `Agent ${agentId} binds profileId ${found.profileId}; got ${input.profileId}`
        );
      }
    } else if (def.profileId !== input.profileId) {
      throw new RpcError(
        -32602,
        `Agent ${agentId} binds profileId ${def.profileId}; got ${input.profileId}`
      );
    }
  }
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
 *
 * Production serializes by canonical git-common-dir + fully resolved target ref
 * (not workspaceId, taskPath, or lexical workspace path). Under that flight:
 * re-read Task/Delivery/lane facts, re-resolve expected target HEAD, and run
 * every Git write/rollback. Never trust caller branch/target.
 *
 * Before any Git write, re-resolves the integration contract and compares the
 * current target branch HEAD to the review-time snapshot (Delivery.targetHead or
 * the expected SHA captured at deliver/auto-integrate start). Drift or a missing
 * snapshot fails loud with stable retryable TARGET_MOVED and does not touch Git.
 */
function makeCommitIntegrator(
  ctx: HandlerContext,
  workspaceRoot: string,
  task: TaskEnvelope,
  options: {
    /**
     * Review-time snapshot: Delivery.targetHead on accept, or SHA captured at
     * deliver / auto-integrate start for commit-bearing paths.
     * Missing on commit-bearing integrate → TARGET_MOVED (legacy fail-loud).
     * Re-resolved from ready Delivery under the target flight on accept.
     */
    expectedTargetHead?: string;
    action: "task.accept" | "task.deliver";
    /** Task path for write-boundary re-read (never trust the stale envelope alone). */
    taskPath: string;
  }
): (commits: string[]) => Promise<void> {
  return async (commits: string[]) => {
    const refs = uniqueCommitRefs(commits);
    if (refs.length === 0) return;

    const taskPath = options.taskPath.trim() || task.path;
    // Lock key from live Task + resolved lane (not caller-supplied branch/target).
    const lockTask = await loadTaskEnvelopeForIntegration(ctx, workspaceRoot, taskPath, task);
    const lockContract = await resolveIntegrationContract(workspaceRoot, lockTask);

    await runIntegrationTargetFlight(workspaceRoot, lockContract.targetBranch, async () => {
      // Write boundary: re-read Task/lane; never trust caller branch/target or stale envelope.
      const liveTask = await loadTaskEnvelopeForIntegration(
        ctx,
        workspaceRoot,
        taskPath,
        lockTask
      );
      const contract = await resolveIntegrationContract(workspaceRoot, liveTask);
      if (contract.targetBranch !== lockContract.targetBranch) {
        throw new Error(
          `Integration targetBranch changed under flight key ` +
            `(lock=${lockContract.targetBranch} live=${contract.targetBranch}); refuse Git write`
        );
      }

      // Accept path: re-load ready Delivery targetHead under the same target lock.
      // Deliver/auto-integrate keeps the snapshot captured at publish prepare.
      let expected = options.expectedTargetHead;
      if (options.action === "task.accept") {
        const mount = requireMountByWorkspaceRoot(ctx, workspaceRoot);
        expected = await loadReadyDeliveryTargetHead(mount.env.fs, liveTask);
      }

      await assertIntegrationTargetHeadUnchanged(workspaceRoot, liveTask, expected, {
        action: options.action,
      });

      if (ctx.integrateCommits) {
        await ctx.integrateCommits(workspaceRoot, refs, liveTask.role);
        return;
      }
      // Re-resolve contract immediately before Git write (lane facts at boundary).
      const writeContract = await resolveIntegrationContract(workspaceRoot, liveTask);
      await integrateWorkspaceCommits(writeContract, refs);
    });
  };
}

/** Find the mounted workspace whose root matches workspaceRoot (realpath-safe). */
function requireMountByWorkspaceRoot(
  ctx: HandlerContext,
  workspaceRoot: string
): import("./workspace-host.js").MountedWorkspace {
  const mounted = nodePath.resolve(workspaceRoot);
  for (const info of ctx.host.list()) {
    const m = ctx.host.require(info.workspaceId);
    if (isSameWorkspaceRoot(m.workspaceRoot, mounted)) return m;
  }
  throw new Error(`No mounted workspace for integration re-read: ${workspaceRoot}`);
}

/**
 * Re-load Task envelope at the Git write boundary from the mounted workspace.
 * Fail-loud when the mount or path cannot be re-read — never invent lane facts.
 */
async function loadTaskEnvelopeForIntegration(
  ctx: HandlerContext,
  workspaceRoot: string,
  taskPath: string,
  fallback: TaskEnvelope
): Promise<TaskEnvelope> {
  const path = taskPath.trim() || fallback.path;
  if (!path) {
    throw new Error("Integration re-read requires taskPath");
  }
  const mount = requireMountByWorkspaceRoot(ctx, workspaceRoot);
  return loadTaskEnvelope(mount.env.fs, path);
}

function uniqueCommitRefs(commits: string[] | undefined): string[] {
  return [...new Set((commits ?? []).map((c) => c.trim()).filter(Boolean))];
}

/**
 * Capture full SHA of the resolved integration target branch HEAD for a
 * commit-bearing Delivery. Fail-loud when the contract/target cannot be resolved.
 */
async function snapshotIntegrationTargetHead(
  workspaceRoot: string,
  task: TaskEnvelope
): Promise<string> {
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  return readRoleBranchTip(contract.workspace, contract.targetBranch);
}

/**
 * Before Git integrate: re-resolve contract and require current target HEAD to
 * match the review-time snapshot. Missing snapshot (legacy ready Delivery) and
 * clean target advance both fail with TARGET_MOVED — never silently guess.
 */
async function assertIntegrationTargetHeadUnchanged(
  workspaceRoot: string,
  task: TaskEnvelope,
  expectedTargetHead: string | undefined,
  meta: { action: "task.accept" | "task.deliver" }
): Promise<void> {
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  const current = await readRoleBranchTip(contract.workspace, contract.targetBranch);
  const expected = expectedTargetHead?.trim() || "";
  if (!expected) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `${meta.action} refused: commit-bearing Delivery is missing targetHead snapshot ` +
        `(legacy or incomplete row); re-deliver so review can re-snapshot target ` +
        `${contract.targetBranch} HEAD (task/delivery state unchanged; Git not touched)`,
      {
        code: "TARGET_MOVED",
        reason: "missing_snapshot",
        action: meta.action,
        taskPath: task.path,
        ...(task.id ? { taskId: task.id } : {}),
        targetBranch: contract.targetBranch,
        currentTargetHead: current,
      }
    );
  }
  if (current !== expected) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `${meta.action} refused: integration target HEAD moved since Delivery review ` +
        `(target=${contract.targetBranch} expected=${expected} current=${current}); ` +
        `re-review or re-deliver (task/delivery state unchanged; Git not touched)`,
      {
        code: "TARGET_MOVED",
        reason: "head_moved",
        action: meta.action,
        taskPath: task.path,
        ...(task.id ? { taskId: task.id } : {}),
        targetBranch: contract.targetBranch,
        expectedTargetHead: expected,
        currentTargetHead: current,
      }
    );
  }
}

/** Load targetHead from the task's active ready Delivery (accept path). */
async function loadReadyDeliveryTargetHead(
  fs: import("../core/adapter.js").FsAdapter,
  task: TaskEnvelope
): Promise<string | undefined> {
  const taskId = task.id || task.path;
  const deliveries = await loadDeliveries(fs, { taskId });
  const activeId = task.activeDeliveryId?.trim();
  const ready =
    (activeId ? deliveries.find((d) => d.id === activeId && d.status === "ready") : undefined) ??
    deliveries.find((d) => d.status === "ready");
  return ready?.targetHead?.trim() || undefined;
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
    const dispatcher = taskParentRoleId(task);
    const label = isProfile ? `task ${task.id || task.path}` : `role ${task.role}`;
    if (!dispatcher) {
      throw new Error(
        `Sub task envelope missing durable parent Role for ${label}; cannot resolve targetBranch`
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
 * - Role / asSub: lane + baseCommit are normally captured at task.dispatch; this
 *   path is capture-once backfill only and must never overwrite an existing base.
 * - Peer agentProfile: first create tent-task/<taskId> here (never tent-role/<profile>).
 * Persists exact workspaceLane.baseCommit at first bind (capture-once).
 * Also backfills roleBranchBase for managed collection once when missing.
 * integrationAuthority: only the on-disk bag counts as recorded truth; absence
 * triggers explicit persist of parent/reviewer + service mutator.
 * Non-Git / pure docs → no fake Git fields (cwd falls back to workspace root);
 * authority remains a derived projection from parent/reviewer, not a Profile permission.
 */
async function ensureTaskWorkspaceLane(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<TaskEnvelope> {
  const hasBase = Boolean(task.baseCommit?.trim());
  // Recorded on-disk field only — never treat a projection-derived bag as present.
  const hasAuthority = Boolean(task.integrationAuthority);
  const laneComplete = Boolean(
    task.worktree && task.branch && task.workspace && task.targetBranch
  );
  if (laneComplete && hasBase && hasAuthority) {
    return task;
  }
  const mount = ctx.host.require(workspaceId);
  return ctx.mutations.run(workspaceId, async () => {
    // Re-load under the bus so concurrent bind cannot double-write baseline.
    const current = await loadTaskEnvelope(mount.env.fs, task.path);
    const currentHasBase = Boolean(current.baseCommit?.trim());
    const currentHasAuthority = Boolean(current.integrationAuthority);
    const currentLaneComplete = Boolean(
      current.worktree && current.branch && current.workspace && current.targetBranch
    );
    if (currentLaneComplete && currentHasBase && currentHasAuthority) {
      return current;
    }

    const isProfile = taskAssigneeKind(current) === "agentProfile";
    let taskTargetBranch: string | undefined;
    if (isProfile && taskAsSub(current)) {
      const dispatcher = taskParentRoleId(current);
      if (!dispatcher) {
        throw new Error(
          `Sub task ${current.id || current.path} is missing a durable parent Role.`
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
    // Capture-once exact baseCommit only when first binding an incomplete lane
    // (e.g. peer agentProfile at startSession). Never rewrite an existing base.
    // Complete-lane legacy Tasks missing baseCommit must use explicit
    // task.backfillWorkspaceLaneBase — never infer from tip/roleBranchBase/cwd.
    // Role-assignee first-claim capture happens in task.claim (captureRoleBaseCommitOnClaim).
    if (!currentHasBase && !currentLaneComplete) {
      const fromEnsure =
        typeof (lane as RoleWorkspaceContract).baseCommit === "string"
          ? (lane as RoleWorkspaceContract).baseCommit!.trim()
          : "";
      const tip = fromEnsure || (await readRoleBranchTip(lane.workspace, lane.branch));
      patch.baseCommit = tip;
      if (!current.roleBranchBase?.trim()) {
        patch.roleBranchBase = tip;
      }
    }
    // integrationAuthority: always derived from parent/reviewer + service mutator.
    if (!currentHasAuthority) {
      if (!current.parentActor || !current.reviewer) {
        throw new Error(
          `Task ${current.id || current.path} missing parentActor/reviewer; ` +
            `cannot derive integrationAuthority (actor=parent/reviewer, mutator=service).`
        );
      }
      patch.integrationAuthority = deriveIntegrationAuthority({
        parentActor: current.parentActor,
        reviewer: current.reviewer,
      });
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
 * Stopped resume-capable agentProfile sessions for the same profile + workspace cwd.
 * Same-lane only (tent-task worktree): cross-Task profile lanes differ and fail the
 * Core gate. Used as candidates; launch path still runs evaluateSessionReuseCompatibility.
 */
async function findResumableManagedSessionsForProfile(
  ctx: HandlerContext,
  workspaceId: string,
  profileId: string,
  cwd: string
): Promise<SessionRecord[]> {
  if (!profileId) return [];
  const candidates = (await ctx.runtime.registry.list())
    .filter(
      (rec) =>
        rec.workspace === workspaceId &&
        rec.profileId === profileId &&
        rec.assigneeKind === "agentProfile" &&
        rec.state === "stopped" &&
        !!rec.resumeToken &&
        !!rec.runtimeWorkspace?.cwd &&
        isSameWorkspaceRoot(
          nodePath.resolve(rec.runtimeWorkspace.cwd),
          nodePath.resolve(cwd)
        )
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const out: SessionRecord[] = [];
  for (const candidate of candidates) {
    const probe = await ctx.runtime.probe(candidate.id);
    if (!probe.alive && probe.resumeCapable) out.push(candidate);
  }
  return out;
}

/**
 * Resolve the durable role whose a2aPolicy / roster (agentIds) govern startSession.
 * Role-agent Tasks with Task.agentId use standing roster membership (no a2a ask).
 * - user caller: unused (root authority)
 * - parent Role task (sub or agentProfile under Role) + role caller: authority = parent Role
 * - peer role task (parent=user): authority = task.role
 * - peer agentProfile with parent=user + role caller: fails (needs durable parent Role)
 */
function resolveA2AAuthorityRole(
  task: TaskEnvelope,
  callerKind: "user" | "role"
): string {
  if (callerKind === "user") return task.role;
  if (taskParentIsRole(task) || taskAsSub(task) || taskAssigneeKind(task) === "agentProfile") {
    const dispatcher = taskParentRoleId(task);
    if (!dispatcher) {
      throw new RpcError(
        -32602,
        taskAsSub(task) || taskParentIsRole(task)
          ? "callerKind=role startSession on parent-Role task requires parentActor kind=role"
          : "callerKind=role startSession on agentProfile task requires parentActor kind=role",
        {
          parentActor: task.parentActor,
          assignee: task.role,
          asSub: taskAsSub(task),
        }
      );
    }
    if (dispatcher === task.role) {
      throw new RpcError(
        -32602,
        "callerKind=role startSession must not use the assignee label as parent Role",
        { parentActor: task.parentActor, assignee: task.role }
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
 * Build managed ACP bootstrap.
 *
 * When Task carries Context Card v1 (cx-5q6za6):
 *   frozen order via assembleManagedPrompt — stable prefix once per
 *   contextGeneration; later Tasks on the same Session append delta only.
 *   Skill/role bodies from 52a0da2 compose fill tent-role / Role / tent-task slots.
 *
 * Legacy envelopes without a card keep the skill-prefix + path Context Card path
 * (migration-compatible until explicit migration).
 * Never copies box/manifest bodies. Never instructs tent task claim/get/deliver.
 * Distinct from relayPromptForTask (external manual path still claim+deliver).
 */
async function buildSessionBootstrapPrompt(
  ctx: HandlerContext,
  task: TaskEnvelope,
  roots: {
    workspaceRoot: string;
    systemRoot: string;
    /** Prior Session contextGeneration when reusing the same managed Session. */
    sessionContextGeneration?: string | null;
    taskInputDelta?: string;
    checkpoint?: string;
  },
  roleFs?: import("../core/adapter.js").FsAdapter
): Promise<string> {
  const systemRoot = roots.systemRoot || systemRootFromWorkspace(roots.workspaceRoot);
  const kind = taskAssigneeKind(task);

  // Load Role definition for durable Role tasks (prompt + roster digest).
  // agentProfile one-shot: tent-task only, no Role prompt/roster.
  let roleDef: RoleDefinition | undefined;
  if (kind === "role" && task.role && roleFs) {
    try {
      const registry = await loadRolesRegistry(roleFs);
      roleDef = resolveRole(registry.roles, task.role);
    } catch {
      roleDef = undefined;
    }
  }

  // Stable block first (byte-identical across Tasks that share Role + skill bodies).
  const skillPrefix = composeManagedSkillBootstrapPrefix({
    packageRoot: ctx.packageRoot,
    assigneeKind: kind,
    role: roleDef,
  });

  let base: string;
  if (task.contextCard) {
    base = buildContextCardManagedBootstrap(task, task.contextCard, {
      workspaceRoot: roots.workspaceRoot,
      systemRoot,
      sessionContextGeneration: roots.sessionContextGeneration,
      // 52a0da2 skill compose already freezes tent-role → Role → tent-task order.
      tentTaskSection: skillPrefix,
      taskInputDelta: roots.taskInputDelta,
      // Explicit caller checkpoint only (digest slot). On-disk Role Checkpoint is
      // appended after full assembly as dynamic tail — never stable prefix.
      checkpoint: roots.checkpoint,
    });
  } else {
    // Legacy no-card envelopes: path Context Card + session steps after skill prefix.
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
    base = assembleManagedSessionBootstrap({
      stableSkillPrefix: skillPrefix,
      contextCardPrompt: card.prompt,
      dynamicTaskTail: sessionSteps,
    });
  }

  // Optional Role Checkpoint: last dynamic tail only. Missing/corrupt fail-open.
  // agentProfile one-shots never inject Role continuation notes.
  return appendRoleCheckpointTail(base, kind, task.role, roleFs);
}

/**
 * Append formatted Role Checkpoint after stable Context Card / skill bootstrap.
 * Fail-open on missing note, path errors, or corrupt files.
 */
async function appendRoleCheckpointTail(
  base: string,
  kind: ReturnType<typeof taskAssigneeKind>,
  roleName: string | undefined,
  roleFs?: import("../core/adapter.js").FsAdapter
): Promise<string> {
  if (kind !== "role" || !roleName?.trim() || !roleFs) return base;
  try {
    const record = await readRoleCheckpoint(roleFs, roleName);
    const tail = formatRoleCheckpointTail(record);
    if (!tail) return base;
    return `${base.trimEnd()}\n\n${tail}\n`;
  } catch {
    return base;
  }
}

/**
 * Context Card v1 managed bootstrap (stable prefix + dynamic delta).
 * Skill bodies / roster come from 52a0da2 compose when provided as tentTaskSection.
 */
function buildContextCardManagedBootstrap(
  task: TaskEnvelope,
  contextCard: TaskContextCardV1,
  roots: {
    workspaceRoot: string;
    systemRoot: string;
    sessionContextGeneration?: string | null;
    tentRoleSection?: string;
    rolePromptRosterSection?: string;
    tentTaskSection?: string;
    taskInputDelta?: string;
    checkpoint?: string;
  }
): string {
  // Fail-loud on unresolved declared durable refs (never invent / drop).
  assertRefsResolved(contextCard, (bucket, ref) => {
    // git refs are revision pointers — presence of id is enough at bootstrap.
    if (bucket === "git") return Boolean(ref.id?.trim());
    // nodes/tasks/deliveries: id required (full FS resolve is Service's job at dispatch).
    return Boolean(ref.id?.trim());
  });

  const includeStablePrefix = shouldInjectStablePrefix({
    sessionContextGeneration: roots.sessionContextGeneration,
    taskContextGeneration: contextCard.contextGeneration,
  });
  // Structured reason available for audit (no prompt-memory inference).
  void decideStablePrefixInjection({
    sessionContextGeneration: roots.sessionContextGeneration,
    taskContextGeneration: contextCard.contextGeneration,
  });

  const executionLane = projectExecutionLaneFromTask(task);
  const executionLaneText = formatExecutionLanePrompt(executionLane);
  const bootstrapNodeIds =
    task.contextCard != null ? taskReferencedNodeIds(task) : [];
  const pointers = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`,
    ...(task.id ? [`Task id: ${task.id}`] : []),
    ...(bootstrapNodeIds.length ? [`nodes: ${bootstrapNodeIds.join(", ")}`] : []),
    `deliveryPolicy: ${task.deliveryPolicy ?? "review"}`,
    `Service status: this task is already claimed (state=${task.state || "running"}).`,
    "Managed path: Local Service already claimed this task; final assistant reply is the report and will be delivered automatically.",
    ...(executionLaneText ? [executionLaneText] : []),
  ].join("\n");

  const assembly = assembleManagedPrompt({
    workspaceRoot: roots.workspaceRoot,
    systemRoot: roots.systemRoot,
    agentsPointer: "AGENTS.md at workspace root (authoritative workspace agents file)",
    tentRoleSection: roots.tentRoleSection,
    rolePromptRosterSection: roots.rolePromptRosterSection,
    tentTaskSection: roots.tentTaskSection,
    contextCard,
    taskPointers: pointers,
    userPrompt: extractTaskUserPrompt(task),
    taskInputDelta: roots.taskInputDelta,
    checkpoint: roots.checkpoint,
    includeStablePrefix,
  });

  // Stable project context inside assembleManagedPrompt is the single path tutorial.
  // Do not prepend legacy drag-style formatContextCardPrompt here (duplicates roots).
  // External/drag formatContextCardPrompt remains unchanged for desktop/export paths.
  if (includeStablePrefix) {
    return `--- Tent managed session bootstrap ---\n${assembly.text}`;
  }
  return (
    `--- Tent managed session delta (contextGeneration=${contextCard.contextGeneration}) ---\n` +
    `${assembly.text}`
  );
}

/**
 * Collect local image path refs from task user prompt + referenced Node bodies.
 * Explicit sources only — no workspace scan. Missing node ids/files are skipped.
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
    const nodeIds =
      task.contextCard != null ? taskReferencedNodeIds(task) : [];
    for (const nodeId of nodeIds) {
      if (!nodeId || nodeId === "root") continue;
      const box = tent.byId.get(nodeId);
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
  const derivedAuthority =
    task.parentActor && task.reviewer
      ? deriveIntegrationAuthority({
          parentActor: task.parentActor,
          reviewer: task.reviewer,
        })
      : undefined;
  const hasLane = Boolean(
    task.workspace ||
      task.worktree ||
      task.branch ||
      task.targetBranch ||
      task.baseCommit ||
      derivedAuthority
  );
  const lane = hasLane
    ? {
        workspace: task.workspace,
        worktree: task.worktree,
        branch: task.branch,
        targetBranch: task.targetBranch,
        // Exact baseCommit only — never substitute roleBranchBase in the projection.
        ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
        ...(derivedAuthority ? { integrationAuthority: derivedAuthority } : {}),
      }
    : undefined;
  const proj: TaskProjection = {
    path: task.path,
    id: task.id,
    role: task.role,
    referencedNodeIds:
      task.contextCard != null ? taskReferencedNodeIds(task) : [],
    status: task.status,
    state: task.state,
    manifest: task.manifest,
    parentActor: task.parentActor,
    reviewer: task.reviewer,
    // Missing asSub on disk reads as false (peer Git lane).
    asSub: taskAsSub(task),
    deliveryPolicy: task.deliveryPolicy,
    // Missing assigneeKind on disk reads as role (backward compatible).
    assigneeKind: taskAssigneeKind(task),
    sessionId: task.sessionId,
    wait: task.wait,
    activeDeliveryId: task.activeDeliveryId,
    lastOutcome: task.lastOutcome,
    workspaceLane: lane,
    // Compact baseCommit capture audit (first-claim | explicit-backfill).
    ...(task.baseCommitCapture
      ? {
          baseCommitCapture: {
            source: task.baseCommitCapture.source,
            baseCommit: task.baseCommitCapture.baseCommit,
            actor: {
              kind: task.baseCommitCapture.actor.kind,
              id: task.baseCommitCapture.actor.id,
            },
            capturedAt: task.baseCommitCapture.capturedAt,
          },
        }
      : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    prompt: task.prompt,
    // Context Card v1 projections (cx-5q6za6) — omit when absent (legacy).
    ...(task.contextCard ? { contextCard: task.contextCard } : {}),
    ...(task.contextGeneration ? { contextGeneration: task.contextGeneration } : {}),
    ...(task.taskDeltaDigest ? { taskDeltaDigest: task.taskDeltaDigest } : {}),
  };
  if (typeof task.agentId === "string" && task.agentId.trim()) {
    proj.agentId = task.agentId.trim();
  }
  return proj;
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
    ...(d.targetHead ? { targetHead: d.targetHead } : {}),
    integrationMode: d.integrationMode,
    review: d.review,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function assertDocsWriteCollaborationFields(
  frontmatter: Record<string, unknown>
): void {
  const protectedHit = PROTECTED_COLLAB_FIELDS.filter((k) => k in frontmatter);
  if (protectedHit.length === 0) return;

  throw new RpcError(
    -32010,
    `docs.write cannot set retired collaboration fields: ${protectedHit.join(", ")}. Collaboration truth lives on Task/Delivery projections.`,
    { fields: protectedHit }
  );
}

function assertRawDocsWriteCollaborationFields(next: Record<string, unknown>): void {
  const protectedHit = PROTECTED_COLLAB_FIELDS.filter((field) => field in next);
  if (protectedHit.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write raw cannot contain retired collaboration fields: ${protectedHit.join(", ")}. Collaboration truth lives on Task/Delivery projections.`,
    { fields: protectedHit }
  );
}

/** Hard gate: only invalid + archived block content writes (V0.2: no read-only mode). */
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
  throw new RpcError(-32010, `${op} rejected: concept is not mutable`, {
    conceptId: concept.id,
    mode: concept.mode,
  });
}

/** Structured frontmatter path: id/mode/archived/deliveryId never via docs.write. */
function assertReservedDocsWriteFields(frontmatter: Record<string, unknown>): void {
  const hard = (["id", "mode", "archived", "deliveryId"] as const).filter((k) => k in frontmatter);
  if (hard.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot set reserved fields: ${hard.join(", ")}. Use docs.setMode for mode; Output deliveryId binds via task.accept.`,
    { fields: hard }
  );
}

/**
 * Structured frontmatter path: type/tags/relations use dedicated Service commands.
 * Public semantic path is docs.setType / docs.tags.* / relation.*.
 */
function assertSemanticDocsWriteFields(frontmatter: Record<string, unknown>): void {
  const hit = SEMANTIC_DOCS_WRITE_FIELDS.filter((k) => k in frontmatter);
  if (hit.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot set semantic fields: ${hit.join(", ")}. Use docs.setType / docs.tags.set / docs.tag.add / docs.tag.remove / relation.create|update|delete.`,
    { fields: hit }
  );
}

/**
 * Raw write may keep existing reserved values but must not introduce or change
 * id/mode/archived/deliveryId. Collaboration fields still use the active-task guard.
 */
function assertRawDocsWriteReserved(
  disk: Record<string, unknown>,
  next: Record<string, unknown>
): void {
  const hard = (["id", "mode", "archived", "deliveryId"] as const).filter(
    (field) => String(next[field] ?? "") !== String(disk[field] ?? "")
  );
  if (hard.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot change reserved fields: ${hard.join(", ")}. Use docs.setMode for mode; Output deliveryId binds via task.accept.`,
    { fields: hard }
  );
}

/**
 * Raw write may keep existing type/tags/relations but must not change them.
 * Dedicated docs.setType / docs.tags.* / relation.* are the public semantic path.
 */
function assertRawDocsWriteSemantic(
  disk: Record<string, unknown>,
  next: Record<string, unknown>
): void {
  const changed: string[] = [];
  if (String(next.type ?? "") !== String(disk.type ?? "")) {
    changed.push("type");
  }
  const diskTags = JSON.stringify(normalizeTagsForCompare(disk.tags));
  const nextTags = JSON.stringify(normalizeTagsForCompare(next.tags));
  if (diskTags !== nextTags) {
    changed.push("tags");
  }
  const diskRelations = JSON.stringify(normalizeRelationsForCompare(disk.relations));
  const nextRelations = JSON.stringify(normalizeRelationsForCompare(next.relations));
  if (diskRelations !== nextRelations) {
    changed.push("relations");
  }
  if (changed.length === 0) return;
  throw new RpcError(
    -32010,
    `docs.write cannot change semantic fields: ${changed.join(", ")}. Use docs.setType / docs.tags.set / docs.tag.add / docs.tag.remove / relation.create|update|delete.`,
    { fields: changed }
  );
}

function normalizeTagsForCompare(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** Stable compare for relations frontmatter (order-sensitive by id then payload). */
function normalizeRelationsForCompare(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const keys = Object.keys(item).sort((a, b) => a.localeCompare(b));
      const ordered: Record<string, unknown> = {};
      for (const k of keys) ordered[k] = item[k];
      return ordered;
    })
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/** Best-effort tag list from raw frontmatter for Core registry sync (normalize in Core). */
function tagsFromFrontmatterData(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.tags)) return [];
  return data.tags.filter((item): item is string => typeof item === "string");
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}
