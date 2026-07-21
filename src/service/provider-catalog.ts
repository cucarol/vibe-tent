/**
 * Authoritative provider verification catalog (product adapters only).
 *
 * Single backend source of truth for UI/client verification badges.
 * Entries cover PRODUCT_ACP_ADAPTER_IDS; canResume is derived from each
 * adapter's capabilities(). Verification levels remain a small product
 * registry (repository evidence: mock suite / live E2E) and are drift-tested
 * against the current product adapter set.
 *
 * Never secrets, env values, credentials, command lines, or machine-local
 * profile configuration. Profiles (`profile.*`) stay separate launch config.
 */

import type { ProviderAdapter } from "../adapters/types.js";
import { createGrokAcpAdapter } from "../adapters/grok-acp/index.js";
import { createCodexAcpAdapter } from "../adapters/codex-acp/index.js";
import { createClaudeAcpAdapter } from "../adapters/claude-acp/index.js";
import { createAntigravityAcpAdapter } from "../adapters/antigravity-acp/index.js";
import { createOpenCodeAcpAdapter } from "../adapters/opencode-acp/index.js";
import { createCopilotAcpAdapter } from "../adapters/copilot-acp/index.js";
import type {
  NativeForegroundLevel,
  ProviderCatalogEntry,
  ProviderCatalogProjection,
  ProviderVerificationLevel,
} from "./types.js";
import { PROVIDER_VERIFICATION_LEVELS } from "./types.js";
import {
  PRODUCT_ACP_ADAPTER_IDS,
  type ProductAcpAdapterId,
} from "./profiles.js";

/**
 * Repository verification level per product adapterId.
 * Keep aligned with real test evidence (mock suites + opt-in live E2E).
 *
 * Level semantics:
 * - adapter-implemented — launch contract coded; no repository mock/live suite claim
 * - mock-tested — offline mock ACP suite covers launch/protocol
 * - live-e2e — checked-in opt-in live E2E exists and has passed against the provider
 */
const PROVIDER_VERIFICATION_LEVELS_BY_ADAPTER: Readonly<
  Record<ProductAcpAdapterId, ProviderVerificationLevel>
> = {
  "grok-acp": "live-e2e",
  "codex-acp": "live-e2e",
  "claude-acp": "live-e2e",
  "antigravity-acp": "mock-tested",
  "opencode-acp": "mock-tested",
  "copilot-acp": "live-e2e",
};

const NATIVE_FOREGROUND_BY_ADAPTER: Readonly<
  Record<ProductAcpAdapterId, NativeForegroundLevel>
> = {
  "grok-acp": "verified",
  "codex-acp": "verified",
  "claude-acp": "verified",
  "antigravity-acp": "unsupported",
  "opencode-acp": "unverified",
  "copilot-acp": "verified",
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
    createAntigravityAcpAdapter(),
    createOpenCodeAcpAdapter(),
    createCopilotAcpAdapter(),
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
    providers.push({
      adapterId,
      verificationLevel,
      canResume: adapter.capabilities().canResume === true,
      nativeForeground: NATIVE_FOREGROUND_BY_ADAPTER[adapterId],
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
