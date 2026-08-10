// Service command/query handlers — sole client mutation entry into core + runtime.

import { nodeNotePath, loadTent, type LoadedTent } from "../core/tree.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { isNodeId } from "../core/id.js";
import {
  createNode,
  dispatch,
  patchBody,
  patchNode,
  resolveDispatchTaskNodeSelection,
  setNodeMode,
} from "../core/ops.js";
import {
  addRegistryTag,
  addTag,
  loadTagRegistry,
  normalizeTagName,
  removeRegistryTag,
  removeTag,
  syncTagRegistryAfterNodeTagsChange,
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
import { isValidNodeType } from "../core/typeRegistry.js";

import { forkNode } from "../core/forkOps.js";
import { renameNode } from "../core/renameOps.js";
import { moveNode, type MovePosition } from "../core/moveOps.js";
import {
  extractTaskUserPrompt,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  primaryNodeId,
  taskAsSub,
  taskParentRoleId,
  type RoleWorkspaceContract,
  type TaskEnvelope,
  type TaskEnvelopePatch,
} from "../core/task.js";
import {
  allowsNonReviewAcceptMode,
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
import {
  assembleManagedPrompt,
  deriveIntegrationAuthority,
  decideStablePrefixInjection,
  ExecutorLaneHistoryError,
  formatExecutionLanePrompt,
  projectExecutionLaneFromTask,
  shouldInjectStablePrefix,
  type TaskContextCard,
} from "../core/task-context-card.js";
import {
  collectStableContextGeneration,
  appendCallerBootstrapSection,
  type StableContextGenerationBundle,
} from "./session-context-generation.js";
import { roleTempRoot, systemRootFromWorkspace, TEMP_DIR } from "../core/paths.js";
import {
  decodeBase64Strict,
  MAX_ATTACHMENT_BYTES,
  storeAttachmentBytes,
} from "../markdown/attachments.js";
import {
  collectBootstrapImageRefsFromTask,
  type BootstrapImageRef,
} from "../adapters/acp/image-prompt.js";
import { cloneAcpSessionConfigSnapshot } from "../adapters/acp/types.js";
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
  loadRolesRegistry,
  normalizeRoleDefinition,
  resolveRole,
  updateRole,
  type RoleDefinition,
} from "../core/skillRoleRegistry.js";
import {
  composeManagedSkillBootstrapPrefix,
} from "../core/managed-skill-compose.js";
import {
  DEFAULT_TASK_REJECT_NOTE,
  findActiveTaskForNode,
  finalizeTaskAccept,
  finalizeTaskDeliverAuto,
  prepareTaskAccept,
  prepareTaskDeliver,
  reconcileTaskLifecycle,
  recoverCommittedTaskDeliver,
  taskCancel,
  taskClaim,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
  type TaskClaimWrite,
  type TaskDeliverOptions,
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
  listTaskWorktreeReclaimPendingForWorkspace,
  recordTaskWorktreeReclaimNeedsAttention,
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
  TERMINAL_TASK_STATES,
  type DeliverDecision,
  type AcceptMode,
  type WaitReason,
} from "../core/task-model.js";
import {
  assertDeliverCommitsInExecutorLane,
  assertOrdinaryExecutorLaneHistoryInGit,
  DeliverCommitLaneError,
  ensureRoleWorkspace,
  ensureRoleWorkspaceIfGit,
  ensureTaskWorkspace,
  ensureTaskWorkspaceIfGit,
  findExactCompletedIntegrationAtTip,
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
  EXTERNAL_ADAPTER_ID,
  isSessionId,
  makeSessionId,
  recordExternalKey,
} from "../runtime/types.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import * as nodePath from "node:path";
import {
  buildBacklinkIndex,
  extractOutLinksDetailed,
  indexFromNodes,
  resolveOutLink,
} from "../markdown/links.js";
import { contentEtag } from "./etag.js";
import { normalizeArtifactRefs } from "../core/artifact.js";
import type { EventBus } from "./events.js";
import { MutationBus } from "./mutation-bus.js";
import type { WorkspaceHost } from "./workspace-host.js";
import type { ToolApprovalStore, ToolPendingApproval } from "./tool-approval-store.js";
import {
  makeDecisionRequestId,
  type DecisionRequestRecord,
  type DecisionRequestStore,
} from "./decision-request-store.js";
import {
  assertDecisionResponseTaskInputMatches,
  prepareDecisionResponse,
} from "./decision-request-flow.js";
import {
  validateDecisionResponse,
  type DecisionRequest,
  type DecisionRequestOption,
  type DecisionResponse,
  type PendingDecisionRequest,
} from "../core/decision-request.js";
import {
  formatTaskInputPrompt,
  makeTaskInputId,
  normalizeTaskInputKind,
  taskInputIdForDecisionRequest,
  type TaskInputRecord,
  type TaskInputStore,
} from "./task-input-store.js";
import type { ManagedDeliveryReportDraftStore } from "./managed-delivery-report-draft-store.js";
import type { LaunchSecretStore } from "./launch-secret-store.js";
import {
  isClientMethod,
  PROTECTED_COLLAB_FIELDS,
  RESERVED_DOCS_WRITE_FIELDS,
  SEMANTIC_DOCS_WRITE_FIELDS,
  RPC_LIFECYCLE,
  type ArtifactRef,
  type NodeProjection,
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
  type PendingDeliveryInteraction,
  type PendingDecisionRequestInteraction,
  type PendingInteractionItem,
  type PendingInteractionListResult,
  type PendingToolApprovalInteraction,
  type ProposalProjection,
  type ProviderCatalogProjection,
  type RoleRegistryEntryProjection,
  type SessionProjection,
  type TaskProjection,
  type TypeRegistryEntryProjection,
} from "./types.js";
import {
  projectAgentConnection,
  projectAgentConnections,
} from "./connections.js";
import { projectProviderCatalog } from "./provider-catalog.js";
import type { AgentConnectionCatalog } from "./connection-catalog.js";
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
   * Authenticated service.health is the attach identity proof; GET /health only
   * exposes unauthenticated liveness diagnostics.
   */
  protocolVersion: number;
  /** Exact machine-local Service generation identity. */
  instanceId: string;
  startedAt: string;
  getPid: () => number;
  /** Service-internal runtime (never exposed as client methods). */
  runtime: AgentRuntime;
  /** Machine-local ACP tool permission approvals (permissionPolicy=ask). */
  toolApprovals: ToolApprovalStore;
  /** Machine-local exact-Task Decision Requests (not chat; not tool permission). */
  decisionRequests: DecisionRequestStore;
  /**
   * Machine-local U2A one-shot task inputs (user→agent append).
   * Not chat; not a Decision Request response; scoped by workspaceId+taskPath.
   */
  taskInputs: TaskInputStore;
  /**
   * Machine-local managed auto-deliver report drafts (final assistantText only).
   * Not chat history; not a ready Delivery; not a sixth pending-interaction.
   * Survives restart so publish failures can retry without re-prompting the Agent.
   */
  managedDeliveryReportDrafts: ManagedDeliveryReportDraftStore;
  /** Machine-local encrypted launch secrets. Plaintext is Service-internal only. */
  launchSecrets: LaunchSecretStore;
  dataDir: string;
  /** Machine-local AgentConnection catalog (serial CRUD + runtime sync). */
  connectionCatalog: AgentConnectionCatalog;
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
   * Production path uses real workspace Git via the Task's canonical lane contract.
   * The executor id is retained only for test hooks and diagnostics.
   */
  integrateCommits?: (
    workspaceRoot: string,
    commits: string[],
    executorId: string
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
  params: Record<string, unknown> | undefined,
  callContext: { callerSessionId?: string; callerExternalKey?: string } = {}
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
      case "connection.list":
        return connectionList(ctx, p);
      case "connection.get":
        return connectionGet(ctx, p);
      case "connection.create":
        return connectionCreate(ctx, p);
      case "connection.update":
        return connectionUpdate(ctx, p);
      case "connection.delete":
        return connectionDelete(ctx, p);
      case "provider.catalog":
        return providerCatalogRpc();
      case "settings.launchSecret.list":
        return settingsLaunchSecretList(ctx, p, callContext);
      case "settings.launchSecret.set":
        return settingsLaunchSecretSet(ctx, p, callContext);
      case "settings.launchSecret.delete":
        return settingsLaunchSecretDelete(ctx, p, callContext);
      case "skill.list":
        return skillList(ctx);
      case "skill.install":
        return skillInstall(ctx, p);
      case "task.dispatch":
        return taskDispatch(ctx, p);
      case "task.claim":
        return taskClaimRpc(ctx, p, {
          sessionId: callContext.callerSessionId,
          externalKey: callContext.callerExternalKey,
        });
      case "task.claimDirect":
        return taskClaimDirectRpc(ctx, p, {
          sessionId: callContext.callerSessionId,
          externalKey: callContext.callerExternalKey,
        });
      case "task.wait":
        return taskWaitRpc(ctx, p);
      case "task.resume":
        return taskResumeRpc(ctx, p);
      case "task.requestDecision":
        return taskRequestDecisionRpc(ctx, p, {
          callerSessionId: callContext.callerSessionId,
        });
      case "task.sendInput":
        return taskSendInputRpc(ctx, p);
      case "task.deliver":
        return taskDeliverRpc(ctx, p);
      case "task.requestReview":
        return taskRequestReviewRpc(ctx, p);
      case "task.accept":
        return taskAcceptRpc(ctx, p, callContext);
      case "task.reject":
        return taskRejectRpc(ctx, p, callContext);
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
      case "toolApproval.listPending":
        return toolApprovalListPending(ctx, p);
      case "toolApproval.get":
        return toolApprovalGet(ctx, p);
      case "toolApproval.approveOnce":
        return toolApprovalResolve(ctx, p, "approved");
      case "toolApproval.deny":
        return toolApprovalResolve(ctx, p, "denied");
      case "decisionRequest.listPending":
        return decisionRequestListPending(ctx, p, {
          callerSessionId: callContext.callerSessionId,
        });
      case "decisionRequest.get":
        return decisionRequestGet(ctx, p, {
          callerSessionId: callContext.callerSessionId,
        });
      case "decisionRequest.respond":
        return decisionRequestRespondRpc(ctx, p, {
          callerSessionId: callContext.callerSessionId,
        });
      case "decisionRequest.escalate":
        return decisionRequestEscalateRpc(ctx, p, {
          callerSessionId: callContext.callerSessionId,
        });
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
      case "task.worktreeReclaim.reconcile":
        return taskWorktreeReclaimReconcileRpc(ctx, p);
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
    instanceId: ctx.instanceId,
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
  // After SessionRegistry boot reconcile, each mount must re-bind tasks to live sessions.
  await reconcileTaskSessionsOnMount(ctx, info.workspaceId);
  return info;
}

/**
 * Stable wait summary when a bound Session is unintentionally unavailable
 * (live terminal exit/fail before Delivery, explicit external leave, or dead
 * after service restart / remount).
 * Kept as a constant so tests, recovery UX, and remount reconcile share one contract text.
 * Recovery: explicit `task.startSession` or explicit `task.replaceSession`; occupation held.
 */
export const SESSION_UNAVAILABLE_WAIT_SUMMARY =
  "Bound session unavailable (service restart or session ended). Restart the session or interrupt the task; occupation is held.";

/** Stable machine-facing code for session-unavailable recoverable park (wait.reason stays external). */
export const SESSION_UNAVAILABLE_WAIT_CODE = "session_unavailable" as const;

/** True when Task is recoverably parked for a dead/unavailable bound Session. */
export function isSessionUnavailableParkedWait(task: TaskEnvelope): boolean {
  if (task.state !== "waiting" || task.wait?.reason !== "external") return false;
  // Prefer durable waitCode; fall back to stable summary for rows written before code.
  if (task.wait.code === SESSION_UNAVAILABLE_WAIT_CODE) return true;
  return task.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
}

/**
 * Apply waiting(reason=external) + SESSION_UNAVAILABLE_WAIT_SUMMARY under the caller's
 * MutationBus critical section. Does not release occupation or cancel TaskInputs,
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
    // Waiting with another reason: replace the current wait diagnostic.
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
 * Shared recoverable park path for an unintentionally unavailable bound Session before Delivery.
 * Live runtime terminal projection and mount reconcile converge here.
 *
 * - Task → waiting(reason=external) with SESSION_UNAVAILABLE_WAIT_SUMMARY
 * - Preserves occupation, worktree, report draft, TaskInputs, Decision Requests, audit facts
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
    ctx.host.markSelfWrite(input.workspaceId, 200, TEMP_DIR);
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

  // Clear hanging tool-approval waiters. Do not cancel TaskInputs / Decision Requests —
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
 * Missing file/field → defaultAcceptMode=review-required.
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
  const supported = new Set(["defaultAcceptMode"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (reserved.has(key)) continue;
    if (!supported.has(key)) {
      throw new RpcError(-32602, `Unknown workspace setting: ${key}`);
    }
    if (value === undefined) continue;
    out[key] = value;
  }
  // Explicit defaultAcceptMode validation at the RPC boundary (clear error).
  if ("defaultAcceptMode" in out) {
    const v = out.defaultAcceptMode;
    if (v !== "review-required" && v !== "auto-accept" && v !== "agent-decide") {
      throw new RpcError(-32602, `Invalid defaultAcceptMode: ${String(v)}`, {
        code: "INVALID_ACCEPT_MODE",
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
  const baseEtag = optionalString(p, "baseEtag");

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
    nodes: tent.roots.map((root) => projectNode(root, includeBody, true)),
  };
}

async function docsGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const node = resolveNode(tent, p);
  return {
    workspaceId,
    node: projectNode(node, true, false),
  };
}

async function docsReadForEdit(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const node = resolveNode(tent, p);
  const notePath = nodeNotePath(node.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { data, body } = parseFrontmatter(raw);
  return {
    workspaceId,
    nodeId: node.id,
    path: node.path,
    name: node.name,
    type: node.type,
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
  const baseEtag = optionalString(p, "baseEtag");
  const rawInput = typeof p.raw === "string" ? p.raw : undefined;
  const body = typeof p.body === "string" ? p.body : undefined;
  const frontmatter =
    p.frontmatter && typeof p.frontmatter === "object" && !Array.isArray(p.frontmatter)
      ? (p.frontmatter as Record<string, unknown>)
      : undefined;

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.write");
    const notePath = nodeNotePath(node.path);
    const diskRaw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(diskRaw);
    // Forced optimistic concurrency for existing nodes (createNote / migrate / role-init are other paths).
    if (!baseEtag) {
      throw new RpcError(-32008, "docs.write requires baseEtag for existing nodes", {
        code: "etag_required",
        currentEtag,
        path: node.path,
        nodeId: node.id,
      });
    }
    if (baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        code: "etag_conflict",
        currentEtag,
        baseEtag,
        path: node.path,
        nodeId: node.id,
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
      await syncTagRegistryAfterNodeTagsChange(
        mount.env.fs,
        node.tags,
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
        // patchNode for non-semantic frontmatter only (type/tags rejected above)
        await patchNode(mount.env, node.path, frontmatter, tent);
      }
      if (body !== undefined) {
        await patchBody(mount.env, node.path, body, tent);
      }
      if (body === undefined && (!frontmatter || Object.keys(frontmatter).length === 0)) {
        throw new RpcError(-32602, "docs.write requires raw, body, and/or frontmatter");
      }
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: node.id, path: node.path, reason: "docs.write" },
      "self"
    );
    // Success: new etag only — clients already hold the written buffer; errors never include body.
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
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
    const node = resolveNode(tent, p);
    ctx.host.markSelfWrite(workspaceId);
    try {
      await setNodeMode(mount.env, node.id, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : "docs.setMode failed";
      if (/not found/i.test(message)) throw new RpcError(-32004, message);
      if (
        /mode must be|Invalid nodes|archive root|already archived|Claimed ranges|restored to editable/i.test(
          message
        )
      ) {
        throw new RpcError(-32602, message);
      }
      throw new RpcError(-32000, message);
    }
    const after = await loadTent(mount.env.fs);
    const updated = after.byId.get(node.id);
    if (!updated) throw new RpcError(-32004, `Node not found after setMode: ${node.id}`);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: updated.id, path: updated.path, reason: "docs.setMode", mode: updated.mode },
      "self"
    );
    return {
      workspaceId,
      nodeId: updated.id,
      path: updated.path,
      mode: updated.mode,
      archived: updated.archived,
      node: projectNode(updated, false, false),
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
    nodeId: string;
    path: string;
    name: string;
    title?: string;
    snippet: string;
    match: "title" | "body" | "path";
  }> = [];

  for (const node of tent.byId.values()) {
    if (node.archived || node.invalid) continue;
    const title = typeof node.fm.title === "string" ? node.fm.title : node.name;
    if (node.name.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      hits.push({
        nodeId: node.id,
        path: node.path,
        name: node.name,
        title,
        snippet: title,
        match: "title",
      });
      continue;
    }
    if (node.path.toLowerCase().includes(q)) {
      hits.push({
        nodeId: node.id,
        path: node.path,
        name: node.name,
        title,
        snippet: node.path,
        match: "path",
      });
      continue;
    }
    const body = node.body ?? "";
    const idx = body.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + q.length + 40);
      hits.push({
        nodeId: node.id,
        path: node.path,
        name: node.name,
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
  const node = resolveNode(tent, p);
  const nodes = [...tent.byId.values()].map((b) => ({
    id: b.id,
    path: b.path,
    name: b.name,
    body: b.body,
    notePath: nodeNotePath(b.path),
  }));
  const reverse = buildBacklinkIndex(nodes);
  return {
    workspaceId,
    nodeId: node.id,
    backlinks: reverse.get(node.id) ?? [],
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
 * Emits registry.tags.updated once on success (no per-Node node.changed).
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
 * Emits exactly one node.changed with reason docs.setType.
 */
async function docsSetType(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.setType");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const type = requireString(p, "type");
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.setType");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "docs.setType");

    if (!isValidNodeType(type, tent.typeRegistry)) {
      throw new RpcError(
        -32602,
        `Invalid node type: ${type}. Primary must be goal|prompt|output; secondary must be a registered modifier.`,
        { type }
      );
    }

    ctx.host.markSelfWrite(workspaceId);
    try {
      await patchNode(mount.env, node.path, { type }, tent);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.setType");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: node.id, path: node.path, reason: "docs.setType", type },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only replace Node tag list (MutationBus + baseEtag).
 * Empty clears Node tags; does not prune registry. Emits node.changed reason docs.tags.set.
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
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.tags.set");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "docs.tags.set");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await patchNode(mount.env, node.path, { tags }, tent);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tags.set");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: node.id, path: node.path, reason: "docs.tags.set" },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only attach one tag (MutationBus + baseEtag; idempotent).
 * Emits node.changed reason docs.tag.add.
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
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.tag.add");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "docs.tag.add");

    ctx.host.markSelfWrite(workspaceId);
    try {
      // Core addTag holds withTentMutation; MutationBus serializes Service mutations only.
      await addTag(mount.env.fs, node.id, tag);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tag.add");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: node.id, path: node.path, reason: "docs.tag.add", tag },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
      etag: contentEtag(afterRaw),
    };
  });
}

/**
 * User-only detach one tag from Node (MutationBus + baseEtag).
 * Registry is not pruned. Emits node.changed reason docs.tag.remove.
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
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.tag.remove");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "docs.tag.remove");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await removeTag(mount.env.fs, node.id, tag);
    } catch (err) {
      throw mapDocsSemanticError(err, "docs.tag.remove");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: node.id, path: node.path, reason: "docs.tag.remove", tag },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
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
    sourceNodeId: view.sourceId,
    sourcePath: view.sourcePath,
  };
}

/**
 * Read-only relation list by stable Node id (or path/nodeId resolver).
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
  const node = resolveNode(tent, p);
  try {
    const listed = listRelationsForNode(tent, node.id);
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
 * Emits exactly one node.changed reason relation.create for the source.
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
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "relation.create");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "relation.create");

    ctx.host.markSelfWrite(workspaceId);
    let record: RelationRecord;
    try {
      record = await createRelation(
        mount.env.fs,
        node.id,
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
      "node.changed",
      workspaceId,
      {
        nodeId: node.id,
        path: node.path,
        reason: "relation.create",
        relationId: record.id,
      },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
      etag: contentEtag(afterRaw),
      relation: projectRelationWire(record),
    };
  });
}

/**
 * User-only update semantic relation on source Node (MutationBus + baseEtag).
 * Cannot change relation id or source. Emits node.changed reason relation.update.
 */
async function relationUpdate(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationMutationResult> {
  requireUserActor(p, "relation.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const relationId = requireString(p, "relationId");
  const baseEtag = optionalString(p, "baseEtag");

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
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "relation.update");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "relation.update");

    ctx.host.markSelfWrite(workspaceId);
    let record: RelationRecord;
    try {
      record = await updateRelation(mount.env.fs, node.id, relationId, patch, tent);
    } catch (err) {
      throw mapRelationError(err, "relation.update");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      {
        nodeId: node.id,
        path: node.path,
        reason: "relation.update",
        relationId: record.id,
      },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
      etag: contentEtag(afterRaw),
      relation: projectRelationWire(record),
    };
  });
}

/**
 * User-only delete semantic relation on source Node (MutationBus + baseEtag).
 * Missing relation id fails loudly. Emits node.changed reason relation.delete.
 */
async function relationDelete(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<RelationDeleteResult> {
  requireUserActor(p, "relation.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const relationId = requireString(p, "relationId");
  const baseEtag = optionalString(p, "baseEtag");

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "relation.delete");
    const notePath = nodeNotePath(node.path);
    await assertDocsSemanticBaseEtag(mount.env.fs, notePath, node, baseEtag, "relation.delete");

    ctx.host.markSelfWrite(workspaceId);
    try {
      await deleteRelation(mount.env.fs, node.id, relationId, tent);
    } catch (err) {
      throw mapRelationError(err, "relation.delete");
    }

    const afterRaw = await mount.env.fs.readFile(notePath);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      {
        nodeId: node.id,
        path: node.path,
        reason: "relation.delete",
        relationId,
      },
      "self"
    );
    return {
      workspaceId,
      nodeId: node.id,
      path: node.path,
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
  if (/not found|Node not found|Node not found|Relation not found/i.test(message)) {
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
  node: import("../core/types.js").Node,
  baseEtag: string | undefined,
  surface: string
): Promise<void> {
  const diskRaw = await fs.readFile(notePath);
  const currentEtag = contentEtag(diskRaw);
  if (!baseEtag) {
    throw new RpcError(-32008, `${surface} requires baseEtag`, {
      code: "etag_required",
      currentEtag,
      path: node.path,
      nodeId: node.id,
    });
  }
  if (baseEtag !== currentEtag) {
    throw new RpcError(-32009, "etag conflict", {
      code: "etag_conflict",
      currentEtag,
      baseEtag,
      path: node.path,
      nodeId: node.id,
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
  if (/not found|Node not found/i.test(message)) {
    return new RpcError(-32004, message);
  }
  if (
    /Unknown type|Primary type|Invalid or archived|cannot be tagged|cannot be empty|path separators|newlines|Reserved or retired|Archived nodes|Invalid subtrees/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

/** Read-only durable Role projection. Connection availability belongs to machine Settings. */
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
  };
  return proj;
}

async function projectRoleRegistryEntryLive(
  _ctx: HandlerContext,
  role: RoleDefinition
): Promise<RoleRegistryEntryProjection> {
  return projectRoleRegistryEntry(role);
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
    // Only durable Role tasks block Role deletion.
    const activeTask = tasks.find(
      (t) =>
        isActiveTaskState(t.state) &&
        roleId !== "" && t.roleId === roleId
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

    const activeSession = await findActiveExternalSessionForRole(ctx, workspaceId, roleId);
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
 * Never accepts launchSecrets / secret-shaped keys.
 */
function parseRoleDefinitionParams(
  p: Record<string, unknown>,
  opts: { requireName: boolean; forUpdate?: boolean }
): RoleDefinition {
  const surface = opts.forUpdate ? "registry.role.update" : "registry.role.create";
  assertAllowedParams(
    p,
    new Set([
      "workspaceId",
      "actor",
      "name",
      ...(opts.forUpdate ? ["roleId"] : []),
      "displayName",
      "prompt",
      "description",
      "color",
      "cli",
    ]),
    surface
  );

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
 * Machine-local AgentConnection catalog for desktop launch picker / editor.
 * Safe projection only — no env maps, API keys, tokens, or secret values.
 */
async function connectionList(ctx: HandlerContext, p: Record<string, unknown>) {
  void p;
  const catalog = ctx.connectionCatalog.list();
  const existsMap = await launchSecretExistsLookup(ctx, catalog);
  return { connections: projectAgentConnections(catalog, { launchSecretExistsById: existsMap }) };
}

async function connectionGet(ctx: HandlerContext, p: Record<string, unknown>) {
  const connectionId = requireString(p, "connectionId");
  const connection = ctx.connectionCatalog.get(connectionId);
  if (!connection) {
    throw new RpcError(-32004, `Agent Connection not found: ${connectionId}`);
  }
  return {
    connection: projectAgentConnection(
      connection,
      await connectionLaunchSecretExistsOpts(ctx, connection)
    ),
  };
}

async function connectionCreate(ctx: HandlerContext, p: Record<string, unknown>) {
  const created = await ctx.connectionCatalog.create(p);
  const connection = projectAgentConnection(
    created,
    await connectionLaunchSecretExistsOpts(ctx, created)
  );
  ctx.events.emit(
    "connection.changed",
    "",
    { action: "create", connectionId: created.connectionId, connection },
    "self"
  );
  return {
    connection,
  };
}

async function connectionUpdate(ctx: HandlerContext, p: Record<string, unknown>) {
  const connectionId = requireString(p, "connectionId");
  const { connectionId: _connectionId, ...patch } = p;
  const updated = await ctx.connectionCatalog.update(connectionId, patch);
  const connection = projectAgentConnection(
    updated,
    await connectionLaunchSecretExistsOpts(ctx, updated)
  );
  ctx.events.emit(
    "connection.changed",
    "",
    { action: "update", connectionId: updated.connectionId, connection },
    "self"
  );
  return {
    connection,
  };
}

async function connectionDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  const connectionId = requireString(p, "connectionId");
  const result = await ctx.connectionCatalog.delete(connectionId);
  ctx.events.emit(
    "connection.changed",
    "",
    { action: "delete", connectionId: result.deleted },
    "self"
  );
  return result;
}

async function launchSecretExistsLookup(
  ctx: HandlerContext,
  routes: Array<{ launchSecretRef?: string }>
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  for (const route of routes) {
    const ref = typeof route.launchSecretRef === "string" ? route.launchSecretRef.trim() : "";
    if (ref && !map.has(ref)) {
      map.set(ref, ctx.launchSecrets.has(ref));
    }
  }
  return map;
}

async function connectionLaunchSecretExistsOpts(
  ctx: HandlerContext,
  connection: { launchSecretRef?: string }
): Promise<{ launchSecretExists: boolean } | undefined> {
  const ref = connection.launchSecretRef?.trim() || undefined;
  if (!ref) return undefined;
  return { launchSecretExists: ctx.launchSecrets.has(ref) };
}

/**
 * Read-only product provider verification catalog (provider.catalog).
 * Machine-global product facts — no workspaceId, no secrets, no Connection config.
 */
function providerCatalogRpc(): ProviderCatalogProjection {
  return projectProviderCatalog();
}

/**
 * Privileged machine Settings surface for opaque launch secrets.
 * It is not an account/OAuth manager. Plaintext is accepted only by set and is
 * never returned, emitted, logged, or persisted outside the encrypted store.
 */
type VerifiedCallerContext = {
  callerSessionId?: string;
  callerExternalKey?: string;
};

function requireMachineSettingsCaller(
  p: Record<string, unknown>,
  surface: string,
  callContext: VerifiedCallerContext
): void {
  if (callContext.callerSessionId || callContext.callerExternalKey) {
    throw new RpcError(
      -32001,
      `${surface} is available only to the local machine Settings client`,
      {
        code: "MACHINE_SETTINGS_CALLER_REQUIRED",
        ...(callContext.callerSessionId ? { callerSessionId: callContext.callerSessionId } : {}),
        ...(callContext.callerExternalKey ? { callerExternalKey: callContext.callerExternalKey } : {}),
      }
    );
  }
  requireUserActor(p, surface);
}

async function settingsLaunchSecretList(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  callContext: VerifiedCallerContext
) {
  assertAllowedParams(p, new Set(["actor"]), "settings.launchSecret.list");
  requireMachineSettingsCaller(p, "settings.launchSecret.list", callContext);
  const launchSecrets = await ctx.launchSecrets.list();
  return { launchSecrets };
}

async function settingsLaunchSecretSet(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  callContext: VerifiedCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["id", "secret", "label", "actor"]),
    "settings.launchSecret.set"
  );
  requireMachineSettingsCaller(p, "settings.launchSecret.set", callContext);
  const id = requireString(p, "id");
  // Accept secret only as a string param; never log or re-emit it.
  if (!("secret" in p) || typeof p.secret !== "string" || p.secret.length === 0) {
    throw new RpcError(-32602, "Missing or invalid string param: secret");
  }
  const secret = p.secret;
  // Optional non-secret display label. There is one canonical wire spelling.
  let metadata: { label?: string } | undefined;
  if ("label" in p && p.label !== undefined && p.label !== null) {
    if (typeof p.label !== "string") {
      throw new RpcError(-32602, "Invalid string param: label");
    }
    metadata = { label: p.label };
  }
  try {
    const launchSecret = await ctx.launchSecrets.set(id, secret, metadata);
    // Safe event: id/metadata only — never secret.
    ctx.events.emit(
      "settings.launchSecret.changed",
      "",
      {
        action: "set",
        id: launchSecret.id,
        updatedAt: launchSecret.updatedAt,
        ...(launchSecret.metadata ? { metadata: launchSecret.metadata } : {}),
      },
      "self"
    );
    return { launchSecret };
  } catch (err) {
    // Sanitize: never include secret in error message/data.
    const message = err instanceof Error ? err.message : "settings.launchSecret.set failed";
    if (secret && message.includes(secret)) {
      throw new RpcError(-32602, "settings.launchSecret.set failed");
    }
    if (
      /Invalid launch secret id|Missing or invalid launch secret|launch secret|metadata|must match/i.test(
        message
      )
    ) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32000, message);
  }
}

async function settingsLaunchSecretDelete(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  callContext: VerifiedCallerContext
) {
  assertAllowedParams(p, new Set(["id", "actor"]), "settings.launchSecret.delete");
  requireMachineSettingsCaller(p, "settings.launchSecret.delete", callContext);
  const id = requireString(p, "id");
  try {
    const result = await ctx.launchSecrets.delete(id);
    ctx.events.emit(
      "settings.launchSecret.changed",
      "",
      { action: "delete", id: result.deleted },
      "self"
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "settings.launchSecret.delete failed";
    if (/not found/i.test(message)) {
      throw new RpcError(-32004, message);
    }
    if (/Invalid launch secret id|Missing or invalid launch secret/i.test(message)) {
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
    const nodeId = await createNode(mount.env, { parentPath, name, type });
    const notePath = parentPath ? `${parentPath}/${name}` : name;
    if (body !== undefined) {
      await patchBody(mount.env, notePath, body.endsWith("\n") ? body : body + "\n");
    }
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId, path: notePath, reason: "docs.createNote" },
      "self"
    );
    return { workspaceId, nodeId, path: notePath, type };
  });
}

/**
 * Store original attachment bytes under attachments/<cx>/….
 * Wire transport is base64 in the canonical `bytesBase64` field.
 * No .b64 companion files; disk is the decoded binary payload.
 */
async function docsImportAttachment(ctx: HandlerContext, p: Record<string, unknown>) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "nodeId", "fileName", "bytesBase64"]),
    "docs.importAttachment"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const fileName = requireString(p, "fileName");
  const rawBase64 =
    typeof p.bytesBase64 === "string" ? p.bytesBase64 : undefined;
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
    const node = resolveNode(tent, p);
    assertDocsModeMutable(node, "docs.importAttachment");
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await storeAttachmentBytes(
        mount.env.fs,
        node.id,
        fileName,
        bytes,
        nodeNotePath(node.path)
      );
      return {
        workspaceId,
        nodeId: node.id,
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
  const nodeId = requireString(p, "nodeId");

  return ctx.mutations.run(workspaceId, async () => {
    if (!isNodeId(nodeId)) throw new RpcError(-32602, `Invalid Node id: ${nodeId}`);
    const tent = await loadTent(mount.env.fs);
    requireCanonicalNode(tent, nodeId);
    ctx.host.markSelfWrite(workspaceId);
    const forkRootId = await forkNode(mount.env, nodeId);
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: forkRootId, reason: "docs.fork", forkOf: nodeId },
      "self"
    );
    return { workspaceId, nodeId: forkRootId, forkOf: nodeId };
  });
}

/**
 * User-only atomic node rename.
 * MutationBus; keeps cx- immutable; moves folder + identity note; rewrites path links.
 * Success emits exactly one node.changed (reason docs.rename) with oldPath/path.
 */
async function docsRename(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.rename");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const newName = requireString(p, "newName");
  // Client cannot supply a replacement identity — only a new display/path stem.
  if ("newId" in p) {
    throw new RpcError(-32602, "docs.rename cannot change node id; cx- is immutable");
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = resolveNode(tent, p);
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await renameNode(mount.env, node.id, newName);
      ctx.events.emit(
        "node.changed",
        workspaceId,
        {
          nodeId: result.id,
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
        nodeId: result.id,
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
    /already exists|cannot be empty|path separators|control characters|newlines|longer than|Invalid or archived|Claimed ranges|Cannot rename|System directories|system pipelines|sibling node|Identity note missing|id drift|immutable/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

/**
 * User-only structural move / reparent.
 * MutationBus; resolve by cx-; require expectedPath; placeNode occupation; rename-style link rewrite on parent change.
 * Success emits exactly one node.changed (reason docs.move) with oldPath/path/pathMap.
 */
async function docsMove(ctx: HandlerContext, p: Record<string, unknown>) {
  requireUserActor(p, "docs.move");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const nodeId = requireString(p, "nodeId");
  const expectedPath = requireString(p, "expectedPath");
  if ("newId" in p) {
    throw new RpcError(-32602, "docs.move cannot change node id; cx- is immutable");
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
    const node = tent.byId.get(nodeId);
    if (!node) {
      throw new RpcError(-32004, `Node not found: ${nodeId}`);
    }
    // Tree identity concurrency: path must match client's expectedPath (not body etag).
    const normalizedExpected = expectedPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const currentPath = node.path;
    if (currentPath !== normalizedExpected) {
      throw new RpcError(-32009, "path stale", {
        code: "path_stale",
        currentPath,
        expectedPath: normalizedExpected,
        nodeId: node.id,
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
      const result = await moveNode(mount.env, node.id, newParentId, position);
      ctx.events.emit(
        "node.changed",
        workspaceId,
        {
          nodeId: result.id,
          path: result.path,
          oldPath: result.oldPath,
          reason: "docs.move",
          pathMap: result.pathMap,
        },
        "self"
      );
      return {
        workspaceId,
        nodeId: result.id,
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
    /already exists|Invalid or archived|Cannot move|active task|System directories|system pipelines|sibling node|id drift|immutable|own subtree|relative to itself|destination parent|Node id is required/i.test(
      message
    )
  ) {
    return new RpcError(-32602, message);
  }
  return new RpcError(-32000, message);
}

// ---- task.* ----

async function taskDispatch(ctx: HandlerContext, p: Record<string, unknown>) {
  assertAllowedParams(
    p,
    new Set([
      "workspaceId",
      "workNodeIds",
      "contextNodeIds",
      "roleId",
      "connectionId",
      "prompt",
      "parentActor",
      "reviewer",
      "asSub",
      "acceptMode",
      "callerKind",
    ]),
    "task.dispatch"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  // Authoritative public Node selection is exact writable work plus shared context.
  const dispatchSelection = resolveTaskNodeSelection(p, mount.env.tentName, "task.dispatch");
  const primaryNodeId = dispatchSelection.primaryId;
  const requestedRoleId = optionalString(p, "roleId");
  const connectionId = optionalString(p, "connectionId");
  if (Boolean(requestedRoleId) === Boolean(connectionId)) {
    throw new RpcError(-32602, "task.dispatch requires exactly one of roleId or connectionId");
  }
  const prompt = requireString(p, "prompt");
  const asSub = p.asSub === true;
  // Protocol 3 has one explicit responsibility pair.
  const explicitParentActor = parseOptionalTaskActor(p.parentActor, "parentActor");
  const explicitReviewer = parseOptionalTaskActor(p.reviewer, "reviewer");
  const explicitAcceptMode = parseAcceptMode(optionalString(p, "acceptMode"));
  // New create requires explicit parentActor + reviewer.
  const resolvedActors = resolveDispatchActorsFromRpc({
    parentActor: explicitParentActor,
    reviewer: explicitReviewer,
  });

  const roleRegistry = requestedRoleId || asSub ? await loadRolesRegistry(mount.env.fs) : undefined;
  const roleDefinition = requestedRoleId
    ? roleRegistry?.roles.find((role) => role.id === requestedRoleId)
    : undefined;
  if (requestedRoleId && !roleDefinition) {
    throw new RpcError(-32004, `Role not found in registry: ${requestedRoleId}`);
  }
  const parentRoleDefinition = asSub && resolvedActors.parentActor.kind === "role"
    ? roleRegistry?.roles.find((role) => role.id === resolvedActors.parentActor.id)
    : undefined;
  if (asSub && !parentRoleDefinition) {
    throw new RpcError(
      -32004,
      `Parent Role not found in registry: ${resolvedActors.parentActor.id}`
    );
  }
  if (connectionId && !ctx.connectionCatalog.get(connectionId)) {
    throw new RpcError(-32004, `Agent Connection not found: ${connectionId}`);
  }
  // parentActor is the persisted authority fact. callerKind is a convenience hint,
  // not a second authorization source; derive the combined start path from parentActor.
  const callerKind = resolvedActors.parentActor.kind;
  // P0-1: role worktree create/reuse + envelope dispatch share the workspace MutationBus
  // critical section so concurrent role worktree add cannot race. Git ops stay inside the
  // bus action (never nested mutations.run).
  // Connection-launched Tasks receive their exact Task lane and reserved Session
  // before the envelope is written. Role handoff captures its Role lane at claim.
  // Role target (peer + asSub): ensure durable Role/parent worktrees for validation only;
  // do NOT persist execution workspaceLane/baseCommit/roleBranchBase at queue — first claim
  // captures the real Role tip in the same lifecycle + workspace mutation boundary.
  // When acceptMode is omitted, snapshot current workspace default into the task
  // envelope at dispatch time (settings changes never rewrite existing tasks).
  const preallocatedTaskId = connectionId ? makeTaskId() : undefined;
  const reservedSessionId = connectionId ? makeSessionId() : undefined;
  const result = await ctx.mutations.run(workspaceId, async () => {
    // Keep registry/Git validation in the same workspace mutation section as lane
    // creation and envelope persistence. Otherwise a concurrent role update could
    // invalidate a check made just before entering the bus.
    if (asSub) {
      await assertSubDispatchPreconditions(mount.env.fs, {
        workspaceRoot: mount.workspaceRoot,
        parentActor: resolvedActors.parentActor,
        targetRoleId: requestedRoleId,
      });
    }
    let workspaceLane: RoleWorkspaceContract | undefined;

    if (asSub) {
      // Parent Role lane must exist so asSub target can be validated / later bound at claim.
      const dispatcherLane = await ensureRoleWorkspace(
        mount.workspaceRoot,
        parentRoleDefinition!.name
      );
      if (requestedRoleId) {
        // Ensure assignee Role worktree exists; leave envelope without execution lane/base.
        await ensureRoleWorkspace(mount.workspaceRoot, roleDefinition!.name);
        // Delay entire Role execution lane until first claim (do not freeze Git tip).
        workspaceLane = undefined;
      } else {
        workspaceLane = await ensureTaskWorkspace(
          mount.workspaceRoot,
          preallocatedTaskId!,
          { targetBranch: dispatcherLane.branch }
        );
      }
    } else if (requestedRoleId) {
      // Peer role: ensure durable tent-role worktree when Git (validation only).
      // Execution lane + baseCommit are captured at first claim, not queue.
      await ensureRoleWorkspaceIfGit(mount.workspaceRoot, roleDefinition!.name);
      workspaceLane = undefined;
    } else {
      // Non-code / non-Git work remains a formal Task rooted at the mounted
      // workspace. A Git lane is created only when the workspace is actually Git.
      workspaceLane = await ensureTaskWorkspaceIfGit(
        mount.workspaceRoot,
        preallocatedTaskId!
      );
    }

    ctx.host.markSelfWrite(workspaceId);
    let acceptMode = explicitAcceptMode;
    if (acceptMode === undefined) {
      const settings = await loadWorkspaceSettings(mount.env.fs);
      acceptMode = settings.defaultAcceptMode;
    }
    // Downstream Task Agent → parent: force review-required.
    if (
      acceptMode !== "review-required" &&
      !allowsNonReviewAcceptMode({
        parentActor: resolvedActors.parentActor,
      })
    ) {
      if (explicitAcceptMode !== undefined) {
        throw new RpcError(
          -32602,
          `acceptMode=${acceptMode} is only legal for a user-facing Task; ` +
            `Task Agent → parent must use review-required (parent=${resolvedActors.parentActor.kind}:${resolvedActors.parentActor.id})`,
          {
            acceptMode,
            parentActor: resolvedActors.parentActor,
            roleId: requestedRoleId,
          }
        );
      }
      // Workspace default elevated downstream is clamped to review-required.
      acceptMode = "review-required";
    }
    if (connectionId) {
      await ctx.runtime.reserveSession({
        sessionId: reservedSessionId!,
        connectionId,
        lastTaskId: preallocatedTaskId!,
        workspace: workspaceId,
        workspaceLane,
        runtimeWorkspace: { cwd: workspaceLane?.worktree || mount.workspaceRoot },
      });
    }
    let dispatched;
    try {
      dispatched = await dispatch(mount.env, primaryNodeId, {
        userPrompt: prompt,
        parentActor: resolvedActors.parentActor,
        reviewer: resolvedActors.reviewer,
        asSub,
        acceptMode,
        workspace: workspaceLane,
        ...(requestedRoleId ? { roleId: requestedRoleId } : {}),
        ...(reservedSessionId ? { sessionId: reservedSessionId } : {}),
        workNodeIds: dispatchSelection.workNodeIds,
        contextNodeIds: dispatchSelection.contextNodeIds,
        ...(preallocatedTaskId ? { taskId: preallocatedTaskId } : {}),
      });
    } catch (error) {
      if (reservedSessionId) {
        try {
          // Provider launch has not started and no Task exists. Remove the exact
          // reservation instead of persisting a Session that points at a phantom Task.
          await ctx.runtime.registry.remove(reservedSessionId);
        } catch (cleanupError) {
          throw new RpcError(
            RPC_LIFECYCLE,
            "Task creation failed and the exact reserved Session could not be removed",
            {
              code: "DISPATCH_RESERVATION_CLEANUP_FAILED",
              sessionId: reservedSessionId,
              cause: error instanceof Error ? error.message : String(error),
              cleanupError:
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }
          );
        }
      }
      throw error;
    }
    let dispatchedState: TaskEnvelope["state"] = "queued";
    if (connectionId) {
      try {
        if (beforeTaskClaimCoreForTests) {
          const pre = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath);
          await beforeTaskClaimCoreForTests({
            workspaceId,
            taskPath: dispatched.taskPath,
            task: pre,
          });
        }
        const claimed = await taskClaim(mount.env, dispatched.taskPath);
        dispatchedState = claimed.state;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const recoveryErrors: string[] = [];
        try {
          // A Connection Task must not remain queued after its atomic claim
          // boundary fails. The ordinary queued interrupt deletes an unclaimed
          // handoff, but this Task already owns a reserved Session and therefore
          // needs a durable terminal audit instead of disappearing.
          const current = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath);
          let terminal: TaskEnvelope;
          if (current.state === "queued") {
            ctx.host.markSelfWrite(workspaceId);
            terminal = await patchTaskEnvelope(mount.env.fs, dispatched.taskPath, {
              state: "interrupted",
              wait: null,
              updatedAt: mount.env.clock.now(),
            });
          } else if (current.state === "running" || current.state === "waiting") {
            terminal = await taskFail(mount.env, dispatched.taskPath, {
              summary: `Connection dispatch could not claim the exact Task: ${detail}`,
            });
          } else {
            terminal = current;
          }
          emitTaskState(ctx, workspaceId, terminal, "task.dispatch.claim-failed");
        } catch (recoveryError) {
          recoveryErrors.push(
            `Task failure: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
          );
        }
        try {
          await ctx.runtime.registry.update(reservedSessionId!, {
            state: "failed",
            lastError: `Connection dispatch could not claim the exact Task: ${detail}`,
          });
        } catch (recoveryError) {
          recoveryErrors.push(
            `Session failure: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
          );
        }
        if (recoveryErrors.length > 0) {
          throw new RpcError(
            RPC_LIFECYCLE,
            `Connection dispatch claim failed and durable recovery was incomplete: ${recoveryErrors.join("; ")}`,
            {
              code: "DISPATCH_CLAIM_RECOVERY_FAILED",
              taskPath: dispatched.taskPath,
              sessionId: reservedSessionId,
              cause: detail,
              recoveryErrors,
            }
          );
        }
        throw error;
      }
    }
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched.taskPath,
        state: dispatchedState,
        roleId: dispatched.roleId,
        sessionId: dispatched.sessionId,
        workNodeIds: [...dispatchSelection.workNodeIds],
        contextNodeIds: [...dispatchSelection.contextNodeIds],
        reason: "task.dispatch",
      },
      "self"
    );
    return { dispatched, workspaceLane };
  });
  const workspaceLane = result.workspaceLane;
  const dispatched = result.dispatched;

  let session: unknown = undefined;
  if (connectionId) {
    // Reservation + Task creation/claim completed in one workspace mutation.
    // Provider startup remains outside so terminal lifecycle transitions can win.
    try {
      session = await taskStartSessionRpc(ctx, {
        workspaceId,
        taskPath: dispatched.taskPath,
        callerKind,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runtime.registry
        .update(reservedSessionId!, {
          state: "failed",
          lastError: `Connection dispatch could not start the exact Task Session: ${detail}`,
        })
        .catch(() => undefined);
      const current = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath).catch(() => null);
      if (
        current &&
        current.state === "running" &&
        current.sessionId === reservedSessionId
      ) {
        await parkTaskForUnavailableSession(ctx, {
          workspaceId,
          taskPath: dispatched.taskPath,
          sessionId: reservedSessionId,
          reason: "task.dispatch.connection-start-failed",
          detail,
        });
      }
      throw error;
    }
  }

  const taskAfter = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath);
  return {
    workspaceId,
    taskPath: dispatched.taskPath,
    manifestPath: dispatched.manifestPath,
    initPath: dispatched.initPath,
    relayPrompt: dispatched.relayPrompt,
    roleId: dispatched.roleId,
    sessionId: dispatched.sessionId,
    asSub: taskAsSub(taskAfter),
    parentActor: taskAfter.parentActor,
    reviewer: taskAfter.reviewer,
    state: taskAfter.state,
    session,
    // Prefer envelope projection (Role baseCommit only after claim; Connection-asSub may
    // still carry dispatch-time lane). Fall back to in-memory lane only when present.
    workspaceLane: projectTask(taskAfter).workspaceLane,
  };
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
    targetRoleId?: string;
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
  if (input.targetRoleId && dispatcher === input.targetRoleId) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub parentActor must not equal the assignee itself",
      { parentActor: input.parentActor, roleId: input.targetRoleId }
    );
  }
  const registry = await loadRolesRegistry(fs);
  const role = registry.roles.find((item) => item.id === dispatcher);
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
 * Accept only canonical `workNodeIds` + `contextNodeIds`. Retired generic Node
 * selection fields are rejected rather than silently translated.
 * Fail loud before MutationBus Task/manifest writes for malformed input.
 * Node existence/archive gates run inside Core under the same workspace lock.
 */
function resolveTaskNodeSelection(
  p: Record<string, unknown>,
  tentName: string,
  method: "task.dispatch" | "task.claimDirect"
): { workNodeIds: string[]; contextNodeIds: string[]; primaryId: string } {
  for (const retired of ["nodeId", "nodeIds", "id", "claimId"] as const) {
    if (p[retired] !== undefined && p[retired] !== null) {
      throw new RpcError(
        -32602,
        `${method} ${retired} is retired; pass workNodeIds[] and contextNodeIds[]`,
        { field: retired }
      );
    }
  }
  for (const field of ["workNodeIds", "contextNodeIds"] as const) {
    if (!Array.isArray(p[field]) || !(p[field] as unknown[]).every((x) => typeof x === "string")) {
      throw new RpcError(-32602, `Invalid string[] param: ${field}`);
    }
  }
  try {
    const selection = resolveDispatchTaskNodeSelection({
      workNodeIds: p.workNodeIds,
      contextNodeIds: p.contextNodeIds,
      tentName,
    });
    return { ...selection, primaryId: selection.workNodeIds[0]! };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(-32602, message, { field: "workNodeIds" });
  }
}

/**
 * Resolve parent/reviewer at dispatch RPC.
 * Requires explicit parentActor. Reviewer may be omitted (derived equal to
 * parent); when present must match exactly — no Role A → reviewer Role B.
 * Equality is enforced only via resolveParentReviewerPair (same as Core write/load).
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

async function taskClaimDirectRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: { sessionId?: string; externalKey?: string } = {}
) {
  assertAllowedParams(
    p,
    new Set([
      "workspaceId",
      "roleId",
      "workNodeIds",
      "contextNodeIds",
      "prompt",
      "sourceTaskPath",
    ]),
    "task.claimDirect"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const roleId = requireString(p, "roleId");
  const prompt = requireString(p, "prompt");
  const sourceTaskPath = optionalString(p, "sourceTaskPath");
  const selection = resolveTaskNodeSelection(p, mount.env.tentName, "task.claimDirect");

  return ctx.mutations.run(workspaceId, async () => {
    const registry = await loadRolesRegistry(mount.env.fs);
    const roleDefinition = registry.roles.find((role) => role.id === roleId);
    if (!roleDefinition) {
      throw new RpcError(-32004, `Role not found in registry: ${roleId}`, {
        code: "DIRECT_CLAIM_ROLE_NOT_FOUND",
        roleId,
      });
    }
    const callerSession = await requireRoleClaimCallerSession(
      ctx,
      workspaceId,
      roleId,
      caller
    );
    await assertRoleSessionHasNoOtherActiveTask(
      ctx,
      workspaceId,
      callerSession.id
    );
    const actors = await resolveDirectClaimResponsibility(ctx, {
      workspaceId,
      roleId,
      sourceTaskPath,
      sourceSessionId: callerSession.id,
    });

    // Direct claim is the Role taking its own execution responsibility. It is
    // never a downstream/asSub dispatch and therefore never enters the
    // self-subdispatch cycle guard.
    await ensureRoleWorkspaceIfGit(mount.workspaceRoot, roleDefinition.name);
    const settings = await loadWorkspaceSettings(mount.env.fs);
    const acceptMode = allowsNonReviewAcceptMode({
      parentActor: actors.parentActor,
    })
      ? settings.defaultAcceptMode
      : "review-required";

    ctx.host.markSelfWrite(workspaceId);
    const roleRootPath = roleTempRoot(roleId);
    const expectedInitPath = nodePath.posix.join(roleRootPath, "init.md");
    const initExisted = await mount.env.fs.exists(expectedInitPath);
    const initBefore = initExisted
      ? await mount.env.fs.readFile(expectedInitPath)
      : undefined;
    let created:
      | Awaited<ReturnType<typeof dispatch>>
      | undefined;
    let previousLastTaskId: string | undefined;
    let callerSessionRebound = false;
    try {
      created = await dispatch(mount.env, selection.primaryId, {
        userPrompt: prompt,
        parentActor: actors.parentActor,
        reviewer: actors.reviewer,
        acceptMode,
        roleId,
        sessionId: callerSession.id,
        workNodeIds: selection.workNodeIds,
        contextNodeIds: selection.contextNodeIds,
      });
      const pre = await loadTaskEnvelope(mount.env.fs, created.taskPath);
      previousLastTaskId = callerSession.lastTaskId;
      await ctx.runtime.registry.update(callerSession.id, {
        lastTaskId: pre.id || pre.path,
      });
      callerSessionRebound = true;
      const claimWrite = await prepareRoleClaimWrite(ctx, workspaceId, pre);
      if (beforeTaskClaimCoreForTests) {
        await beforeTaskClaimCoreForTests({
          workspaceId,
          taskPath: created.taskPath,
          task: pre,
        });
      }
      const task = await taskClaim(mount.env, created.taskPath, {
        ...(claimWrite ? { claimWrite } : {}),
      });
      emitTaskState(ctx, workspaceId, task, "task.claimDirect");
      for (const nodeId of task.workNodeIds) {
        if (nodeId === "root") continue;
        ctx.events.emit(
          "node.changed",
          workspaceId,
          { nodeId, reason: "task.claim-projection" },
          "self"
        );
      }
      return {
        workspaceId,
        taskPath: created.taskPath,
        manifestPath: created.manifestPath,
        initPath: created.initPath,
        task: projectTask(task),
        state: task.state,
        roleId: task.roleId,
        sessionId: task.sessionId,
        workNodeIds: [...task.workNodeIds],
        contextNodeIds: [...task.contextNodeIds],
      };
    } catch (err) {
      if (callerSessionRebound) {
        await ctx.runtime.registry
          .update(callerSession.id, { lastTaskId: previousLastTaskId })
          .catch(() => undefined);
      }
      if (created) {
        const cleanupErrors: string[] = [];
        for (const exactPath of [created.taskPath, created.manifestPath]) {
          try {
            if (await mount.env.fs.exists(exactPath)) {
              await mount.env.fs.remove(exactPath);
            }
          } catch (cleanupErr) {
            cleanupErrors.push(
              `${exactPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
            );
          }
        }
        if (created.initPath) {
          try {
            if (initExisted && initBefore !== undefined) {
              await mount.env.fs.writeFile(created.initPath, initBefore);
            } else if (await mount.env.fs.exists(created.initPath)) {
              await mount.env.fs.remove(created.initPath);
            }
          } catch (cleanupErr) {
            cleanupErrors.push(
              `${created.initPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
            );
          }
        }
        if (cleanupErrors.length > 0) {
          throw new RpcError(
            RPC_LIFECYCLE,
            `task.claimDirect failed and exact artifact cleanup was incomplete: ${cleanupErrors.join("; ")}`,
            {
              code: "DIRECT_CLAIM_CLEANUP_FAILED",
              taskPath: created.taskPath,
              cause: err instanceof Error ? err.message : String(err),
            }
          );
        }
      }
      throw err;
    }
  });
}

async function resolveDirectClaimResponsibility(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    roleId: string;
    sourceTaskPath?: string;
    sourceSessionId?: string;
  }
): Promise<{ parentActor: TaskActorRef; reviewer: TaskActorRef }> {
  const mount = ctx.host.require(input.workspaceId);
  let session: SessionRecord | null = null;
  if (input.sourceSessionId) {
    session = await ctx.runtime.registry.read(input.sourceSessionId);
    if (!session) {
      throw new RpcError(-32004, `Session not found: ${input.sourceSessionId}`, {
        code: "DIRECT_CLAIM_SESSION_NOT_FOUND",
      });
    }
    if (
      session.workspace !== input.workspaceId ||
      session.roleId !== input.roleId ||
      session.state !== "external" ||
      !SessionRegistry.isOpen(session.state)
    ) {
      throw new RpcError(
        -32001,
        "task.claimDirect source Session is not a live exact-workspace binding for the claiming Role",
        {
          code: "DIRECT_CLAIM_SESSION_MISMATCH",
          sessionId: session.id,
          roleId: input.roleId,
        }
      );
    }
  }

  const rootResponsibility = (): { parentActor: TaskActorRef; reviewer: TaskActorRef } =>
    resolveParentReviewerPair({
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });

  const explicitSourceTask = Boolean(input.sourceTaskPath);
  const sourceRef = input.sourceTaskPath || session?.lastTaskId?.trim() || "";
  if (!sourceRef) {
    return rootResponsibility();
  }

  let sourceTask: TaskEnvelope | undefined;
  if (input.sourceTaskPath) {
    try {
      sourceTask = await loadTaskEnvelope(mount.env.fs, input.sourceTaskPath);
    } catch (err) {
      throw new RpcError(
        -32004,
        `task.claimDirect source Task could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { code: "DIRECT_CLAIM_SOURCE_TASK_NOT_FOUND", taskPath: input.sourceTaskPath }
      );
    }
  } else {
    const matches = (await loadTaskEnvelopes(mount.env.fs)).filter(
      (task) => task.id === sourceRef || task.path === sourceRef
    );
    if (matches.length === 0) {
      // A durable Role Session may outlive retention of its prior Task. The stale
      // lastTaskId is not authority and must not prevent the Role's next root Task.
      return rootResponsibility();
    }
    if (matches.length !== 1) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.claimDirect Session lastTaskId resolved ambiguously (${matches.length} Tasks)`,
        { code: "DIRECT_CLAIM_SOURCE_TASK_AMBIGUOUS", lastTaskId: sourceRef }
      );
    }
    sourceTask = matches[0]!;
  }

  const sameRoleTask = sourceTask.roleId === input.roleId;
  const activeClaim = sourceTask.state !== "queued" && isActiveTaskState(sourceTask.state);
  if (explicitSourceTask && (!sameRoleTask || !activeClaim)) {
    throw new RpcError(
      -32001,
      "task.claimDirect source Task is not an active claimed Task owned by the claiming Role",
      {
        code: "DIRECT_CLAIM_SOURCE_TASK_MISMATCH",
        taskPath: sourceTask.path,
        roleId: input.roleId,
        taskRoleId: sourceTask.roleId,
        taskSessionId: sourceTask.sessionId,
        state: sourceTask.state,
      }
    );
  }
  if (!explicitSourceTask && !sameRoleTask) {
    throw new RpcError(
      -32001,
      "task.claimDirect Session lastTaskId belongs to a different Role or assignee kind",
      {
        code: "DIRECT_CLAIM_SOURCE_TASK_MISMATCH",
        taskPath: sourceTask.path,
        roleId: input.roleId,
        taskRoleId: sourceTask.roleId,
        taskSessionId: sourceTask.sessionId,
      }
    );
  }
  if (!explicitSourceTask && sourceTask.state === "queued") {
    return rootResponsibility();
  }
  if (
    !explicitSourceTask &&
    session &&
    isActiveTaskState(sourceTask.state) &&
    sourceTask.sessionId &&
    sourceTask.sessionId !== session.id
  ) {
    // Registry lastTaskId can lag a Task Session replacement. Do not inherit a
    // stale chain implicitly; the caller can name the active --from-task exactly.
    return rootResponsibility();
  }
  if (!sourceTask.parentActor || !sourceTask.reviewer) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "task.claimDirect source Task is missing persisted parent/reviewer",
      { code: "DIRECT_CLAIM_SOURCE_AUTHORITY_MISSING", taskPath: sourceTask.path }
    );
  }
  try {
    return resolveParentReviewerPair({
      parentActor: sourceTask.parentActor,
      reviewer: sourceTask.reviewer,
    });
  } catch (err) {
    throw new RpcError(
      RPC_LIFECYCLE,
      err instanceof Error ? err.message : "Invalid source Task responsibility chain",
      { code: "DIRECT_CLAIM_SOURCE_AUTHORITY_INVALID", taskPath: sourceTask.path }
    );
  }
}

async function taskClaimRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: { sessionId?: string; externalKey?: string } = {}
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath"]),
    "task.claim"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  // Per-Task lifecycle flight + workspace mutation: claim must not race deliver/backfill.
  return runTaskLifecycle(workspaceId, taskPath, () =>
    ctx.mutations.run(workspaceId, async () => {
      // Prepare Role lane/base BEFORE Core claim transition so a failed prepare
      // leaves the Task queued (no intermediate running without base).
      const pre = await loadTaskEnvelope(mount.env.fs, taskPath);
      let claimWrite: TaskClaimWrite | undefined;
      let callerSession: SessionRecord | undefined;
      let previousLastTaskId: string | undefined;
      let recoverWaitingExternalRoleTask = false;
      if (pre.roleId) {
        callerSession = await requireRoleClaimCallerSession(
          ctx,
          workspaceId,
          pre.roleId,
          caller
        );
        await assertRoleSessionHasNoOtherActiveTask(
          ctx,
          workspaceId,
          callerSession.id,
          { path: pre.path, id: pre.id }
        );
        if (pre.state === "running" && pre.sessionId !== callerSession.id) {
          throw new RpcError(
            RPC_LIFECYCLE,
            "task.claim cannot replace the exact Session of a running Role Task",
            {
              code: "TASK_CLAIM_SESSION_MISMATCH",
              taskPath,
              boundSessionId: pre.sessionId,
              callerSessionId: callerSession.id,
            }
          );
        }
        recoverWaitingExternalRoleTask = pre.state === "waiting";
      }
      if (pre.state !== "running" && !recoverWaitingExternalRoleTask) {
        // First claim only: prepare lane/base (no disk write) then single-patch claim.
        const preparedRoleWrite = await prepareRoleClaimWrite(ctx, workspaceId, pre);
        claimWrite = {
          ...(preparedRoleWrite ?? {}),
          ...(callerSession ? { sessionId: callerSession.id } : {}),
        };
        if (beforeTaskClaimCoreForTests) {
          await beforeTaskClaimCoreForTests({ workspaceId, taskPath, task: pre });
        }
      }
      if (callerSession && pre.state !== "running" && !recoverWaitingExternalRoleTask) {
        previousLastTaskId = callerSession.lastTaskId;
        await ctx.runtime.registry.update(callerSession.id, {
          lastTaskId: pre.id || pre.path,
        });
      }
      let task: TaskEnvelope;
      try {
        if (pre.state !== "running" && !recoverWaitingExternalRoleTask) {
          ctx.host.markSelfWrite(workspaceId);
        }
        task = recoverWaitingExternalRoleTask
          ? await restoreExactExternalRoleTask(ctx, {
              workspaceId,
              taskPath,
              callerSessionId: callerSession!.id,
            })
          : await taskClaim(mount.env, taskPath, {
              ...(claimWrite ? { claimWrite } : {}),
            });
      } catch (error) {
        if (callerSession && pre.state !== "running" && !recoverWaitingExternalRoleTask) {
          await ctx.runtime.registry
            .update(callerSession.id, { lastTaskId: previousLastTaskId })
            .catch(() => undefined);
        }
        throw error;
      }
      emitTaskState(ctx, workspaceId, task, "task.claim");
      for (const nodeId of task.workNodeIds) {
        if (nodeId === "root") continue;
        ctx.events.emit(
          "node.changed",
          workspaceId,
          { nodeId, reason: "task.claim-projection" },
          "self"
        );
      }
      return {
        workspaceId,
        taskPath,
        task: projectTask(task),
        state: task.state,
        roleId: task.roleId,
        workNodeIds: [...task.workNodeIds],
        contextNodeIds: [...task.contextNodeIds],
        sessionId: task.sessionId,
      };
    })
  );
}

/**
 * Validate and, only for an explicitly recoverable wait, resume a Role Task on
 * its exact existing external Session. This never creates/replaces a Session or
 * starts an Agent Connection/provider. Callers must hold the Task lifecycle and
 * workspace mutation boundaries whenever a waiting Task may be resumed.
 */
async function restoreExactExternalRoleTask(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    callerSessionId?: string;
  }
): Promise<TaskEnvelope> {
  const mount = ctx.host.require(input.workspaceId);
  const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
  const roleId = task.roleId?.trim() || "";
  const sessionId = task.sessionId?.trim() || "";
  if (!roleId || !sessionId) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "External Role Task recovery requires exact persisted roleId and sessionId",
      { code: "EXTERNAL_ROLE_TASK_BINDING_REQUIRED", taskPath: input.taskPath }
    );
  }
  if (input.callerSessionId && input.callerSessionId !== sessionId) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "task.claim caller Session does not own the exact waiting Role Task",
      {
        code: "TASK_CLAIM_SESSION_MISMATCH",
        taskPath: input.taskPath,
        boundSessionId: sessionId,
        callerSessionId: input.callerSessionId,
      }
    );
  }

  const session = await ctx.runtime.registry.read(sessionId);
  const lastTaskRef = session?.lastTaskId?.trim() || "";
  if (
    !session ||
    session.state !== "external" ||
    session.adapterId !== EXTERNAL_ADAPTER_ID ||
    session.workspace !== input.workspaceId ||
    session.roleId !== roleId ||
    (lastTaskRef !== task.id && lastTaskRef !== task.path)
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "External Role Session is not bound to the exact workspace/Role/Task",
      {
        code: "EXTERNAL_ROLE_TASK_SESSION_MISMATCH",
        taskPath: input.taskPath,
        sessionId,
        roleId,
      }
    );
  }
  const probe = await ctx.runtime.probe(sessionId);
  if (!probe.alive || probe.state !== "external" || !SessionRegistry.isOpen(probe.state)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "External Role Session is not alive and open for exact Task recovery",
      {
        code: "EXTERNAL_ROLE_TASK_SESSION_UNAVAILABLE",
        taskPath: input.taskPath,
        sessionId,
        state: probe.state,
      }
    );
  }

  if (task.state === "running") return task;
  if (
    task.state !== "waiting" ||
    (!isRejectResumeParkedWait(task) && !isSessionUnavailableParkedWait(task))
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "External Role Task is not in an exact recoverable Session wait",
      {
        code: "EXTERNAL_ROLE_TASK_WAIT_NOT_RECOVERABLE",
        taskPath: input.taskPath,
        state: task.state,
        waitCode: task.wait?.code,
      }
    );
  }
  ctx.host.markSelfWrite(input.workspaceId);
  return taskResume(mount.env, input.taskPath);
}

async function requireRoleClaimCallerSession(
  ctx: HandlerContext,
  workspaceId: string,
  roleId: string,
  caller: { sessionId?: string; externalKey?: string }
): Promise<SessionRecord> {
  let callerSessionId = caller.sessionId?.trim() || undefined;
  if (!callerSessionId && caller.externalKey?.trim()) {
    const matches = (await ctx.runtime.registry.list()).filter(
      (record) =>
        record.state === "external" &&
        recordExternalKey(record) === caller.externalKey!.trim()
    );
    if (matches.length === 1) callerSessionId = matches[0]!.id;
    else if (matches.length > 1) {
      throw new RpcError(-32001, "task.claim host-native Session context is ambiguous", {
        code: "TASK_CLAIM_CALLER_SESSION_AMBIGUOUS",
        externalKey: caller.externalKey,
      });
    }
  }
  if (!callerSessionId) {
    throw new RpcError(
      -32001,
      "task.claim requires trusted current Role Session context",
      { code: "TASK_CLAIM_CALLER_SESSION_REQUIRED", roleId }
    );
  }
  const mount = ctx.host.require(workspaceId);
  await requireRoleNameById(mount.env.fs, roleId);
  const session = await ctx.runtime.registry.read(callerSessionId);
  if (
    !session ||
    session.state !== "external" ||
    session.workspace !== workspaceId ||
    session.roleId !== roleId
  ) {
    throw new RpcError(
      -32001,
      "task.claim caller Session is not an exact live workspace/Role binding",
      {
        code: "TASK_CLAIM_CALLER_SESSION_MISMATCH",
        roleId,
        callerSessionId,
      }
    );
  }
  return session;
}

async function assertRoleSessionHasNoOtherActiveTask(
  ctx: HandlerContext,
  workspaceId: string,
  sessionId: string,
  excludeTask?: { path: string; id?: string }
): Promise<void> {
  const conflictingTasks = (
    await listIncompleteTasksBoundToSession(ctx, workspaceId, sessionId)
  )
    .filter(
      (task) =>
        !excludeTask ||
        (task.path !== excludeTask.path &&
          (!excludeTask.id || task.id !== excludeTask.id))
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  if (conflictingTasks.length === 0) return;
  const conflict = conflictingTasks[0]!;
  throw new RpcError(
    RPC_LIFECYCLE,
    "task.claim caller Session is already bound to another active Task",
    {
      code: "TASK_CLAIM_SESSION_ALREADY_ACTIVE",
      sessionId,
      conflictingTaskPath: conflict.path,
      conflictingTaskId: conflict.id,
      conflictingTaskState: conflict.state,
    }
  );
}

/**
 * Prepare Role claim write payload without mutating the envelope.
 * Returns undefined when no lane/base fields need to be written (non-Git / Session-only /
 * already complete). Throws before Core claim so the Task stays queued on failure.
 * Never writes intermediate lane-only patches.
 */
async function prepareRoleClaimWrite(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<TaskClaimWrite | undefined> {
  if (!task.roleId) return undefined;

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
    const registry = await loadRolesRegistry(mount.env.fs);
    let targetBranchHint: string | undefined;
    if (taskAsSub(task)) {
      const dispatcher = taskParentRoleId(task);
      if (!dispatcher) {
        throw new Error(
          `Sub task ${task.id || task.path} is missing a durable parent Role for claim lane bind.`
        );
      }
      const dispatcherRole = registry.roles.find((item) => item.id === dispatcher);
      if (!dispatcherRole) throw new Error(`Parent Role not found in registry: ${dispatcher}`);
      const dispatcherLane = await ensureRoleWorkspace(
        mount.workspaceRoot,
        dispatcherRole.name
      );
      targetBranchHint = dispatcherLane.branch;
      const recordedTarget = task.targetBranch?.trim();
      if (recordedTarget && recordedTarget !== targetBranchHint) {
        throw new Error(
          `Task envelope targetBranch mismatch for Role ${task.roleId}: ` +
            `envelope=${recordedTarget} expected=${targetBranchHint}`
        );
      }
    }
    // Ensure durable Role worktree/branch exists; do not patch envelope yet.
    const role = registry.roles.find((item) => item.id === task.roleId);
    if (!role) throw new Error(`Role not found in registry: ${task.roleId}`);
    const ensured = await ensureRoleWorkspace(mount.workspaceRoot, role.name);
    // Build a transient view for integration contract validation (no disk write).
    const view: TaskEnvelope = {
      ...task,
      workspace: task.workspace || ensured.workspace,
      worktree: task.worktree || ensured.worktree,
      branch: task.branch || ensured.branch,
      targetBranch: task.targetBranch || targetBranchHint || ensured.targetBranch,
    };
    real = await resolveIntegrationContract(mount.workspaceRoot, view, mount.env.fs);
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
  const patch: TaskClaimWrite = {
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

  const resumed = await ctx.mutations.run(workspaceId, async () => {
    // A Core-committed reject-resume is not ordinary running work until the
    // deterministic Service continuation row exists and matches. Open rows are
    // allowed here so start/replace recovery can reuse this exact primitive.
    await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskResume(mount.env, taskPath);
    emitTaskState(ctx, workspaceId, task, "task.resume");
    return task;
  });
  const sessionId = resumed.sessionId?.trim();
  if (sessionId) {
    // Explicit resume is the bounded production recovery entrance for a final
    // managed report preserved before a prior publication failure. This stays
    // outside the workspace mutation/Task flight and never re-prompts provider.
    try {
      await requestManagedAutoDeliverRetryFromDraft(ctx, {
        workspaceId,
        taskPath,
        sessionId,
      });
    } catch {
      // Resume is already durable. A preserved report remains retryable and
      // its own diagnostics are authoritative; publication failure must not
      // turn the successful resume operation into a false failure.
    }
  }
  // The draft retry can commit its Delivery WAL and then fail before the Task
  // write. Always reconcile Core authority before projecting the RPC result.
  const current = (await reconcileTaskLifecycle(mount.env, taskPath)).task;
  return { workspaceId, taskPath, task: projectTask(current), state: current.state };
}

/** Decision authority accepts only the derived Session capability, never externalKey discovery. */
type DecisionCallerContext = {
  callerSessionId?: string;
};

/** Resolve an authenticated transport Session; RPC params never select it. */
async function resolveDecisionCallerSession(
  ctx: HandlerContext,
  caller: DecisionCallerContext
): Promise<SessionRecord | undefined> {
  const sessionId = caller.callerSessionId?.trim();
  if (sessionId) {
    const session = await ctx.runtime.registry.read(sessionId);
    if (!session) {
      throw new RpcError(-32001, "Authenticated caller Session is not registered", {
        code: "DECISION_CALLER_SESSION_MISSING",
        sessionId,
      });
    }
    return session;
  }
  return undefined;
}

function assertDecisionRequesterBinding(
  task: TaskEnvelope,
  workspaceId: string,
  session: SessionRecord | undefined
): asserts session is SessionRecord {
  if (!task.id || !task.sessionId || !session) {
    throw new RpcError(
      -32001,
      "task.requestDecision requires the exact authenticated executing Session",
      { code: "DECISION_REQUESTER_SESSION_REQUIRED", taskPath: task.path }
    );
  }
  if (
    session.id !== task.sessionId ||
    session.workspace !== workspaceId ||
    session.lastTaskId !== task.id ||
    !SessionRegistry.isOpen(session.state)
  ) {
    throw new RpcError(
      -32001,
      "Decision requester is not the exact live Session bound to this Task",
      {
        code: "DECISION_REQUESTER_SESSION_MISMATCH",
        taskId: task.id,
        taskSessionId: task.sessionId,
        callerSessionId: session.id,
      }
    );
  }
}

/** Create one exact-Task Decision Request and park on waiting(user-input). */
async function taskRequestDecisionRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: DecisionCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "question", "options"]),
    "task.requestDecision"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const question = requireString(p, "question").trim();
  if (!question) {
    throw new RpcError(-32602, "task.requestDecision requires non-empty question");
  }
  const options = parseDecisionRequestOptions(p.options);
  const existing = await ctx.decisionRequests.getPendingForTask(workspaceId, taskPath);
  if (existing) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Task already has a pending Decision Request (${existing.id})`,
      { requestId: existing.id, workspaceId, taskPath }
    );
  }

  return runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, taskPath);
    if (current.state !== "running") {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.requestDecision requires running task (state=${current.state})`,
        { taskPath, state: current.state }
      );
    }
    const callerSession = await resolveDecisionCallerSession(ctx, caller);
    assertDecisionRequesterBinding(current, workspaceId, callerSession);
    const again = await ctx.decisionRequests.getPendingForTask(workspaceId, taskPath);
    if (again) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Task already has a pending Decision Request (${again.id})`,
        { requestId: again.id, workspaceId, taskPath }
      );
    }
    if (!current.parentActor) {
      throw new RpcError(
        RPC_LIFECYCLE,
        "task.requestDecision requires a frozen parent authority",
        { code: "DECISION_TARGET_MISSING", taskId: current.id }
      );
    }
    const request: PendingDecisionRequest = {
      id: makeDecisionRequestId(),
      taskId: current.id!,
      requester: { kind: "session", id: callerSession.id },
      target: current.parentActor,
      question,
      options,
      status: "pending",
    };
    const task = await taskWait(mount.env, taskPath, {
      reason: "user-input",
      summary: `Decision Request pending: ${question.slice(0, 200)}`,
    });
    let stored: DecisionRequestRecord;
    try {
      stored = await ctx.decisionRequests.add({ workspaceId, taskPath, request });
    } catch (error) {
      await taskResume(mount.env, taskPath);
      throw error;
    }
    emitTaskState(ctx, workspaceId, task, "task.requestDecision");
    ctx.events.emit(
      "decisionRequest.pending",
      workspaceId,
      projectDecisionRequest(stored),
      "self"
    );
    if (callerSession.state !== "external") {
      try {
        await ctx.runtime.registry.update(callerSession.id, { state: "waiting-user" });
      } catch {
        // Task + Decision Request are already durable; managed Session projection is best-effort.
      }
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(task),
      state: task.state,
      request: projectDecisionRequest(stored),
    };
  }));
}

function parseDecisionRequestOptions(raw: unknown): DecisionRequestOption[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new RpcError(-32602, "task.requestDecision options must be an array");
  }
  const options: DecisionRequestOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RpcError(-32602, "task.requestDecision option must be {id,label}");
    }
    const row = item as Record<string, unknown>;
    assertAllowedParams(row, new Set(["id", "label"]), "task.requestDecision option");
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!id || !label) {
      throw new RpcError(-32602, "task.requestDecision option requires non-empty id and label");
    }
    options.push({ id, label });
  }
  return options;
}

function taskRejectResumeFeedbackId(deliveryId: string): string {
  if (!/^dl-[a-z0-9]+$/i.test(deliveryId)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Reject-resume continuation requires a canonical Delivery id: ${deliveryId}`,
      { code: "TASK_REJECT_RESUME_CONTINUATION_CHANGED", deliveryId }
    );
  }
  return `ti-rf-${deliveryId.slice(3).toLowerCase()}`;
}

function rejectResumeFeedbackMatches(
  item: TaskInputRecord,
  input: {
    workspaceId: string;
    taskPath: string;
    task: TaskEnvelope;
    deliveryId: string;
    note: string;
    exactText: boolean;
  }
): boolean {
  const expectedSessionId = input.task.sessionId?.trim() || undefined;
  const actualSessionId = item.sessionId?.trim() || undefined;
  const expectedText = input.exactText
    ? input.note
    : input.note.trim() || DEFAULT_TASK_REJECT_NOTE;
  const actualText = input.exactText
    ? item.text ?? ""
    : (item.text ?? "").trim() || DEFAULT_TASK_REJECT_NOTE;
  const requiresCurrentSession =
    item.status === "pending" || item.status === "processing" || item.status === "failed";
  return (
    item.id === taskRejectResumeFeedbackId(input.deliveryId) &&
    item.workspaceId === input.workspaceId &&
    item.taskPath === input.taskPath &&
    item.taskId === input.task.id! &&
    (!requiresCurrentSession || actualSessionId === expectedSessionId) &&
    item.role === taskParentRoleId(input.task) &&
    normalizeTaskInputKind(item.kind) === "review-feedback" &&
    typeof item.text === "string" &&
    actualText === expectedText
  );
}

/**
 * Core WAL reconciliation plus the Service-owned reject-resume continuation
 * boundary. A rejected Delivery projected back to running is not ordinary
 * runnable work until its deterministic review-feedback row is durable.
 */
async function reconcileServiceTaskLifecycle(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  options?: { blockOpenRejectResumeFeedback?: boolean }
): Promise<TaskEnvelope> {
  const mount = ctx.host.require(workspaceId);
  const reconciled = await reconcileTaskLifecycle(mount.env, taskPath);
  const pending = reconciled.rejectResume;
  if (!pending) return reconciled.task;

  const inputId = taskRejectResumeFeedbackId(pending.deliveryId);
  const item = await ctx.taskInputs.get(inputId, workspaceId, taskPath);
  if (
    !item ||
    !rejectResumeFeedbackMatches(item, {
      workspaceId,
      taskPath,
      task: reconciled.task,
      deliveryId: pending.deliveryId,
      note: pending.note,
      exactText: false,
    })
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "Reject-resume continuation is incomplete; retry the exact task.reject request before mutating this Task.",
      {
        code: "TASK_REJECT_RESUME_CONTINUATION_REQUIRED",
        taskPath,
        deliveryId: pending.deliveryId,
        inputId,
      }
    );
  }
  if (item.status === "uncertain") {
    throw new RpcError(
      RPC_LIFECYCLE,
      "Reject-resume review feedback has uncertain delivery; acknowledge it with taskInput.ack before starting or replacing the Session.",
      {
        code: "TASK_REJECT_RESUME_CONTINUATION_UNCERTAIN",
        taskPath,
        deliveryId: pending.deliveryId,
        inputId,
      }
    );
  }
  if (item.status === "cancelled") {
    throw new RpcError(
      RPC_LIFECYCLE,
      "Reject-resume review feedback was cancelled; retry the exact task.reject request before mutating this Task.",
      {
        code: "TASK_REJECT_RESUME_CONTINUATION_CANCELLED",
        taskPath,
        deliveryId: pending.deliveryId,
        inputId,
      }
    );
  }
  if (
    options?.blockOpenRejectResumeFeedback &&
    (item.status === "pending" || item.status === "processing" || item.status === "failed")
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "Reject-resume review feedback must run before new task input; retry the exact task.reject request if recovery is required.",
      {
        code: "TASK_REJECT_RESUME_CONTINUATION_OPEN",
        taskPath,
        deliveryId: pending.deliveryId,
        inputId,
        inputStatus: item.status,
      }
    );
  }
  return reconciled.task;
}

/**
 * U2A: user-only one-shot text and/or contextRefs to a running/waiting task.
 * Does not answer pending Decision Requests, write chat history, or mutate Connections.
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

  // A pending decision has its own authenticated response path.
  const pendingDecision = await ctx.decisionRequests.getPendingForTask(workspaceId, taskPath);
  if (pendingDecision) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Task has a pending Decision Request (${pendingDecision.id}); use decisionRequest.respond instead of task.sendInput`,
      { requestId: pendingDecision.id, workspaceId, taskPath }
    );
  }

  // Per-Task lifecycle flight + MutationBus: wait out same-Task accept/auto-deliver
  // Git windows, then re-read state so sendInput cannot slip past auto-deliver.
  const { current, input } = await runTaskLifecycle(workspaceId, taskPath, () =>
  ctx.mutations.run(workspaceId, async () => {
    const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath, {
      blockOpenRejectResumeFeedback: true,
    });
    if (current.state !== "running" && current.state !== "waiting") {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.sendInput requires running or waiting task (state=${current.state})`,
        { taskPath, state: current.state }
      );
    }

    const currentDecision = await ctx.decisionRequests.getPendingForTask(
      workspaceId,
      taskPath
    );
    if (currentDecision) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Task has a pending Decision Request (${currentDecision.id}); use decisionRequest.respond instead of task.sendInput`,
        { requestId: currentDecision.id, workspaceId, taskPath }
      );
    }

    const now = new Date().toISOString();
    const input = await ctx.taskInputs.add({
      id: makeTaskInputId(),
      workspaceId,
      taskPath,
      taskId: current.id || undefined,
      sessionId: current.sessionId || undefined,
      role: taskParentRoleId(current),
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
    enqueueManagedTaskInputBackground(ctx, input);
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

/**
 * Resolve the sole managed inject identity from the exact durable Task binding.
 * TaskInput rows are retry/audit facts, never authority for choosing a Session.
 */
async function resolveManagedInjectSessionId(
  ctx: HandlerContext,
  latest: TaskInputRecord
): Promise<string | undefined> {
  const mount = ctx.host.get(latest.workspaceId);
  if (!mount) {
    throw new Error(`TaskInput workspace is not mounted: ${latest.workspaceId}`);
  }
  const task = await loadTaskEnvelope(mount.env.fs, latest.taskPath);
  if (!task.id) {
    throw new Error(`TaskInput exact Task is missing canonical id: ${latest.taskPath}`);
  }
  if (latest.taskId && task.id !== latest.taskId) {
    throw new Error(
      `TaskInput Task identity mismatch: expected ${latest.taskId}, got ${task.id}`
    );
  }
  const sessionId = task.sessionId?.trim();
  if (!sessionId) return undefined;

  const session = await ctx.runtime.registry.read(sessionId);
  if (!session) {
    throw new Error(`TaskInput bound Session is missing from registry: ${sessionId}`);
  }
  if (session.workspace !== latest.workspaceId) {
    throw new Error(
      `TaskInput bound Session workspace mismatch: expected ${latest.workspaceId}, got ${session.workspace || "missing"}`
    );
  }
  if (session.lastTaskId !== task.id) {
    throw new Error(
      `TaskInput bound Session Task mismatch: expected ${task.id}, got ${session.lastTaskId || "missing"}`
    );
  }
  return sessionId;
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
  item: TaskInputRecord
): void {
  if (!managedTaskInputAccepting) {
    // Shutdown in progress: leave durable pending/failed for next process.
    return;
  }
  const work = deliverManagedTaskInput(ctx, item).then(
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
 * Explicit Session recovery trigger for durable retryable TaskInputs.
 *
 * This is intentionally called only after task.startSession has proven/bound a
 * usable exact-Task Session, or after task.replaceSession has completed its
 * authoritative Task + TaskInput rebind. It is not a mount/startup scanner.
 * Provider work stays on the existing per-Task background FIFO; duplicate
 * scheduling is harmless because each worker reloads the durable row before
 * rebinding that exact retryable row and claiming pending|failed -> processing.
 */
async function scheduleRetryableTaskInputsAfterSessionBind(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
  }
): Promise<void> {
  const retryable = await ctx.taskInputs.listRetryableForTask(
    input.workspaceId,
    input.taskPath
  );
  retryable.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  for (const item of retryable) {
    enqueueManagedTaskInputBackground(ctx, item);
  }
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
  item: TaskInputRecord
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

    const failRebind = async (prefix: string, err: unknown): Promise<ManagedTaskInputDelivery> => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        latest = await ctx.taskInputs.markFailed(latest!.id, `${prefix}: ${message}`, "service");
      } catch {
        /* keep prior */
      }
      return { input: latest!, continued: false, continueError: `${prefix}: ${message}` };
    };

    let sessionId: string | undefined;
    try {
      sessionId = await resolveManagedInjectSessionId(ctx, latest);
    } catch (err) {
      return failRebind("TaskInput exact Session guard failed", err);
    }
    if (!sessionId) return { input: latest, continued: false };

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
    try {
      sessionId = await resolveManagedInjectSessionId(ctx, latest);
    } catch (err) {
      return failRebind("TaskInput exact Session guard failed after processing", err);
    }
    if (!sessionId) {
      return failRebind(
        "TaskInput exact Session guard failed after processing",
        new Error("Task no longer has a managed Session binding")
      );
    }
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

    let continueResult: { continued: boolean; error?: string };
    let finalInput = forInject;
    continueResult = await continueManagedAfterTaskInput(ctx, forInject);
    if (continueResult.continued) {
      try {
        finalInput = await ctx.taskInputs.markDelivered(forInject.id, "service", {
          sessionId,
        });
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
        finalInput = await ctx.taskInputs.markFailed(forInject.id, failMsg, "service");
      } catch {
        // store closed / already terminal
      }
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
  const prompt = formatTaskInputPrompt(item);
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
 * Shared authority: a pending Decision Request, or any TaskInput still pending,
 * processing, failed, or uncertain on this task blocks a ready Delivery. Same check for public
 * task.deliver / task.requestReview and managed auto-deliver.
 *
 * Uncertain is at-most-once and never re-injected, but blocks until explicit
 * acknowledgement. delivered / consumed / cancelled rows do not block.
 * Reads each durable domain store directly; interaction.listPending is projection only.
 */
async function assertNoBlockingTaskInputsForDeliver(
  ctx: HandlerContext,
  workspaceId: string,
  task: { path: string; id?: string; state: string }
): Promise<void> {
  const pendingDecision = await ctx.decisionRequests.getPendingForTask(
    workspaceId,
    task.path
  );
  if (pendingDecision) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.deliver refused: task has pending Decision Request ${pendingDecision.id}; ` +
        `respond or escalate it before Delivery (task remains ${task.state}, no ready Delivery)`,
      {
        code: "PENDING_DECISION_REQUEST",
        taskPath: task.path,
        ...(task.id ? { taskId: task.id } : {}),
        requestId: pendingDecision.id,
        target: pendingDecision.target,
      }
    );
  }
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
async function requireRoleNameById(
  fs: import("../core/adapter.js").FsAdapter,
  roleId: string
): Promise<string> {
  const registry = await loadRolesRegistry(fs);
  const role = registry.roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`Role not found in registry: ${roleId}`);
  return role.name;
}

async function resolveTaskWorktreeForDirtyCheck(
  workspaceRoot: string,
  task: TaskEnvelope,
  fs: import("../core/adapter.js").FsAdapter
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
  const isTaskScoped = !task.roleId;
  let targetBranch = task.targetBranch?.trim();
  if (isTaskScoped && taskAsSub(task)) {
    const parentRole = taskParentRoleId(task);
    if (parentRole) {
      const registry = await loadRolesRegistry(fs);
      const role = registry.roles.find((item) => item.id === parentRole);
      if (!role) throw new Error(`Parent Role not found in registry: ${parentRole}`);
      targetBranch = (await ensureRoleWorkspace(mountedRoot, role.name)).branch;
    }
  }
  const lane = isTaskScoped
    ? await ensureTaskWorkspace(mountedRoot, task.id || task.path, {
        ...(targetBranch ? { targetBranch } : {}),
      })
    : await ensureRoleWorkspace(mountedRoot, await requireRoleNameById(fs, task.roleId!));
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
  task: TaskEnvelope,
  fs: import("../core/adapter.js").FsAdapter
): Promise<void> {
  const lane = await resolveTaskWorktreeForDirtyCheck(workspaceRoot, task, fs);
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
      await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, taskForIntegrate, mount.env.fs);
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
          ? await snapshotIntegrationTargetHead(mount.workspaceRoot, taskForIntegrate, mount.env.fs)
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

/**
 * Bind a review mutation to authenticated transport authority. The actor field
 * remains an audit/consistency assertion; it never selects caller identity.
 */
async function resolveReviewCallerActor(
  ctx: HandlerContext,
  workspaceId: string,
  requestedActor: string,
  action: "accept" | "reject",
  callContext: VerifiedCallerContext
): Promise<string> {
  const callerSessionId = callContext.callerSessionId?.trim();
  let derivedActor = "user";

  if (callerSessionId) {
    const session = await ctx.runtime.registry.read(callerSessionId);
    if (
      !session ||
      session.state !== "external" ||
      session.workspace !== workspaceId ||
      !session.roleId
    ) {
      throw new RpcError(
        -32001,
        `task.${action} requires an exact authenticated external Role Session reviewer`,
        {
          code: "REVIEW_CALLER_FORBIDDEN",
          action,
          workspaceId,
          callerSessionId,
        }
      );
    }
    derivedActor = session.roleId;
  } else if (callContext.callerExternalKey?.trim()) {
    throw new RpcError(
      -32001,
      `task.${action} external host identity requires a valid Session capability`,
      {
        code: "REVIEW_CALLER_SESSION_REQUIRED",
        action,
        workspaceId,
      }
    );
  }

  if (requestedActor.trim() !== derivedActor) {
    throw new RpcError(
      -32001,
      `task.${action} actor does not match authenticated caller authority`,
      {
        code: "REVIEW_CALLER_MISMATCH",
        action,
        workspaceId,
        requestedActor: requestedActor.trim(),
        derivedActor,
        ...(callerSessionId ? { callerSessionId } : {}),
      }
    );
  }
  return derivedActor;
}

async function taskAcceptRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  callContext: VerifiedCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "deliveryId", "actor", "outputNodeIds"]),
    "task.accept"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const deliveryId = requireString(p, "deliveryId");
  const actor = requireString(p, "actor");
  const outputNodeIds = optionalStringArray(p, "outputNodeIds");

  // Per-Task flight spans prepare → Git → finalize; MutationBus only around prepare/finalize.
  const result = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const reviewerActor = await resolveReviewCallerActor(
      ctx,
      workspaceId,
      actor,
      "accept",
      callContext
    );
    const acceptOptions = { actor: reviewerActor, deliveryId, outputNodeIds };
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
      await beforeTaskAcceptFinalizeForTests?.({ workspaceId, taskPath, deliveryId });
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
  for (const nodeId of result.task.workNodeIds) {
    if (nodeId === "root") continue;
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId, reason: "task.accept-projection" },
      "self"
    );
  }
  // Output provenance bind invalidation: only Outputs that newly wrote deliveryId.
  for (const outputId of result.changedOutputIds) {
    ctx.events.emit(
      "node.changed",
      workspaceId,
      { nodeId: outputId, reason: "output.provenance-bind" },
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
  const nodeId = requireString(p, "nodeId");
  if (!isNodeId(nodeId)) throw new RpcError(-32602, `Invalid Node id: ${nodeId}`);
  try {
    const projected = await resolveOutputProvenance(mount.env.fs, { nodeId });
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
 *   3) exact Session continuity when sessionId is present (still on RPC path):
 *      external Role Session validates the exact durable Task binding and stays
 *      running without any Agent Connection/provider operation;
 *      managed Session restore/bind otherwise:
 *      alive rebind or native resume first (contextRestored=true); when native
 *      resume explicitly fails or prior is not resumeCapable, start an honest
 *      independent new Session with recovery bootstrap (contextRestored=false).
 *      Registry/Connection identity failures still park waiting(external) and fail
 *      the RPC — never leave running with a dead managed process.
 *   4) return accepted/processing quickly — do **not** await the full Agent turn
 *   5) background per-task FIFO inject (## Review Feedback) exactly once;
 *      status/events queryable via taskInput.*; failed is retryable, uncertain
 *      is at-most-once; already processing/delivered/uncertain skips re-inject
 *
 * No sessionId: core rework + pending review-feedback for poll+ack.
 * Role/Connection continuity and Delivery authority are unchanged.
 */
async function taskRejectRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  callContext: VerifiedCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "deliveryId", "actor", "note", "resume"]),
    "task.reject"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const deliveryId = requireString(p, "deliveryId");
  const actor = requireString(p, "actor");
  // Delivery record may use trimmed note; U2A review-feedback preserves exact text.
  const noteForDelivery = optionalString(p, "note");
  const noteExact = optionalStringExact(p, "note");
  const resume = p.resume !== false;

  // Per-Task lifecycle flight + MutationBus: wait out same-Task accept mid-Git.
  // Managed session restore happens after so runtime never nests inside either lock.
  const result = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const reviewerActor = await resolveReviewCallerActor(
      ctx,
      workspaceId,
      actor,
      "reject",
      callContext
    );
    return ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const rejected = await taskReject(mount.env, taskPath, {
        actor: reviewerActor,
        deliveryId,
        note: noteForDelivery,
        resume,
      });
      // The deterministic review-feedback row is the Service continuation WAL.
      // Keep it in the same Task flight as Core reject so another composite RPC
      // cannot observe reject-resume as ordinary runnable work between the two.
      const reviewInput = resume
        ? await createRejectResumeReviewFeedback(ctx, {
            workspaceId,
            taskPath,
            task: rejected.task,
            deliveryId: rejected.delivery.id,
            note:
              noteExact !== undefined
                ? noteExact
                : rejected.delivery.review?.note || DEFAULT_TASK_REJECT_NOTE,
          })
        : undefined;
      if (reviewInput && afterTaskRejectContinuationPersistForTests) {
        await afterTaskRejectContinuationPersistForTests({
          workspaceId,
          taskPath,
          deliveryId,
          inputId: reviewInput.id,
        });
      }
      // External Role continuity is a pure exact-binding validation and belongs
      // in the same Task lifecycle/mutation flight as reject. Capture failure so
      // the already-durable rejected Delivery can be parked honestly afterward.
      let externalRestoreError: unknown;
      if (resume && rejected.task.roleId && rejected.task.sessionId) {
        try {
          await restoreExactExternalRoleTask(ctx, { workspaceId, taskPath });
        } catch (error) {
          externalRestoreError = error;
        }
      }
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
      return { ...rejected, reviewInput, externalRestoreError };
    });
  });

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

  // Rework path: the durable row was created/reused inside the exact Task flight.
  const reviewInput = result.reviewInput!;

  // No bound Session: keep review feedback pending for scoped poll/get/ack.
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

  // A durable Role Task is executed by its exact external Role Session. Reuse
  // the same bounded recovery primitive as task.claim: validate workspace,
  // Role, Task and liveness, but never start an Agent Connection/provider.
  if (result.task.roleId) {
    if (result.externalRestoreError === undefined) {
      return {
        workspaceId,
        taskPath,
        task: projectTask(result.task),
        delivery: projectDelivery(result.delivery),
        state: result.task.state,
        input: projectTaskInput(reviewInput),
        /** Durable review-feedback accepted for external poll/get/ack. */
        accepted: true,
        enqueued: false,
        continued: false,
      };
    }
    const message =
      result.externalRestoreError instanceof Error
        ? result.externalRestoreError.message
        : String(result.externalRestoreError);
    await parkTaskAfterRejectResumeFailure(ctx, {
      workspaceId,
      taskPath,
      sessionId: boundSessionId,
      message,
      summaryPrefix: EXTERNAL_ROLE_REJECT_RESUME_FAILED_WAIT_SUMMARY,
    });
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.reject resume failed to restore external Role Session: ${message}`,
      { taskPath, sessionId: boundSessionId, inputId: reviewInput.id }
    );
  }

  // Prior managed delivery marks sessionId+taskPath delivered; clear dedup so a
  // successful rework prompt_complete can deliver again.
  clearManagedAutoDeliverDedup(boundSessionId, taskPath);

  try {
    const restored = await restoreManagedSessionAfterRejectResume(ctx, {
      workspaceId,
      taskPath,
    });
    const restoredSessionId = restored.session.sessionId;
    if (restoredSessionId !== boundSessionId) {
      throw new Error(
        `reject-resume must preserve the exact Session id; expected ${boundSessionId}, got ${restoredSessionId}`
      );
    }
    // Fast accept: durable pending + live session bind are the RPC contract.
    // Managed inject of ## Review Feedback runs on the per-task FIFO in the
    // background — same as task.sendInput.
    // Do not await the full Agent turn (CLI/fetch headers timeout would otherwise
    // false-fail a still-running turn).
    enqueueManagedTaskInputBackground(ctx, reviewInput);
    return {
      workspaceId,
      taskPath,
      task: projectTask(restored.task),
      delivery: projectDelivery(result.delivery),
      state: restored.task.state,
      session: restored.session,
      input: projectTaskInput(reviewInput),
      /** Durable row + restore accepted; does not mean provider turn finished. */
      accepted: true,
      /** Managed session restored and background inject scheduled. */
      enqueued: true,
      /** Always false on accept — poll taskInput.get / events for delivered|failed. */
      continued: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail-loud: must not remain running while the managed process is dead.
    // Review TaskInput stays pending (not cancelled) for later poll / retry.
    await parkTaskAfterRejectResumeFailure(ctx, {
      workspaceId,
      taskPath,
      sessionId: boundSessionId,
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
    deliveryId: string;
    note?: string;
  }
): Promise<TaskInputRecord> {
  const now = new Date().toISOString();
  // Preserve note exactly — do not trim. Undefined → empty string so payload is valid.
  const text = typeof input.note === "string" ? input.note : "";
  const id = taskRejectResumeFeedbackId(input.deliveryId);
  const existing = await ctx.taskInputs.get(id, input.workspaceId, input.taskPath);
  if (existing) {
    if (
      !rejectResumeFeedbackMatches(existing, {
        ...input,
        note: text,
        exactText: true,
      })
    ) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Reject-resume continuation ${id} conflicts with its exact Delivery request.`,
        {
          code: "TASK_REJECT_RESUME_CONTINUATION_CHANGED",
          taskPath: input.taskPath,
          deliveryId: input.deliveryId,
          inputId: id,
        }
      );
    }
    return existing;
  }
  const record = await ctx.taskInputs.add({
    id,
    workspaceId: input.workspaceId,
    taskPath: input.taskPath,
    taskId: input.task.id!,
    sessionId: input.task.sessionId || undefined,
    role: taskParentRoleId(input.task),
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
    await removePendingDecisionRequestForTerminal(
      ctx,
      workspaceId,
      taskPath,
      "task.interrupt"
    );
    emitTaskState(ctx, workspaceId, task, "task.interrupt");
    await cancelTaskInputsForTask(ctx, workspaceId, taskPath, "task.interrupt");
    if (sessionId) {
      try {
        await ctx.toolApprovals.cancelSession(sessionId, "denied");
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
    await removePendingDecisionRequestForTerminal(
      ctx,
      workspaceId,
      taskPath,
      "task.cancel"
    );
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
 * Machine Agent Connection gate → AgentRuntimePort.startSession → exact Task Session only.
 * Shares authorized per-Task managed-session flight with task.replaceSession.
 * Usable bound Session reuses without launch unless a flight is already held.
 */
async function taskStartSessionRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "callerKind", "bootstrapPrompt"]),
    "task.startSession"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const taskPath = requireString(p, "taskPath");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");

  const prepared = await prepareAuthorizedTaskStartSession(
    ctx,
    p,
    workspaceId,
    taskPath,
    callerKind
  );
  if (prepared.kind === "reuse") {
    const existing = managedSessionInFlight.get(managedSessionFlightKey(workspaceId, taskPath));
    if (existing) {
      return joinOrConflictManagedSessionFlight(
        existing,
        prepared.connectionId,
        "startSession",
        taskPath
      );
    }
    const result = await runTaskLifecycle(workspaceId, taskPath, async () => {
      const mount = ctx.host.require(workspaceId);
      const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
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
    await scheduleRetryableTaskInputsAfterSessionBind(ctx, {
      workspaceId,
      taskPath,
    });
    return result;
  }

  return runManagedSessionFlight(workspaceId, taskPath, prepared.connectionId, "startSession", () =>
    launchAndBindTaskStartSession(ctx, prepared)
  );
}

type TaskSessionBindSnapshot = {
  taskId: string | undefined;
  state: TaskEnvelope["state"];
  sessionId: string;
  updatedAt: string | undefined;
  roleId: string | undefined;
  nodeContextJson: string;
  workspace: string | undefined;
  worktree: string | undefined;
  branch: string | undefined;
  targetBranch: string | undefined;
  baseCommit: string | undefined;
  acceptMode: TaskEnvelope["acceptMode"];
  parentActor: TaskEnvelope["parentActor"];
  reviewer: TaskEnvelope["reviewer"];
};

function captureTaskSessionBindSnapshot(task: TaskEnvelope): TaskSessionBindSnapshot {
  return {
    taskId: task.id,
    state: task.state,
    sessionId: task.sessionId?.trim() || "",
    updatedAt: task.updatedAt,
    roleId: task.roleId,
    nodeContextJson: JSON.stringify({
      workNodeIds: task.workNodeIds,
      contextNodeIds: task.contextNodeIds,
      nodeSnapshots: task.nodeSnapshots,
    }),
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
    baseCommit: task.baseCommit,
    acceptMode: task.acceptMode,
    parentActor: task.parentActor,
    reviewer: task.reviewer,
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
    actual.roleId === expected.roleId &&
    actual.workspace === expected.workspace &&
    actual.worktree === expected.worktree &&
    actual.branch === expected.branch &&
    actual.targetBranch === expected.targetBranch &&
    actual.baseCommit === expected.baseCommit &&
    actual.acceptMode === expected.acceptMode &&
    JSON.stringify(actual.parentActor) === JSON.stringify(expected.parentActor) &&
    JSON.stringify(actual.reviewer) === JSON.stringify(expected.reviewer) &&
    actual.nodeContextJson === expected.nodeContextJson;
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

function assertTaskSessionPostStartOwnership(
  operation: "task.startSession" | "task.replaceSession",
  taskPath: string,
  current: TaskEnvelope,
  expected: TaskSessionBindSnapshot
): void {
  const actual = captureTaskSessionBindSnapshot(current);
  const immutableIdentityUnchanged =
    actual.taskId === expected.taskId &&
    actual.sessionId === expected.sessionId &&
    actual.roleId === expected.roleId &&
    actual.workspace === expected.workspace &&
    actual.worktree === expected.worktree &&
    actual.branch === expected.branch &&
    actual.targetBranch === expected.targetBranch &&
    actual.baseCommit === expected.baseCommit &&
    actual.acceptMode === expected.acceptMode &&
    JSON.stringify(actual.parentActor) === JSON.stringify(expected.parentActor) &&
    JSON.stringify(actual.reviewer) === JSON.stringify(expected.reviewer) &&
    actual.nodeContextJson === expected.nodeContextJson;
  const validSameSessionProgress =
    current.state === "running" || current.state === "waiting";
  if (immutableIdentityUnchanged && validSameSessionProgress) return;
  throw new RpcError(
    RPC_LIFECYCLE,
    `${operation}: Task no longer owns the managed Session after provider start`,
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
  | {
      kind: "reuse";
      connectionId: string;
      result: ReturnType<typeof projectStartSessionResult>;
    }
  | {
      kind: "launch";
      workspaceId: string;
      taskPath: string;
      connectionId: string;
      task: TaskEnvelope;
      bootstrapPrompt?: string;
    };

/**
 * Exact bound-Session preparation for startSession.
 * Must run before any provider-launch flight join/coalesce.
 */
async function prepareAuthorizedTaskStartSession(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  workspaceId: string,
  taskPath: string,
  callerKind: "user" | "role",
  opts?: {
    /** No claim, wait-resume, or session reuse (replaceSession). */
    skipReuseAndLaunchPrep?: boolean;
  }
): Promise<PreparedTaskStartSession> {
  const mount = ctx.host.require(workspaceId);
  const bootstrapPrompt = optionalString(p, "bootstrapPrompt");
  let task = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
  const boundSessionId = task.sessionId?.trim() || "";
  if (!boundSessionId) {
    throw new RpcError(
      -32602,
      "task.startSession/task.replaceSession requires an exact bound Session"
    );
  }
  const boundSession = await ctx.runtime.registry.read(boundSessionId);
  if (!boundSession || !boundSession.connectionId) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Bound managed Session not found: ${boundSessionId}`,
      { code: "BOUND_SESSION_MISSING", taskPath, sessionId: boundSessionId }
    );
  }
  const exactTaskId = task.id!;
  if (
    boundSession.workspace !== workspaceId ||
    boundSession.lastTaskId !== exactTaskId
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Bound Session ${boundSessionId} does not match the exact Task/workspace`,
      { code: "BOUND_SESSION_IDENTITY_MISMATCH", taskPath, sessionId: boundSessionId }
    );
  }
  const connectionId = boundSession.connectionId;

  // replaceSession eligibility/launch is owned by executeTaskReplaceSession.
  if (opts?.skipReuseAndLaunchPrep) {
    return {
      kind: "launch",
      workspaceId,
      taskPath,
      connectionId,
      task,
      bootstrapPrompt,
    };
  }

  if (task.state === "queued" && callerKind === "user") {
    // User-driven convenience: claim before start.
    await taskClaimRpc(ctx, { workspaceId, taskPath });
    task = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
  }
  if (task.state !== "running" && task.state !== "waiting") {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.startSession requires running or waiting; got ${task.state}`
    );
  }

  // startSession is a recovery entry only for a previously bound unavailable
  // Session. It must not bypass user-input / tool / product-control waits.
  if (task.state === "waiting") {
    if (!isSessionUnavailableParkedWait(task)) {
      throw new RpcError(
        RPC_LIFECYCLE,
        "task.startSession allows waiting only with durable waitCode=session_unavailable; resolve the existing wait first",
        {
          code: "INVALID_TASK_WAIT",
          taskPath,
          waitReason: task.wait?.reason,
          waitCode: task.wait?.code,
        }
      );
    }
    await taskResumeRpc(ctx, { workspaceId, taskPath });
    task = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
  }

  // Same-Task alive idempotency only. Context-generation drift controls stable
  // prefix injection, not provider-conversation identity.
  const callerBootstrapAppend = bootstrapPrompt; // never replaces managed bootstrap
  if (task.sessionId) {
    const probe = await ctx.runtime.probe(boundSession.id);
    if (probe.alive && boundSession.state !== "external") {
      return {
        kind: "reuse",
        connectionId,
        result: projectStartSessionResult(workspaceId, taskPath, task, boundSession, {
          cwd: task.worktree || mount.workspaceRoot,
        }),
      };
    }
  }

  return {
    kind: "launch",
    workspaceId,
    taskPath,
    connectionId,
    task,
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
  const { workspaceId, taskPath, connectionId } = prepared;
  const mount = ctx.host.require(workspaceId);
  let task = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
    if (current.state !== "running") {
      throw new RpcError(
        RPC_LIFECYCLE,
        `task.startSession requires running at provider launch; got ${current.state}`,
        { code: "INVALID_TASK_STATE", state: current.state, taskPath }
      );
    }
    if (!current.sessionId) {
      throw new RpcError(
        -32602,
        "task.startSession Task lost its exact Session binding",
        { taskPath, connectionId }
      );
    }
    const withLane = await ensureTaskWorkspaceLane(ctx, workspaceId, current);
    return withLane;
  });

  // Capture lane + roleBranchBase only after the execution slot is acquired.
  // Role: durable tent-role lane. Connection execution: task-scoped tent-task/<taskId> lane.
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

  // Live authoritative contextGeneration: always recompute from current AGENTS /
  // Skill body+version / Role prompt / Connection launch snapshot. Persisted
  // Task/card generation never overrides live facts. Collector failure is fail-loud
  // (never yields reusable fallback facts).
  const priorSessionId = task.sessionId!.trim();
  let priorSession: SessionRecord | undefined;
  let resumePrior = false;
  let firstStart = false;
  priorSession = (await ctx.runtime.registry.read(priorSessionId)) ?? undefined;
  if (!priorSession) {
      await parkTaskForUnavailableSession(ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        reason: "task.startSession.bound-session-missing",
      });
      throw new RpcError(
        RPC_LIFECYCLE,
        `Bound Session not found: ${priorSessionId}; use task.replaceSession for an explicit fresh Session`,
        { code: "BOUND_SESSION_MISSING", taskPath, sessionId: priorSessionId }
      );
  }
  const exactTaskId = task.id!;
  if (
    priorSession.workspace !== workspaceId ||
    priorSession.connectionId !== connectionId ||
    priorSession.lastTaskId !== exactTaskId
  ) {
      await parkTaskForUnavailableSession(ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        reason: "task.startSession.bound-session-identity-mismatch",
        detail: `Session binding mismatch (connectionId=${priorSession.connectionId}, lastTaskId=${priorSession.lastTaskId ?? "missing"})`,
      });
      throw new RpcError(
        RPC_LIFECYCLE,
        `Bound Session ${priorSessionId} does not match the exact Task/Connection; use task.replaceSession for an explicit fresh Session`,
        {
          code: "BOUND_SESSION_IDENTITY_MISMATCH",
          taskPath,
          sessionId: priorSessionId,
          connectionId,
        }
      );
  }
  firstStart = priorSession.state === "reserved";
  if (!firstStart) {
    const probe = await ctx.runtime.probe(priorSessionId);
    if (probe.alive || !probe.resumeCapable) {
      await parkTaskForUnavailableSession(ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        reason: "task.startSession.native-resume-unavailable",
      });
      throw new RpcError(
        RPC_LIFECYCLE,
        `Bound Session ${priorSessionId} cannot be resumed; use task.replaceSession for an explicit fresh Session`,
        {
          code: "BOUND_SESSION_NOT_RESUMABLE",
          taskPath,
          sessionId: priorSessionId,
          alive: probe.alive,
          resumeCapable: probe.resumeCapable,
        }
      );
    }
    resumePrior = true;
  }

  const connectionSnapshot = priorSession.connectionSnapshot;
  if (!connectionSnapshot) {
    throw new RpcError(
      RPC_LIFECYCLE,
      `Bound Session ${priorSessionId} has no immutable Agent Connection snapshot`,
      { code: "BOUND_SESSION_SNAPSHOT_MISSING", taskPath, sessionId: priorSessionId }
    );
  }
  let stableBundle: StableContextGenerationBundle;
  try {
    stableBundle = await collectStableContextGeneration({
      workspaceRoot: mount.workspaceRoot,
      workspaceIdentity: workspaceId,
      packageRoot: ctx.packageRoot,
      packageVersion: ctx.version,
      task,
      session: priorSession,
      fs: mount.env.fs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(
      -32000,
      `task.startSession contextGeneration collection failed: ${message}`,
      { code: "CONTEXT_GENERATION_COLLECT_FAILED", taskPath, connectionId }
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
  // Official managed bootstrap is always Service-owned (stable + delta).
  // Public bootstrapPrompt is an appended dynamic section only — never a replacement.
  // Context drift sends the full current stable prefix into the same provider
  // conversation; it never changes resume identity.
  const sessionContextGeneration =
    resumePrior && priorSession?.contextGeneration?.trim() === liveGeneration
      ? liveGeneration
      : undefined;
  let sessionBootstrap = await buildSessionBootstrapPrompt(
    ctx,
    task,
    {
      workspaceRoot: mount.workspaceRoot,
      systemRoot: mount.systemRoot,
      sessionContextGeneration,
      currentContextGeneration: liveGeneration,
    },
    mount.env.fs
  );
  sessionBootstrap = appendCallerBootstrapSection(
    sessionBootstrap,
    prepared.bootstrapPrompt
  );

  // Ephemeral image path refs from task user prompt + claimed node bodies only.
  // Paths only — never base64; never written to Task/Session/Connection disk.
  // ACP image blocks still require live initialize promptCapabilities.image === true.
  const bootstrapImageRefs = await collectTaskBootstrapImageRefs(task);
  const bootstrapImageSystemRoot =
    bootstrapImageRefs.length > 0 ? mount.systemRoot : undefined;

  const bindSnapshot = await runTaskLifecycle(workspaceId, taskPath, async () => {
    const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
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
        lastTaskId: task.id!,
      });
    } else if (firstStart) {
      handle = await ctx.runtime.startSession({
        sessionId: priorSessionId,
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
        workspace: workspaceId,
      });
    } else {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Bound Session ${priorSessionId} is neither reserved nor resumable`,
        { code: "BOUND_SESSION_NOT_STARTABLE", taskPath, sessionId: priorSessionId }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (resumePrior) {
      await parkTaskForUnavailableSession(ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        reason: "task.startSession.native-resume-failed",
        detail: message,
      });
      throw new RpcError(
        RPC_LIFECYCLE,
        `Bound Session ${priorSessionId} could not resume; Task remains waiting for explicit task.replaceSession`,
        {
          code: "BOUND_SESSION_RESUME_FAILED",
          taskPath,
          sessionId: priorSessionId,
          detail: message,
          recoverable: true,
        }
      );
    }
    await parkTaskForUnavailableSession(ctx, {
      workspaceId,
      taskPath,
      sessionId: priorSessionId,
      reason: "task.startSession.first-launch-failed",
      detail: message,
    });
    throw new RpcError(RPC_LIFECYCLE, message, {
      code: "SESSION_LAUNCH_FAILED",
      taskPath,
      sessionId: priorSessionId,
      recoverable: true,
    });
  }

  // Bind sessionId reference only on task (never PID/token).
  // Persist only Task binding plus non-secret context metadata.
  let bound: TaskEnvelope;
  try {
    if (afterManagedSessionProviderStartForTests) {
      await afterManagedSessionProviderStartForTests({
        operation: "task.startSession",
        workspaceId,
        taskPath,
        sessionId: handle.sessionId,
      });
    }
    bound = await runTaskLifecycle(workspaceId, taskPath, () =>
      ctx.mutations.run(workspaceId, async () => {
        const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
        assertTaskSessionBindSnapshot("task.startSession", taskPath, current, bindSnapshot);
        ctx.host.markSelfWrite(workspaceId);
        const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: handle.sessionId,
          contextGeneration: liveGeneration,
          updatedAt: mount.env.clock.now(),
        });
        const generation = liveGeneration;
        try {
          await ctx.runtime.registry.update(handle.sessionId, {
            contextGeneration: generation,
            ...(next.taskDeltaDigest
              ? { taskDeltaDigest: next.taskDeltaDigest }
              : {}),
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
            connectionId: handle.connectionId,
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

  await scheduleRetryableTaskInputsAfterSessionBind(ctx, {
    workspaceId,
    taskPath,
  });

  return projectStartSessionResult(workspaceId, taskPath, bound, {
    id: handle.sessionId,
    connectionId: handle.connectionId,
    adapterId: handle.adapterId,
    state: handle.state,
    roleId: handle.roleId,
    runtimeWorkspace: handle.runtimeWorkspace,
  }, { cwd });
}

/** Stable restoreReason for explicit same-Task fresh Session replacement. */
export const REPLACE_SESSION_RESTORE_REASON = "task.replaceSession.fresh" as const;

/** Explicit fresh managed Session on the same Task (unusable provider context). */
async function taskReplaceSessionRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "callerKind", "force"]),
    "task.replaceSession"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const taskPath = requireString(p, "taskPath");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("force" in p && p.force !== undefined && p.force !== false) {
    throw new RpcError(-32602, "task.replaceSession does not support force; wait for turnBusy=false and retry", {
      code: "FORCE_NOT_SUPPORTED",
    });
  }
  const prepared = await prepareAuthorizedTaskStartSession(ctx, p, workspaceId, taskPath, callerKind, {
    skipReuseAndLaunchPrep: true,
  });
  if (prepared.kind !== "launch") {
    throw new RpcError(RPC_LIFECYCLE, "task.replaceSession could not prepare a fresh managed Session");
  }
  const connectionId = prepared.connectionId;
  // Outer managed-session flight: concurrent same-Connection replace/start still join/coalesce.
  // Exact-Task lifecycle stages are acquired only for authoritative prepare/CAS bind;
  // provider startup stays outside the coordinator so terminal transitions can win.
  return runManagedSessionFlight(workspaceId, taskPath, connectionId, "replaceSession", () =>
    executeTaskReplaceSession(ctx, workspaceId, taskPath, connectionId)
  );
}

async function assertReplaceSessionEligible(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string
): Promise<void> {
  const mount = ctx.host.require(workspaceId);
  const task = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
  if (task.state !== "running" && task.state !== "waiting") {
    throw new RpcError(RPC_LIFECYCLE, `task.replaceSession requires running or waiting; got ${task.state}`, {
      code: "INVALID_TASK_STATE",
      state: task.state,
    });
  }
  if (task.state === "waiting" && !isSessionUnavailableParkedWait(task)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "task.replaceSession allows waiting only with durable waitCode=session_unavailable; resolve user-input or tool waits first",
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
  const prior = await ctx.runtime.registry.read(priorSessionId);
  if (
    !prior ||
    !prior.connectionId ||
    prior.workspace !== workspaceId ||
    prior.lastTaskId !== task.id
  ) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "task.replaceSession requires an exact managed Session binding",
      { code: "BOUND_SESSION_IDENTITY_MISMATCH", taskPath, sessionId: priorSessionId }
    );
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
  connectionId: string
) {
  const mount = ctx.host.require(workspaceId);
  let task = await runTaskLifecycle(workspaceId, taskPath, async () => {
    await assertReplaceSessionEligible(ctx, workspaceId, taskPath);
    let current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
    if (current.state === "waiting") {
      await taskResumeRpc(ctx, { workspaceId, taskPath });
      current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
    }
    return ensureTaskWorkspaceLane(ctx, workspaceId, current);
  });
  const priorSessionId = task.sessionId!.trim();
  const preserved = {
    taskId: task.id,
    nodeContextJson: JSON.stringify({
      workNodeIds: task.workNodeIds,
      contextNodeIds: task.contextNodeIds,
      nodeSnapshots: task.nodeSnapshots,
    }),
    worktree: task.worktree,
    branch: task.branch,
    acceptMode: task.acceptMode,
    roleId: task.roleId,
  };
  let replacementSessionId: string | undefined;
  const parkAfterRetirement = async (detail: string): Promise<void> => {
    await parkTaskForUnavailableSession(ctx, {
      workspaceId,
      taskPath,
      sessionId: replacementSessionId ?? priorSessionId,
      reason: "task.replaceSession.failed",
      detail,
    });
  };

  try {
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
    task = await runTaskLifecycle(workspaceId, taskPath, async () => {
      const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
      assertTaskSessionBindSnapshot(
        "task.replaceSession",
        taskPath,
        current,
        captureTaskSessionBindSnapshot(task)
      );
      return current;
    });
    replacementSessionId = makeSessionId();
    await ctx.runtime.reserveSession({
      sessionId: replacementSessionId,
      connectionId,
      lastTaskId: task.id!,
      workspace: workspaceId,
      workspaceLane,
      runtimeWorkspace: { cwd },
    });

    task = await runTaskLifecycle(workspaceId, taskPath, async () => {
      const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
      assertTaskSessionBindSnapshot(
        "task.replaceSession",
        taskPath,
        current,
        captureTaskSessionBindSnapshot(task)
      );
      return current;
    });

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
    clearManagedAutoDeliverDedup(priorSessionId, taskPath);
    const bootstrapImageRefs = await collectTaskBootstrapImageRefs(task);
    task = await runTaskLifecycle(workspaceId, taskPath, async () => {
      let current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
      // Stopping the prior managed Session legitimately projects this exact Task to
      // waiting(session_unavailable). Resume that replace-owned projection before
      // taking the final pre-launch snapshot; every other drift remains fail-closed.
      if (
        current.state === "waiting" &&
        current.sessionId === priorSessionId &&
        isSessionUnavailableParkedWait(current)
      ) {
        await taskResumeRpc(ctx, { workspaceId, taskPath });
        current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
      }
      assertTaskSessionBindSnapshot(
        "task.replaceSession",
        taskPath,
        current,
        captureTaskSessionBindSnapshot(task)
      );
      return current;
    });
    const replacementSession = await ctx.runtime.registry.read(replacementSessionId);
    if (!replacementSession) {
      throw new RpcError(RPC_LIFECYCLE, "Reserved replacement Session disappeared", {
        code: "REPLACE_SESSION_RESERVATION_MISSING",
        sessionId: replacementSessionId,
      });
    }
    const replacementTask: TaskEnvelope = {
      ...task,
      sessionId: replacementSessionId,
    };
    const stableBundle = await collectStableContextGeneration({
      workspaceRoot: mount.workspaceRoot,
      workspaceIdentity: workspaceId,
      packageRoot: ctx.packageRoot,
      packageVersion: ctx.version,
      task: replacementTask,
      session: replacementSession,
      fs: mount.env.fs,
    });
    const liveGeneration = stableBundle.contextGeneration;
    task = await managedTaskInputQueue.run(
      managedTaskInputQueueKey(workspaceId, taskPath),
      async () => {
        const beforePrebind = task;
        const prebound = await runTaskLifecycle(workspaceId, taskPath, () =>
          ctx.mutations.run(workspaceId, async () => {
            const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
            assertTaskSessionBindSnapshot(
              "task.replaceSession",
              taskPath,
              current,
              captureTaskSessionBindSnapshot(beforePrebind)
            );
            ctx.host.markSelfWrite(workspaceId);
            const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
              sessionId: replacementSessionId,
              state: "running",
              wait: null,
              contextGeneration: liveGeneration,
              updatedAt: mount.env.clock.now(),
            });
            emitTaskState(ctx, workspaceId, next, "task.replaceSession.prebind");
            return next;
          })
        );
        try {
          // The exact Task FIFO excludes managed inject workers across the
          // Task+TaskInput rebind boundary. Provider startup cannot observe a
          // new-bound Task with open rows still pointing at the retired Session.
          await ctx.taskInputs.rebindOpenSessions(
            workspaceId,
            taskPath,
            replacementSessionId!
          );
          return prebound;
        } catch (rebindError) {
          const detail = rebindError instanceof Error
            ? rebindError.message
            : String(rebindError);
          try {
            if (beforeReplaceTaskInputRollbackForTests) {
              await beforeReplaceTaskInputRollbackForTests({
                workspaceId,
                taskPath,
                priorSessionId,
                replacementSessionId: replacementSessionId!,
              });
            }
            await runTaskLifecycle(workspaceId, taskPath, () =>
              ctx.mutations.run(workspaceId, async () => {
                const current = await loadTaskEnvelope(mount.env.fs, taskPath);
                if (current.sessionId !== replacementSessionId) {
                  throw new RpcError(
                    RPC_LIFECYCLE,
                    "task.replaceSession Task changed before TaskInput rebind rollback",
                    {
                      code: "TASK_SESSION_BIND_CAS_FAILED",
                      taskPath,
                      expectedSessionId: replacementSessionId,
                      actualSessionId: current.sessionId,
                    }
                  );
                }
                ctx.host.markSelfWrite(workspaceId);
                const rolledBack = await patchTaskEnvelope(mount.env.fs, taskPath, {
                  sessionId: priorSessionId,
                  state: "waiting",
                  wait: {
                    reason: "external",
                    summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
                    code: SESSION_UNAVAILABLE_WAIT_CODE,
                  },
                  updatedAt: mount.env.clock.now(),
                });
                emitTaskState(
                  ctx,
                  workspaceId,
                  rolledBack,
                  "task.replaceSession.input-rebind-rollback"
                );
                return rolledBack;
              })
            );
          } catch (rollbackError) {
            throw new RpcError(
              RPC_LIFECYCLE,
              `task.replaceSession TaskInput rebind failed and Task rollback was incomplete: ${detail}`,
              {
                code: "REPLACE_SESSION_TASK_INPUT_REBIND_ROLLBACK_FAILED",
                taskPath,
                priorSessionId,
                newSessionId: replacementSessionId,
                rebindError: detail,
                rollbackError:
                  rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              }
            );
          }
          throw new RpcError(
            RPC_LIFECYCLE,
            `task.replaceSession TaskInput rebind failed before provider start: ${detail}`,
            {
              code: "REPLACE_SESSION_TASK_INPUT_REBIND_FAILED",
              taskPath,
              priorSessionId,
              newSessionId: replacementSessionId,
              rolledBackToSessionId: priorSessionId,
            }
          );
        }
      }
    );
    const prelaunchSnapshot = captureTaskSessionBindSnapshot(task);
    const handle = await ctx.runtime.startSession({
      sessionId: replacementSessionId,
      workspaceLane,
      runtimeWorkspace: { cwd },
      cwd,
      bootstrapPrompt: await buildFreshReplaceSessionBootstrap(ctx, task, {
        workspaceRoot: mount.workspaceRoot,
        systemRoot: mount.systemRoot,
        priorSessionId,
        currentContextGeneration: liveGeneration,
        roleFs: mount.env.fs,
      }),
      ...(bootstrapImageRefs.length > 0
        ? { bootstrapImageRefs, bootstrapImageSystemRoot: mount.systemRoot }
        : {}),
      workspace: workspaceId,
    });

    if (afterManagedSessionProviderStartForTests) {
      await afterManagedSessionProviderStartForTests({
        operation: "task.replaceSession",
        workspaceId,
        taskPath,
        sessionId: handle.sessionId,
      });
    }

    const bound = await runTaskLifecycle(workspaceId, taskPath, () =>
      ctx.mutations.run(workspaceId, async () => {
        const current = await reconcileServiceTaskLifecycle(ctx, workspaceId, taskPath);
        // Provider events may validly advance this exact replacement-bound Task
        // before startSession returns. Verify immutable identity and ownership only;
        // do not mistake same-Session waiting/delivery progress for a late-bind race.
        assertTaskSessionPostStartOwnership(
          "task.replaceSession",
          taskPath,
          current,
          prelaunchSnapshot
        );
        ctx.events.emit(
          "session.state",
          workspaceId,
          {
            sessionId: handle.sessionId,
            state: handle.state,
            connectionId: handle.connectionId,
            taskPath,
            reason: REPLACE_SESSION_RESTORE_REASON,
            contextRestored: false,
            priorSessionId,
            replacedSessionId: priorSessionId,
          },
          "self"
        );
        return current;
      })
    );

    await ctx.runtime.registry.update(handle.sessionId, {
      contextRestored: false,
      restoreReason: REPLACE_SESSION_RESTORE_REASON,
      replacedSessionId: priorSessionId,
      contextGeneration: liveGeneration,
    });
    try {
      const priorRow = await ctx.runtime.registry.read(priorSessionId);
      if (priorRow) {
        await ctx.runtime.registry.update(priorSessionId, {
          replacedBySessionId: handle.sessionId,
          lastError: `replaced by ${handle.sessionId} (${REPLACE_SESSION_RESTORE_REASON})`,
        });
      }
    } catch {
      /* ignore */
    }
    clearManagedAutoDeliverDedup(handle.sessionId, taskPath);

    const nodeContextJson = JSON.stringify({
      workNodeIds: bound.workNodeIds,
      contextNodeIds: bound.contextNodeIds,
      nodeSnapshots: bound.nodeSnapshots,
    });
    if (
      bound.id !== preserved.taskId ||
      bound.roleId !== preserved.roleId ||
      bound.acceptMode !== preserved.acceptMode ||
      bound.worktree !== preserved.worktree ||
      bound.branch !== preserved.branch ||
      nodeContextJson !== preserved.nodeContextJson
    ) {
      throw new RpcError(RPC_LIFECYCLE, "task.replaceSession mutated task lane/Node context/identity", {
        code: "TASK_IDENTITY_DRIFT",
      });
    }

    await scheduleRetryableTaskInputsAfterSessionBind(ctx, {
      workspaceId,
      taskPath,
    });

    return {
      workspaceId,
      taskPath,
      task: projectTask(bound),
      session: {
        sessionId: handle.sessionId,
        connectionId: handle.connectionId,
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
    if (replacementSessionId) {
      cleanupStopped = await stopUnboundManagedSession(
        ctx,
        replacementSessionId,
        "task.replaceSession",
        err instanceof Error ? err.message : String(err)
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const replaceErrorCode =
      err instanceof RpcError
        ? (err.data as { code?: string } | undefined)?.code
        : undefined;
    const alreadyRolledBackAfterInputRebind =
      replaceErrorCode === "REPLACE_SESSION_TASK_INPUT_REBIND_FAILED";
    let rollbackRecoveryError: string | undefined;
    if (
      replaceErrorCode === "REPLACE_SESSION_TASK_INPUT_REBIND_ROLLBACK_FAILED" &&
      replacementSessionId
    ) {
      const failedReplacementSessionId = replacementSessionId;
      try {
        await managedTaskInputQueue.run(
          managedTaskInputQueueKey(workspaceId, taskPath),
          async () => {
            const current = await loadTaskEnvelope(mount.env.fs, taskPath);
            if (
              current.sessionId === failedReplacementSessionId &&
              (current.state === "running" || current.state === "waiting")
            ) {
              // The first store failure may be transient. Converge open rows to
              // the exact current binding before parking that stopped Session.
              await ctx.taskInputs.rebindOpenSessions(
                workspaceId,
                taskPath,
                failedReplacementSessionId
              );
            }
          }
        );
      } catch (recoveryError) {
        rollbackRecoveryError =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      }
    }
    if (!isTaskSessionBindCasError(err) && !alreadyRolledBackAfterInputRebind) {
      await parkAfterRetirement(message);
    }
    if (isTaskSessionBindCasError(err)) {
      const data = (err as RpcError).data as Record<string, unknown>;
      throw new RpcError(RPC_LIFECYCLE, message, {
        ...data,
        ...(replacementSessionId ? { orphanSessionId: replacementSessionId } : {}),
        ...(cleanupStopped !== undefined ? { cleanupStopped } : {}),
      });
    }
    if (err instanceof RpcError) {
      if (rollbackRecoveryError) {
        throw new RpcError(RPC_LIFECYCLE, message, {
          ...((err.data as Record<string, unknown> | undefined) ?? {}),
          rollbackRecoveryError,
          ...(cleanupStopped !== undefined ? { cleanupStopped } : {}),
        });
      }
      throw err;
    }
    throw new RpcError(RPC_LIFECYCLE, `task.replaceSession failed to start replacement session: ${message}`, {
      code: "REPLACE_SESSION_LAUNCH_FAILED",
      taskPath,
      priorSessionId,
      ...(replacementSessionId ? { sessionId: replacementSessionId } : {}),
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
    currentContextGeneration: string;
    roleFs?: import("../core/adapter.js").FsAdapter;
  }
): Promise<string> {
  const base = await buildSessionBootstrapPrompt(
    ctx,
    task,
    {
      workspaceRoot: roots.workspaceRoot,
      systemRoot: roots.systemRoot,
      currentContextGeneration: roots.currentContextGeneration,
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
    `Node refs: ${taskReferencedNodeIds(task).join(", ")}`,
    "Pending TaskInputs and acceptMode are preserved on this Task. Final report still goes through Delivery only.",
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
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskId", "nodeId", "roleId", "sessionId"]),
    "delivery.list"
  );
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskId = optionalString(p, "taskId");
  const nodeId = optionalString(p, "nodeId");
  const roleId = optionalString(p, "roleId");
  const sessionId = optionalString(p, "sessionId");
  let deliveries = await loadDeliveries(mount.env.fs, { taskId });
  let tasks: TaskEnvelope[] | undefined;
  if (nodeId) {
    const tent = await loadTent(mount.env.fs);
    requireCanonicalNode(tent, nodeId);
    tasks = await loadTaskEnvelopes(mount.env.fs);
    const taskNodeIds = new Map(
      tasks.map((task) => [task.id || task.path, new Set(taskReferencedNodeIds(task))])
    );
    deliveries = deliveries.filter((delivery) => taskNodeIds.get(delivery.taskId)?.has(nodeId));
  }
  if (roleId || sessionId) {
    tasks ??= await loadTaskEnvelopes(mount.env.fs);
    const taskById = new Map(tasks.map((task) => [task.id || task.path, task]));
    deliveries = deliveries.filter((delivery) => {
      const task = taskById.get(delivery.taskId);
      return (!roleId || task?.roleId === roleId) &&
        (!sessionId || task?.sessionId === sessionId);
    });
  }
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
 * Node-keyed collaboration projection. Exact-Node occupation is singular; a
 * multi-Node Task appears as the same active Task on every referenced Node.
 */
async function nodeCollaborationRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<NodeCollaboration> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const nodeId = requireString(p, "nodeId");
  const node = requireCanonicalNode(tent, nodeId);
  if (node.invalid) {
    throw new RpcError(
      -32004,
      `Node is invalid and has no collaboration projection: ${node.path}`,
      { nodeId: node.id, path: node.path, detail: node.invalidReason }
    );
  }
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const deliveries = await loadDeliveries(mount.env.fs);
  const selected = listDirectActiveTasksForNode(node.id, tasks);
  const sessionsById = await loadSessionSummariesForCollaboration(
    ctx,
    collectExplicitSessionIds(selected)
  );
  return projectNodeCollaboration(
    workspaceId,
    node.id,
    selected,
    deliveries,
    sessionsById
  );
}

/**
 * V0.2 batch Node collaboration projection — same item semantics as node.collaboration.
 * Input `nodeIds` order is preserved in `items`. Empty nodeIds → empty items.
 * Loads tent + tasks + deliveries once; probes only unique explicit sessionIds (no N+1 by node).
 */
async function nodeCollaborationsRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<NodeCollaborationsResult> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const idsRaw = p.nodeIds;
  if (!Array.isArray(idsRaw)) {
    throw new RpcError(-32602, "node.collaborations requires nodeIds: string[]");
  }
  const nodeIds: string[] = [];
  for (let i = 0; i < idsRaw.length; i++) {
    const id = idsRaw[i];
    if (typeof id !== "string" || !id.trim()) {
      throw new RpcError(-32602, `node.collaborations nodeIds[${i}] must be a non-empty string`);
    }
    nodeIds.push(id.trim());
  }

  if (nodeIds.length === 0) {
    return { workspaceId, items: [] };
  }

  const tent = await loadTent(mount.env.fs);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const deliveries = await loadDeliveries(mount.env.fs);

  const selectedByNodeId = new Map<string, TaskEnvelope[]>();
  for (const nodeId of nodeIds) {
    if (selectedByNodeId.has(nodeId)) continue; // duplicate Node ids share one resolution
    const node = requireCanonicalNode(tent, nodeId);
    if (node.invalid) {
      throw new RpcError(
        -32004,
        `Node is invalid and has no collaboration projection: ${node.path}`,
        { nodeId: node.id, path: node.path, detail: node.invalidReason }
      );
    }
    selectedByNodeId.set(nodeId, listDirectActiveTasksForNode(nodeId, tasks));
  }

  const allSelected = [...selectedByNodeId.values()].flat();
  const sessionsById = await loadSessionSummariesForCollaboration(
    ctx,
    collectExplicitSessionIds(allSelected)
  );

  const items: NodeCollaboration[] = [];
  for (const nodeId of nodeIds) {
    items.push(
      projectNodeCollaboration(
        workspaceId,
        nodeId,
        selectedByNodeId.get(nodeId) ?? [],
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
 * Build one exact-Node collaboration item. More than one active Task is
 * persisted corruption and fails loudly rather than inventing a list contract.
 */
function projectNodeCollaboration(
  workspaceId: string,
  nodeId: string,
  occupations: readonly TaskEnvelope[],
  deliveries: import("../core/delivery.js").DeliveryRecord[],
  sessionsById: ReadonlyMap<string, NodeCollaborationSessionSummary>
): NodeCollaboration {
  if (occupations.length > 1) {
    throw new RpcError(-32010, `Node has multiple active Task occupations: ${nodeId}`, {
      nodeId,
      taskIds: occupations.map((task) => task.id || task.path),
    });
  }
  const entries: NodeCollaborationActiveTask[] = occupations.map((activeTask) => {
    const taskSummary: NodeCollaborationTaskSummary = {
      id: activeTask.id || activeTask.path,
      state: activeTask.state,
      roleId: activeTask.roleId,
      sessionId: activeTask.sessionId,
    };
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
        if (!activeTask.id || found.taskId !== activeTask.id) {
          throw new RpcError(-32010, `Task points at a foreign Delivery: ${activeTask.activeDeliveryId}`, {
            taskId: activeTask.id ?? null,
            deliveryTaskId: found.taskId,
          });
        }
        delivery = { id: found.id, status: found.status };
      }
    }

    return { task: taskSummary, session, delivery };
  });

  return {
    workspaceId,
    nodeId,
    activeTask: entries[0] ?? null,
  };
}

/**
 * Workspace-level graph projection for Working-set Canvas.
 * Nodes: stable summaries only (no body). Edges: parent + markdown + wiki + relation.
 * Unresolved node links / relation targets are retained with explicit unresolved payload.
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
 * Build workspace graph projection from loaded tent.
 * Reuses markdown link parser + node index (no ad-hoc regex).
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
  const visit = (node: import("../core/types.js").Node, parentNodeId: string | null): void => {
    nodes.push(projectGraphNodeSummary(node));
    parentEdges.push({ parentNodeId, childNodeId: node.id });
    for (const child of node.children) visit(child, node.id);
  };
  for (const root of tent.roots) visit(root, null);

  // Reuse markdown link parser + node index (same as docs.backlinks / resolve path).
  // OkfNode.id is notePath-stem; OkfNode.nodeId is the stable cx- handle.
  // Graph nodes are keyed by canonical Node id, so resolved edges map via nodeId/path.
  const nodeIndex = indexFromNodes(tent.byId.values());
  const emitLinks = (node: import("../core/types.js").Node): void => {
    const notePath = nodeNotePath(node.path);
    for (const link of extractOutLinksDetailed(node.body)) {
      // Artifacts / external schemes are not node graph edges (node-model §6.1).
      if (link.kind === "artifact") continue;
      const resolved = resolveOutLink(nodeIndex, link, notePath);
      const edge: GraphLinkEdge = {
        fromNodeId: node.id,
        raw: link.raw,
      };
      if (link.label) edge.label = link.label;

      // Prefer stable cx- via path/id lookup; never emit path-stem as node id.
      const targetNode =
        (resolved.targetPath ? tent.byPath.get(resolved.targetPath) : undefined) ??
        (resolved.targetNodeId ? tent.byId.get(resolved.targetNodeId) : undefined);

      if (resolved.kind === "unresolved" || !targetNode) {
        // Explicit unresolved — never silent-drop node-link candidates.
        // If resolveOutLink thought it resolved but we cannot map to a Tent Node,
        // still surface unresolved rather than inventing a foreign id.
        const target =
          (link as { targetPath?: string }).targetPath ??
          resolved.targetPath ??
          (resolved.targetNodeId && resolved.targetNodeId !== link.raw ? resolved.targetNodeId : undefined);
        edge.unresolved = target ? { raw: link.raw, target } : { raw: link.raw };
      } else {
        edge.toNodeId = targetNode.id;
      }
      if (link.kind === "wiki") wikiEdges.push(edge);
      else markdownEdges.push(edge);
    }
    for (const child of node.children) emitLinks(child);
  };
  for (const root of tent.roots) emitLinks(root);

  // Semantic relations: DFS source order + source frontmatter array order.
  // Never fold into markdown/wiki even when targets look similar.
  const emitRelations = (node: import("../core/types.js").Node): void => {
    for (const rel of node.relations) {
      const edge: GraphRelationEdge = {
        id: rel.id,
        fromNodeId: node.id,
        kind: rel.kind,
        direction: rel.direction,
      };
      if (rel.label !== undefined) edge.label = rel.label;
      if ("nodeId" in rel.target) {
        // Project stored nodeId honestly; do not re-resolve or drop missing targets here.
        edge.toNodeId = rel.target.nodeId;
      } else {
        edge.unresolved = rel.target.unresolved;
      }
      relationEdges.push(edge);
    }
    for (const child of node.children) emitRelations(child);
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

function projectGraphNodeSummary(source: import("../core/types.js").Node): GraphNodeSummary {
  const title = typeof source.fm.title === "string" ? source.fm.title : undefined;
  const node: GraphNodeSummary = {
    nodeId: source.id,
    etag: source.etag,
    path: source.path,
    name: source.name,
    type: source.type,
    tags: source.tags,
    mode: source.mode,
    archived: source.archived,
    invalid: source.invalid,
  };
  if (title) node.title = title;
  return node;
}

// ---- proposal triage (separate from task delivery review) ----

async function proposalList(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const nodeId = optionalString(p, "nodeId");
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
  if (nodeId) {
    requireCanonicalNode(await loadTent(mount.env.fs), nodeId);
    proposals = proposals.filter((item) => item.nodeId === nodeId);
  }
  if (statusRaw !== "all") {
    proposals = proposals.filter((item) => item.status === statusRaw);
  }
  return { proposals: proposals.map(projectProposal) };
}

async function proposalSubmit(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const nodeId = requireString(p, "nodeId");
  const role = requireString(p, "role");
  const body = requireString(p, "body");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    requireCanonicalNode(await loadTent(mount.env.fs), nodeId);
    const proposal = await submitProposal(mount.env.fs, mount.env.clock, role, nodeId, body);
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
    nodeId: proposal.nodeId,
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
      nodeId: proposal.nodeId,
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
      connectionId: rec.connectionId,
      adapterId: rec.adapterId,
      ...(rec.acpSession
        ? { acpSession: cloneAcpSessionConfigSnapshot(rec.acpSession) }
        : {}),
      state: probe.state,
      roleId: rec.roleId,
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
    connectionId: rec.connectionId,
    adapterId: rec.adapterId,
    ...(rec.acpSession
      ? { acpSession: cloneAcpSessionConfigSnapshot(rec.acpSession) }
      : {}),
    state: probe.state,
    roleId: rec.roleId,
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
  assertAllowedParams(
    p,
    new Set(["workspaceId", "sessionId", "roleId", "externalKey", "lastTaskId", "cwd"]),
    "session.enter"
  );
  const workspaceId = optionalString(p, "workspaceId");
  if (workspaceId) ctx.host.require(workspaceId);

  const sessionId = optionalString(p, "sessionId");
  const roleId = optionalString(p, "roleId");
  const externalKey = optionalString(p, "externalKey");
  const lastTaskId = optionalString(p, "lastTaskId");
  const cwd = optionalString(p, "cwd");

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
      roleId: roleId || undefined,
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
    connectionId: handle.connectionId,
    adapterId: handle.adapterId,
    state: probe.state,
    roleId: handle.roleId,
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

  const roleCheckpointTail = handle.roleId
    ? await loadRoleCheckpointTailByIdSafe(ctx, workspaceId, handle.roleId)
    : "";

  return {
    session,
    sessionToken: handle.sessionToken,
    reused: priorExternalId === handle.sessionId,
    /**
     * Optional cooperative Role Checkpoint tail for the durable Role just entered.
     * Dynamic only — callers append after stable Role init / bootstrap prefix.
     * Absent when no Role or no note on disk.
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
 * exact workspace === this workspaceId AND roleId === the checkpoint Role.
 * Missing or mismatched workspace/role (including unscoped legacy rows) drop
 * attribution — never invent continuity from an unrelated Session.
 */
async function resolveRoleCheckpointSourceSessionId(
  ctx: HandlerContext,
  workspaceId: string,
  roleId: string,
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
    const recRole = rec.roleId?.trim() || "";
    if (!recRole || recRole !== roleId) return undefined;
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
  const { roleName, roleId } = await resolveDurableCheckpointRole(ctx, workspaceId, roleRef);
  if (!roleId) throw new RpcError(-32602, `Durable Role is missing canonical id: ${roleRef}`);
  const actor = requireRoleCheckpointActor(p, roleName, "role.checkpoint.set");
  const text = requireString(p, "text");
  const rawSource =
    optionalString(p, "sourceSessionId") || optionalString(p, "sessionId") || undefined;
  const sourceSessionId = await resolveRoleCheckpointSourceSessionId(
    ctx,
    workspaceId,
    roleId,
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

async function loadRoleCheckpointTailByIdSafe(
  ctx: HandlerContext,
  workspaceId: string | undefined,
  roleId: string
): Promise<string> {
  if (!workspaceId || !roleId.trim()) return "";
  try {
    const resolved = await resolveDurableCheckpointRole(ctx, workspaceId, roleId);
    return loadRoleCheckpointTailSafe(ctx, workspaceId, resolved.roleName);
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
        connectionId: rec.connectionId,
        adapterId: rec.adapterId,
        state: probe.state,
        roleId: rec.roleId,
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
    connectionId: rec.connectionId,
    adapterId: rec.adapterId,
    state: probe.state,
    roleId: rec.roleId,
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
 * End or unbind an external session. Never delivers or accepts tasks. Any exact
 * running Task remains occupied and is parked recoverably before the binding stops.
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
  let incompleteTasks = await listIncompleteTasksBoundToSession(
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
    const leaveWorkspaceId = rec.workspace || workspaceId;
    const closeWithinMutation = async () => {
      const currentSession = await ctx.runtime.registry.read(sessionId);
      if (currentSession?.state !== "external") {
        state = currentSession?.state === "failed" ? "failed" : "stopped";
        return;
      }
      if (leaveWorkspaceId) {
        const mount = ctx.host.require(leaveWorkspaceId);
        const boundTasks = (
          await listIncompleteTasksBoundToSession(
            ctx,
            leaveWorkspaceId,
            sessionId
          )
        ).sort((a, b) => a.path.localeCompare(b.path));
        ctx.host.markSelfWrite(leaveWorkspaceId, 200, TEMP_DIR);
        for (const boundTask of boundTasks) {
          const currentTask = await loadTaskEnvelope(mount.env.fs, boundTask.path);
          if (currentTask.sessionId?.trim() !== sessionId) continue;
          // Persist/project every exact running/waiting binding before closing
          // the Session. A single workspace mutation is the ordering authority:
          // no multiple Task locks are held, so deterministic path iteration
          // cannot deadlock with claim/reject lifecycle flights.
          await applySessionUnavailablePark(
            ctx,
            leaveWorkspaceId,
            boundTask.path,
            "session.leave"
          );
        }
      }
      await ctx.runtime.stopSession(sessionId, "user");
      left = true;
      const after = await ctx.runtime.registry.read(sessionId);
      state = after?.state ?? "stopped";
    };

    // Match external claim/reject's workspace mutation boundary. The whole
    // probe→resume operation or the whole enumerate→park-all→close operation
    // wins; neither can interleave inside the workspace mutation boundary.
    if (leaveWorkspaceId) {
      await ctx.mutations.run(leaveWorkspaceId, closeWithinMutation);
    } else {
      await closeWithinMutation();
    }

    if (leaveWorkspaceId) {
      incompleteTasks = await listIncompleteTasksBoundToSession(
        ctx,
        leaveWorkspaceId,
        sessionId
      );
    }
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
): Promise<
  Array<{
    path: string;
    id?: string;
    state: string;
    roleId?: string;
    sessionId?: string;
  }>
> {
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
): Promise<
  Array<{
    path: string;
    id?: string;
    state: string;
    roleId?: string;
    sessionId?: string;
  }>
> {
  if (sessionIds.length === 0) return [];
  const idSet = new Set(sessionIds);
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const out: Array<{
    path: string;
    id?: string;
    state: string;
    roleId?: string;
    sessionId?: string;
  }> = [];
  for (const task of tasks) {
    const sid = task.sessionId?.trim();
    if (!sid || !idSet.has(sid)) continue;
    if (!isActiveTaskState(task.state)) continue;
    out.push({
      path: task.path,
      id: task.id,
      state: task.state,
      roleId: task.roleId,
      sessionId: sid,
    });
  }
  return out;
}

// ---- ACP tool permission approvals (permissionPolicy=ask) ----

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
  // Do not resume while the exact Task still has a pending Decision Request.
  if (decision === "approved" && !hasPendingForSession && item.taskPath) {
    try {
      const pendingDecision = await ctx.decisionRequests.getPendingForTask(
        item.workspaceId,
        item.taskPath
      );
      if (!pendingDecision) {
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

// ---- Session → parent/user Decision Request (not tool permission; not chat) ----

async function decisionCallerAuthority(
  ctx: HandlerContext,
  workspaceId: string,
  caller: DecisionCallerContext
): Promise<TaskActorRef> {
  const session = await resolveDecisionCallerSession(ctx, caller);
  if (!session) return { kind: "user", id: "user" };
  if (
    session.workspace !== workspaceId ||
    !session.roleId ||
    !SessionRegistry.isOpen(session.state)
  ) {
    throw new RpcError(-32001, "Caller Session is not an exact live Role authority", {
      code: "DECISION_RESPONDER_FORBIDDEN",
      sessionId: session.id,
      workspaceId,
    });
  }
  return { kind: "role", id: session.roleId };
}

function assertDecisionAuthority(
  request: DecisionRequestRecord,
  responder: TaskActorRef
): void {
  if (
    request.target.kind !== responder.kind ||
    request.target.id !== responder.id
  ) {
    throw new RpcError(-32001, "Caller is not the frozen Decision Request target", {
      code: "DECISION_RESPONDER_FORBIDDEN",
      requestId: request.id,
      target: request.target,
      responder,
    });
  }
}

async function decisionRequestListPending(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: DecisionCallerContext
) {
  assertAllowedParams(p, new Set(["workspaceId"]), "decisionRequest.listPending");
  const workspaceId = requireWorkspaceId(ctx, p);
  const responder = await decisionCallerAuthority(ctx, workspaceId, caller);
  const mounted = ctx.host.require(workspaceId);
  const authorized = (await ctx.decisionRequests.listPending(workspaceId)).filter(
    (request) =>
      request.target.kind === responder.kind && request.target.id === responder.id
  );
  const pending = (
    await Promise.all(
      authorized.map(async (request) => {
        const task = await loadTaskEnvelope(mounted.env.fs, request.taskPath).catch(
          () => undefined
        );
        return task && task.id === request.taskId && !TERMINAL_TASK_STATES.has(task.state)
          ? request
          : undefined;
      })
    )
  ).filter((request): request is DecisionRequestRecord => request !== undefined);
  return { requests: pending.map(projectDecisionRequest) };
}

/**
 * Workspace-scoped unified pending projection for the local user.
 * Aggregates three domain sources only — no new store, no resolve verbs, no
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

  let requests: Awaited<ReturnType<typeof ctx.decisionRequests.listPending>>;
  let toolApprovals: Awaited<ReturnType<typeof ctx.toolApprovals.listPending>>;
  let deliveries: Awaited<ReturnType<typeof loadDeliveries>>;
  try {
    // Parallel reads are independent; reject if any source fails.
    const settled = await Promise.all([
      ctx.decisionRequests.listPending(workspaceId),
      ctx.toolApprovals.listPending(workspaceId),
      loadDeliveries(mount.env.fs),
    ]);
    requests = settled[0];
    toolApprovals = settled[1];
    deliveries = settled[2];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(
      -32000,
      `interaction.listPending failed to load pending sources: ${message}`,
      { workspaceId }
    );
  }

  // Task envelopes supply optional nodeId/sessionId pointers for rows that
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

  for (const request of requests.filter((item) => item.target.kind === "user")) {
    const task = tasksByPath.get(request.taskPath) ?? tasksById.get(request.taskId);
    if (!task || task.id !== request.taskId || TERMINAL_TASK_STATES.has(task.state)) {
      continue;
    }
    const item: PendingDecisionRequestInteraction = {
      kind: "decisionRequest",
      id: request.id,
      workspaceId: request.workspaceId,
      createdAt: request.createdAt,
      taskPath: request.taskPath,
      taskId: request.taskId,
      sessionId: request.requester.id,
      ...(task ? { role: taskParentRoleId(task) } : {}),
      target: request.target,
      question: request.question,
      options: request.options.map((option) => ({ ...option })),
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
    const responsibleRole = projected.role ?? (task ? taskParentRoleId(task) : undefined);
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
      ...(responsibleRole ? { role: responsibleRole } : {}),
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
      sourceNodeId: delivery.sourceNodeId,
      path: delivery.path,
      status: "ready",
      ...(task?.path ? { taskPath: task.path } : {}),
      ...(task?.sessionId ? { sessionId: task.sessionId } : {}),
    };
    items.push(item);
  }

  items.sort(comparePendingInteraction);

  const counts = {
    decisionRequest: 0,
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

async function requireExactDecisionRequest(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<{ workspaceId: string; taskPath: string; request: DecisionRequestRecord }> {
  const workspaceId = requireWorkspaceId(ctx, p);
  const taskPath = requireString(p, "taskPath");
  const requestId = requireString(p, "requestId");
  const request = await ctx.decisionRequests.getExact(workspaceId, taskPath, requestId);
  if (!request) {
    throw new RpcError(-32004, `Decision Request not found for exact Task: ${requestId}`);
  }
  return { workspaceId, taskPath, request };
}

async function decisionRequestGet(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: DecisionCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "requestId"]),
    "decisionRequest.get"
  );
  const exact = await requireExactDecisionRequest(ctx, p);
  const responder = await decisionCallerAuthority(ctx, exact.workspaceId, caller);
  assertDecisionAuthority(exact.request, responder);
  if (exact.request.status === "pending") {
    const mount = ctx.host.require(exact.workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, exact.taskPath).catch(() => undefined);
    if (!task || task.id !== exact.request.taskId || TERMINAL_TASK_STATES.has(task.state)) {
      throw new RpcError(-32004, `Decision Request not found for active exact Task: ${exact.request.id}`);
    }
  }
  return { request: projectDecisionRequest(exact.request) };
}

function parseDecisionResponseParam(
  raw: unknown,
  options: readonly DecisionRequestOption[]
): DecisionResponse {
  try {
    return validateDecisionResponse(raw, options);
  } catch (error) {
    throw new RpcError(-32602, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Persist deterministic TaskInput before answering the request, then resume and
 * schedule the existing exact-Task FIFO. A retry reuses the same ti-* row.
 */
async function decisionRequestRespondRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: DecisionCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "requestId", "response"]),
    "decisionRequest.respond"
  );
  const exact = await requireExactDecisionRequest(ctx, p);
  const responder = await decisionCallerAuthority(ctx, exact.workspaceId, caller);
  assertDecisionAuthority(exact.request, responder);
  const response = parseDecisionResponseParam(p.response, exact.request.options);
  const mount = ctx.host.require(exact.workspaceId);

  const result = await runTaskLifecycle(exact.workspaceId, exact.taskPath, () =>
    ctx.mutations.run(exact.workspaceId, async () => {
      const currentRequest = await ctx.decisionRequests.getExact(
        exact.workspaceId,
        exact.taskPath,
        exact.request.id
      );
      if (!currentRequest) {
        throw new RpcError(-32004, `Decision Request not found: ${exact.request.id}`);
      }
      assertDecisionAuthority(currentRequest, responder);
      const task = await loadTaskEnvelope(mount.env.fs, exact.taskPath);
      if (!task.id || task.id !== currentRequest.taskId) {
        throw new RpcError(RPC_LIFECYCLE, "Decision Request Task identity changed", {
          code: "DECISION_TASK_MISMATCH",
          requestId: currentRequest.id,
        });
      }
      if (TERMINAL_TASK_STATES.has(task.state)) {
        throw new RpcError(RPC_LIFECYCLE, "Cannot respond to a Decision Request for a terminal Task", {
          code: "DECISION_TASK_TERMINAL",
          requestId: currentRequest.id,
          taskId: task.id,
          state: task.state,
        });
      }
      if (task.sessionId !== currentRequest.requester.id) {
        throw new RpcError(RPC_LIFECYCLE, "Decision requester Session is no longer bound to the exact Task", {
          code: "DECISION_SESSION_MISMATCH",
          requestId: currentRequest.id,
          requesterSessionId: currentRequest.requester.id,
          taskSessionId: task.sessionId,
        });
      }
      const session = await ctx.runtime.registry.read(currentRequest.requester.id);
      if (
        !session ||
        session.workspace !== exact.workspaceId ||
        session.lastTaskId !== task.id
      ) {
        throw new RpcError(RPC_LIFECYCLE, "Decision requester Session registry binding is stale", {
          code: "DECISION_SESSION_BINDING_STALE",
          requestId: currentRequest.id,
        });
      }
      const now = new Date().toISOString();
      const prepared = prepareDecisionResponse({
        request: coreDecisionRequest(currentRequest),
        responder,
        response,
        binding: {
          workspaceId: exact.workspaceId,
          taskPath: exact.taskPath,
          taskId: task.id,
          sessionId: currentRequest.requester.id,
          ...(taskParentRoleId(task) ? { role: taskParentRoleId(task) } : {}),
        },
        now,
      });
      const existingInput = await ctx.taskInputs.get(
        prepared.taskInput.id,
        exact.workspaceId,
        exact.taskPath
      );
      const input = existingInput
        ? (assertDecisionResponseTaskInputMatches(existingInput, prepared.taskInput), existingInput)
        : await ctx.taskInputs.add(prepared.taskInput);
      const wasPending = currentRequest.status === "pending";
      const answered = await ctx.decisionRequests.answerExact({
        workspaceId: exact.workspaceId,
        taskPath: exact.taskPath,
        requestId: currentRequest.id,
        responder,
        response,
      });
      if (wasPending) {
        ctx.events.emit(
          "decisionRequest.resolved",
          exact.workspaceId,
          projectDecisionRequest(answered),
          "self"
        );
      }
      let nextTask = task;
      if (task.state === "waiting" && task.wait?.reason === "user-input") {
        ctx.host.markSelfWrite(exact.workspaceId);
        nextTask = await taskResume(mount.env, exact.taskPath);
        emitTaskState(ctx, exact.workspaceId, nextTask, "decisionRequest.respond");
      }
      return { answered, input, task: nextTask };
    })
  );

  ctx.events.emit(
    "taskInput.pending",
    exact.workspaceId,
    projectTaskInput(result.input),
    "self"
  );
  enqueueManagedTaskInputBackground(ctx, result.input);
  return {
    request: projectDecisionRequest(result.answered),
    input: projectTaskInput(result.input),
    task: projectTask(result.task),
    state: result.task.state,
    accepted: true,
    enqueued: true,
  };
}

function coreDecisionRequest(item: DecisionRequestRecord): DecisionRequest {
  return item.status === "pending"
    ? {
        id: item.id,
        taskId: item.taskId,
        requester: item.requester,
        target: item.target,
        question: item.question,
        options: item.options,
        status: "pending",
      }
    : {
        id: item.id,
        taskId: item.taskId,
        requester: item.requester,
        target: item.target,
        question: item.question,
        options: item.options,
        status: "answered",
        response: item.response,
        resolvedBy: item.resolvedBy,
      };
}

async function decisionRequestEscalateRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  caller: DecisionCallerContext
) {
  assertAllowedParams(
    p,
    new Set(["workspaceId", "taskPath", "requestId"]),
    "decisionRequest.escalate"
  );
  const exact = await requireExactDecisionRequest(ctx, p);
  const responder = await decisionCallerAuthority(ctx, exact.workspaceId, caller);
  assertDecisionAuthority(exact.request, responder);
  if (responder.kind !== "role") {
    throw new RpcError(-32001, "Only the frozen Role target may escalate to user");
  }
  const mount = ctx.host.require(exact.workspaceId);
  const escalated = await runTaskLifecycle(exact.workspaceId, exact.taskPath, () =>
    ctx.mutations.run(exact.workspaceId, async () => {
      const current = await ctx.decisionRequests.getExact(
        exact.workspaceId,
        exact.taskPath,
        exact.request.id
      );
      if (!current) {
        throw new RpcError(-32004, `Decision Request not found: ${exact.request.id}`);
      }
      assertDecisionAuthority(current, responder);
      if (current.status !== "pending") {
        throw new RpcError(RPC_LIFECYCLE, `Decision Request is already answered: ${current.id}`);
      }
      const task = await loadTaskEnvelope(mount.env.fs, exact.taskPath);
      if (!task.id || task.id !== current.taskId || TERMINAL_TASK_STATES.has(task.state)) {
        throw new RpcError(RPC_LIFECYCLE, "Cannot escalate a Decision Request for a terminal or changed Task", {
          code: "DECISION_TASK_TERMINAL_OR_CHANGED",
          requestId: current.id,
          taskId: current.taskId,
          state: task.state,
        });
      }
      return ctx.decisionRequests.escalateExact(
        exact.workspaceId,
        exact.taskPath,
        exact.request.id
      );
    })
  );
  ctx.events.emit(
    "decisionRequest.pending",
    exact.workspaceId,
    projectDecisionRequest(escalated),
    "self"
  );
  return { request: projectDecisionRequest(escalated) };
}

function projectDecisionRequest(item: DecisionRequestRecord) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    taskPath: item.taskPath,
    taskId: item.taskId,
    requester: item.requester,
    target: item.target,
    question: item.question,
    options: item.options,
    status: item.status,
    ...(item.status === "answered"
      ? { response: item.response, resolvedBy: item.resolvedBy, answeredAt: item.answeredAt }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ---- U2A task input (one-shot append; not chat; not DecisionRequest) ----

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
    const visible = await filterPublishedTaskInputs(ctx, attention);
    return { inputs: visible.map(projectTaskInput) };
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
  if (await isUnpublishedDecisionResponseInput(ctx, item)) {
    throw new RpcError(-32004, `TaskInput not found: ${inputId}`);
  }
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
  if (await isUnpublishedDecisionResponseInput(ctx, existing)) {
    throw new RpcError(
      RPC_LIFECYCLE,
      "Decision response TaskInput is not published until its Decision Request is answered",
      { inputId, workspaceId, taskPath }
    );
  }

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

  if (task.roleId && actorRaw === task.roleId) {
    return { actor: actorRaw, task };
  }
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
        const workspaceMatches = rec.workspace === item.workspaceId;
        const taskMatches =
          rec.lastTaskId === task.id && task.sessionId === item.sessionId;
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
      expectedRoleId: task.roleId,
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

async function isUnpublishedDecisionResponseInput(
  ctx: HandlerContext,
  item: TaskInputRecord
): Promise<boolean> {
  if (normalizeTaskInputKind(item.kind) !== "decision-response") return false;
  const pending = await ctx.decisionRequests.getPendingForTask(
    item.workspaceId,
    item.taskPath
  );
  return !!pending && taskInputIdForDecisionRequest(pending.id) === item.id;
}

async function filterPublishedTaskInputs(
  ctx: HandlerContext,
  items: TaskInputRecord[]
): Promise<TaskInputRecord[]> {
  const visibility = await Promise.all(
    items.map(async (item) => !(await isUnpublishedDecisionResponseInput(ctx, item)))
  );
  return items.filter((_item, index) => visibility[index]);
}

async function removePendingDecisionRequestForTerminal(
  ctx: HandlerContext,
  workspaceId: string,
  taskPath: string,
  resolvedBy: string
): Promise<void> {
  let removed: DecisionRequestRecord | undefined;
  try {
    removed = await ctx.decisionRequests.removePendingForTask(workspaceId, taskPath);
  } catch (error) {
    const pending = await ctx.decisionRequests
      .getPendingForTask(workspaceId, taskPath)
      .catch(() => undefined);
    ctx.events.emit(
      "decisionRequest.resolved",
      workspaceId,
      {
        ...(pending ? { requestId: pending.id, taskId: pending.taskId } : {}),
        taskPath,
        terminal: true,
        resolvedBy,
        cleanupFailed: true,
        diagnostic: error instanceof Error ? error.message : String(error),
      },
      "self"
    );
    return;
  }
  if (!removed) return;
  ctx.events.emit(
    "decisionRequest.resolved",
    workspaceId,
    {
      requestId: removed.id,
      taskId: removed.taskId,
      taskPath: removed.taskPath,
      terminal: true,
      resolvedBy,
    },
    "self"
  );
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
 * Exact-task reconcile for local user or the persisted parent/reviewer Role.
 * This never scans inventory or prunes Git: it reloads one authoritative
 * envelope and reuses the terminal reclaim gates.
 */
async function taskWorktreeReclaimReconcileRpc(
  ctx: HandlerContext,
  p: Record<string, unknown>
) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const task = await loadTaskEnvelope(mount.env.fs, taskPath);
  requireTaskWorktreeReconcileActor(p, task);
  const result = await maybeAutoReclaimTaskWorktree(
    ctx,
    workspaceId,
    task,
    "task.worktreeReclaim.reconcile"
  );
  const diagnostic =
    result ??
    (await evaluateTaskWorktreeReclaimForEnvelope(
      mount.env.fs,
      mount.workspaceRoot,
      task
    ));
  return { workspaceId, taskPath, ...diagnostic };
}

function requireTaskWorktreeReconcileActor(
  p: Record<string, unknown>,
  task: TaskEnvelope
): string {
  const actor = requireString(p, "actor");
  if (actor === "user") return actor;
  const authorized = [task.parentActor, task.reviewer].some(
    (candidate) => candidate?.kind === "role" && candidate.id === actor
  );
  if (!authorized) {
    throw new RpcError(
      -32001,
      "task.worktreeReclaim.reconcile requires user or the exact Task parent/reviewer Role",
      { actor, taskId: task.id, taskPath: task.path }
    );
  }
  return actor;
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
    // Best-effort settle retry; the durable exact row remains available for
    // explicit task.worktreeReclaim.reconcile.
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
 * Best-effort auto-reclaim of a terminal Connection-executed Task worktree.
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
 * and retries after session settle / explicit exact-task reconcile.
 */
async function maybeAutoReclaimTaskWorktree(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope,
  reason: string
): Promise<TaskWorktreeReclaimResult | undefined> {
  const mount = ctx.host.get(workspaceId);
  if (!mount) return undefined;

  // Only task-scoped Connection lanes with a recorded Git path participate.
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
    const blocked: TaskWorktreeReclaimResult = {
      eligible: false,
      code: "REMOVE_FAILED",
      reason: `Auto-reclaim threw: ${err instanceof Error ? err.message : String(err)}`,
      taskId: task.id,
      taskPath: task.path,
      taskState: task.state,
      workspace: task.workspace,
      worktree: task.worktree,
      branch: task.branch,
      targetBranch: task.targetBranch,
      reclaimed: false,
      alreadyGone: false,
    };
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
        reason: blocked.reason,
        trigger: reason,
      },
      "self"
    );
    return blocked;
  }
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

async function readNodeBody(
  mount: { env: { fs: import("../core/adapter.js").FsAdapter } },
  node: { path: string; body?: string }
): Promise<{ body: string; raw: string; etag: string }> {
  const notePath = nodeNotePath(node.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { body } = parseFrontmatter(raw);
  return { body, raw, etag: contentEtag(raw) };
}

/**
 * List annotations for one canonical Node.
 * Does not rewrite stored anchors.
 */
async function annotationListRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const nodeId = requireString(p, "nodeId");

  const tent = await loadTent(mount.env.fs);
  const node = requireCanonicalNode(tent, nodeId);
  const note = await readNodeBody(mount, node);
  const documentBody = note.body;

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

  const nodeId = requireString(p, "nodeId");

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

  const baseEtag = optionalString(p, "documentEtag");
  if (!baseEtag) {
    throw new RpcError(-32602, "annotation.create requires documentEtag");
  }

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const node = requireCanonicalNode(tent, nodeId);
    const note = await readNodeBody(mount, node);
    if (baseEtag !== note.etag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag: note.etag,
        baseEtag,
        path: node.path,
        nodeId,
      });
    }

    try {
      const record = await createAnnotation(mount.env.fs, {
        nodeId: node.id,
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
      const node = tent.byId.get(record.nodeId) ?? null;
      let documentBody: string | null = null;
      if (node) {
        documentBody = (await readNodeBody(mount, node)).body;
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
      const node = tent.byId.get(record.nodeId) ?? null;
      let documentBody: string | null = null;
      if (node) {
        documentBody = (await readNodeBody(mount, node)).body;
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
  connectionId: string;
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
  connectionId: string,
  operation: ManagedSessionFlightOperation,
  taskPath: string
): Promise<unknown> {
  if (existing.connectionId !== connectionId || existing.operation !== operation) {
    throw new RpcError(RPC_LIFECYCLE, MANAGED_SESSION_IN_PROGRESS_MESSAGE, {
      taskPath,
      connectionId,
      operation,
      inFlightConnectionId: existing.connectionId,
      inFlightOperation: existing.operation,
      retryable: true,
    });
  }
  return existing.promise;
}

async function runManagedSessionFlight(
  workspaceId: string,
  taskPath: string,
  connectionId: string,
  operation: ManagedSessionFlightOperation,
  run: () => Promise<unknown>
): Promise<unknown> {
  const flightKey = managedSessionFlightKey(workspaceId, taskPath);
  const existing = managedSessionInFlight.get(flightKey);
  if (existing) return joinOrConflictManagedSessionFlight(existing, connectionId, operation, taskPath);

  let settle!: (value: unknown) => void;
  let rejectFlight!: (reason: unknown) => void;
  const flightPromise = new Promise<unknown>((resolve, reject) => {
    settle = resolve;
    rejectFlight = reject;
  });
  flightPromise.catch(() => undefined);
  managedSessionInFlight.set(flightKey, { connectionId, operation, promise: flightPromise });
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
  const draft = await ctx.managedDeliveryReportDrafts.get(
    input.workspaceId,
    input.taskPath
  );
  if (!draft) return;
  const priorOutcome = parseTaskOutcomeReport(draft.assistantText);
  if (priorOutcome?.outcome === "blocked" || priorOutcome?.outcome === "needs-input") {
    // Control reports are durable evidence for the parked turn, not deferred
    // Delivery candidates. Only a real later provider report may supersede one.
    return;
  }
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
  if (ev.type === "session.config_options") {
    // AgentRuntime enqueues the registry update before emit; registry reads join
    // that write chain. No transcript/UI event is emitted for audit snapshots.
    return;
  }
  if (ev.type === "session.acp_observation") {
    // Machine-local diagnostics only. AgentRuntime enqueues persistence before
    // fan-out; never project this into Task/chat or client-visible state.
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
    // all retain durable TaskInputs. Unbound sessions still cancel by sessionId
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
      // Runtime events require the bidirectional exact binding. Registry lastTaskId
      // alone is never authority for mutating a Task.
      const currentTask = tasks.find((t) => {
        if (t.id !== rec.lastTaskId && t.path !== rec.lastTaskId) return false;
        return t.sessionId === ev.sessionId;
      });
      const task = currentTask;
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
        // Keep waiting while the exact Task has a pending Decision Request.
        const pendingDecision = await ctx.decisionRequests.getPendingForTask(
          mount.workspaceId,
          task.path
        );
        if (!pendingDecision) {
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
    // cancellation of TaskInputs.
    await cancelTaskInputsForTask(ctx, input.workspaceId, input.taskPath, "task.fail");
    if (input.sessionId) {
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
    await removePendingDecisionRequestForTerminal(
      ctx,
      input.workspaceId,
      input.taskPath,
      "task.fail"
    );
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
    (task.wait.summary.includes(REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY) ||
      task.wait.summary.includes(EXTERNAL_ROLE_REJECT_RESUME_FAILED_WAIT_SUMMARY))
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
  if (!rec?.lastTaskId || !rec.workspace) return undefined;
  try {
    const mountInfos = ctx.host.list();
    for (const info of mountInfos) {
      if (info.workspaceId !== rec.workspace) continue;
      const mount = ctx.host.get(info.workspaceId);
      if (!mount) continue;
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      const currentTask = tasks.find((t) => {
        if (t.id !== rec.lastTaskId && t.path !== rec.lastTaskId) return false;
        return t.sessionId === sessionId;
      });
      return currentTask;
    }
  } catch {
    // best-effort
  }
  return undefined;
}

/**
 * Whether session terminal cleanup must retain durable TaskInputs.
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
 * - outcome blocked|needs-input → park via existing wait paths; no ready Delivery
 * - review-required → pending independent accept; auto-accept/agent-decide only at
 *   the user-facing responsibility boundary, regardless of Role/Session executor
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
  const summary = (parsedOutcome.report || rawReport).trim();
  // Keep the complete bounded outcome wire in drafts so idempotent retry
  // re-parses control reports without relying on the truncated wait summary.
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

    // Identity-only preflight. Core owns lifecycle/WAL convergence below; raw
    // Task state must not decide whether an already-committed Delivery is done.
    // Avoid killing an already-rebound reject-resume session.
    const pre = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
    if (!pre || !["running", "delivered", "accepted"].includes(pre.state)) {
      return;
    }
    if (pre.sessionId !== sessionId) {
      return;
    }

    // The provider's final report must be durable before it can wait behind a
    // Task flight or hit any Core/seal/Git failure. Never overwrite a different
    // exact-Task draft: that row belongs to the earlier completion attempt.
    const existingDraft = await ctx.managedDeliveryReportDrafts.get(
      input.workspaceId,
      input.taskPath
    );
    if (existingDraft) {
      const exactExisting =
        existingDraft.sessionId === sessionId &&
        existingDraft.assistantText.trim() === draftText;
      if (!exactExisting) {
        const priorOutcome = parseTaskOutcomeReport(existingDraft.assistantText);
        const priorWasControl =
          priorOutcome?.outcome === "blocked" || priorOutcome?.outcome === "needs-input";
        if (pre.state !== "running" || !priorWasControl) {
          throw new Error(
            "managed Delivery report draft conflicts with this Session or completion report"
          );
        }
        // The current Task binding above proves this report belongs to the exact
        // live Session. A formally resumed/replaced turn may supersede a prior
        // blocked/needs-input control report even when that report came from the
        // retired Session; non-control cross-Session drafts remain fail-closed.
        await ctx.managedDeliveryReportDrafts.preserve({
          workspaceId: input.workspaceId,
          taskPath: input.taskPath,
          taskId: pre.id,
          sessionId,
          assistantText: draftText,
        });
      } else {
        draftPreserved = true;
      }
      draftPreserved = true;
    } else {
      await ctx.managedDeliveryReportDrafts.preserve({
        workspaceId: input.workspaceId,
        taskPath: input.taskPath,
        taskId: pre.id!,
        sessionId,
        assistantText: draftText,
      });
      draftPreserved = true;
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
    if (!summary) {
      // Delivered with an empty body is not usable, but its full control wire is
      // already durable for diagnosis/retry.
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

    // One exact-Task flight owns WAL recovery, seal, Git and finalization.
    let published = false;
    await runTaskLifecycle(input.workspaceId, input.taskPath, async () => {
      type Phase =
        | { kind: "skip" }
        | { kind: "done"; result: TaskDeliverResult }
        | {
            kind: "auto";
            sourceNodeId: string;
            deliveryId: string;
            commits: string[];
            targetHead?: string;
            opts: TaskDeliverOptions;
          };

      // Reconcile a previously committed Delivery before deriving anything
      // from mutable current Git state. Core returns the exact persisted
      // candidate/options; Service only verifies the bound managed Session.
      const recovered = await ctx.mutations.run(input.workspaceId, () =>
        recoverCommittedTaskDeliver(mount.env, input.taskPath, {
          summary,
          lastOutcome: "delivered",
        })
      );
      const current = recovered?.task ?? await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (current.sessionId !== sessionId) return;
      if (!recovered && current.state !== "running") return;

      if (!recovered) {
        // Outside the mutation bus: capture-once baseline for legacy Git-lane
        // tasks missing roleBranchBase. Nested mutations.run would deadlock.
        if (input.commits === undefined) {
          await ensureTaskWorkspaceLane(ctx, input.workspaceId, current);
        }
        // Refuse before stopping the managed Session. A committed Delivery has
        // already passed this gate in its original attempt.
        await assertNoBlockingTaskInputsForDeliver(ctx, input.workspaceId, current);
      }

      // A committed candidate was originally published only after a successful
      // seal; re-proving the seal here also prevents stale drafts from clearing
      // while the same managed process remains mutable.
      const sealed = await sealManagedSessionBeforeDelivery(ctx, {
        workspaceId: input.workspaceId,
        sessionId,
        taskPath: input.taskPath,
      });
      if (!sealed) {
        throw new Error(
          "managed session could not be sealed before auto-deliver (process still mutable)"
        );
      }

      let phase: Phase;
      if (recovered) {
        if (recovered.prepared.kind === "done") {
          phase = { kind: "done", result: recovered.prepared.result };
        } else {
          phase = {
            kind: "auto",
            sourceNodeId: recovered.prepared.sourceNodeId,
            deliveryId: recovered.prepared.deliveryId,
            commits: recovered.prepared.commits,
            ...(recovered.prepared.targetHead
              ? { targetHead: recovered.prepared.targetHead }
              : {}),
            opts: recovered.options,
          };
        }
      } else {
        phase = await ctx.mutations.run(input.workspaceId, async (): Promise<Phase> => {
        const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);

        // Only deliver from active running managed session for this sessionId.
        if (task.state !== "running") {
          // Already delivered / review / terminal / interrupted — ignore duplicate.
          return { kind: "skip" };
        }
        if (task.sessionId && task.sessionId !== sessionId) {
          return { kind: "skip" };
        }

        // TOCTOU revalidation: same TaskInput authority under the publish mutation
        // so a concurrent sendInput cannot slip a blocker past the pre-seal gate.
        // sendInput state+add is also on this MutationBus + lifecycle flight.
        await assertNoBlockingTaskInputsForDeliver(ctx, input.workspaceId, task);

        // Seal-after, publish-before: refuse dirty task worktree so uncommitted
        // agent edits cannot be skipped in favor of stale already-committed SHAs.
        // Fail-loud keeps task running for commit-then-retry (same as public deliver).
        await assertTaskWorktreeCleanForDeliver(mount.workspaceRoot, task, mount.env.fs);
        // Ordinary executor lane history gate (cx-5q6za6): no merge/foreign ancestry.
        await assertOrdinaryExecutorLaneHistoryForDeliver(mount.workspaceRoot, task);

        // Collect pending role-lane commits unless the caller supplied an explicit list
        // (tests only). Production always auto-collects via the authoritative lane contract.
        // Collection runs after seal so tail commits after end_turn cannot appear.
        let commits = input.commits;
        if (commits === undefined) {
          commits = await collectManagedDeliveryCommits(mount.workspaceRoot, task, mount.env.fs);
        }
        // Explicit or auto-collected commits[] must belong to the recorded executor lane.
        await assertDeliverCommitsBelongToExecutorLane(mount.workspaceRoot, task, commits);
        const pendingCommits = uniqueCommitRefs(commits);
        const targetHead =
          pendingCommits.length > 0
            ? await snapshotIntegrationTargetHead(mount.workspaceRoot, task, mount.env.fs)
            : undefined;
        if (targetHead && afterTargetHeadSnapshotForTests) {
          await afterTargetHeadSnapshotForTests(mount.workspaceRoot);
        }

        ctx.host.markSelfWrite(input.workspaceId);

        // agent-decide without an explicit agent decision: request-review (never auto-accept).
        // Downstream Task Agent → parent is always review (elevated policy already refused at dispatch).
        const mode = task.acceptMode;
        const decision =
          mode === "agent-decide" ? ("request-review" as const) : undefined;

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
          sourceNodeId: prepared.sourceNodeId,
          deliveryId: prepared.deliveryId,
          commits: prepared.commits,
          ...(prepared.targetHead ? { targetHead: prepared.targetHead } : {}),
          opts,
        };
        });
      }

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
            sourceNodeId: phase.sourceNodeId,
            deliveryId: phase.deliveryId,
            commits: phase.commits,
            ...(phase.targetHead ? { targetHead: phase.targetHead } : {}),
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
        // Best-effort; pending queue + explicit exact-task reconcile remain.
      }
    }
  } catch (err) {
    // Deliver / integrate / collection / seal / dirty-worktree failure must NOT
    // terminal-fail the task. Pre-delivery failures keep the Task running; an
    // auto-accept integration failure keeps its already-published ready Delivery
    // and delivered Task reviewable. Both remain occupied and emit diagnostics.
    // Only session.failed (launch/process) maps Task → failed. Report draft stays
    // on disk for idempotent retry.
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
      if (
        task.state === "running" ||
        task.state === "waiting" ||
        task.state === "delivered"
      ) {
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
  task: TaskEnvelope,
  fs: import("../core/adapter.js").FsAdapter
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
  const contract = await resolveIntegrationContract(workspaceRoot, task, fs);
  const pending = await listPendingRoleCommits(contract, base);
  return pending.map((commit) => commit.ref);
}

/**
 * Seal the managed turn before publishing Delivery.
 * Stops the process (and cancels pending tool asks) so
 * post-response worktree mutations cannot land after the task enters delivered.
 * Returns true only when the session is positively observed dead and idle.
 * Returns false when stop/probe fails or the process may still be mutable.
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
    await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
  } catch {
    // Approval cleanup is best-effort; runtime death is the seal authority.
  }

  // Intentionally do NOT cancelTaskInputsForSession here — seal must not
  // rewrite open U2A rows that still block ready Delivery.
  const failures: string[] = [];
  try {
    const before = await ctx.runtime.probe(input.sessionId);
    if (!before.alive && !before.turnBusy) return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`pre-stop probe failed: ${message}`);
  }

  // Even when the first probe is unavailable, make the bounded stop attempt.
  // Publication still requires a later positive dead+idle observation.
  try {
    await ctx.runtime.stopSession(input.sessionId, "user");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`stop failed: ${message}`);
  }

  try {
    const after = await ctx.runtime.probe(input.sessionId);
    if (!after.alive && !after.turnBusy) return true;
    failures.push(
      `post-stop probe remained mutable: alive=${String(after.alive)} turnBusy=${String(after.turnBusy)}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`post-stop probe failed: ${message}`);
  }

  const message = failures.join("; ") || "dead and idle state was not proven";
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
  return false;
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
      // After a successful ready Delivery, open rows should already be terminal
      // (gate refused otherwise). Cancel only still-open pending/failed leftovers;
      // delivered / processing / uncertain stay.
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

/** Test-only crash boundary after real accept integration and before finalize. */
let beforeTaskAcceptFinalizeForTests:
  | ((input: { workspaceId: string; taskPath: string; deliveryId: string }) => Promise<void>)
  | null = null;

export function setBeforeTaskAcceptFinalizeForTests(
  fn:
    | ((input: { workspaceId: string; taskPath: string; deliveryId: string }) => Promise<void>)
    | null
): void {
  beforeTaskAcceptFinalizeForTests = fn;
}

/** Test-only crash boundary after reject WAL + deterministic feedback persistence, before restore. */
let afterTaskRejectContinuationPersistForTests:
  | ((input: {
      workspaceId: string;
      taskPath: string;
      deliveryId: string;
      inputId: string;
    }) => Promise<void>)
  | null = null;

export function setAfterTaskRejectContinuationPersistForTests(
  fn:
    | ((input: {
        workspaceId: string;
        taskPath: string;
        deliveryId: string;
        inputId: string;
      }) => Promise<void>)
    | null
): void {
  afterTaskRejectContinuationPersistForTests = fn;
}

/** Test-only race boundary after provider start and before final exact-Task bind. */
let afterManagedSessionProviderStartForTests:
  | ((input: {
      operation: "task.startSession" | "task.replaceSession";
      workspaceId: string;
      taskPath: string;
      sessionId: string;
    }) => Promise<void>)
  | null = null;

export function setAfterManagedSessionProviderStartForTests(
  fn:
    | ((input: {
        operation: "task.startSession" | "task.replaceSession";
        workspaceId: string;
        taskPath: string;
        sessionId: string;
      }) => Promise<void>)
    | null
): void {
  afterManagedSessionProviderStartForTests = fn;
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

/** Test-only: fail between TaskInput rebind failure and exact Task rollback. */
let beforeReplaceTaskInputRollbackForTests:
  | ((input: {
      workspaceId: string;
      taskPath: string;
      priorSessionId: string;
      replacementSessionId: string;
    }) => Promise<void>)
  | null = null;

export function setBeforeReplaceTaskInputRollbackForTests(
  fn:
    | ((input: {
        workspaceId: string;
        taskPath: string;
        priorSessionId: string;
        replacementSessionId: string;
      }) => Promise<void>)
    | null
): void {
  beforeReplaceTaskInputRollbackForTests = fn;
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
  afterTaskRejectContinuationPersistForTests = null;
  afterManagedSessionProviderStartForTests = null;
  beforeTaskClaimCoreForTests = null;
  beforeReplaceTaskInputRollbackForTests = null;
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
  item: TaskInputRecord
): Promise<ManagedTaskInputDelivery> {
  return deliverManagedTaskInput(ctx, item);
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
 * Used when registry/Connection identity is missing or independent new-session start fails.
 */
export const REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY =
  "驳回续跑未能恢复原 managed Session。可显式 replaceSession，或 interrupt 任务；occupation 保持。";

/** Honest diagnostic for an exact external Role Session that could not resume. */
export const EXTERNAL_ROLE_REJECT_RESUME_FAILED_WAIT_SUMMARY =
  "驳回续跑未能恢复原 external Role Session。请恢复同一 Session 后 claim，或 interrupt 任务；occupation 保持。";

/** Restore provenance for reject-resume managed session recovery. */
export type RejectResumeRestoreReason =
  | "task.reject.resume.alive"
  | "task.reject.resume.native";

type RejectResumeRestoredSession = {
  sessionId: string;
  connectionId: string;
  adapterId: string;
  state: string;
  cwd?: string;
  /**
   * Reject-resume always preserves the provider conversation.
   */
  contextRestored: boolean;
  /** Why the exact Session was usable (alive or native resume). */
  restoreReason: RejectResumeRestoreReason;
};

/**
 * After core reject(resume) for a managed task:
 * - alive → rebind the exact Tent Session id
 * - stopped + resumeCapable → native runtime.resumeSession on that exact id
 * - missing/corrupt/native failure → park for explicit task.replaceSession
 * Review feedback is injected once only after provider continuity is restored.
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
  const prior = await ctx.runtime.registry.read(priorSessionId);
  if (!prior) {
    throw new Error(
      `Managed session registry row missing for ${priorSessionId}; cannot restore after reject-resume`
    );
  }
  const priorTaskRef = prior.lastTaskId?.trim() || "";
  if (!priorTaskRef || priorTaskRef !== task.id) {
    throw new Error(
      `Managed Session ${priorSessionId} is not bound to the exact rejected Task ` +
        `(session.lastTaskId=${priorTaskRef || "(missing)"}, taskId=${task.id})`
    );
  }

  const connectionId = prior.connectionId?.trim();
  const adapterId = prior.adapterId?.trim();
  if (!connectionId || !adapterId) {
    throw new Error(
      `Managed session ${priorSessionId} has no Agent Connection binding for reject-resume restore`
    );
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
          connectionId,
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
          connectionId,
          adapterId,
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

  if (!probe?.resumeCapable) {
    throw new Error(
      `Managed Session ${priorSessionId} cannot restore its provider conversation; use task.replaceSession explicitly`
    );
  }

  rejectResumeNativeInFlight.add(priorSessionId);
  try {
    const handle = await ctx.runtime.resumeSession({
      sessionId: priorSessionId,
      runtimeWorkspace: { cwd },
      cwd,
      bootstrapPrompt: emptyBootstrap,
      lastTaskId: task.id!,
    });
    if (handle.sessionId !== priorSessionId) {
      throw new Error(
        `Native resume changed Session identity; expected ${priorSessionId}, got ${handle.sessionId}`
      );
    }
    if (!handle.connectionId || !handle.adapterId) {
      throw new Error(`Native resume returned an unbound managed Session: ${priorSessionId}`);
    }
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
          connectionId: handle.connectionId,
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
        connectionId: handle.connectionId,
        adapterId: handle.adapterId,
        state: handle.state,
        cwd,
        contextRestored: true,
        restoreReason: "task.reject.resume.native",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Native resume failed for ${priorSessionId}: ${message}`);
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
    summaryPrefix?: string;
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

      const summary = `${input.summaryPrefix ?? REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY} (${input.message})`;
      let next = current;
      if (current.state === "running") {
        next = await taskWait(mount.env, input.taskPath, {
          reason: "external",
          summary,
          code: SESSION_UNAVAILABLE_WAIT_CODE,
        });
      } else {
        next = await patchTaskEnvelope(mount.env.fs, input.taskPath, {
          state: "waiting",
          wait: { reason: "external", summary, code: SESSION_UNAVAILABLE_WAIT_CODE },
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

export async function invokeManagedAutoDeliverRetryFromDraftForTests(
  ctx: HandlerContext,
  input: { workspaceId: string; taskPath: string; sessionId: string }
): Promise<void> {
  return requestManagedAutoDeliverRetryFromDraft(ctx, input);
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
      roleId: task.roleId,
      workNodeIds: [...task.workNodeIds],
      contextNodeIds: [...task.contextNodeIds],
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

function assertAllowedParams(
  params: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  surface: string
): void {
  const unknown = Object.keys(params).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new RpcError(
      -32602,
      `${surface} received unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    );
  }
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

function parseAcceptMode(raw: string | undefined): AcceptMode | undefined {
  if (!raw) return undefined;
  if (raw === "review-required" || raw === "auto-accept" || raw === "agent-decide") {
    return raw;
  }
  throw new RpcError(-32602, `Invalid acceptMode: ${raw}`);
}

function parseCallerKind(raw: string): "user" | "role" {
  if (raw === "user" || raw === "role") return raw;
  throw new RpcError(-32602, `Invalid callerKind: ${raw}`);
}

function resolveNode(tent: LoadedTent, p: Record<string, unknown>) {
  return requireCanonicalNode(tent, requireString(p, "nodeId"));
}

function requireCanonicalNode(tent: LoadedTent, nodeId: string) {
  if (!isNodeId(nodeId)) {
    throw new RpcError(-32602, `nodeId must be a canonical cx-* Node id: ${nodeId}`);
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new RpcError(-32004, `Node not found: ${nodeId}`);
  return node;
}

function projectNode(
  node: import("../core/types.js").Node,
  includeBody: boolean,
  withChildren: boolean
): NodeProjection {
  const title = typeof node.fm.title === "string" ? node.fm.title : undefined;
  const proj: NodeProjection = {
    nodeId: node.id,
    path: node.path,
    name: node.name,
    type: node.type,
    tags: node.tags,
    mode: node.mode,
    archived: node.archived,
    invalid: node.invalid,
  };
  if (title) (proj as NodeProjection & { title?: string }).title = title;
  if (includeBody) {
    proj.bodyPreview = node.body.slice(0, 500);
  }
  if (withChildren) {
    proj.children = node.children.map((child) => projectNode(child, includeBody, true));
  }
  return proj;
}

function parseArtifactRefs(data: Record<string, unknown>): ArtifactRef[] {
  const raw = data.artifactRefs;
  if (!Array.isArray(raw)) return [];
  return normalizeArtifactRefs(raw);
}

/**
 * P0-2: integrate delivery commits into the real workspace Git main/target branch.
 * Reuses core ensureRoleWorkspace + integrateWorkspaceCommits (idempotent).
 * Failures propagate so accept/auto-accept cannot mark accepted or release occupation.
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
    const mount = requireMountByWorkspaceRoot(ctx, workspaceRoot);
    const lockContract = await resolveIntegrationContract(workspaceRoot, lockTask, mount.env.fs);

    await runIntegrationTargetFlight(workspaceRoot, lockContract.targetBranch, async () => {
      // Write boundary: re-read Task/lane; never trust caller branch/target or stale envelope.
      const liveTask = await loadTaskEnvelopeForIntegration(
        ctx,
        workspaceRoot,
        taskPath,
        lockTask
      );
      const contract = await resolveIntegrationContract(workspaceRoot, liveTask, mount.env.fs);
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

      const recovered = await assertIntegrationTargetHeadUnchanged(
        workspaceRoot,
        liveTask,
        refs,
        expected,
        mount.env.fs,
        { action: options.action }
      );
      if (recovered) return;

      if (ctx.integrateCommits) {
        await ctx.integrateCommits(
          workspaceRoot,
          refs,
          liveTask.roleId ?? liveTask.sessionId ?? "unknown-executor"
        );
        return;
      }
      // Re-resolve contract immediately before Git write (lane facts at boundary).
      const writeContract = await resolveIntegrationContract(workspaceRoot, liveTask, mount.env.fs);
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
  task: TaskEnvelope,
  fs: import("../core/adapter.js").FsAdapter
): Promise<string> {
  const contract = await resolveIntegrationContract(workspaceRoot, task, fs);
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
  commits: string[],
  expectedTargetHead: string | undefined,
  fs: import("../core/adapter.js").FsAdapter,
  meta: { action: "task.accept" | "task.deliver" }
): Promise<boolean> {
  const contract = await resolveIntegrationContract(workspaceRoot, task, fs);
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
    const recovered = await findExactCompletedIntegrationAtTip(contract, commits, expected);
    if (recovered?.targetHead === current) return true;
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
  return false;
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
 * Session-only tasks re-validate against ensureTaskWorkspace(taskId) (tent-task/<id>).
 * Sub tasks keep envelope targetBranch (dispatcher role branch) as first-class —
 * do not overwrite with peer mainline from ensure*Workspace.
 */
async function resolveIntegrationContract(
  workspaceRoot: string,
  task: TaskEnvelope,
  fs: import("../core/adapter.js").FsAdapter
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

  const isTaskScoped = !task.roleId;
  const registry = await loadRolesRegistry(fs);
  let dispatcherLane: RoleWorkspaceContract | undefined;
  if (taskAsSub(task)) {
    const dispatcher = taskParentRoleId(task);
    const label = isTaskScoped ? `task ${task.id || task.path}` : `Role ${task.roleId}`;
    if (!dispatcher) {
      throw new Error(
        `Sub task envelope missing durable parent Role for ${label}; cannot resolve targetBranch`
      );
    }
    const dispatcherRole = registry.roles.find((role) => role.id === dispatcher);
    if (!dispatcherRole) throw new Error(`Parent Role not found in registry: ${dispatcher}`);
    dispatcherLane = await ensureRoleWorkspace(mountedRoot, dispatcherRole.name);
    if (task.targetBranch && task.targetBranch !== dispatcherLane.branch) {
      throw new Error(
        `Task envelope targetBranch mismatch for ${label}: envelope=${task.targetBranch} expected=${dispatcherLane.branch}`
      );
    }
  }

  const executorRole = task.roleId
    ? registry.roles.find((role) => role.id === task.roleId)
    : undefined;
  if (task.roleId && !executorRole) {
    throw new Error(`Role not found in registry: ${task.roleId}`);
  }
  const real = isTaskScoped
    ? await ensureTaskWorkspace(mountedRoot, task.id || task.path, {
        ...(dispatcherLane ? { targetBranch: dispatcherLane.branch } : {}),
      })
    : await ensureRoleWorkspace(mountedRoot, executorRole!.name);

  const label = isTaskScoped ? `task ${task.id || task.path}` : `Role ${task.roleId}`;
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
 * - Role / asSub: lane + baseCommit are captured by their canonical creation/claim path;
 *   this function never repairs a completed lane with missing provenance.
 * - Session-only Task: first create tent-task/<taskId> here (never a Role lane).
 * Persists exact workspaceLane.baseCommit at first bind (capture-once).
 * Also backfills roleBranchBase for managed collection once when missing.
 * integrationAuthority: only the on-disk bag counts as recorded truth; absence
 * triggers explicit persist of parent/reviewer + service mutator.
 * Non-Git / pure docs → no fake Git fields (cwd falls back to workspace root);
 * authority remains a derived projection from parent/reviewer, not a Connection permission.
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

    const isTaskScoped = !current.roleId;
    let taskTargetBranch: string | undefined;
    const registry = await loadRolesRegistry(mount.env.fs);
    if (isTaskScoped && taskAsSub(current)) {
      const dispatcher = taskParentRoleId(current);
      if (!dispatcher) {
        throw new Error(
          `Sub task ${current.id || current.path} is missing a durable parent Role.`
        );
      }
      const dispatcherRole = registry.roles.find((role) => role.id === dispatcher);
      if (!dispatcherRole) throw new Error(`Parent Role not found in registry: ${dispatcher}`);
      const dispatcherLane = await ensureRoleWorkspace(
        mount.workspaceRoot,
        dispatcherRole.name
      );
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
        : isTaskScoped
          ? await ensureTaskWorkspaceIfGit(
              mount.workspaceRoot,
              current.id || current.path,
              { ...(taskTargetBranch ? { targetBranch: taskTargetBranch } : {}) }
            )
          : await ensureRoleWorkspaceIfGit(
              mount.workspaceRoot,
              await requireRoleNameById(mount.env.fs, current.roleId!)
            );
    if (!lane) return current;

    // Sub tasks keep dispatcher tent-role/* as targetBranch; never rewrite to mainline
    // when backfilling an incomplete lane (Connection execution still defers lane creation).
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
    // (e.g. Connection execution at startSession). Never rewrite an existing base.
    // A complete lane missing baseCommit is invalid in the fresh registry; never
    // infer it from tip/roleBranchBase/cwd.
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
 * Active external Session for a durable Role. Managed ACP Sessions carry no Role id.
 */
async function findActiveExternalSessionForRole(
  ctx: HandlerContext,
  workspaceId: string,
  roleId: string
): Promise<SessionRecord | undefined> {
  if (!roleId) return undefined;
  const all = await ctx.runtime.registry.list();
  return all.find(
    (rec) =>
      rec.workspace === workspaceId &&
      rec.roleId === roleId &&
      rec.state === "external"
  );
}

function projectStartSessionResult(
  workspaceId: string,
  taskPath: string,
  task: TaskEnvelope,
  session: Pick<
    SessionRecord,
    "id" | "connectionId" | "adapterId" | "state" | "roleId" | "runtimeWorkspace"
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
      connectionId: session.connectionId,
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
 * Frozen order via assembleManagedPrompt — stable prefix once per
 * contextGeneration; later Tasks on the same Session append delta only.
 * Skill/role bodies compose fill tent-role / Role / tent-task slots.
 * Never copies Node/manifest bodies. Never instructs tent task claim/get/deliver.
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
    /** Live generation computed from the actual immutable Connection snapshot. */
    currentContextGeneration: string;
    taskInputDelta?: string;
    checkpoint?: string;
  },
  roleFs?: import("../core/adapter.js").FsAdapter
): Promise<string> {
  const systemRoot = roots.systemRoot || systemRootFromWorkspace(roots.workspaceRoot);
  // Load Role definition for durable Role tasks (prompt only).
  // temporary Session: tent-task only, no Role prompt.
  let roleDef: RoleDefinition | undefined;
  if (task.roleId && roleFs) {
    try {
      const registry = await loadRolesRegistry(roleFs);
      roleDef = registry.roles.find((role) => role.id === task.roleId);
    } catch {
      roleDef = undefined;
    }
  }

  // Stable block first (byte-identical across Tasks that share Role + skill bodies).
  const skillPrefix = composeManagedSkillBootstrapPrefix({
    packageRoot: ctx.packageRoot,
    roleId: task.roleId,
    role: roleDef,
  });

  const base = buildContextCardManagedBootstrap(task, task.contextCard, {
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
    sessionContextGeneration: roots.sessionContextGeneration,
    currentContextGeneration: roots.currentContextGeneration,
    tentTaskSection: skillPrefix,
    taskInputDelta: roots.taskInputDelta,
    // Explicit caller checkpoint only (digest slot). On-disk Role Checkpoint is
    // appended after full assembly as dynamic tail — never stable prefix.
    checkpoint: roots.checkpoint,
  });

  // Optional Role Checkpoint: last dynamic tail only. Missing/corrupt fail-open.
  // Temporary Sessions never inject Role continuation notes.
  return appendRoleCheckpointTail(base, roleDef?.name, roleFs);
}

/**
 * Append formatted Role Checkpoint after stable Context Card / skill bootstrap.
 * Fail-open on missing note, path errors, or corrupt files.
 */
async function appendRoleCheckpointTail(
  base: string,
  roleName: string | undefined,
  roleFs?: import("../core/adapter.js").FsAdapter
): Promise<string> {
  if (!roleName?.trim() || !roleFs) return base;
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
 * Context Card v2 managed bootstrap (stable prefix + dynamic delta).
 * Skill bodies and Role prompt come from managed compose when provided as tentTaskSection.
 */
function buildContextCardManagedBootstrap(
  task: TaskEnvelope,
  contextCard: TaskContextCard,
  roots: {
    workspaceRoot: string;
    systemRoot: string;
    sessionContextGeneration?: string | null;
    currentContextGeneration: string;
    tentRoleSection?: string;
    rolePromptSection?: string;
    tentTaskSection?: string;
    taskInputDelta?: string;
    checkpoint?: string;
  }
): string {
  const includeStablePrefix = shouldInjectStablePrefix({
    sessionContextGeneration: roots.sessionContextGeneration,
    currentContextGeneration: roots.currentContextGeneration,
  });
  // Structured reason available for audit (no prompt-memory inference).
  void decideStablePrefixInjection({
    sessionContextGeneration: roots.sessionContextGeneration,
    currentContextGeneration: roots.currentContextGeneration,
  });

  const executionLane = projectExecutionLaneFromTask(task);
  const executionLaneText = formatExecutionLanePrompt(executionLane);
  const bootstrapNodeIds =
    taskReferencedNodeIds(task);
  const pointers = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`,
    ...(task.id ? [`Task id: ${task.id}`] : []),
    ...(bootstrapNodeIds.length ? [`nodes: ${bootstrapNodeIds.join(", ")}`] : []),
    `acceptMode: ${task.acceptMode}`,
    ...(task.parentActor
      ? [`parentActor: ${task.parentActor.kind}:${task.parentActor.id}`]
      : []),
    ...(task.reviewer
      ? [`reviewer: ${task.reviewer.kind}:${task.reviewer.id}`]
      : []),
    ...(task.roleId ? [`roleId: ${task.roleId}`] : []),
    ...(task.sessionId ? [`sessionId: ${task.sessionId}`] : []),
    `Service status: this task is already claimed (state=${task.state || "running"}).`,
    "Managed path: Local Service already claimed this task; final assistant reply is the report and will be delivered automatically.",
    ...(executionLaneText ? [executionLaneText] : []),
  ].join("\n");

  const assembly = assembleManagedPrompt({
    workspaceRoot: roots.workspaceRoot,
    systemRoot: roots.systemRoot,
    agentsPointer: "AGENTS.md at workspace root (authoritative workspace agents file)",
    tentRoleSection: roots.tentRoleSection,
    rolePromptSection: roots.rolePromptSection,
    tentTaskSection: roots.tentTaskSection,
    contextCard,
    contextGeneration: roots.currentContextGeneration,
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
    `--- Tent managed session delta (contextGeneration=${roots.currentContextGeneration}) ---\n` +
    `${assembly.text}`
  );
}

/**
 * Collect local image path refs from the Task prompt + frozen Node snapshots.
 * Explicit sources only — no workspace scan and no live Node body re-read.
 * Returns paths only (never base64).
 */
async function collectTaskBootstrapImageRefs(task: TaskEnvelope): Promise<BootstrapImageRef[]> {
  const userPrompt = extractTaskUserPrompt(task);
  const claimBodies = task.nodeSnapshots.map((snapshot) => ({
    body: snapshot.body,
    notePath: nodeNotePath(snapshot.path),
  }));
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
    roleId: task.roleId,
    workNodeIds: [...task.workNodeIds],
    contextNodeIds: [...task.contextNodeIds],
    state: task.state,
    manifest: task.manifest,
    parentActor: task.parentActor,
    reviewer: task.reviewer,
    // Missing asSub on disk reads as false (peer Git lane).
    asSub: taskAsSub(task),
    acceptMode: task.acceptMode,
    sessionId: task.sessionId,
    wait: task.wait,
    activeDeliveryId: task.activeDeliveryId,
    lastOutcome: task.lastOutcome,
    workspaceLane: lane,
    // Compact first-claim baseCommit capture audit.
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
    contextCard: task.contextCard,
    ...(task.contextGeneration ? { contextGeneration: task.contextGeneration } : {}),
    ...(task.taskDeltaDigest ? { taskDeltaDigest: task.taskDeltaDigest } : {}),
  };
  return proj;
}

function projectDelivery(d: import("../core/delivery.js").DeliveryRecord): DeliveryProjection {
  return {
    path: d.path,
    id: d.id,
    taskId: d.taskId,
    sourceNodeId: d.sourceNodeId,
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
  node: import("../core/types.js").Node,
  op: string
): void {
  if (isContentMutable(node)) return;
  if (node.invalid) {
    throw new RpcError(-32010, `${op} rejected: node is invalid`, {
      nodeId: node.id,
      mode: node.mode,
    });
  }
  if (node.mode === "archived" || node.archived) {
    throw new RpcError(-32010, `${op} rejected: node is archived`, {
      nodeId: node.id,
      mode: node.mode,
    });
  }
  throw new RpcError(-32010, `${op} rejected: node is not mutable`, {
    nodeId: node.id,
    mode: node.mode,
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
