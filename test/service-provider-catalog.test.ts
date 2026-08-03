/**
 * Service provider.catalog RPC — authoritative product verification projection.
 * Layer: CLIENT_METHODS + provider-catalog registry + handler + ServiceClient.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import {
  CLIENT_METHODS,
  isClientMethod,
  NATIVE_FOREGROUND_LEVELS,
  PROVIDER_VERIFICATION_LEVELS,
  type ProviderCatalogEntry,
  type ProviderCatalogProjection,
  type ProviderVerificationLevel,
} from "../src/service/types.js";
import {
  defaultProductAcpAdapters,
  isProviderVerificationLevel,
  PRODUCT_ACP_ADAPTER_IDS,
  projectProviderCatalog,
  providerCatalogEntry,
} from "../src/service/provider-catalog.js";

const LEVEL_SET = new Set<string>(PROVIDER_VERIFICATION_LEVELS);

/**
 * Expected verification levels from repository evidence.
 * opt-in-live-probe = checked-in opt-in script exists (NOT full CI certification).
 * mock-tested = offline mock only.
 * live-verified must not be used merely because a script exists.
 */
const EXPECTED_LEVELS: Record<string, ProviderVerificationLevel> = {
  "grok-acp": "opt-in-live-probe",
  "codex-acp": "opt-in-live-probe",
  "claude-acp": "opt-in-live-probe",
  "opencode-acp": "opt-in-live-probe",
  "copilot-acp": "opt-in-live-probe",
  "pi-acp": "mock-tested",
};

const EXPECTED_FOREGROUND = {
  "grok-acp": "verified",
  "codex-acp": "verified",
  "claude-acp": "verified",
  "opencode-acp": "verified",
  "copilot-acp": "verified",
  "pi-acp": "unverified",
} as const;

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-prov-cat-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

test("CLIENT_METHODS includes provider.catalog", () => {
  assert.ok(isClientMethod("provider.catalog"));
  assert.ok(CLIENT_METHODS.includes("provider.catalog"));
});

test("PROVIDER_VERIFICATION_LEVELS is the closed honest enum", () => {
  assert.deepEqual([...PROVIDER_VERIFICATION_LEVELS], [
    "adapter-implemented",
    "mock-tested",
    "opt-in-live-probe",
    "live-verified",
  ]);
  assert.ok(isProviderVerificationLevel("opt-in-live-probe"));
  assert.ok(isProviderVerificationLevel("live-verified"));
  assert.ok(isProviderVerificationLevel("mock-tested"));
  // Legacy / marketing names are not product levels.
  assert.ok(!isProviderVerificationLevel("live-e2e"));
  assert.ok(!isProviderVerificationLevel("live-tested"));
  assert.ok(!isProviderVerificationLevel("mock"));
});

test("projectProviderCatalog covers every product adapter with closed levels", () => {
  const { providers } = projectProviderCatalog();
  assert.equal(providers.length, PRODUCT_ACP_ADAPTER_IDS.length);
  assert.deepEqual(
    providers.map((p) => p.adapterId),
    [...PRODUCT_ACP_ADAPTER_IDS]
  );

  const adaptersById = new Map(
    defaultProductAcpAdapters().map((a) => [a.id, a])
  );

  for (const entry of providers) {
    assert.ok(LEVEL_SET.has(entry.verificationLevel), entry.adapterId);
    const expectedLevel = EXPECTED_LEVELS[entry.adapterId];
    assert.ok(expectedLevel, `unexpected adapterId in catalog: ${entry.adapterId}`);
    assert.equal(entry.verificationLevel, expectedLevel);

    // canResume is derived from the live adapter capabilities — not a second map.
    const adapter = adaptersById.get(entry.adapterId);
    assert.ok(adapter, entry.adapterId);
    assert.equal(entry.canResume, adapter.capabilities().canResume);

    // Minimal projection: no secret-shaped or env-value fields.
    assert.equal(
      Object.keys(entry).every((k) =>
        ["adapterId", "verificationLevel", "canResume", "nativeForeground", "notes"].includes(k)
      ),
      true
    );
    assert.ok(NATIVE_FOREGROUND_LEVELS.includes(entry.nativeForeground));
    assert.equal(
      entry.nativeForeground,
      EXPECTED_FOREGROUND[entry.adapterId as keyof typeof EXPECTED_FOREGROUND]
    );
    assert.ok(!("envKey" in entry));
    assert.ok(!("credentialRef" in entry));
    assert.ok(!("baseUrl" in entry));
    assert.ok(!("secret" in entry));
    assert.ok(!("apiKey" in entry));
    assert.ok(!("command" in entry));
    assert.ok(!("args" in entry));
  }

  // Product short names present as adapterId prefixes.
  const shortNames = ["grok", "codex", "claude", "copilot", "opencode", "pi"];
  for (const name of shortNames) {
    assert.ok(
      providers.some((p) => p.adapterId === `${name}-acp` || p.adapterId === name),
      `missing product adapter for ${name}`
    );
  }

  // Opt-in live probes exist for these adapters — not live-verified badges.
  const optIn = providers.filter((p) => p.verificationLevel === "opt-in-live-probe");
  assert.deepEqual(
    optIn.map((p) => p.adapterId),
    ["grok-acp", "codex-acp", "claude-acp", "opencode-acp", "copilot-acp"]
  );
  // Catalog must not claim live-verified merely because a script exists.
  assert.equal(
    providers.filter((p) => p.verificationLevel === "live-verified").length,
    0
  );
  // Mock-only product adapters.
  assert.equal(providerCatalogEntry("antigravity-acp"), undefined);
  assert.equal(providerCatalogEntry("pi-acp")?.verificationLevel, "mock-tested");

  // Resume evidence: every current product adapter has a verified native restore path.
  assert.equal(providerCatalogEntry("grok-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("opencode-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("codex-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("claude-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("copilot-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("pi-acp")?.canResume, true);
  assert.equal(providerCatalogEntry("fake-cli"), undefined);
  assert.equal(providerCatalogEntry("gemini-acp"), undefined);
});

test("defaultProductAcpAdapters drift-check against PRODUCT_ACP_ADAPTER_IDS", () => {
  const adapters = defaultProductAcpAdapters();
  const adapterIds = adapters.map((a) => a.id as string).sort();
  const productIds = ([...PRODUCT_ACP_ADAPTER_IDS] as string[]).sort();
  assert.deepEqual(
    adapterIds,
    productIds,
    "default product ACP adapters must match PRODUCT_ACP_ADAPTER_IDS exactly"
  );
  // No fake / test-only adapters in the product verification set.
  assert.ok(!adapterIds.includes("fake-cli"));
});

test("provider.catalog RPC returns registry projection without secrets", async () => {
  await withService(async (svc) => {
    const res = await rpcCall(svc.url, "provider.catalog", {}, { token: svc.token });
    assert.ok(!res.error, JSON.stringify(res.error));
    const body = res.result as ProviderCatalogProjection;
    assert.ok(Array.isArray(body.providers));
    assert.equal(body.providers.length, PRODUCT_ACP_ADAPTER_IDS.length);

    const byId = new Map(body.providers.map((p) => [p.adapterId, p]));
    for (const id of PRODUCT_ACP_ADAPTER_IDS) {
      const entry = byId.get(id) as ProviderCatalogEntry;
      assert.ok(entry, id);
      assert.equal(entry.verificationLevel, EXPECTED_LEVELS[id]);
      assert.equal(
        entry.canResume,
        projectProviderCatalog().providers.find((p) => p.adapterId === id)?.canResume
      );
    }

    const json = JSON.stringify(body);
    assert.ok(!/api[_-]?key/i.test(json));
    assert.ok(!/secret/i.test(json));
    assert.ok(!/password/i.test(json));
    // "token" alone is too broad (e.g. resumeToken field names); ban secret shapes.
    assert.ok(!/"token"\s*:/i.test(json));
    assert.ok(!/credential/i.test(json));
    assert.ok(!/envKey/i.test(json));
  });
});

test("ServiceClient.providerCatalog convenience matches RPC", async () => {
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.providerCatalog()) as ProviderCatalogProjection;
    assert.deepEqual(result, projectProviderCatalog());
  });
});
