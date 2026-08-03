// Provider-neutral ACP Connection bag helpers (extras.acp + shared field normalization).

import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  type AcpPermissionPolicy,
  type AcpRouteOptions,
} from "./types.js";
import type { AcpMcpServerWire, AcpSkillMetaRef } from "./mcp-skills.js";
import type { BootstrapImageRef } from "./image-prompt.js";
import type { ConnectionLaunchPlan } from "../types.js";
import type { BoundedBinaryRead } from "../../core/adapter.js";
import { NodeFs } from "../../fs/node-fs.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Read the canonical ACP bag from ConnectionLaunchPlan.extras.
 */
export function readAcpExtras(extras: Record<string, unknown> | undefined): unknown {
  if (!extras || typeof extras !== "object") return {};
  if (extras.acp !== undefined) return extras.acp;
  return {};
}

/**
 * Read snapshot-time ACP session projection from ConnectionLaunchPlan.extras.
 * Built by AgentRuntime at start/resume from the Connection snapshot — not hot-reloaded.
 * Wire values may contain secrets; never log the returned mcpServers array.
 */
export function readAcpSessionProjection(extras: Record<string, unknown> | undefined): {
  mcpServers: AcpMcpServerWire[];
  skills: AcpSkillMetaRef[];
} {
  if (!extras || typeof extras !== "object") {
    return { mcpServers: [], skills: [] };
  }
  const mcpRaw = extras.acpMcpServers;
  const skillRaw = extras.acpSkills;
  const mcpServers = Array.isArray(mcpRaw) ? (mcpRaw as AcpMcpServerWire[]) : [];
  const skills = Array.isArray(skillRaw) ? (skillRaw as AcpSkillMetaRef[]) : [];
  return { mcpServers, skills };
}

/**
 * Ephemeral image projection fields for AcpClient from a ConnectionLaunchPlan.
 * Paths only on the plan; bytes are read at session/prompt under system root.
 * Image blocks still require live initialize promptCapabilities.image === true.
 * Never log or persist resolved bytes.
 */
/**
 * Core-owned spawn overlay + diagnostic secrets from ConnectionLaunchPlan.
 * Passed through to AcpClient so reserved keys and resolver outputs are not lost.
 */
export function readCoreChildEnvClientOptions(plan: ConnectionLaunchPlan): {
  coreEnv?: ConnectionLaunchPlan["coreEnv"];
  diagnosticSecrets?: string[];
} {
  const out: {
    coreEnv?: ConnectionLaunchPlan["coreEnv"];
    diagnosticSecrets?: string[];
  } = {};
  if (plan.coreEnv && Object.keys(plan.coreEnv).length > 0) {
    out.coreEnv = plan.coreEnv;
  }
  if (Array.isArray(plan.diagnosticSecrets) && plan.diagnosticSecrets.length > 0) {
    out.diagnosticSecrets = plan.diagnosticSecrets.filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
  }
  return out;
}

export function readBootstrapImageClientOptions(plan: ConnectionLaunchPlan): {
  bootstrapImageRefs?: BootstrapImageRef[];
  bootstrapImageSystemRoot?: string;
  readBootstrapImageBinary?: (
    relativePath: string,
    maxBytes: number
  ) => Promise<BoundedBinaryRead>;
} {
  const refs = Array.isArray(plan.bootstrapImageRefs)
    ? plan.bootstrapImageRefs
    : [];
  const systemRoot =
    typeof plan.extras?.bootstrapImageSystemRoot === "string"
      ? plan.extras.bootstrapImageSystemRoot.trim()
      : "";
  if (refs.length === 0) {
    return {};
  }
  const out: {
    bootstrapImageRefs?: BootstrapImageRef[];
    bootstrapImageSystemRoot?: string;
    readBootstrapImageBinary?: (
      relativePath: string,
      maxBytes: number
    ) => Promise<BoundedBinaryRead>;
  } = {
    bootstrapImageRefs: refs,
  };
  if (systemRoot) {
    out.bootstrapImageSystemRoot = systemRoot;
    const nodeFs = new NodeFs(systemRoot);
    out.readBootstrapImageBinary = (relativePath: string, maxBytes: number) =>
      nodeFs.readBinaryBounded(relativePath, maxBytes);
  }
  return out;
}

export function normalizeAcpPermissionPolicy(
  raw: unknown
): AcpPermissionPolicy {
  return raw === "allow" || raw === "ask" || raw === "deny" ? raw : "deny";
}

/** Shared timeout + permissionPolicy normalization; does not invent model/envKey defaults. */
export function normalizeSharedAcpOpts(raw: unknown): {
  executable?: string;
  model?: string;
  envKey?: string;
  launchSecretRef?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  promptTimeoutMs: number;
  permissionPolicy: AcpPermissionPolicy;
  permissionTimeoutMs: number;
} {
  const o = (raw && typeof raw === "object" ? raw : {}) as AcpRouteOptions;
  return {
    executable:
      typeof o.executable === "string" && o.executable.trim()
        ? o.executable.trim()
        : undefined,
    model:
      typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined,
    envKey:
      typeof o.envKey === "string" && o.envKey.trim()
        ? o.envKey.trim()
        : undefined,
    launchSecretRef:
      typeof o.launchSecretRef === "string" && o.launchSecretRef.trim()
        ? o.launchSecretRef.trim()
        : undefined,
    baseUrlEnvKey:
      typeof o.baseUrlEnvKey === "string" && o.baseUrlEnvKey.trim()
        ? o.baseUrlEnvKey.trim()
        : undefined,
    baseUrl:
      typeof o.baseUrl === "string" && o.baseUrl.trim()
        ? o.baseUrl.trim()
        : undefined,
    promptTimeoutMs:
      typeof o.promptTimeoutMs === "number" && o.promptTimeoutMs > 0
        ? o.promptTimeoutMs
        : DEFAULT_PROMPT_TIMEOUT_MS,
    permissionPolicy: normalizeAcpPermissionPolicy(o.permissionPolicy),
    permissionTimeoutMs:
      typeof o.permissionTimeoutMs === "number" && o.permissionTimeoutMs > 0
        ? o.permissionTimeoutMs
        : DEFAULT_PERMISSION_TIMEOUT_MS,
  };
}

/** Resolve process/plan env value for an explicitly configured env key name. */
export function resolvePlanOrProcessEnv(
  envKey: string,
  planEnv: Record<string, string>,
  resolve?: (envKey: string, planEnv: Record<string, string>) => string | undefined
): string | undefined {
  if (resolve) return resolve(envKey, planEnv);
  const fromPlan = planEnv[envKey];
  if (typeof fromPlan === "string" && fromPlan.trim()) return fromPlan;
  const fromProc = process.env[envKey];
  if (typeof fromProc === "string" && fromProc.trim()) return fromProc;
  return undefined;
}

/** Legacy display helper. Prefer defaultNpxLaunch for an actually spawnable plan. */
export function defaultNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** Resolve npx without a command-shell hop (`.cmd` + piped stdio is EINVAL on Windows). */
export function defaultNpxLaunch(): { command: string; argsPrefix: string[] } {
  if (process.platform !== "win32") return { command: "npx", argsPrefix: [] };

  const candidates: string[] = [];
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) candidates.push(path.join(path.dirname(npmExecPath), "npx-cli.js"));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const root = dir.trim().replace(/^"|"$/g, "");
    if (root) candidates.push(path.join(root, "node_modules", "npm", "bin", "npx-cli.js"));
  }

  const npxCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npxCli) {
    throw new Error(
      "Unable to locate npm/bin/npx-cli.js on Windows; install Node.js/npm or configure an explicit ACP executable"
    );
  }
  const adjacentNode = path.resolve(npxCli, "..", "..", "..", "..", "node.exe");
  return {
    command: fs.existsSync(adjacentNode) ? adjacentNode : "node.exe",
    argsPrefix: [npxCli],
  };
}

/**
 * Resolve command/args for npx-based ACP bridges.
 * Precedence: plan.command/args → Connection executable → package defaults.
 */
export function resolveNpxAcpLaunch(input: {
  planCommand?: string;
  planArgs?: string[];
  executable?: string;
  defaultPackage: string;
}): { command: string; args: string[] } {
  const defaultArgs = ["--yes", input.defaultPackage];
  const usingDefaultLauncher =
    !(typeof input.planCommand === "string" && input.planCommand.trim()) &&
    !input.executable;
  const defaultLaunch = usingDefaultLauncher ? defaultNpxLaunch() : undefined;
  const command =
    (typeof input.planCommand === "string" && input.planCommand.trim()
      ? input.planCommand.trim()
      : undefined) ||
    input.executable ||
    defaultLaunch!.command;
  const args =
    input.planArgs && input.planArgs.length > 0
      ? [...input.planArgs]
      : usingDefaultLauncher
        ? [...defaultLaunch!.argsPrefix, ...defaultArgs]
        : [];
  return { command, args };
}
