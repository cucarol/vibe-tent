import {
  updateWorkspaceSettings,
  loadWorkspaceSettings,
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
import { contentEtag } from "./etag.js";
import type { EventBus } from "./events.js";
import type { MutationBus } from "./mutation-bus.js";
import { RpcError } from "./rpc-error.js";
import type { WorkspaceHost } from "./workspace-host.js";

export interface WorkspaceAdminDeps {
  host: Pick<WorkspaceHost, "require" | "markSelfWrite">;
  mutations: Pick<MutationBus, "run">;
  events: Pick<EventBus, "emit">;
  requireWorkspaceId: (params: Record<string, unknown>) => string;
  requireUserActor: (params: Record<string, unknown>, surface: string) => string;
  optionalString: (params: Record<string, unknown>, key: string) => string | undefined;
}

/** Read projection of workspace collaboration settings. */
export async function handleWorkspaceSettings(
  deps: WorkspaceAdminDeps,
  params: Record<string, unknown>
) {
  const workspaceId = deps.requireWorkspaceId(params);
  const mount = deps.host.require(workspaceId);
  const settings = await loadWorkspaceSettings(mount.env.fs);
  return {
    workspaceId,
    settings: projectWorkspaceSettings(settings),
  };
}

/** User-only workspace settings mutation through the existing MutationBus. */
export async function handleWorkspaceSettingsUpdate(
  deps: WorkspaceAdminDeps,
  params: Record<string, unknown>
) {
  deps.requireUserActor(params, "workspace.settings.update");
  const workspaceId = deps.requireWorkspaceId(params);
  const mount = deps.host.require(workspaceId);
  const patch = parseWorkspaceSettingsPatch(params);

  return deps.mutations.run(workspaceId, async () => {
    deps.host.markSelfWrite(workspaceId);
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
      emitWorkspaceSettingsUpdated(deps, workspaceId, result.settings);
    }
    return {
      workspaceId,
      settings: projectWorkspaceSettings(result.settings),
      changed: result.changed,
    };
  });
}

/** Read projection of the canonical workspace-root AGENTS.md. */
export async function handleWorkspaceAgents(
  deps: WorkspaceAdminDeps,
  params: Record<string, unknown>
) {
  const workspaceId = deps.requireWorkspaceId(params);
  const mount = deps.host.require(workspaceId);
  const file = await loadWorkspaceAgents(mount.workspaceRoot);
  return projectWorkspaceAgents(workspaceId, file);
}

/** User-only AGENTS.md write through the existing MutationBus. */
export async function handleWorkspaceAgentsWrite(
  deps: WorkspaceAdminDeps,
  params: Record<string, unknown>
) {
  deps.requireUserActor(params, "workspace.agents.write");
  const workspaceId = deps.requireWorkspaceId(params);
  const mount = deps.host.require(workspaceId);
  if (typeof params.content !== "string") {
    throw new RpcError(-32602, "workspace.agents.write requires string content");
  }
  const content = params.content;
  const baseEtag = deps.optionalString(params, "baseEtag");

  return deps.mutations.run(workspaceId, async () => {
    const before = await loadWorkspaceAgents(mount.workspaceRoot);
    const currentEtag = contentEtag(before.content);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: WORKSPACE_AGENTS_FILENAME,
      });
    }

    deps.host.markSelfWrite(workspaceId);
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
      deps.events.emit(
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

/** Top-level RPC fields are the only workspace settings patch shape. */
function parseWorkspaceSettingsPatch(
  params: Record<string, unknown>
): Record<string, unknown> {
  if (
    typeof params.patch === "object" &&
    params.patch !== null &&
    !Array.isArray(params.patch)
  ) {
    throw new RpcError(
      -32602,
      "workspace.settings.update does not accept nested patch; pass fields at the top level"
    );
  }
  const reserved = new Set(["workspaceId", "actor", "patch"]);
  const supported = new Set(["defaultAcceptMode"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (reserved.has(key)) continue;
    if (!supported.has(key)) {
      throw new RpcError(-32602, `Unknown workspace setting: ${key}`);
    }
    if (value === undefined) continue;
    out[key] = value;
  }
  if ("defaultAcceptMode" in out) {
    const value = out.defaultAcceptMode;
    if (
      value !== "review-required" &&
      value !== "auto-accept" &&
      value !== "agent-decide"
    ) {
      throw new RpcError(-32602, `Invalid defaultAcceptMode: ${String(value)}`, {
        code: "INVALID_ACCEPT_MODE",
      });
    }
  }
  return out;
}

function projectWorkspaceSettings(settings: WorkspaceSettings): WorkspaceSettings {
  return { ...settings };
}

function emitWorkspaceSettingsUpdated(
  deps: WorkspaceAdminDeps,
  workspaceId: string,
  settings: WorkspaceSettings
): void {
  deps.events.emit(
    "workspace.settings.updated",
    workspaceId,
    { settings: projectWorkspaceSettings(settings) },
    "self"
  );
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
