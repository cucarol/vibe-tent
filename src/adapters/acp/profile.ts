// Provider-neutral ACP profile bag helpers (extras.acp + shared field normalization).

import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  type AcpPermissionPolicy,
  type AcpProfileOptions,
} from "./types.js";
import type { AcpMcpServerWire, AcpSkillMetaRef } from "./mcp-skills.js";
import type { BootstrapImageRef } from "./image-prompt.js";
import type { LaunchPlan } from "../types.js";
import { NodeFs } from "../../fs/node-fs.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Read ACP profile bag from LaunchPlan.extras.
 * Canonical: extras.acp. Optional legacyKeys (e.g. "grokAcp") for pre-canonical plans.
 */
export function readAcpExtras(
  extras: Record<string, unknown> | undefined,
  legacyKeys: string[] = []
): unknown {
  if (!extras || typeof extras !== "object") return {};
  if (extras.acp !== undefined) return extras.acp;
  for (const key of legacyKeys) {
    if (extras[key] !== undefined) return extras[key];
  }
  return {};
}

/**
 * Read snapshot-time ACP session projection from LaunchPlan.extras.
 * Built by AgentRuntime at start/resume from profileSnapshot — not hot-reloaded.
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
 * Ephemeral image projection fields for AcpClient from a LaunchPlan.
 * Paths only on the plan; bytes are read at session/prompt under system root.
 * Image blocks still require live initialize promptCapabilities.image === true.
 * Never log or persist resolved bytes.
 */
/**
 * Core-owned spawn overlay + diagnostic secrets from LaunchPlan.
 * Passed through to AcpClient so reserved keys and resolver outputs are not lost.
 */
export function readCoreChildEnvClientOptions(plan: LaunchPlan): {
  coreEnv?: LaunchPlan["coreEnv"];
  diagnosticSecrets?: string[];
} {
  const out: {
    coreEnv?: LaunchPlan["coreEnv"];
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

export function readBootstrapImageClientOptions(plan: LaunchPlan): {
  bootstrapImageRefs?: BootstrapImageRef[];
  bootstrapImageSystemRoot?: string;
  readBootstrapImageBinary?: (relativePath: string) => Promise<Uint8Array>;
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
    readBootstrapImageBinary?: (relativePath: string) => Promise<Uint8Array>;
  } = {
    bootstrapImageRefs: refs,
  };
  if (systemRoot) {
    out.bootstrapImageSystemRoot = systemRoot;
    const nodeFs = new NodeFs(systemRoot);
    out.readBootstrapImageBinary = (relativePath: string) =>
      nodeFs.readBinary(relativePath);
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
  credentialRef?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  promptTimeoutMs: number;
  permissionPolicy: AcpPermissionPolicy;
  permissionTimeoutMs: number;
} {
  const o = (raw && typeof raw === "object" ? raw : {}) as AcpProfileOptions;
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
    credentialRef:
      typeof o.credentialRef === "string" && o.credentialRef.trim()
        ? o.credentialRef.trim()
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
 * Precedence: plan.command/args → profile executable → package defaults.
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
