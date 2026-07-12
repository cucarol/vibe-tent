// Machine-local AgentProfile catalog (architecture §3.3). Never in workspace git.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentProfileConfig } from "../runtime/types.js";
import { FAKE_ADAPTER_ID } from "../adapters/fake/index.js";

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

/** Default catalog for Windows MVP harness — fake adapter only (no paid networks). */
export function defaultAgentProfiles(): AgentProfileConfig[] {
  return [
    {
      id: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true },
    },
  ];
}

export async function ensureDefaultProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const existing = await loadAgentProfiles(dataDir);
  if (existing.length > 0) return existing;
  const defaults = defaultAgentProfiles();
  await saveAgentProfiles(dataDir, defaults);
  return defaults;
}
