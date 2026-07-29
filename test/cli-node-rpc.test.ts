import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ServiceClient } from "../src/service/client.js";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-rpc.js";

function fakeClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const concept = (id: string, path: string, type = "prompt") => ({
    concept: { id, name: path.split("/").at(-1) ?? path, path, type },
  });
  const client = {
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-node-cli",
      workspaceRoot,
      systemRoot: `${workspaceRoot}/.tent`,
    }),
    docsList: async (...args: unknown[]) => {
      calls.push({ method: "docsList", args });
      return { concepts: [] };
    },
    docsGet: async (_workspaceId: string, ref: { id?: string; path?: string }) => {
      calls.push({ method: "docsGet", args: [_workspaceId, ref] });
      if (ref.id === "cx-parent") return concept("cx-parent", "Project");
      if (ref.id === "cx-child") return concept("cx-child", "Project/Context");
      if (ref.id) return concept(ref.id, `Node-${ref.id}`);
      return concept("cx-path", String(ref.path));
    },
    docsCreateNote: async (...args: unknown[]) => {
      calls.push({ method: "docsCreateNote", args });
      return { id: "cx-child", path: "Project/Context" };
    },
    docsReadForEdit: async (...args: unknown[]) => {
      calls.push({ method: "docsReadForEdit", args });
      return { id: "cx-child", path: "Project/Context", etag: "etag-1" };
    },
    registryTagCreate: async (...args: unknown[]) => {
      calls.push({ method: "registryTagCreate", args });
      return {};
    },
    docsTagsSet: async (...args: unknown[]) => {
      calls.push({ method: "docsTagsSet", args });
      return {};
    },
    docsWrite: async (...args: unknown[]) => {
      calls.push({ method: "docsWrite", args });
      return { id: "cx-child", etag: "etag-2" };
    },
    docsMove: async (...args: unknown[]) => {
      calls.push({ method: "docsMove", args });
      return { id: "cx-child", path: "Target/Context" };
    },
  };
  return { client: client as unknown as ServiceClient, calls };
}

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-cli-"));
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent", "index.md"), "# Index\n");
  return workspace;
}

test("node CLI help exposes only Service-backed Node operations", () => {
  const help = nodeHelpText();
  assert.match(help, /tent node create/);
  assert.match(help, /Local Service/);
  assert.doesNotMatch(help, /new-box|direct-write/);
});

test("node create resolves parent, writes body, and applies approved tags", async () => {
  const { client, calls } = fakeClient();
  const workspace = await makeWorkspace();
  const result = await runNodeCommand(
    "create",
    [
      "Context",
      "--type",
      "prompt",
      "--parent",
      "cx-parent",
      "--body",
      "Current project context",
      "--tags",
      "onboarding,context",
      "--json",
    ],
    { client, cwd: workspace, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const create = calls.find((entry) => entry.method === "docsCreateNote");
  assert.deepEqual(create?.args[1], {
    name: "Context",
    type: "prompt",
    parentPath: "Project",
    body: "Current project context",
  });
  assert.equal(calls.filter((entry) => entry.method === "registryTagCreate").length, 2);
  const tags = calls.find((entry) => entry.method === "docsTagsSet");
  assert.deepEqual(tags?.args[1], {
    id: "cx-child",
    tags: ["onboarding", "context"],
    baseEtag: "etag-1",
  });
});

test("node write obtains the authoritative etag before mutation", async () => {
  const { client, calls } = fakeClient();
  const workspace = await makeWorkspace();
  const result = await runNodeCommand(
    "write",
    ["cx-child", "--body", "Updated"],
    { client, cwd: workspace }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const write = calls.find((entry) => entry.method === "docsWrite");
  assert.deepEqual(write?.args[1], {
    id: "cx-child",
    body: "Updated",
    baseEtag: "etag-1",
  });
});

test("node move uses stable id plus current expectedPath", async () => {
  const { client, calls } = fakeClient();
  const workspace = await makeWorkspace();
  const result = await runNodeCommand(
    "move",
    ["cx-child", "--parent", "cx-parent", "--json"],
    { client, cwd: workspace, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const move = calls.find((entry) => entry.method === "docsMove");
  assert.deepEqual(move?.args[1], {
    id: "cx-child",
    expectedPath: "Project/Context",
    newParentId: "cx-parent",
    position: { mode: "inside" },
  });
});

test("node CLI rejects path-based structural move and missing write body", async () => {
  const { client } = fakeClient();
  const workspace = await makeWorkspace();
  const move = await runNodeCommand("move", ["Project/Context", "--parent", "root"], {
    client,
    cwd: workspace,
  });
  assert.notEqual(move.exitCode, 0);
  assert.match(move.stderr, /stable cx- id/);

  const write = await runNodeCommand("write", ["cx-child"], {
    client,
    cwd: workspace,
  });
  assert.notEqual(write.exitCode, 0);
  assert.match(write.stderr, /--body/);
});
