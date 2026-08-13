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
  DEFAULT_ACCEPT_MODE,
  isAcceptMode,
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

test("DEFAULT_ACCEPT_MODE is canonical on task-model (no workspace-settings re-export shim)", async () => {
  assert.equal(DEFAULT_ACCEPT_MODE, "review-required");
  assert.equal(defaultWorkspaceSettings().defaultAcceptMode, DEFAULT_ACCEPT_MODE);
  assert.equal(isAcceptMode("review-required"), true);
  assert.equal(isAcceptMode("auto-accept"), true);
  assert.equal(isAcceptMode("agent-decide"), true);
  assert.equal(isAcceptMode("review"), false);
  assert.equal(isAcceptMode("bypass"), false);
  assert.equal(isAcceptMode("manual"), false);
  // Display labels are UI/docs-owned; Core must not export product label maps.
  const taskModel = await import("../src/core/task-model.js");
  assert.equal("DELIVERY_POLICY_PRODUCT_LABELS" in taskModel, false);
  // V0.2 canonical default lives on task-model; workspace-settings imports it, does not re-export.
  const settingsMod = await import("../src/core/workspace-settings.js");
  assert.equal("DEFAULT_ACCEPT_MODE" in settingsMod, false);
});

test("normalizeWorkspaceSettings: omitted mode defaults; invalid/retired values fail loud", () => {
  assert.throws(() => normalizeWorkspaceSettings(undefined), WorkspaceSettingsError);
  assert.throws(() => normalizeWorkspaceSettings(null), WorkspaceSettingsError);
  assert.deepEqual(normalizeWorkspaceSettings({}), {
    defaultAcceptMode: "review-required",
  });
  for (const value of ["nope", "manual", "review", "bypass"]) {
    assert.throws(
      () => normalizeWorkspaceSettings({ defaultAcceptMode: value }),
      (err: unknown) =>
        err instanceof WorkspaceSettingsError && err.code === "INVALID_ACCEPT_MODE"
    );
  }
  assert.throws(
    () => normalizeWorkspaceSettings({ defaultTaskResultPolicy: "review" }),
    (err: unknown) =>
      err instanceof WorkspaceSettingsError && err.code === "INVALID_ACCEPT_MODE"
  );
  assert.deepEqual(normalizeWorkspaceSettings({ defaultAcceptMode: "auto-accept" }), {
    defaultAcceptMode: "auto-accept",
  });
  assert.deepEqual(normalizeWorkspaceSettings({ defaultAcceptMode: "agent-decide" }), {
    defaultAcceptMode: "agent-decide",
  });
  // Extensibility: unknown keys preserved
  const ext = normalizeWorkspaceSettings({
    defaultAcceptMode: "review-required",
    futureFlag: true,
    nested: { a: 1 },
  });
  assert.equal(ext.defaultAcceptMode, "review-required");
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
    JSON.stringify({ defaultAcceptMode: "auto-accept", note: "x" }, null, 2) + "\n"
  );
  const loaded = await loadWorkspaceSettings(fsa);
  assert.equal(loaded.defaultAcceptMode, "auto-accept");
  assert.equal(loaded.note, "x");
});

test("loadWorkspaceSettings: retired on-disk acceptance fields fail loud without rewrite", async () => {
  const { fsa } = await makeSystemRoot();
  for (const raw of [
    { defaultAcceptMode: "manual" },
    { defaultAcceptMode: "review" },
    { defaultAcceptMode: "bypass" },
    { defaultTaskResultPolicy: "review" },
  ]) {
    const serialized = JSON.stringify(raw, null, 2) + "\n";
    await fsa.writeFile(WORKSPACE_SETTINGS_PATH, serialized);
    await assert.rejects(
      () => loadWorkspaceSettings(fsa),
      (err: unknown) =>
        err instanceof WorkspaceSettingsError && err.code === "INVALID_ACCEPT_MODE"
    );
    assert.equal(await fsa.readFile(WORKSPACE_SETTINGS_PATH), serialized);
  }
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
  assert.equal(JSON.parse(resetRaw).defaultAcceptMode, "review-required");
});

test("saveWorkspaceSettings + updateWorkspaceSettings: mutation-safe and no-op detection", async () => {
  const { fsa } = await makeSystemRoot();

  const saved = await saveWorkspaceSettings(fsa, {
    defaultAcceptMode: "agent-decide",
    tag: "a",
  });
  assert.equal(saved.defaultAcceptMode, "agent-decide");
  assert.equal(saved.tag, "a");

  const noop = await updateWorkspaceSettings(fsa, {
    defaultAcceptMode: "agent-decide",
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.settings.defaultAcceptMode, "agent-decide");

  const changed = await updateWorkspaceSettings(fsa, {
    defaultAcceptMode: "auto-accept",
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.settings.defaultAcceptMode, "auto-accept");
  assert.equal(changed.settings.tag, "a");

  const emptyPatch = await updateWorkspaceSettings(fsa, {});
  assert.equal(emptyPatch.changed, false);

  await assert.rejects(
    () => updateWorkspaceSettings(fsa, { defaultAcceptMode: "nope" }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceSettingsError);
      assert.equal(err.code, "INVALID_ACCEPT_MODE");
      return true;
    }
  );

  for (const value of ["manual", "review", "bypass"] as const) {
    await assert.rejects(
      () => updateWorkspaceSettings(fsa, { defaultAcceptMode: value as never }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceSettingsError);
        assert.equal(err.code, "INVALID_ACCEPT_MODE");
        return true;
      }
    );
  }
});
