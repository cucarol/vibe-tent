// Resolve in-workspace tent root for CLI service path (architecture §3.1).

import * as path from "node:path";
import {
  findTentSystemRoot,
  NOT_INSIDE_TENT_MESSAGE,
} from "../core/status.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
import type { ServiceClient } from "../service/client.js";

export type WorkspaceContext = {
  /** Absolute path to workspace root (parent of `.tent/`). */
  workspaceRoot: string;
  /** Absolute path to tent system root (`…/.tent`). */
  systemRoot: string;
  /** Mounted workspace id from Local Service. */
  workspaceId: string;
};

/**
 * Locate workspace from cwd or --workspace, then ensure it is mounted on the service.
 * Service is the sole mount authority; CLI only attaches and requests mount.
 */
export async function ensureMountedWorkspace(
  client: ServiceClient,
  options: { cwd?: string; workspace?: string } = {}
): Promise<WorkspaceContext> {
  const { workspaceRoot, systemRoot } = await resolveWorkspacePaths(options);

  const listed = (await client.listWorkspaces()) as {
    workspaces?: Array<{ workspaceId: string; workspaceRoot: string }>;
  };
  const existing = (listed.workspaces ?? []).find(
    (w) => path.resolve(w.workspaceRoot) === path.resolve(workspaceRoot)
  );
  if (existing) {
    return {
      workspaceRoot,
      systemRoot,
      workspaceId: existing.workspaceId,
    };
  }

  const mounted = (await client.mount(workspaceRoot)) as {
    workspaceId: string;
    workspaceRoot: string;
    systemRoot: string;
  };
  return {
    workspaceRoot: mounted.workspaceRoot ?? workspaceRoot,
    systemRoot: mounted.systemRoot ?? systemRoot,
    workspaceId: mounted.workspaceId,
  };
}

export async function resolveWorkspacePaths(options: {
  cwd?: string;
  workspace?: string;
}): Promise<{ workspaceRoot: string; systemRoot: string }> {
  const start = path.resolve(options.workspace || options.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start);
  if (!systemRoot) {
    throw new Error(
      NOT_INSIDE_TENT_MESSAGE +
        (options.workspace ? ` (searched from --workspace ${start})` : "")
    );
  }
  const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
  if (!workspaceRoot) {
    throw new Error(
      `Tent system root is not an in-workspace .tent layout: ${systemRoot}. ` +
        `Service path requires <workspace>/.tent/ (architecture §3.1). ` +
        `Legacy pure-system-root fixtures still use direct CLI commands, not task RPC.`
    );
  }
  return { workspaceRoot: path.resolve(workspaceRoot), systemRoot: path.resolve(systemRoot) };
}
