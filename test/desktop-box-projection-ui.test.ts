/**
 * Desktop box.projection + document empty-state + backlinks wiring (workbench layer).
 * Pure helpers + static source contracts — no Electron.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyBoxProjectionsToTree,
  boxProjectionSummaryLine,
  boxStatusLabel,
  collectCoordinationBoxIds,
  normalizeBoxProjection,
} from "../src/desktop/workbench/box-projection.js";
import { documentEmptyCopy } from "../src/desktop/workbench/open-tabs.js";

const root = process.cwd();

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8");
}

test("normalizeBoxProjection accepts todo/doing/done only", () => {
  assert.equal(normalizeBoxProjection(null), null);
  assert.equal(normalizeBoxProjection({ workspaceId: "w", boxId: "cx-1", status: "running" }), null);
  const ok = normalizeBoxProjection({
    workspaceId: "w",
    boxId: "cx-1",
    status: "doing",
    assignee: "reviewer",
    activeTaskId: "task-9",
  });
  assert.deepEqual(ok, {
    workspaceId: "w",
    boxId: "cx-1",
    status: "doing",
    assignee: "reviewer",
    activeTaskId: "task-9",
  });
  const bare = normalizeBoxProjection({
    workspaceId: "w",
    id: "cx-2",
    status: "todo",
  });
  assert.equal(bare?.boxId, "cx-2");
  assert.equal(bare?.status, "todo");
  assert.equal(bare?.assignee, undefined);
});

test("collectCoordinationBoxIds walks tree depth-first", () => {
  const ids = collectCoordinationBoxIds([
    {
      id: "n1",
      coordination: false,
      children: [
        { id: "c1", coordination: true },
        {
          id: "c2",
          coordination: false,
          children: [{ id: "c2a", coordination: true }],
        },
      ],
    },
    { id: "g1", coordination: true },
  ]);
  assert.deepEqual(ids, ["c1", "c2a", "g1"]);
});

test("applyBoxProjectionsToTree strips list collab and overlays projection", () => {
  const tree = [
    {
      id: "cx-idle",
      coordination: true,
      status: "doing", // stale list field — must not win without projection
      assignee: "stale-owner",
      children: [],
    },
    {
      id: "cx-busy",
      coordination: true,
      status: "todo",
      children: [],
    },
    {
      id: "note-1",
      coordination: false,
      status: "todo",
      children: [],
    },
  ];
  const map = new Map([
    [
      "cx-busy",
      {
        workspaceId: "w",
        boxId: "cx-busy",
        status: "doing" as const,
        assignee: "agent-a",
        activeTaskId: "t1",
      },
    ],
  ]);
  const next = applyBoxProjectionsToTree(tree, map);
  assert.equal(next[0]!.status, undefined);
  assert.equal(next[0]!.assignee, undefined);
  assert.equal(next[1]!.status, "doing");
  assert.equal(next[1]!.assignee, "agent-a");
  assert.equal(next[2]!.status, undefined);
  assert.equal(next[2]!.assignee, undefined);
});

test("boxStatusLabel / summary line are Chinese and projection-only", () => {
  assert.equal(boxStatusLabel("doing"), "进行中");
  assert.equal(boxStatusLabel("todo"), "待办");
  assert.equal(boxStatusLabel("done"), "完成");
  assert.equal(boxProjectionSummaryLine(null), null);
  assert.equal(
    boxProjectionSummaryLine({
      workspaceId: "w",
      boxId: "cx",
      status: "doing",
      assignee: "r",
    }),
    "进行中 · r"
  );
  assert.equal(
    boxProjectionSummaryLine({ workspaceId: "w", boxId: "cx", status: "todo" }),
    "待办"
  );
});

test("documentEmptyCopy exposes left-click open-workspace when no mount", () => {
  const noWs = documentEmptyCopy(false);
  assert.equal(noWs.action, "open-workspace");
  assert.equal(noWs.title, "打开工作区");
  assert.ok(noWs.hint);

  const emptyDocs = documentEmptyCopy(true);
  assert.equal(emptyDocs.action, null);
  assert.equal(emptyDocs.title, "未打开文档");
});

test("renderer sources wire box.projection, backlinks, empty open-ws (no frontmatter status)", async () => {
  const stateTs = await read("src/desktop/renderer/main/state.ts");
  const treeTs = await read("src/desktop/renderer/main/tree.ts");
  const inspectorTs = await read("src/desktop/renderer/main/inspector.ts");
  const documentTs = await read("src/desktop/renderer/main/document.ts");
  const shellTs = await read("src/desktop/workbench/shell-model.ts");
  const html = await read("src/desktop/renderer/index.html");
  const docsClient = await read("src/desktop/client/service-docs-client.ts");

  assert.match(stateTs, /box\.projection/);
  assert.match(stateTs, /reloadBoxProjections/);
  assert.match(stateTs, /docs\.backlinks/);
  assert.match(stateTs, /stripListCollabFields|status: _s/);
  assert.match(stateTs, /clearLocalDocumentSession/);

  assert.match(treeTs, /boxStatusLabel/);
  // Tree marks only todo|doing — not frontmatter synonyms like in_progress
  assert.doesNotMatch(treeTs, /in_progress/);

  assert.match(inspectorTs, /boxProjectionFor|boxProjectionSummaryLine/);
  assert.match(inspectorTs, /renderBacklinks/);
  assert.match(inspectorTs, /docs\.rename/);
  assert.match(inspectorTs, /不可变|不可改/);

  assert.match(documentTs, /data-empty-act="open-ws"/);
  assert.match(documentTs, /openWorkspace/);
  assert.match(documentTs, /onConceptOpened/);

  assert.match(shellTs, /box\.projection/);
  assert.match(shellTs, /refreshBoxProjections/);

  assert.match(html, /id="sec-backlinks"/);
  assert.match(html, /id="backlinks-host"/);

  assert.match(docsClient, /docs\.rename/);
  assert.match(docsClient, /docs\.setMode/);
});
