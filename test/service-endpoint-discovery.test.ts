import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  MAX_SERVICE_ENDPOINT_CANDIDATES,
  MAX_SERVICE_ENDPOINT_FILE_BYTES,
  readServiceEndpointCandidates,
  removeServiceEndpoint,
  serviceEndpointPath,
  writeServiceEndpoint,
  type ServiceEndpointRecord,
} from "../src/service/data-dir.js";
import {
  discoverAuthenticatedServiceEndpoint,
  MultipleHealthyServiceEndpointsError,
} from "../src/service/endpoint-discovery.js";
import { ServiceProtocolIncompatibleError } from "../src/service/protocol.js";

function endpoint(
  suffix: string,
  offsetMs = 0,
  overrides: Partial<ServiceEndpointRecord> = {}
): ServiceEndpointRecord {
  return {
    instanceId: `instance-${suffix}`,
    pid: 10_000 + offsetMs,
    host: "127.0.0.1",
    port: 20_000 + offsetMs,
    startedAt: new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString(),
    version: "0.1.0",
    token: `token-${suffix}`,
    ...overrides,
  };
}

async function tempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-endpoint-generation-"));
}

async function putGeneration(
  dataDir: string,
  record: ServiceEndpointRecord,
  body: string = JSON.stringify(record, null, 2) + "\n"
): Promise<string> {
  await fs.mkdir(dataDir, { recursive: true });
  const file = serviceEndpointPath(dataDir, record.instanceId, record.startedAt);
  await fs.writeFile(file, body, "utf8");
  return file;
}

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(absolute);
  }
  return result;
}

test("production source never reads or advertises the legacy mutable endpoint singleton", async () => {
  const srcRoot = path.resolve("src");
  const matches: string[] = [];
  for (const file of await sourceFiles(srcRoot)) {
    const text = await fs.readFile(file, "utf8");
    if (!text.includes("service.json")) continue;
    matches.push(path.relative(srcRoot, file).replaceAll("\\", "/"));
  }
  assert.deepEqual(matches, ["service/data-dir.ts"]);
  const dataDirSource = await fs.readFile(path.join(srcRoot, "service", "data-dir.ts"), "utf8");
  assert.match(dataDirSource, /legacy mutable `service\.json` singleton is intentionally not read/);

  for (const relative of [
    "cli/service-attach.ts",
    "desktop/client/service-attach.ts",
    "desktop/main/service-host.ts",
  ]) {
    const attachSource = await fs.readFile(path.join(srcRoot, ...relative.split("/")), "utf8");
    assert.doesNotMatch(attachSource, /\bclient\.health\s*\(/);
    assert.doesNotMatch(attachSource, /fetch\s*\([^\n]*\/health/);
  }
});

test("immutable endpoint generation publishes while an older generation is open", async () => {
  const dataDir = await tempDataDir();
  const old = endpoint("old", 1);
  const current = endpoint("current", 100);
  const oldFile = await putGeneration(dataDir, old);
  for (let index = 0; index < MAX_SERVICE_ENDPOINT_CANDIDATES; index += 1) {
    await putGeneration(dataDir, endpoint(`filler-${index}`, 10 + index));
  }
  const oldHandle = await fs.open(oldFile, "r");
  try {
    const currentFile = await writeServiceEndpoint(dataDir, current);
    assert.equal(
      path.basename(currentFile),
      path.basename(serviceEndpointPath(dataDir, current.instanceId, current.startedAt))
    );
    assert.equal((await readServiceEndpointCandidates(dataDir))[0]?.instanceId, current.instanceId);
    await assert.rejects(() => writeServiceEndpoint(dataDir, current), /EEXIST/);
  } finally {
    await oldHandle.close();
  }
});

test("endpoint enumeration is strict, bounded, deterministic, and ignores legacy singleton", async () => {
  const dataDir = await tempDataDir();
  await fs.writeFile(
    path.join(dataDir, "service.json"),
    JSON.stringify(endpoint("legacy", 1)),
    "utf8"
  );
  const mismatched = endpoint("mismatch", 2);
  await putGeneration(dataDir, mismatched, JSON.stringify({ ...mismatched, instanceId: "other" }));
  const malformed = endpoint("malformed", 3);
  await putGeneration(dataDir, malformed, "{not-json");
  const oversized = endpoint("oversized", 4);
  await putGeneration(dataDir, oversized, "x".repeat(MAX_SERVICE_ENDPOINT_FILE_BYTES + 1));

  const valid: ServiceEndpointRecord[] = [];
  for (let index = 0; index < MAX_SERVICE_ENDPOINT_CANDIDATES + 1; index += 1) {
    const record = endpoint(`bounded-${index}`, 100 + index);
    valid.push(record);
    await putGeneration(dataDir, record);
  }

  const discovered = await readServiceEndpointCandidates(dataDir);
  assert.equal(discovered.length, MAX_SERVICE_ENDPOINT_CANDIDATES);
  assert.equal(discovered[0]?.instanceId, valid.at(-1)?.instanceId);
  assert.equal(discovered.at(-1)?.instanceId, valid[1]?.instanceId);
  assert.equal(discovered.some((record) => record.instanceId === "instance-legacy"), false);
});

test("publication best-effort removes only strict generations outside the newest bounded set", async () => {
  const dataDir = await tempDataDir();
  for (let index = 0; index < MAX_SERVICE_ENDPOINT_CANDIDATES + 1; index += 1) {
    await putGeneration(dataDir, endpoint(`cleanup-${index}`, 100 + index));
  }
  const current = endpoint("cleanup-current", 1_000);
  await writeServiceEndpoint(dataDir, current);

  const deadline = Date.now() + 2_000;
  let names: string[] = [];
  do {
    names = (await fs.readdir(dataDir)).filter(
      (name) => name.startsWith("service.endpoint.") && name.endsWith(".json")
    );
    if (names.length <= MAX_SERVICE_ENDPOINT_CANDIDATES) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.equal(names.length, MAX_SERVICE_ENDPOINT_CANDIDATES);
  assert.equal((await readServiceEndpointCandidates(dataDir))[0]?.instanceId, current.instanceId);
});

test("top-set endpoint reads skip corrupt generations and enforce an exact byte bound", async () => {
  const dataDir = await tempDataDir();
  const valid = endpoint("valid-top", 1);
  await putGeneration(dataDir, valid);

  const mismatched = endpoint("mismatch-top", 2);
  await putGeneration(
    dataDir,
    mismatched,
    JSON.stringify({ ...mismatched, instanceId: "different-instance" })
  );
  const malformed = endpoint("malformed-top", 3);
  await putGeneration(dataDir, malformed, "{broken");

  const exactLimit = endpoint("exact-limit", 4);
  const exactJson = JSON.stringify(exactLimit);
  assert.ok(Buffer.byteLength(exactJson, "utf8") < MAX_SERVICE_ENDPOINT_FILE_BYTES);
  await putGeneration(
    dataDir,
    exactLimit,
    exactJson + " ".repeat(MAX_SERVICE_ENDPOINT_FILE_BYTES - Buffer.byteLength(exactJson, "utf8"))
  );

  const overLimit = endpoint("over-limit", 5);
  await putGeneration(dataDir, overLimit, " ".repeat(MAX_SERVICE_ENDPOINT_FILE_BYTES + 1));

  const discovered = await readServiceEndpointCandidates(dataDir);
  assert.deepEqual(
    discovered.map((record) => record.instanceId),
    [exactLimit.instanceId, valid.instanceId]
  );
});

test("authenticated discovery classifies protocol before compatible identity", async () => {
  const dataDir = await tempDataDir();
  const candidate = endpoint("protocol", 1);
  await putGeneration(dataDir, candidate);

  await assert.rejects(
    () =>
      discoverAuthenticatedServiceEndpoint(dataDir, async () => ({
        health: { status: "ok", pid: candidate.pid, startedAt: candidate.startedAt },
        value: "legacy",
      })),
    (error: unknown) =>
      error instanceof ServiceProtocolIncompatibleError && error.kind === "missing"
  );
  await assert.rejects(
    () =>
      discoverAuthenticatedServiceEndpoint(dataDir, async () => ({
        health: {
          status: "ok",
          protocolVersion: 4,
          pid: candidate.pid,
          startedAt: candidate.startedAt,
        },
        value: "old-protocol",
      })),
    (error: unknown) =>
      error instanceof ServiceProtocolIncompatibleError && error.kind === "mismatch"
  );
  assert.equal(
    await discoverAuthenticatedServiceEndpoint(dataDir, async () => ({
      health: {
        status: "ok",
        protocolVersion: 5,
        instanceId: "wrong-instance",
        pid: candidate.pid,
        startedAt: candidate.startedAt,
      },
      value: "wrong-identity",
    })),
    null
  );
});

test("authenticated discovery fails loud for any incompatible or multiple compatible live Services", async () => {
  const dataDir = await tempDataDir();
  const first = endpoint("first", 1);
  const second = endpoint("second", 2);
  await putGeneration(dataDir, first);
  await putGeneration(dataDir, second);

  await assert.rejects(
    () =>
      discoverAuthenticatedServiceEndpoint(dataDir, async (candidate) => ({
        health: {
          status: "ok",
          protocolVersion: candidate.instanceId === first.instanceId ? 4 : 5,
          instanceId: candidate.instanceId,
          pid: candidate.pid,
          startedAt: candidate.startedAt,
        },
        value: candidate.instanceId,
      })),
    ServiceProtocolIncompatibleError
  );
  await assert.rejects(
    () =>
      discoverAuthenticatedServiceEndpoint(dataDir, async (candidate) => ({
        health: {
          status: "ok",
          protocolVersion: 5,
          instanceId: candidate.instanceId,
          pid: candidate.pid,
          startedAt: candidate.startedAt,
        },
        value: candidate.instanceId,
      })),
    MultipleHealthyServiceEndpointsError
  );

  await removeServiceEndpoint(dataDir, first);
  const remaining = await readServiceEndpointCandidates(dataDir);
  assert.deepEqual(remaining.map((record) => record.instanceId), [second.instanceId]);
});
