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
  taskFail,
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
  listPendingRoleCommits,
  readRoleBranchTip,
} from "../core/workspace.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { makeSessionId } from "../runtime/types.js";
import type { RuntimeEvent, SessionRecord } from "../runtime/types.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import * as nodePath from "node:path";
import { buildBacklinkIndex } from "../markdown/links.js";
import { contentEtag } from "./etag.js";
import type { EventBus } from "./events.js";
import { MutationBus } from "./mutation-bus.js";
import type { WorkspaceHost } from "./workspace-host.js";
import type { A2AApprovalStore } from "./a2a-store.js";
import { makeApprovalId } from "./a2a-store.js";
import type { ToolApprovalStore, ToolPendingApproval } from "./tool-approval-store.js";
import type { CredentialStore } from "./credential-store.js";
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
import {
  projectAgentProfile,
  projectAgentProfiles,
} from "./profiles.js";
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
      case "profile.get":
        return profileGet(ctx, p);
      case "profile.create":
        return profileCreate(ctx, p);
      case "profile.update":
        return profileUpdate(ctx, p);
      case "profile.delete":
        return profileDelete(ctx, p);
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
      case "toolApproval.listPending":
        return toolApprovalListPending(ctx, p);
      case "toolApproval.get":
        return toolApprovalGet(ctx, p);
      case "toolApproval.approveOnce":
        return toolApprovalResolve(ctx, p, "approved");
      case "toolApproval.deny":
        return toolApprovalResolve(ctx, p, "denied");
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
  // After SessionRegistry boot reconcile, each mount must re-bind tasks to live sessions.
  await reconcileTaskSessionsOnMount(ctx, info.workspaceId);
  return info;
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
  return {
    profile: projectAgentProfile(
      created,
      await profileCredentialExistsOpts(ctx, created)
    ),
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
  return {
    profile: projectAgentProfile(
      updated,
      await profileCredentialExistsOpts(ctx, updated)
    ),
  };
}

async function profileDelete(ctx: HandlerContext, p: Record<string, unknown>) {
  const id = requireString(p, "id");
  return ctx.profileCatalog.delete(id);
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

  // Any waiting (a2a-approval, external after restart, user-input, …) must resume to
  // running and clear wait *before* launching a new session. A2A ask path still parks
  // running→waiting earlier in this function when policy requires approval.
  if (task.state === "waiting") {
    await taskResumeRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }

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

  // The task owns the role's managed execution window only after the active-role
  // gate passes. Capture the branch baseline here, not at dispatch: queued tasks
  // may be created while an earlier task is still adding commits to the same lane.
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

  // After service restart: waiting task may still hold the old Tent sessionId.
  // When probe says resumeCapable (provider token + canResume), reuse that session
  // via native load — never cross worktree/cwd. Otherwise keep create-new semantics.
  const priorSessionId = task.sessionId?.trim() || "";
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
        const taskMatches =
          prior?.lastTaskId === taskPath ||
          (!!task.id && prior?.lastTaskId === task.id);
        resumePrior =
          cwdMatches &&
          profileMatches &&
          workspaceMatches &&
          roleMatches &&
          taskMatches;
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
      });
    } else {
      handle = await ctx.runtime.startSession({
        sessionId: makeSessionId(),
        profileId,
        roleName: task.role,
        workspaceLane,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: sessionBootstrap,
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

  // Resume task projection if it was parked on tool approval wait.
  // Adapter re-emits session.live after decision; service also resumes here for
  // approve path so UI does not wait solely on racey runtime events.
  if (decision === "approved" && item.taskPath) {
    try {
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

// ---- runtime event bridge (called from service bootstrap) ----

/**
 * Dedup keys for managed auto-delivery: one successful prompt_complete per
 * sessionId+taskPath must not create two deliveries (reconnect / double emit).
 * Authority remains task lifecycle (ready delivery / non-running state also blocks).
 */
const managedAutoDeliverInFlight = new Set<string>();
const managedAutoDeliverDone = new Set<string>();

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
  const workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
  if (ev.type === "session.stdout_tail") {
    // Diagnostics only — never product chat; optional quiet emit.
    return;
  }

  // Reflect waiting-user on session row for probe honesty (no chat).
  if (ev.type === "session.waiting_user") {
    if (rec && SessionRegistry.isNonTerminal(rec.state)) {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user",
      });
    }
  } else if (ev.type === "session.live") {
    const current = await ctx.runtime.registry.read(ev.sessionId);
    if (current && current.state === "waiting-user") {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "live",
        ...(ev.pid != null ? { pid: ev.pid } : {}),
      });
    }
  } else if (ev.type === "session.failed" || ev.type === "session.exited") {
    // Pending tool approvals must not hang after process death.
    await ctx.toolApprovals.cancelSession(ev.sessionId, "denied");
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
      const task = tasks.find(
        (t) =>
          t.sessionId === ev.sessionId ||
          t.id === rec.lastTaskId ||
          t.path === rec.lastTaskId
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
        ev.type === "session.live" &&
        task.state === "waiting" &&
        task.wait?.reason === "user-input"
      ) {
        // Tool approval resolved (or session resumed) → running again.
        await ctx.mutations.run(mount.workspaceId, async () => {
          ctx.host.markSelfWrite(mount.workspaceId);
          const resumed = await taskResume(mount.env, task.path);
          emitTaskState(ctx, mount.workspaceId, resumed, "session.live");
        });
      } else if (
        (ev.type === "session.failed" || ev.type === "session.exited") &&
        (task.state === "running" || task.state === "waiting")
      ) {
        // Any terminal session without a delivery releases the task occupation.
        // Intentional interrupt is already terminal before stopSession emits exited,
        // so it never enters this active-task branch.
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

  // Stop managed process first when still live (idempotent).
  if (input.sessionId) {
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

  await ctx.mutations.run(input.workspaceId, async () => {
    ctx.host.markSelfWrite(input.workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
    if (current.state !== "running" && current.state !== "waiting" && current.state !== "failed") {
      // delivered / terminal other — do not force fail
      return;
    }
    const failed = await taskFail(mount.env, input.taskPath, {
      summary: input.summary,
    });
    emitTaskState(ctx, input.workspaceId, failed, input.reason);
  });
}

/**
 * Managed ACP path: capture final assistant response → same task.deliver lifecycle.
 * - summary/report = assistant final reply
 * - never auto-accept; manual → pending review; bypass/agent-decide use existing policy
 * - empty/error already filtered by adapter; still refuse empty here
 * - duplicate completion / already-delivered / terminal → ignore (no second delivery)
 * - production auto-collects pending commits from the task's authoritative role lane
 * - only after successful taskDeliver, stop the managed session so the role is free
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

  let deliveredOk = false;
  try {
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;

    // Outside the mutation bus: capture-once baseline for legacy Git-lane tasks
    // missing roleBranchBase. Nested mutations.run would deadlock.
    if (input.commits === undefined) {
      const pre = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
      if (pre && pre.state === "running") {
        await ensureTaskWorkspaceLane(ctx, input.workspaceId, pre);
      }
    }

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

      // Collect pending role-lane commits unless the caller supplied an explicit list
      // (tests only). Production always auto-collects via the authoritative lane contract.
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
      deliveredOk = true;
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

    // Free the role slot only after successful delivery. Stop failure must not
    // roll back delivery; keep registry resume metadata and emit diagnostics.
    if (deliveredOk) {
      await stopManagedSessionAfterDelivery(ctx, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        taskPath: input.taskPath,
      });
    }
  } catch (err) {
    // Deliver / integrate / collection failure must NOT terminal-fail the task.
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
 * After successful managed delivery, stop the runtime session so the same role
 * can accept a new task. Registry row stays (resume metadata). Stop errors are
 * diagnostic-only — delivery already committed and must not roll back.
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

/** Test helper: clear in-process managed deliver dedup (does not touch disk). */
export function resetManagedAutoDeliverDedupForTests(): void {
  managedAutoDeliverInFlight.clear();
  managedAutoDeliverDone.clear();
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
 * Also backfills roleBranchBase once when missing on legacy/pre-baseline envelopes;
 * never overwrites an existing baseline (restart / resume / reject-resume safe).
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

    const lane =
      currentLaneComplete
        ? {
            workspace: current.workspace!,
            worktree: current.worktree!,
            branch: current.branch!,
            targetBranch: current.targetBranch!,
          }
        : await ensureRoleWorkspaceIfGit(mount.workspaceRoot, current.role);
    if (!lane) return current;

    const patch: Parameters<typeof patchTaskEnvelope>[2] = {
      updatedAt: mount.env.clock.now(),
    };
    if (!currentLaneComplete) {
      patch.workspace = lane.workspace;
      patch.worktree = lane.worktree;
      patch.branch = lane.branch;
      patch.targetBranch = lane.targetBranch;
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
