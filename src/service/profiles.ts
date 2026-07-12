// Machine-local AgentProfile catalog (architecture §3.3). Never in workspace git.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentProfileConfig } from "../runtime/types.js";
import { FAKE_ADAPTER_ID } from "../adapters/fake/index.js";
import {
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../adapters/grok-acp/index.js";
import type { AgentProfileProjection } from "./types.js";

export function profilesPath(dataDir: string): string {
  return path.join(dataDir, "agent-profiles.json");
}

export async function loadAgentProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const file = profilesPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { profiles?: AgentProfileConfig[] };
    const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    return list.filter((p) => p && typeof p.id === "string" && typeof p.adapterId === "string");
  } catch {
    return [];
  }
}

export async function saveAgentProfiles(
  dataDir: string,
  profiles: AgentProfileConfig[]
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    profilesPath(dataDir),
    JSON.stringify({ profiles }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Default catalog for Local Service.
 * - fake-default: test / harness only (no network)
 * - grok-acp-default: first real provider; secrets only via process env (envKey name here)
 *
 * Never write API key values into this file — only env key *names* and paths.
 */
export function defaultAgentProfiles(): AgentProfileConfig[] {
  return [
    {
      id: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true },
    },
    {
      id: "grok-acp-default",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayNameKey: "profile.grokAcp.default",
      grokAcp: {
        // executable omitted → %USERPROFILE%\.grok\bin\grok.exe (or ~/.grok/bin/grok)
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        // Default deny tool permissions — never unconditional yolo.
        permissionPolicy: "deny",
      },
    },
  ];
}

export async function ensureDefaultProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const existing = await loadAgentProfiles(dataDir);
  if (existing.length > 0) {
    // Migrate older catalogs that only had fake: ensure grok-acp-default is present.
    if (!existing.some((p) => p.id === "grok-acp-default")) {
      const grok = defaultAgentProfiles().find((p) => p.id === "grok-acp-default")!;
      const merged = [...existing, grok];
      await saveAgentProfiles(dataDir, merged);
      return merged;
    }
    return existing;
  }
  const defaults = defaultAgentProfiles();
  await saveAgentProfiles(dataDir, defaults);
  return defaults;
}

/** Whether a profile is harness/test-only (must not be product default). */
export function isTestOnlyProfile(profile: AgentProfileConfig): boolean {
  return profile.adapterId === FAKE_ADAPTER_ID || !!profile.fake;
}

const DISPLAY_NAME_BY_KEY: Record<string, string> = {
  "profile.fake.default": "fake-default（测试）",
  "profile.grokAcp.default": "Grok ACP",
};

/**
 * Project a machine-local profile for clients.
 * Strips env maps, executable paths that may leak layout, and all secret-bearing fields.
 * Never includes API keys, tokens, or env *values*.
 */
export function projectAgentProfile(profile: AgentProfileConfig): AgentProfileProjection {
  const testOnly = isTestOnlyProfile(profile);
  const displayName =
    (profile.displayNameKey && DISPLAY_NAME_BY_KEY[profile.displayNameKey]) ||
    profile.id;
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    displayName,
    displayNameKey: profile.displayNameKey,
    // Model id only — never env values, keys, or executable paths.
    model: profile.grokAcp?.model,
    testOnly,
    permissionPolicy: profile.grokAcp?.permissionPolicy,
  };
}

/** Safe list for profile.list RPC — never secrets. */
export function projectAgentProfiles(profiles: AgentProfileConfig[]): AgentProfileProjection[] {
  return profiles
    .map(projectAgentProfile)
    .sort((a, b) => {
      // Product profiles first; then id.
      if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
}
