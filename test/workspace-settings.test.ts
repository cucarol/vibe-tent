/**
 * Core workspace settings (.tent/settings.json).
 * Layer: normalize/default, corruption backup, mutation no-op, system-file registration.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  isSystemNoteName,
  SYSTEM_REGISTRY_FILES,
  WORKSPACE_SETTINGS_PATH,
} from "../src/core/paths.js";
import {
  DEFAULT_DELIVERY_POLICY,
  isDeliveryPolicy,
  normalizeDeliveryPolicyRead,
} from "../src/core/task-model.js";
import {
  defaultWorkspaceSettings,
  loadWorkspaceSettings,
  normalizeWorkspaceSettings,
  saveWorkspaceSettings,
  updateWorkspaceSettings,
  WorkspaceSettingsError,
} from "../src/core/workspace-settings.js";

async function makeSystemRoot(): Promise<{ root: string; fsa: NodeFs }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-settings-"));
  const fsa = new NodeFs(root);
  return { root, fsa };
}

test("settings.json is registered as a system file", () => {
  assert.equal(WORKSPACE_SETTINGS_PATH, "settings.json");
  assert.ok(SYSTEM_REGISTRY_FILES.has(WORKSPACE_SETTINGS_PATH));
  assert.ok(isSystemNoteName(WORKSPACE_SETTINGS_PATH));
});

test("DEFAULT_DELIVERY_POLICY is canonical on task-model (no workspace-settings re-export shim)", async () => {
  assert.equal(DEFAULT_DELIVERY_POLICY, "review");
  assert.equal(defaultWorkspaceSettings().defaultDeliveryPolicy, DEFAULT_DELIVERY_POLICY);
  assert.equal(isDeliveryPolicy("review"), true);
  assert.equal(isDeliveryPolicy("manual"), false);
  assert.equal(normalizeDeliveryPolicyRead("manual"), "review");
  assert.equal(normalizeDeliveryPolicyRead("review"), "review");
  // Display labels are UI/docs-owned; Core must not export product label maps.
  const taskModel = await import("../src/core/task-model.js");
  assert.equal("DELIVERY_POLICY_PRODUCT_LABELS" in taskModel, false);
  // V0.2 canonical default lives on task-model; workspace-settings imports it, does not re-export.
  const settingsMod = await import("../src/core/workspace-settings.js");
  assert.equal("DEFAULT_DELIVERY_POLICY" in settingsMod, false);
});

test("normalizeWorkspaceSettings: missing/invalid defaultDeliveryPolicy → review", () => {
  assert.deepEqual(normalizeWorkspaceSettings(undefined), {
    defaultDeliveryPolicy: "review",
  });
  assert.deepEqual(normalizeWorkspaceSettings(null), {
    defaultDeliveryPolicy: "review",
  });
  assert.deepEqual(normalizeWorkspaceSettings({}), {
    defaultDeliveryPolicy: "review",
  });
  assert.deepEqual(normalizeWorkspaceSettings({ defaultDeliveryPolicy: "nope" }), {
    defaultDeliveryPolicy: "review",
  });
  // Historical on-disk `manual` normalizes to `review` at the read boundary only.
  assert.deepEqual(normalizeWorkspaceSettings({ defaultDeliveryPolicy: "manual" }), {
    defaultDeliveryPolicy: "review",
  });
  assert.deepEqual(normalizeWorkspaceSettings({ defaultDeliveryPolicy: "bypass" }), {
    defaultDeliveryPolicy: "bypass",
  });
  assert.deepEqual(normalizeWorkspaceSettings({ defaultDeliveryPolicy: "agent-decide" }), {
    defaultDeliveryPolicy: "agent-decide",
  });
  // Extensibility: unknown keys preserved
  const ext = normalizeWorkspaceSettings({
    defaultDeliveryPolicy: "review",
    futureFlag: true,
    nested: { a: 1 },
  });
  assert.equal(ext.defaultDeliveryPolicy, "review");
  assert.equal(ext.futureFlag, true);
  assert.deepEqual(ext.nested, { a: 1 });
});

test("loadWorkspaceSettings: missing file → defaults; valid file loads", async () => {
  const { fsa } = await makeSystemRoot();
  const missing = await loadWorkspaceSettings(fsa);
  assert.deepEqual(missing, defaultWorkspaceSettings());
  assert.equal(await fsa.exists(WORKSPACE_SETTINGS_PATH), false);

  await fsa.writeFile(
    WORKSPACE_SETTINGS_PATH,
    JSON.stringify({ defaultDeliveryPolicy: "bypass", note: "x" }, null, 2) + "\n"
  );
  const loaded = await loadWorkspaceSettings(fsa);
  assert.equal(loaded.defaultDeliveryPolicy, "bypass");
  assert.equal(loaded.note, "x");
});

test("loadWorkspaceSettings: historical on-disk manual → review projection", async () => {
  const { fsa } = await makeSystemRoot();
  await fsa.writeFile(
    WORKSPACE_SETTINGS_PATH,
    JSON.stringify({ defaultDeliveryPolicy: "manual" }, null, 2) + "\n"
  );
  const loaded = await loadWorkspaceSettings(fsa);
  assert.equal(loaded.defaultDeliveryPolicy, "review");
});

test("loadWorkspaceSettings: corrupt file → backup, reset, warning", async () => {
  const { root, fsa } = await makeSystemRoot();
  await fsa.writeFile(WORKSPACE_SETTINGS_PATH, "{not-json");

  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const loaded = await loadWorkspaceSettings(fsa);
    assert.deepEqual(loaded, defaultWorkspaceSettings());
  } finally {
    console.error = orig;
  }

  assert.ok(warnings.some((w) => /settings\.json was corrupt/i.test(w)));
  const entries = await fs.readdir(root);
  assert.ok(entries.some((n) => n.startsWith("settings.json.corrupt-")));
  const resetRaw = await fsa.readFile(WORKSPACE_SETTINGS_PATH);
  assert.equal(JSON.parse(resetRaw).defaultDeliveryPolicy, "review");
});

test("saveWorkspaceSettings + updateWorkspaceSettings: mutation-safe and no-op detection", async () => {
  const { fsa } = await makeSystemRoot();

  const saved = await saveWorkspaceSettings(fsa, {
    defaultDeliveryPolicy: "agent-decide",
    tag: "a",
  });
  assert.equal(saved.defaultDeliveryPolicy, "agent-decide");
  assert.equal(saved.tag, "a");

  const noop = await updateWorkspaceSettings(fsa, {
    defaultDeliveryPolicy: "agent-decide",
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.settings.defaultDeliveryPolicy, "agent-decide");

  const changed = await updateWorkspaceSettings(fsa, {
    defaultDeliveryPolicy: "bypass",
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.settings.defaultDeliveryPolicy, "bypass");
  assert.equal(changed.settings.tag, "a");

  const emptyPatch = await updateWorkspaceSettings(fsa, {});
  assert.equal(emptyPatch.changed, false);

  await assert.rejects(
    () => updateWorkspaceSettings(fsa, { defaultDeliveryPolicy: "nope" }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceSettingsError);
      assert.equal(err.code, "INVALID_DELIVERY_POLICY");
      return true;
    }
  );

  // New writes reject historical `manual` (read-only migration value).
  await assert.rejects(
    () => updateWorkspaceSettings(fsa, { defaultDeliveryPolicy: "manual" as never }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceSettingsError);
      assert.equal(err.code, "INVALID_DELIVERY_POLICY");
      return true;
    }
  );
});
