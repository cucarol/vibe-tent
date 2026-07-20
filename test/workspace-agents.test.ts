/**
 * Core workspace-root AGENTS.md (canonical fixed path).
 * Layer: path containment, missing→empty, atomic write, no-op detection.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  loadWorkspaceAgents,
  resolveWorkspaceAgentsPath,
  writeWorkspaceAgents,
  WORKSPACE_AGENTS_FILENAME,
  WorkspaceAgentsError,
} from "../src/core/workspace-agents.js";

async function makeWorkspaceRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-agents-"));
}

test("WORKSPACE_AGENTS_FILENAME is fixed AGENTS.md", () => {
  assert.equal(WORKSPACE_AGENTS_FILENAME, "AGENTS.md");
});

test("resolveWorkspaceAgentsPath: direct child of workspace root only", async () => {
  const root = await makeWorkspaceRoot();
  const resolved = resolveWorkspaceAgentsPath(root);
  assert.equal(path.basename(resolved), "AGENTS.md");
  assert.equal(path.dirname(resolved), path.resolve(root));
  // Nested / traversal names must not be accepted via basename contract.
  assert.equal(path.basename(path.resolve(root, "subdir/AGENTS.md")), "AGENTS.md");
  assert.notEqual(path.dirname(path.resolve(root, "subdir/AGENTS.md")), path.resolve(root));
});

test("loadWorkspaceAgents: missing file projects empty not-present", async () => {
  const root = await makeWorkspaceRoot();
  const file = await loadWorkspaceAgents(root);
  assert.equal(file.path, "AGENTS.md");
  assert.equal(file.content, "");
  assert.equal(file.exists, false);
  assert.equal(await fs.access(path.join(root, "AGENTS.md")).then(() => true).catch(() => false), false);
});

test("writeWorkspaceAgents: creates file atomically; no-op when unchanged", async () => {
  const root = await makeWorkspaceRoot();
  const body = "# Agents\n\nUse tent task deliver.\n";
  const created = await writeWorkspaceAgents(root, body);
  assert.equal(created.changed, true);
  assert.equal(created.file.exists, true);
  assert.equal(created.file.content, body);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), body);

  const noop = await writeWorkspaceAgents(root, body);
  assert.equal(noop.changed, false);
  assert.equal(noop.file.exists, true);
  assert.equal(noop.file.content, body);

  const updated = await writeWorkspaceAgents(root, body + "more\n");
  assert.equal(updated.changed, true);
  assert.equal(updated.file.content, body + "more\n");
});

test("writeWorkspaceAgents: missing → empty content still creates file (changed)", async () => {
  const root = await makeWorkspaceRoot();
  const result = await writeWorkspaceAgents(root, "");
  assert.equal(result.changed, true);
  assert.equal(result.file.exists, true);
  assert.equal(result.file.content, "");
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "");
});

test("writeWorkspaceAgents: non-string content fails loud", async () => {
  const root = await makeWorkspaceRoot();
  await assert.rejects(
    async () => writeWorkspaceAgents(root, 1 as unknown as string),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceAgentsError);
      assert.equal(err.code, "INVALID_CONTENT");
      return true;
    }
  );
});
