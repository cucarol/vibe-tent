/**
 * Authoritative provider verification catalog (product adapters only).
 *
 * Single backend source of truth for UI/client verification badges.
 * Entries cover PRODUCT_ACP_ADAPTER_IDS; canResume is derived from each
 * adapter's capabilities(). Verification levels remain a small product
 * registry (repository evidence: mock suite / opt-in live probe) and are
 * drift-tested against the current product adapter set.
 *
 * Never secrets, env values, credentials, command lines, or machine-local
 * provider metadata. Agent Connections remain separate launch configuration.
 *
 * Honesty: "has a checked-in script" is at most opt-in-live-probe — never
 * live-verified and never a claim of full CI certification on every host.
 */

import type { ProviderAdapter } from "../adapters/types.js";
import { createGrokAcpAdapter } from "../adapters/grok-acp/index.js";
import { createCodexAcpAdapter } from "../adapters/codex-acp/index.js";
import { createClaudeAcpAdapter } from "../adapters/claude-acp/index.js";
import { createOpenCodeAcpAdapter } from "../adapters/opencode-acp/index.js";
import { createCopilotAcpAdapter } from "../adapters/copilot-acp/index.js";
import { createPiAcpAdapter } from "../adapters/pi-acp/index.js";
import type {
  NativeForegroundLevel,
  ProviderCatalogEntry,
  ProviderCatalogProjection,
  ProviderVerificationLevel,
} from "./types.js";
import { PROVIDER_VERIFICATION_LEVELS } from "./types.js";
export const PRODUCT_ACP_ADAPTER_IDS = [
  "grok-acp",
  "codex-acp",
  "claude-acp",
  "opencode-acp",
  "copilot-acp",
  "pi-acp",
] as const;
export type ProductAcpAdapterId = (typeof PRODUCT_ACP_ADAPTER_IDS)[number];

/**
 * Repository verification level per product adapterId.
 * Keep aligned with real test evidence (mock suites + opt-in live probes).
 *
 * Level semantics (see types.ts PROVIDER_VERIFICATION_LEVELS):
 * - adapter-implemented — launch contract coded; no repository mock/live suite claim
 * - mock-tested — offline mock ACP suite covers launch/protocol
 * - opt-in-live-probe — checked-in opt-in live script/probe exists; not CI-always
 * - live-verified — reserved for machine-local durable proof (not used as a
 *   static "script exists" badge)
 */
const PROVIDER_VERIFICATION_LEVELS_BY_ADAPTER: Readonly<
  Record<ProductAcpAdapterId, ProviderVerificationLevel>
> = {
  // Checked-in opt-in: npm run test:grok-e2e (+ also in test:foreground-e2e).
  "grok-acp": "opt-in-live-probe",
  // Checked-in opt-in: npm run test:foreground-e2e with TENT_LIVE_PROVIDERS=…
  "codex-acp": "opt-in-live-probe",
  "claude-acp": "opt-in-live-probe",
  "opencode-acp": "opt-in-live-probe",
  "copilot-acp": "opt-in-live-probe",
  // Mock suite + initialize/session-new probe evidence; no checked-in paid live E2E yet.
  "pi-acp": "mock-tested",
};

const NATIVE_FOREGROUND_BY_ADAPTER: Readonly<
  Record<ProductAcpAdapterId, NativeForegroundLevel>
> = {
  "grok-acp": "verified",
  "codex-acp": "verified",
  "claude-acp": "verified",
  "opencode-acp": "verified",
  "copilot-acp": "verified",
  // pi-acp maps loadSession + session-map to pi session files; native CLI
  // hand-back not covered by Tent's foreground-e2e matrix yet.
  "pi-acp": "unverified",
};

/** Optional non-secret catalog notes for honest UI copy. */
const PROVIDER_CATALOG_NOTES: Readonly<
  Partial<Record<ProductAcpAdapterId, string>>
> = {
  "grok-acp":
    "mock suite + opt-in live E2E (test:grok-e2e); not automatic CI certification",
  "codex-acp":
    "mock suite + opt-in live probe (test:foreground-e2e); not automatic CI certification",
  "claude-acp":
    "mock suite + opt-in live probe (test:foreground-e2e); Node bridge may require ≥22",
  "opencode-acp":
    "mock suite + opt-in live probe (test:foreground-e2e); not automatic CI certification",
  "copilot-acp":
    "mock suite + opt-in live probe (test:foreground-e2e); not automatic CI certification",
  "pi-acp":
    "third-party pi-acp bridge; mock suite; initialize loadSession verified when pi is installed; no paid live E2E in default CI",
};

const LEVEL_SET = new Set<string>(PROVIDER_VERIFICATION_LEVELS);

export function isProviderVerificationLevel(
  value: string
): value is ProviderVerificationLevel {
  return LEVEL_SET.has(value);
}

/**
 * Default product ACP adapter instances used only for capability projection.
 * Mirrors AgentRuntime's product registration set (no fake-cli).
 */
export function defaultProductAcpAdapters(): ProviderAdapter[] {
  return [
    createGrokAcpAdapter(),
    createCodexAcpAdapter(),
    createClaudeAcpAdapter(),
    createOpenCodeAcpAdapter(),
    createCopilotAcpAdapter(),
    createPiAcpAdapter(),
  ];
}

/**
 * Project the authoritative catalog. Pure / sync — no disk, env, or secrets.
 * Order matches PRODUCT_ACP_ADAPTER_IDS (product CRUD whitelist).
 * canResume comes from adapter.capabilities(); levels from the static registry.
 */
export function projectProviderCatalog(): ProviderCatalogProjection {
  const byId = new Map(
    defaultProductAcpAdapters().map((adapter) => [adapter.id, adapter])
  );
  const providers: ProviderCatalogEntry[] = [];
  for (const adapterId of PRODUCT_ACP_ADAPTER_IDS) {
    const adapter = byId.get(adapterId);
    if (!adapter) {
      throw new Error(
        `provider catalog missing product adapter instance for adapterId: ${adapterId}`
      );
    }
    const verificationLevel = PROVIDER_VERIFICATION_LEVELS_BY_ADAPTER[adapterId];
    if (!verificationLevel) {
      throw new Error(
        `provider catalog missing verification level for product adapterId: ${adapterId}`
      );
    }
    const notes = PROVIDER_CATALOG_NOTES[adapterId];
    providers.push({
      adapterId,
      verificationLevel,
      canResume: adapter.capabilities().canResume === true,
      nativeForeground: NATIVE_FOREGROUND_BY_ADAPTER[adapterId],
      ...(notes ? { notes } : {}),
    });
  }
  return { providers };
}

/** Lookup one adapter; undefined when not a product catalog entry. */
export function providerCatalogEntry(
  adapterId: string
): ProviderCatalogEntry | undefined {
  return projectProviderCatalog().providers.find((p) => p.adapterId === adapterId);
}
