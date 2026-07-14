// Service command/query handlers — sole client mutation entry into core + runtime.

import { boxNotePath, loadTent, type LoadedTent } from "../core/tree.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import {
  createBox,
  dispatch,
  patchBody,
  patchBox,
} from "../core/ops.js";
import { promoteConcept } from "../core/concept.js";
import { forkNode } from "../core/forkOps.js";
import {
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  sessionBootstrapPromptForTask,
  type RoleWorkspaceContract,
  type TaskEnvelope,
} from "../core/task.js";
import { taskContextCard } from "../core/context-card.js";
import { systemRootFromWorkspace } from "../core/paths.js";
import { loadDeliveries } from "../core/delivery.js";
import { loadTypeRegistry } from "../core/typeRegistry.js";
import { loadRolesRegistry, roleA2APolicy } from "../core/skillRoleRegistry.js";
import {
  taskAccept,
  taskCancel,
  taskClaim,
  taskDeliver,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
} from "../core/task-lifecycle.js";
import {
  TaskLifecycleError,
  type A2APolicy,
  type DeliverDecision,
  type DeliveryPolicy,
  type WaitReason,
  evaluateA2A,
} from "../core/task-model.js";
import {
  ensureRoleWorkspace,
  ensureRoleWorkspaceIfGit,
  integrateWorkspaceCommits,
  isSameWorkspaceRoot,
} from "../core/workspace.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { makeSessionId } from "../runtime/types.js";
import type { RuntimeEvent, SessionRecord } from "../runtime/types.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import * as nodePath from "node:path";
import { buildBacklinkIndex } from "../markdown/links.js";
import { contentEtag } from "./etag.js";
import type { EventBus } from "./events.js";
import type { MutationBus } from "./mutation-bus.js";
import type { WorkspaceHost } from "./workspace-host.js";
import type { A2AApprovalStore } from "./a2a-store.js";
import { makeApprovalId } from "./a2a-store.js";
import {
  isClientMethod,
  PROTECTED_COLLAB_FIELDS,
  RPC_A2A_ASK,
  RPC_A2A_DENIED,
  RPC_LIFECYCLE,
  type ArtifactRef,
  type ConceptProjection,
  type DeliveryProjection,
  type RoleRegistryEntryProjection,
  type SessionProjection,
  type TaskProjection,
  type TypeRegistryEntryProjection,
} from "./types.js";
import { loadAgentProfiles, projectAgentProfiles } from "./profiles.js";

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
  dataDir: string;
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

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
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
      case "docs.search":
        return docsSearch(ctx, p);
      case "docs.backlinks":
        return docsBacklinks(ctx, p);
      case "registry.types":
        return registryTypes(ctx, p);
      case "registry.roles":
        return registryRoles(ctx, p);
      case "profile.list":
        return profileList(ctx, p);
      case "task.dispatch":
        return taskDispatch(ctx, p);
      case "task.claim":
        return taskClaimRpc(ctx, p);
      case "task.wait":
        return taskWaitRpc(ctx, p);
      case "task.resume":
        return taskResumeRpc(ctx, p);
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
      case "session.list":
        return sessionList(ctx, p);
      case "session.get":
        return sessionGet(ctx, p);
      case "a2a.listPending":
        return a2aListPending(ctx, p);
      case "a2a.resolve":
        return a2aResolve(ctx, p);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
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
  return info;
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
    const notePath = boxNotePath(concept.path);
    const diskRaw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(diskRaw);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: concept.path,
      });
    }

    if (rawInput !== undefined) {
      const diskParsed = parseFrontmatter(diskRaw);
      const nextParsed = parseFrontmatter(rawInput);
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
    } else {
      if (frontmatter) {
        assertDocsWriteAllowed(tent, concept.id, frontmatter, await loadTaskEnvelopes(mount.env.fs));
      }

      ctx.host.markSelfWrite(workspaceId);
      if (frontmatter && Object.keys(frontmatter).length > 0) {
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
    const after = parseFrontmatter(afterRaw);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.write" },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      cx: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
      body: after.body,
      raw: afterRaw,
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
    .map((role) => ({
      name: role.name,
      description: role.description,
      color: role.color,
      prompt: role.prompt,
      a2aPolicy: roleA2APolicy(role),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, roles };
}

/**
 * Machine-local AgentProfile catalog for desktop launch picker.
 * Safe metadata only — no keys, tokens, env values, or executable secrets.
 * Optional includeTest: when true, also return fake/harness profiles (tests/dev).
 * Default product list hides testOnly profiles so fake is not a product default.
 */
async function profileList(ctx: HandlerContext, p: Record<string, unknown>) {
  const includeTest = p.includeTest === true;
  // Runtime holds the live catalog (service start + test injects); disk is fallback.
  const fromRuntime = ctx.runtime.listProfiles();
  const source =
    fromRuntime.length > 0 ? fromRuntime : await loadAgentProfiles(ctx.dataDir);
  let profiles = projectAgentProfiles(source);
  if (!includeTest) {
    profiles = profiles.filter((pr) => !pr.testOnly);
  }
  return { profiles };
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

// ---- task.* ----

async function taskDispatch(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId") ?? optionalString(p, "id") ?? requireString(p, "claimId");
  const role = requireString(p, "role");
  const prompt = requireString(p, "prompt");
  const dispatchedBy = optionalString(p, "dispatchedBy");
  const deliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const profileId = optionalString(p, "profileId");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  // Trusted override only (harness / internal). Ordinary a2aPolicy param is ignored.
  const a2aPolicyOverride = parseOptionalA2APolicy(optionalString(p, "a2aPolicyOverride"));

  if (startSession && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with startSession requires explicit profileId (no fake-default fallback)"
    );
  }

  // P0-1: role worktree create/reuse + envelope dispatch share the workspace MutationBus
  // critical section so concurrent role worktree add cannot race. Git ops stay inside the
  // bus action (never nested mutations.run).
  const result = await ctx.mutations.run(workspaceId, async () => {
    const roleLane = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, role);
    ctx.host.markSelfWrite(workspaceId);
    const dispatched = await dispatch(mount.env, boxId, role, {
      userPrompt: prompt,
      dispatchedBy,
      deliveryPolicy,
      workspace: roleLane,
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched.taskPath,
        state: "queued",
        role,
        boxId,
        reason: "task.dispatch",
      },
      "self"
    );
    return { dispatched, roleLane };
  });
  const roleLane = result.roleLane;
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
      ...(a2aPolicyOverride !== undefined ? { a2aPolicyOverride } : {}),
    });
  }

  const taskAfter = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath).catch(() => null);
  return {
    workspaceId,
    taskPath: dispatched.taskPath,
    manifestPath: dispatched.manifestPath,
    initPath: dispatched.initPath,
    relayPrompt: dispatched.relayPrompt,
    state: startSession ? "running" : "queued",
    session,
    workspaceLane: taskAfter ? projectTask(taskAfter).workspaceLane : roleLane
      ? {
          workspace: roleLane.workspace,
          worktree: roleLane.worktree,
          branch: roleLane.branch,
          targetBranch: roleLane.targetBranch,
        }
      : undefined,
  };
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

async function taskRejectRpc(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actor = requireString(p, "actor");
  const note = optionalString(p, "note");
  const resume = p.resume !== false;

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await taskReject(mount.env, taskPath, { actor, note, resume });
    emitTaskState(ctx, workspaceId, result.task, "task.reject");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.reject",
      },
      "self"
    );
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state,
    };
  });
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
    if (sessionId) {
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
  // Trusted internal override only (a2a.resolve re-entry, explicit harness).
  // Client-supplied a2aPolicy is NOT trusted for role callers — load from role registry.
  const trustedOverride = parseOptionalA2APolicy(optionalString(p, "a2aPolicyOverride"));
  const bootstrapPrompt = optionalString(p, "bootstrapPrompt");
  const approvalId = optionalString(p, "approvalId");

  // Resolve prior ask approval
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
  } else {
    const taskForPolicy = await loadTaskEnvelope(mount.env.fs, taskPath);
    const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
      callerKind,
      taskRole: taskForPolicy.role,
      trustedOverride,
    });
    const decision = evaluateA2A({
      callerKind,
      policy: a2aPolicy,
      profileAllowed: true,
    });
    if (decision === "deny") {
      throw new RpcError(RPC_A2A_DENIED, "A2A policy denies starting a new runtime session", {
        policy: a2aPolicy,
        callerKind,
        role: taskForPolicy.role,
      });
    }
    if (decision === "ask") {
      const task = taskForPolicy;
      const item = await ctx.a2a.add({
        id: makeApprovalId(),
        workspaceId,
        taskPath,
        taskId: task.id,
        role: task.role,
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
          role: task.role,
          profileId,
          summary: `Role ${task.role} requests startSession on profile ${profileId}`,
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

  // Resume from waiting(a2a-approval) after resolve
  if (task.state === "waiting" && task.wait?.reason === "a2a-approval") {
    await taskResumeRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }

  // P0-1: managed ACP cwd must be role worktree when Git lane exists.
  // Backfill lane on pre-P0 envelopes; pure docs / non-Git stay at workspace root.
  task = await ensureTaskWorkspaceLane(ctx, workspaceId, task);

  // Same role: only one managed ACP session in starting/live/waiting-user.
  // Tasks may be many; external role sessions are not service-registry managed.
  // Idempotent: same task already bound to its active session returns that handle.
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

  const sessionId = makeSessionId();
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

  let handle;
  try {
    handle = await ctx.runtime.startSession({
      sessionId,
      profileId,
      roleName: task.role,
      workspaceLane,
      runtimeWorkspace: { cwd },
      cwd,
      bootstrapPrompt: sessionBootstrap,
      lastTaskId: task.id || taskPath,
      workspace: workspaceId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only true session launch/process failure maps task → failed.
    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const failed = await patchTaskEnvelope(mount.env.fs, taskPath, {
        state: "failed",
        wait: null,
        updatedAt: mount.env.clock.now(),
      });
      emitTaskState(ctx, workspaceId, failed, "session.failed");
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
        reason: "task.startSession",
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
      alive: probe.alive,
      resumeCapable: probe.resumeCapable,
      lastTaskId: rec.lastTaskId,
      workspace: rec.workspace,
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
    alive: probe.alive,
    resumeCapable: probe.resumeCapable,
    lastTaskId: rec.lastTaskId,
    workspace: rec.workspace,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  return { session: projection };
}

async function a2aListPending(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.a2a.listPending(workspaceId);
  return { approvals: pending };
}

async function a2aResolve(ctx: HandlerContext, p: Record<string, unknown>) {
  const approvalId = requireString(p, "approvalId");
  const decisionRaw = requireString(p, "decision");
  const actor = optionalString(p, "actor") ?? "user";
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

// ---- runtime event bridge (called from service bootstrap) ----

/**
 * Dedup keys for managed auto-delivery: one successful prompt_complete per
 * sessionId+taskPath must not create two deliveries (reconnect / double emit).
 * Authority remains task lifecycle (ready delivery / non-running state also blocks).
 */
const managedAutoDeliverInFlight = new Set<string>();
const managedAutoDeliverDone = new Set<string>();

function managedDeliverKey(sessionId: string, taskPath: string): string {
  return `${sessionId}::${taskPath}`;
}

export function mapRuntimeEventToService(
  ctx: HandlerContext,
  ev: RuntimeEvent
): void {
  // Find workspace from session registry (async-safe best effort via fire-and-forget).
  void (async () => {
    try {
      const rec = await ctx.runtime.registry.read(ev.sessionId);
      const workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
      if (ev.type === "session.stdout_tail") {
        // Diagnostics only — never product chat; optional quiet emit.
        return;
      }
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

      // Map waiting_user / failed / prompt_complete onto bound task when lastTaskId known.
      if (!rec?.lastTaskId) return;
      const mountInfos = ctx.host.list();
      for (const info of mountInfos) {
        if (rec.workspace && info.workspaceId !== rec.workspace) continue;
        const mount = ctx.host.get(info.workspaceId);
        if (!mount) continue;
        const tasks = await loadTaskEnvelopes(mount.env.fs);
        const task = tasks.find(
          (t) => t.sessionId === ev.sessionId || t.id === rec.lastTaskId
        );
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
          ev.type === "session.failed" &&
          (task.state === "running" || task.state === "waiting")
        ) {
          await ctx.mutations.run(mount.workspaceId, async () => {
            ctx.host.markSelfWrite(mount.workspaceId);
            const failed = await patchTaskEnvelope(mount.env.fs, task.path, {
              state: "failed",
              wait: null,
              updatedAt: mount.env.clock.now(),
            });
            emitTaskState(ctx, mount.workspaceId, failed, "session.failed");
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
    } catch {
      // mapping must not crash the runtime
    }
  })();
}

/**
 * Managed ACP path: capture final assistant response → same task.deliver lifecycle.
 * - summary/report = assistant final reply
 * - never auto-accept; manual → pending review; bypass/agent-decide use existing policy
 * - empty/error already filtered by adapter; still refuse empty here
 * - duplicate completion / already-delivered / terminal → ignore (no second delivery)
 */
async function tryManagedAutoDeliver(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId: string;
    assistantText: string;
    /**
     * Explicit commits only. Production managed ACP never auto-guesses/collects
     * worktree commits; tests may pass commits to exercise integrate failure.
     */
    commits?: string[];
  }
): Promise<void> {
  const summary = input.assistantText.trim();
  if (!summary) {
    // Adapter should have failed already; do not invent a delivery.
    return;
  }

  const key = managedDeliverKey(input.sessionId, input.taskPath);
  if (managedAutoDeliverDone.has(key) || managedAutoDeliverInFlight.has(key)) {
    return;
  }
  managedAutoDeliverInFlight.add(key);

  try {
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;

    // Re-load authority state under mutation bus.
    await ctx.mutations.run(input.workspaceId, async () => {
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);

      // Only deliver from active running managed session for this sessionId.
      if (task.state !== "running") {
        // Already delivered / review / terminal / interrupted — ignore duplicate.
        return;
      }
      if (task.sessionId && task.sessionId !== input.sessionId) {
        return;
      }

      // Ready delivery already present → lifecycle forbids double ready.
      const existing = await loadDeliveries(mount.env.fs, {
        taskId: task.id || input.taskPath,
      });
      if (existing.some((d) => d.status === "ready")) {
        managedAutoDeliverDone.add(key);
        return;
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
        // Never invent commits here — only forward an explicit list when provided.
        ...(input.commits && input.commits.length > 0 ? { commits: input.commits } : {}),
      });

      managedAutoDeliverDone.add(key);
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
  } catch (err) {
    // Deliver / integrate failure must NOT terminal-fail the task.
    // Keep running/occupation so the user can retry; expose via session diagnostics/event.
    // Only session.failed (launch/process) maps task → failed.
    const message = err instanceof Error ? err.message : String(err);
    try {
      const mount = ctx.host.get(input.workspaceId);
      if (!mount) return;
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (task.state === "running" || task.state === "waiting") {
        // Clear in-flight so a later prompt_complete / retry can attempt again.
        // Do not add to managedAutoDeliverDone — failure is not success.
        try {
          await ctx.runtime.registry.update(input.sessionId, {
            lastError: `managed auto-deliver failed: ${message}`,
          });
        } catch {
          // Session row may be gone; still emit diagnostics.
        }
        ctx.events.emit(
          "session.state",
          input.workspaceId,
          {
            sessionId: input.sessionId,
            taskPath: input.taskPath,
            taskState: task.state,
            runtimeEvent: "session.prompt_complete.failed",
            error: message,
            // Explicit: task remains non-terminal for retry.
            taskFailed: false,
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

/** Test helper: clear in-process managed deliver dedup (does not touch disk). */
export function resetManagedAutoDeliverDedupForTests(): void {
  managedAutoDeliverInFlight.clear();
  managedAutoDeliverDone.clear();
}

/**
 * Test helper: invoke managed auto-deliver with optional explicit commits.
 * Production session.prompt_complete never auto-collects worktree commits.
 */
export async function invokeManagedAutoDeliverForTests(
  ctx: HandlerContext,
  input: {
    workspaceId: string;
    taskPath: string;
    sessionId: string;
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
 * - role caller → load role.a2aPolicy from registry (default deny)
 * - trustedOverride → only when service-internal / harness passes a2aPolicyOverride
 * Ordinary client `a2aPolicy` params are not applied here.
 */
async function resolveStartSessionA2APolicy(
  fs: import("../core/adapter.js").FsAdapter,
  input: {
    callerKind: "user" | "role";
    taskRole: string;
    trustedOverride?: A2APolicy;
  }
): Promise<A2APolicy> {
  if (input.callerKind === "user") return "allow";
  if (input.trustedOverride !== undefined) return input.trustedOverride;
  const registry = await loadRolesRegistry(fs);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  return roleA2APolicy(role);
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
  throw new RpcError(-32602, "docs.* requires id or path");
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
 * Resolve the role lane contract for integration.
 * Re-validate envelope workspace/targetBranch against mounted root + real
 * ensureRoleWorkspace(role) contract — do not trust a stale envelope alone.
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

  // Always resolve the authoritative role lane (creates/reuses worktree as needed).
  const real = await ensureRoleWorkspace(mountedRoot, task.role);

  if (task.branch && task.branch !== real.branch) {
    throw new Error(
      `Task envelope branch mismatch for role ${task.role}: envelope=${task.branch} expected=${real.branch}`
    );
  }
  if (task.targetBranch && task.targetBranch !== real.targetBranch) {
    throw new Error(
      `Task envelope targetBranch mismatch for role ${task.role}: envelope=${task.targetBranch} expected=${real.targetBranch}`
    );
  }
  if (task.worktree) {
    const claimedWt = nodePath.resolve(task.worktree);
    const realWt = nodePath.resolve(real.worktree);
    if (!isSameWorkspaceRoot(claimedWt, realWt)) {
      throw new Error(
        `Task envelope worktree mismatch for role ${task.role}: envelope=${task.worktree} expected=${real.worktree}`
      );
    }
  }

  // Prefer real contract paths (normalized realpath) over envelope strings.
  return real;
}

/**
 * Ensure task envelope carries WorkspaceLane before managed startSession.
 * Git workspace → create/reuse role worktree and patch missing fields under MutationBus
 * (worktree create + envelope patch share one critical section; no nested run).
 * Non-Git / pure docs → leave unset (cwd falls back to workspace root).
 */
async function ensureTaskWorkspaceLane(
  ctx: HandlerContext,
  workspaceId: string,
  task: TaskEnvelope
): Promise<TaskEnvelope> {
  if (task.worktree && task.branch && task.workspace && task.targetBranch) {
    return task;
  }
  const mount = ctx.host.require(workspaceId);
  return ctx.mutations.run(workspaceId, async () => {
    const lane = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, task.role);
    if (!lane) return task;
    ctx.host.markSelfWrite(workspaceId);
    return patchTaskEnvelope(mount.env.fs, task.path, {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      updatedAt: mount.env.clock.now(),
    });
  });
}

/**
 * Active managed ACP session for a role (starting/live/waiting-user).
 * External sessions (state=external) are intentionally excluded — they are not
 * service-registry managed and do not consume this single-slot rule.
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
      SessionRegistry.isNonTerminal(rec.state) &&
      rec.state !== "external"
  );
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
 * Never copies box/manifest bodies. Never instructs tent task claim/get/deliver.
 * Distinct from relayPromptForTask (external manual path still claim+deliver).
 */
function buildSessionBootstrapPrompt(
  task: TaskEnvelope,
  roots: { workspaceRoot: string; systemRoot: string }
): string {
  const systemRoot = roots.systemRoot || systemRootFromWorkspace(roots.workspaceRoot);
  const card = taskContextCard(task.id || task.path, {
    path: task.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
    label: `task:${task.role}`,
  });
  const sessionSteps = sessionBootstrapPromptForTask(task, {
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
  });
  const aux: string[] = [];
  if (task.role) aux.push(`role: ${task.role}`);
  if (task.claims?.length) aux.push(`claims: ${task.claims.join(", ")}`);
  if (task.deliveryPolicy) aux.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  return (
    `${card.prompt}\n\n` +
    `--- Tent managed session bootstrap ---\n` +
    (aux.length ? `${aux.join("\n")}\n` : "") +
    `${sessionSteps}\n`
  );
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
    deliveryPolicy: task.deliveryPolicy,
    assigneeKind: task.assigneeKind,
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

  const active = hasActiveTaskForConcept(tent, conceptId, concept.path, tasks);
  const occupied = active || !!concept.fm.owner || concept.locked;
  if (!occupied) return;

  throw new RpcError(
    -32010,
    `docs.write cannot change collaboration projection fields while box has an active task: ${protectedHit.join(", ")}. Use task.* transitions.`,
    { fields: protectedHit, conceptId }
  );
}

function hasActiveTaskForConcept(
  tent: LoadedTent,
  conceptId: string,
  conceptPath: string,
  tasks: import("../core/task.js").TaskEnvelope[]
): boolean {
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "taken") continue;
    // Prefer full state when available
    const state = task.state;
    if (
      state &&
      state !== "queued" &&
      state !== "running" &&
      state !== "waiting" &&
      state !== "delivered"
    ) {
      // terminal legacy taken may still show status=taken after interrupt — check state
      if (state === "accepted" || state === "interrupted" || state === "failed" || state === "rejected") {
        continue;
      }
    }
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
