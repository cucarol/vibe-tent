/**
 * ACP image prompt projection — transport-only gate (promptCapabilities.image).
 * No connection capability flag. Paths only; never base64 on disk/Session/Connection.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_ACP_IMAGE_BYTES,
  acpTransportSupportsImage,
  collectBootstrapImageRefsFromTask,
  extractMarkdownImageRefs,
  fileUriForSystemRelative,
  normalizeSystemRelativePath,
  projectBootstrapImagesToAcpPrompt,
  resolveLocalImagePath,
} from "../src/adapters/acp/image-prompt.js";
import { createGrokAcpAdapter } from "../src/adapters/grok-acp/index.js";
import { createAgentRuntime } from "../src/runtime/index.js";
import type { StartSessionRequest } from "../src/runtime/types.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { BoundedBinaryRead } from "../src/core/adapter.js";

const MOCK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

/** Minimal valid 1×1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function completeBinary(bytes: Uint8Array): BoundedBinaryRead {
  return { bytes, truncated: false };
}

function startConnection(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: StartSessionRequest & { connectionId: string }
) {
  const { connectionId, ...start } = request;
  const workspace = start.workspace ?? start.workspaceLane?.workspace ?? start.runtimeWorkspace?.cwd ?? start.cwd;
  if (!workspace) throw new Error("test start requires a workspace");
  const currentTaskId = start.currentTaskId ?? `tk-${start.sessionId.replace(/[^a-z0-9]/gi, "")}`;
  return runtime.reserveSession({
    sessionId: start.sessionId,
    connectionId,
    currentTaskId,
    workspace,
    workspaceLane: start.workspaceLane,
    runtimeWorkspace: start.runtimeWorkspace,
    cwd: start.cwd,
  }).then(() => runtime.startSession({ ...start, currentTaskId, workspace }));
}

/** Subscribe before startSession so early prompt_complete is not missed. */
function waitSessionEvent(
  runtime: ReturnType<typeof createAgentRuntime>,
  sessionId: string,
  type: "session.prompt_complete" | "session.failed",
  timeoutMs = 10_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting ${type} for ${sessionId}`)),
      timeoutMs
    );
    const unsub = runtime.subscribe(sessionId, (ev) => {
      if (ev.type === type) {
        clearTimeout(t);
        unsub();
        resolve();
      }
      if (type !== "session.failed" && ev.type === "session.failed") {
        clearTimeout(t);
        unsub();
        reject(new Error(ev.error));
      }
    });
  });
}

test("extractMarkdownImageRefs: local images only; skips external and wiki embeds", () => {
  const refs = extractMarkdownImageRefs(
    [
      "See ![a](attachments/cx/a.png)",
      "and ![](./attachments/cx/b.jpg)",
      "skip ![ext](https://example.com/x.png)",
      "skip ![[wiki-embed]]",
      "and [not image](attachments/cx/c.png)",
    ].join("\n")
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.relativePath, "attachments/cx/a.png");
  assert.equal(refs[1]!.relativePath, "attachments/cx/b.jpg");
});

test("extractMarkdownImageRefs: resolves relative to note path", () => {
  const refs = extractMarkdownImageRefs("![shot](./shot.png)", {
    fromNotePath: "inbox/inbox.md",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.relativePath, "inbox/shot.png");
});

test("normalizeSystemRelativePath: rejects traversal and absolute paths", () => {
  assert.equal(normalizeSystemRelativePath("../etc/passwd"), null);
  assert.equal(normalizeSystemRelativePath("/abs"), null);
  assert.equal(normalizeSystemRelativePath("C:/windows"), null);
  assert.equal(normalizeSystemRelativePath("attachments/x.png"), "attachments/x.png");
  assert.equal(resolveLocalImagePath("attachments/x.png"), "attachments/x.png");
  // Note-relative `..` that leaves system root is rejected; one level up from inbox stays in root.
  assert.equal(resolveLocalImagePath("../escape.png", "inbox/a.md"), "escape.png");
  assert.equal(resolveLocalImagePath("../../escape.png", "inbox/a.md"), null);
  assert.equal(resolveLocalImagePath("../escape.png", "a.md"), null);
});

test("acpTransportSupportsImage: only explicit true", () => {
  assert.equal(acpTransportSupportsImage(undefined), false);
  assert.equal(acpTransportSupportsImage({}), false);
  assert.equal(acpTransportSupportsImage({ promptCapabilities: {} }), false);
  assert.equal(
    acpTransportSupportsImage({ promptCapabilities: { image: false } }),
    false
  );
  assert.equal(
    acpTransportSupportsImage({ promptCapabilities: { image: true } }),
    true
  );
  // Do not treat loadSession as image capability.
  assert.equal(acpTransportSupportsImage({ loadSession: true }), false);
});

test("projectBootstrapImagesToAcpPrompt: fallback when transport lacks image", async () => {
  const refs = [
    {
      relativePath: "attachments/cx/a.png",
      markdownPointer: "![](attachments/cx/a.png)",
    },
  ];
  const text = "Tent contextCard v1\n## User Prompt\nsee image";

  const noTransport = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: text,
    imageRefs: refs,
    transportSupportsImage: false,
    readBinaryBounded: async () => completeBinary(PNG_1X1),
  });
  assert.equal(noTransport.imagesAttached, false);
  assert.equal(noTransport.prompt.length, 1);
  assert.equal(noTransport.prompt[0]!.type, "text");
  assert.match(
    (noTransport.prompt[0] as { text: string }).text,
    /Tent image note/
  );
  assert.match(
    (noTransport.prompt[0] as { text: string }).text,
    /promptCapabilities\.image/
  );
  assert.ok(!("data" in noTransport.prompt[0]!));
  // Fallback is honest: no image block, Markdown pointer preserved.
  assert.match(
    (noTransport.prompt[0] as { text: string }).text,
    /attachments\/cx\/a\.png/
  );
});

test("projectBootstrapImagesToAcpPrompt: attaches image when transport advertises image", async () => {
  const refs = [
    {
      relativePath: "attachments/cx/a.png",
      markdownPointer: "![](attachments/cx/a.png)",
    },
  ];
  const systemRoot = path.join(os.tmpdir(), "tent-img-sys-root");
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "hello",
    imageRefs: refs,
    transportSupportsImage: true,
    systemRoot,
    readBinaryBounded: async (rel) => {
      assert.equal(rel, "attachments/cx/a.png");
      return completeBinary(new Uint8Array(PNG_1X1));
    },
  });
  assert.equal(result.imagesAttached, true);
  assert.equal(result.prompt.length, 2);
  assert.equal(result.prompt[0]!.type, "text");
  assert.equal(result.prompt[1]!.type, "image");
  const img = result.prompt[1] as {
    type: "image";
    mimeType: string;
    data: string;
    uri?: string;
  };
  assert.equal(img.mimeType, "image/png");
  assert.ok(img.data.length > 0);
  // Standard ACP image shape: type/data/mimeType (uri optional absolute file://).
  assert.ok(img.uri?.startsWith("file:"));
  // Text block must not embed base64 payload as protocol noise.
  assert.ok(!(result.prompt[0] as { text: string }).text.includes(img.data));
});

test("projectBootstrapImagesToAcpPrompt: no invalid file URI without systemRoot", async () => {
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "hello",
    imageRefs: [{ relativePath: "attachments/cx/a.png" }],
    transportSupportsImage: true,
    readBinaryBounded: async () => completeBinary(new Uint8Array(PNG_1X1)),
  });
  assert.equal(result.imagesAttached, true);
  const img = result.prompt[1] as { type: "image"; uri?: string };
  assert.equal(img.uri, undefined);
});

test("projectBootstrapImagesToAcpPrompt: unreadable path keeps pointer (no throw)", async () => {
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "bootstrap",
    imageRefs: [{ relativePath: "attachments/missing.png" }],
    transportSupportsImage: true,
    readBinaryBounded: async () => {
      throw new Error("Path escapes Tent root: attachments/missing.png");
    },
  });
  assert.equal(result.imagesAttached, false);
  assert.match((result.prompt[0] as { text: string }).text, /image note|pointers/i);
});

test("projectBootstrapImagesToAcpPrompt: rejects path traversal refs", async () => {
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "bootstrap",
    imageRefs: [{ relativePath: "../outside.png", markdownPointer: "![](../outside.png)" }],
    transportSupportsImage: true,
    readBinaryBounded: async () => {
      throw new Error("should not read traversal path");
    },
  });
  assert.equal(result.imagesAttached, false);
  assert.match((result.prompt[0] as { text: string }).text, /outside\.png|image note/i);
});

test("projectBootstrapImagesToAcpPrompt: magic bytes beat mismatched extension", async () => {
  // .png extension but JPEG-looking is still wrong; pure text with .png is rejected.
  const fake = new TextEncoder().encode("not-an-image-payload");
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "bootstrap",
    imageRefs: [{ relativePath: "attachments/cx/lie.png" }],
    transportSupportsImage: true,
    readBinaryBounded: async () => completeBinary(fake),
  });
  assert.equal(result.imagesAttached, false);
  assert.ok(
    result.notes.some((n) => /magic|non-image/i.test(n)),
    `expected magic-mismatch note, got: ${result.notes.join("; ")}`
  );
});

test("projectBootstrapImagesToAcpPrompt: skips oversized single image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-bounded-image-"));
  const rel = "attachments/cx/big.png";
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, PNG_1X1.subarray(0, 12));
  await fs.truncate(abs, MAX_ACP_IMAGE_BYTES * 4);
  const nodeFs = new NodeFs(root);
  let requestedBytes = 0;
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "bootstrap",
    imageRefs: [{ relativePath: rel }],
    transportSupportsImage: true,
    readBinaryBounded: async (relativePath, maxBytes) => {
      requestedBytes = maxBytes;
      const read = await nodeFs.readBinaryBounded(relativePath, maxBytes);
      assert.ok(read.bytes.byteLength <= maxBytes);
      return read;
    },
  });
  assert.equal(requestedBytes, MAX_ACP_IMAGE_BYTES + 1);
  assert.equal(result.imagesAttached, false);
  assert.ok(result.notes.some((n) => /oversized/i.test(n)));
});

test("projectBootstrapImagesToAcpPrompt: bounds each read by remaining aggregate budget", async () => {
  const first = new Uint8Array(PNG_1X1.subarray(0, 12));
  const requested: number[] = [];
  const result = await projectBootstrapImagesToAcpPrompt({
    bootstrapText: "bootstrap",
    imageRefs: [
      { relativePath: "attachments/cx/first.png" },
      { relativePath: "attachments/cx/second.png" },
    ],
    transportSupportsImage: true,
    readBinaryBounded: async (_relativePath, maxBytes) => {
      requested.push(maxBytes);
      if (requested.length === 1) return completeBinary(first);
      return { bytes: new Uint8Array(), truncated: true };
    },
  });
  assert.deepEqual(requested, [
    MAX_ACP_IMAGE_BYTES + 1,
    MAX_ACP_IMAGE_BYTES - first.byteLength + 1,
  ]);
  assert.equal(result.imagesAttached, true);
  assert.ok(result.notes.some((n) => /total budget/i.test(n)));
});

test("fileUriForSystemRelative: rejects escape and missing root", () => {
  assert.equal(fileUriForSystemRelative("attachments/a.png"), undefined);
  assert.equal(fileUriForSystemRelative("../x.png", "/tmp/tent"), undefined);
  const uri = fileUriForSystemRelative("attachments/a.png", path.join(os.tmpdir(), "tent-root"));
  assert.ok(uri?.startsWith("file:"));
});

test("collectBootstrapImageRefsFromTask: user prompt + claims only (not arbitrary notes)", async () => {
  const refs = await collectBootstrapImageRefsFromTask({
    prompt: "see ![u](attachments/user.png)",
    claimBodies: [
      {
        body: "claimed ![c](attachments/claim.png)",
        notePath: "concepts/c.md",
      },
    ],
  });
  assert.equal(refs.length, 2);
  assert.ok(refs.some((r) => r.relativePath === "attachments/user.png"));
  assert.ok(refs.some((r) => r.relativePath === "attachments/claim.png"));
  // Non-claim body is never passed in — collection API does not scan workspace.
});

test("managed ACP: image block sent when MOCK_ACP_PROMPT_IMAGE (no Connection capability flag)", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-acp-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-acp-data-"));
  const systemRoot = path.join(workspace, ".tent");
  await fs.mkdir(path.join(systemRoot, "attachments", "cx"), { recursive: true });
  const rel = "attachments/cx/dot.png";
  await fs.writeFile(path.join(systemRoot, rel), PNG_1X1);

  const logPath = path.join(workspace, "mock-log.json");
  const route = {
    connectionId: "mock-img",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL, envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny" as const, promptTimeoutMs: 8_000,
  };

  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
    adapters: [
      createGrokAcpAdapter({
        resolveApiKey: (_k, planEnv) => planEnv.CPA_GROK_API_KEY ?? "test-key",
      }),
    ],
  });

  const done = waitSessionEvent(runtime, "ss-img-1", "session.prompt_complete", 10_000);
  const handle = await startConnection(runtime, {
    sessionId: "ss-img-1",
    connectionId: "mock-img",
    cwd: workspace,
    env: { MOCK_ACP_LOG: logPath, MOCK_ACP_KEEP_ALIVE: "1", MOCK_ACP_PROMPT_IMAGE: "1", MOCK_ACP_PROMPT_TEXT: "IMG_OK", CPA_GROK_API_KEY: "test-key-not-real" },
    bootstrapPrompt: "bootstrap with image",
    bootstrapImageRefs: [{ relativePath: rel, markdownPointer: `![](${rel})` }],
    bootstrapImageSystemRoot: systemRoot,
  });
  assert.ok(handle.sessionId);
  await done;

  await runtime.stopSession(handle.sessionId, "user");
  const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
    promptBlocks: Array<Array<{ type: string; mimeType?: string; dataChars?: number }>>;
    promptImageCapable: boolean;
  };
  assert.equal(log.promptImageCapable, true);
  assert.ok(Array.isArray(log.promptBlocks) && log.promptBlocks.length >= 1);
  const blocks = log.promptBlocks[0]!;
  assert.ok(blocks.some((b) => b.type === "text"));
  const img = blocks.find((b) => b.type === "image");
  assert.ok(img, "expected image content block in session/prompt");
  assert.equal(img!.mimeType, "image/png");
  assert.ok((img!.dataChars ?? 0) > 0);

  // Session registry / Connection snapshot must not persist base64 image payloads.
  const sessionRaw = await fs
    .readFile(path.join(dataDir, "sessions", "ss-img-1.json"), "utf8")
    .catch(() => "");
  if (sessionRaw) {
    assert.ok(!sessionRaw.includes(PNG_1X1.toString("base64")));
    assert.ok(!/"type"\s*:\s*"image"/.test(sessionRaw));
  }
});

test("managed ACP: fallback text-only when transport lacks promptCapabilities.image", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-fb-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-fb-data-"));
  const systemRoot = path.join(workspace, ".tent");
  await fs.mkdir(path.join(systemRoot, "attachments", "cx"), { recursive: true });
  const rel = "attachments/cx/dot.png";
  await fs.writeFile(path.join(systemRoot, rel), PNG_1X1);

  const logPath = path.join(workspace, "mock-log.json");
  const route = {
    connectionId: "mock-img-fb",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL, envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny" as const, promptTimeoutMs: 8_000,
  };

  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
    adapters: [
      createGrokAcpAdapter({
        resolveApiKey: (_k, planEnv) => planEnv.CPA_GROK_API_KEY ?? "test-key",
      }),
    ],
  });

  const done = waitSessionEvent(runtime, "ss-img-fb", "session.prompt_complete", 10_000);
  const handle = await startConnection(runtime, {
    sessionId: "ss-img-fb",
    connectionId: "mock-img-fb",
    cwd: workspace,
    env: { MOCK_ACP_LOG: logPath, MOCK_ACP_KEEP_ALIVE: "1", MOCK_ACP_PROMPT_TEXT: "FB_OK", CPA_GROK_API_KEY: "test-key-not-real" },
    bootstrapPrompt: "bootstrap pointer only",
    bootstrapImageRefs: [{ relativePath: rel, markdownPointer: `![](${rel})` }],
    bootstrapImageSystemRoot: systemRoot,
  });
  await done;

  await runtime.stopSession(handle.sessionId, "user");
  const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
    prompts: string[];
    promptBlocks: Array<Array<{ type: string }>>;
  };
  const blocks = log.promptBlocks[0] ?? [];
  assert.ok(blocks.every((b) => b.type !== "image"), "must not send image without capability");
  assert.match(log.prompts[0] ?? "", /Tent image note|Markdown pointers/i);
});

test("managed ACP: text-only bootstrap still works without image refs", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-txt-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-img-txt-data-"));
  const logPath = path.join(workspace, "mock-log.json");
  const route = {
    connectionId: "mock-txt",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL, envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny" as const, promptTimeoutMs: 8_000,
  };

  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
    adapters: [
      createGrokAcpAdapter({
        resolveApiKey: (_k, planEnv) => planEnv.CPA_GROK_API_KEY ?? "test-key",
      }),
    ],
  });

  const done = waitSessionEvent(runtime, "ss-txt-1", "session.prompt_complete", 10_000);
  const handle = await startConnection(runtime, {
    sessionId: "ss-txt-1",
    connectionId: "mock-txt",
    cwd: workspace,
    env: { MOCK_ACP_LOG: logPath, MOCK_ACP_KEEP_ALIVE: "1", MOCK_ACP_PROMPT_TEXT: "TEXT_OK", CPA_GROK_API_KEY: "test-key-not-real" },
    bootstrapPrompt: "plain text bootstrap only",
  });
  await done;

  await runtime.stopSession(handle.sessionId, "user");
  const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
    prompts: string[];
    promptBlocks: Array<Array<{ type: string }>>;
  };
  assert.match(log.prompts[0] ?? "", /plain text bootstrap only/);
  const blocks = log.promptBlocks[0] ?? [];
  assert.ok(blocks.every((b) => b.type === "text"));
  assert.ok(!blocks.some((b) => b.type === "image"));
});
