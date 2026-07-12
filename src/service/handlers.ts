// Service command/query handlers — sole client mutation entry into core.

import { boxNotePath, loadTent, type LoadedTent } from "../core/tree.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import {
  createBox,
  dispatch,
  patchBody,
  patchBox,
  taskAck,
} from "../core/ops.js";
import { promoteConcept } from "../core/concept.js";
import { forkNode } from "../core/forkOps.js";
import { loadTaskEnvelope, loadTaskEnvelopes } from "../core/task.js";
import { contentEtag } from "./etag.js";
import type { EventBus } from "./events.js";
import type { MutationBus } from "./mutation-bus.js";
import type { WorkspaceHost } from "./workspace-host.js";
import {
  isClientMethod,
  PROTECTED_COLLAB_FIELDS,
  type ConceptProjection,
  type TaskProjection,
} from "./types.js";

export interface HandlerContext {
  host: WorkspaceHost;
  mutations: MutationBus;
  events: EventBus;
  version: string;
  startedAt: string;
  getPid: () => number;
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

  switch (method) {
    case "service.health":
      return health(ctx);
    case "service.subscribe":
      // Transport layer upgrades to SSE; RPC returns capability flag.
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
    case "task.dispatch":
      return taskDispatch(ctx, p);
    case "task.claim":
      return taskClaim(ctx, p);
    case "task.list":
      return taskList(ctx, p);
    case "task.get":
      return taskGet(ctx, p);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
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
  const { body } = parseFrontmatter(raw);
  return {
    workspaceId,
    id: concept.id,
    path: concept.path,
    body,
    etag: contentEtag(raw),
    frontmatter: concept.fm,
  };
}

async function docsWrite(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");
  const body = typeof p.body === "string" ? p.body : undefined;
  const frontmatter =
    p.frontmatter && typeof p.frontmatter === "object" && !Array.isArray(p.frontmatter)
      ? (p.frontmatter as Record<string, unknown>)
      : undefined;

  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept(tent, p);
    const notePath = boxNotePath(concept.path);
    const raw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(raw);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: concept.path,
      });
    }

    if (frontmatter) {
      assertDocsWriteAllowed(tent, concept.id, frontmatter, await loadTaskEnvelopes(mount.env.fs));
    }

    ctx.host.markSelfWrite(workspaceId);
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      await patchBox(mount.env, concept.path, frontmatter, tent);
    }
    if (body !== undefined) {
      // Re-load tent only if frontmatter changed path identity (it doesn't).
      await patchBody(mount.env, concept.path, body, tent);
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
      path: concept.path,
      etag: contentEtag(afterRaw),
      body: after.body,
    };
  });
}

async function docsCreateNote(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const type = optionalString(p, "type") ?? "note";
  const parentPath = optionalString(p, "parentPath") ?? "";

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const id = await createBox(mount.env, { parentPath, name, type });
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id, path: parentPath ? `${parentPath}/${name}` : name, reason: "docs.createNote" },
      "self"
    );
    return { workspaceId, id, path: parentPath ? `${parentPath}/${name}` : name, type };
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
    // Resolve path → id if needed
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

async function taskDispatch(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId") ?? optionalString(p, "id") ?? requireString(p, "claimId");
  const role = requireString(p, "role");
  const prompt = requireString(p, "prompt");
  const dispatchedBy = optionalString(p, "dispatchedBy");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await dispatch(mount.env, boxId, role, {
      userPrompt: prompt,
      dispatchedBy,
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: result.taskPath,
        state: "queued",
        role,
        boxId,
        reason: "task.dispatch",
      },
      "self"
    );
    return {
      workspaceId,
      taskPath: result.taskPath,
      manifestPath: result.manifestPath,
      initPath: result.initPath,
      relayPrompt: result.relayPrompt,
      state: "queued",
    };
  });
}

async function taskClaim(ctx: HandlerContext, p: Record<string, unknown>) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");

  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    await taskAck(mount.env, taskPath);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: taskPath,
        state: "running",
        role: task.role,
        claims: task.claims,
        reason: "task.claim",
      },
      "self"
    );
    // Projected status/owner live on concept frontmatter via core taskAck.
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
      state: "running",
      role: task.role,
      claims: task.claims,
    };
  });
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

// ---- helpers ----

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
  if (includeBody) {
    proj.bodyPreview = box.body.slice(0, 500);
  }
  if (withChildren) {
    proj.children = box.children.map((c) => projectConcept(c, includeBody, true));
  }
  return proj;
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
    role: task.role,
    claims: task.claims,
    status: task.status,
    manifest: task.manifest,
    dispatchedBy: task.dispatchedBy,
    workspaceLane: lane,
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
  // Also treat legacy owner lock as active occupation.
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
