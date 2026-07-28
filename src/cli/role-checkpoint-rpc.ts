// Role Checkpoint CLI — cooperative continuation note for Role Session replacement.
// Surface: tent role-checkpoint set|show|clear
//
// set/clear are operational mutations: in-workspace always Local Service + MutationBus.
// show is read-only (direct core file read allowed).
// Never invents continuity or Delivery bodies. Skill text is Planning-owned.

import * as path from "node:path";
import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import { ensureMountedWorkspace } from "./workspace-context.js";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE } from "../core/status.js";
import {
  formatRoleCheckpointTail,
  readRoleCheckpoint,
  type RoleCheckpointPointers,
} from "../core/role-checkpoint.js";
import { NodeFs } from "../fs/node-fs.js";
import {
  TENT_SYSTEM_DIR,
  workspaceRootFromSystemRoot,
} from "../core/paths.js";

export type RoleCheckpointRpcGlobals = {
  workspace?: string;
  cwd?: string;
  dataDir?: string;
  attachOnly?: boolean;
  serviceEntry?: string;
  packageRoot?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected client (tests); skips attach when set. */
  client?: ServiceClient;
};

export type RoleCheckpointCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** In-workspace system root = parent of `.tent` is the real workspace. */
function isInWorkspaceSystemRoot(systemRoot: string): boolean {
  return workspaceRootFromSystemRoot(systemRoot) !== undefined;
}

export function roleCheckpointHelpText(): string {
  return `tent role-checkpoint — optional cooperative Role Session continuation note

Usage:
  tent role-checkpoint set  <role> --text <note> [--actor user|<role>]
                            [--session <ss-…>] [--nodes id,id] [--tasks id,id]
                            [--deliveries id,id] [--git ref,ref]
  tent role-checkpoint show <role>
  tent role-checkpoint clear <role> [--actor user|<role>]

Semantics:
  set    Overwrite the single current note under temp/<role>/checkpoint.md
         (in-workspace: Local Service RPC + MutationBus; never direct-write)
  show   Print the note + dynamic-tail projection (or report absent; read-only)
  clear  Remove the note (idempotent; same Service mutation path as set)

Actor (set/clear):
  --actor user          User / UI path (default)
  --actor <role>        Exact target Role operational name (future tent-role Skill)
  Unrelated Role actors are refused by the Service.

Rules:
  - Dynamic tail only — never stable Role init / cache prefix.
  - Not a Delivery, Task state, Core entity, or OS-temp artifact.
  - Crash recovery must work without this note (re-query Tent/Git facts).
  - One note per Role; later writes replace earlier ones.
  - Direct core mutation of set/clear is fail-loud on in-workspace .tent.

Common flags:
  --workspace <path>   Workspace root (wins over cwd for set/show/clear)
  --data-dir <path>    Service data area
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}

export async function runRoleCheckpointCommand(
  sub: string,
  args: string[],
  globals: RoleCheckpointRpcGlobals = {}
): Promise<RoleCheckpointCommandResult> {
  const normalized = (sub || "").trim().toLowerCase();
  if (
    !normalized ||
    normalized === "help" ||
    normalized === "--help" ||
    normalized === "-h"
  ) {
    return { exitCode: 0, stdout: roleCheckpointHelpText() + "\n", stderr: "" };
  }
  if (normalized !== "set" && normalized !== "show" && normalized !== "clear") {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `Unknown role-checkpoint subcommand: ${sub || "(empty)"}\n` +
        roleCheckpointHelpText() +
        "\n",
    };
  }

  try {
    const { positionals, flags } = parseRoleCheckpointFlags(args);
    const json = globals.json === true || flags.json === "true";
    const role = positionals[0]?.trim();
    if (!role) {
      return failUsage(
        `Usage: tent role-checkpoint ${normalized} <role> …\n` + roleCheckpointHelpText()
      );
    }
    if (normalized === "set" && positionals.length > 1) {
      return failUsage(
        "Usage: tent role-checkpoint set <role> --text <note> [--actor user|<role>] …"
      );
    }
    if (normalized !== "set" && positionals.length > 1) {
      return failUsage(`Usage: tent role-checkpoint ${normalized} <role>`);
    }

    // Refuse legacy direct-mutation flags on set/clear (no silent bypass).
    if (
      (normalized === "set" || normalized === "clear") &&
      (flags.direct === "true" || flags["no-service"] === "true")
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `role-checkpoint ${normalized} refuses --direct / --no-service: ` +
          `in-workspace mutations must use Local Service (MutationBus).\n` +
          `Omit those flags; attach/bootstrap Service is the default path.\n`,
      };
    }

    // show: prefer Service when a client is injected or caller asked for service;
    // otherwise allow direct read-only file access (no MutationBus write).
    if (normalized === "show" && !globals.client && flags.service !== "true") {
      return await runShowDirect(role, flags, json, globals);
    }

    return await runViaService(normalized, role, flags, json, globals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

async function runViaService(
  normalized: "set" | "show" | "clear",
  role: string,
  flags: Record<string, string>,
  json: boolean,
  globals: RoleCheckpointRpcGlobals
): Promise<RoleCheckpointCommandResult> {
  const attachOpts: CliAttachOptions = {
    dataDir: flags["data-dir"] || globals.dataDir,
    attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
    serviceEntry: flags["service-entry"] || globals.serviceEntry,
    packageRoot: globals.packageRoot,
    env: globals.env,
  };
  const client =
    globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
  const ctx = await ensureMountedWorkspace(client, {
    cwd: globals.cwd,
    workspace: flags.workspace || globals.workspace,
  });
  const workspaceId = ctx.workspaceId;
  const actor = resolveActorFlag(flags);

  if (normalized === "show") {
    const result = (await client.roleCheckpointGet(workspaceId, role)) as {
      checkpoint: unknown;
      tail: string;
    };
    if (json) return okJson(result);
    if (!result.checkpoint) {
      return {
        exitCode: 0,
        stdout: `No Role Checkpoint for role ${role}.\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: (result.tail?.trim() ? result.tail.trim() + "\n" : "") || "",
      stderr: "",
    };
  }

  if (normalized === "clear") {
    const result = (await client.roleCheckpointClear(workspaceId, role, {
      actor,
    })) as { cleared: boolean; actor?: string };
    if (json) return okJson(result);
    return {
      exitCode: 0,
      stdout: result.cleared
        ? `✓ Role Checkpoint cleared for ${role}\n`
        : `No Role Checkpoint to clear for ${role}\n`,
      stderr: "",
    };
  }

  // set
  const text = flags.text || flags.note || flags.body;
  if (!text?.trim()) {
    return failUsage(
      "Usage: tent role-checkpoint set <role> --text <note> [--actor user|<role>] [--session <ss-…>] [--nodes …]"
    );
  }
  const pointers = pointersFromFlags(flags);
  const result = await client.roleCheckpointSet(workspaceId, {
    role,
    text,
    actor,
    sourceSessionId: flags.session || flags["session-id"] || flags.sourceSessionId,
    ...(pointers ? { pointers } : {}),
  });
  if (json) return okJson(result);
  const path =
    (result as { checkpoint?: { path?: string } })?.checkpoint?.path ||
    `temp/${role}/checkpoint.md`;
  return {
    exitCode: 0,
    stdout: `✓ Role Checkpoint written: ${path}\n`,
    stderr: "",
  };
}

/**
 * Read-only show via system-root files. Never used for set/clear.
 * Explicit --workspace (flag or globals.workspace) always wins over cwd so a
 * caller inside another Tent cannot inspect the wrong workspace.
 */
async function runShowDirect(
  role: string,
  flags: Record<string, string>,
  json: boolean,
  globals: RoleCheckpointRpcGlobals
): Promise<RoleCheckpointCommandResult> {
  const explicitWorkspace = (flags.workspace || globals.workspace || "").trim();
  const start = explicitWorkspace
    ? path.resolve(explicitWorkspace)
    : path.resolve(globals.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start);
  if (!systemRoot) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        NOT_INSIDE_TENT_MESSAGE +
        (explicitWorkspace ? ` (searched from --workspace ${start})` : "") +
        "\n",
    };
  }
  // Defense: never allow this helper to be reused for mutations silently.
  void isInWorkspaceSystemRoot;

  const fsa = new NodeFs(systemRoot);
  try {
    const record = await readRoleCheckpoint(fsa, role);
    if (json) {
      return okJson({
        role,
        checkpoint: record,
        tail: formatRoleCheckpointTail(record),
      });
    }
    if (!record) {
      return {
        exitCode: 0,
        stdout: `No Role Checkpoint for role ${role}.\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: formatRoleCheckpointTail(record) + "\n",
      stderr: "",
    };
  } catch (error) {
    // Path-unsafe role names fail loud (same core gate as Service).
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

/**
 * Default actor is user (UI/CLI). Exact target Role name is for Role-operated
 * cooperative replacement; Service enforces match to the checkpoint role.
 */
function resolveActorFlag(flags: Record<string, string>): string {
  const raw = (flags.actor || flags.by || "").trim();
  return raw || "user";
}

function pointersFromFlags(flags: Record<string, string>): RoleCheckpointPointers | undefined {
  const split = (raw?: string): string[] | undefined => {
    if (!raw?.trim()) return undefined;
    const items = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  };
  const nodes = split(flags.nodes || flags.node);
  const tasks = split(flags.tasks || flags.task);
  const deliveries = split(flags.deliveries || flags.delivery);
  const git = split(flags.git);
  if (!nodes && !tasks && !deliveries && !git) return undefined;
  return {
    ...(nodes ? { nodes } : {}),
    ...(tasks ? { tasks } : {}),
    ...(deliveries ? { deliveries } : {}),
    ...(git ? { git } : {}),
  };
}

function parseRoleCheckpointFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleanFlags = new Set([
    "json",
    "service",
    "via-service",
    "attach-only",
    "direct",
    "no-service",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function failUsage(msg: string): RoleCheckpointCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}

function okJson(value: unknown): RoleCheckpointCommandResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value, null, 2) + "\n",
    stderr: "",
  };
}

// Keep TENT_SYSTEM_DIR referenced for help/docs consistency (in-workspace contract).
void TENT_SYSTEM_DIR;
