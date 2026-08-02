// Runnable local preview for Markdown node workspace (no Electron).
// Usage: npx tsx src/markdown/preview-server.ts <tentSystemRoot> [--port 8765]

import * as http from "node:http";
import * as path from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import { CoreDocsClient } from "./core-docs-client.js";
import { renderWorkspacePage } from "./html-shell.js";
import { WorkspaceController } from "./workspace-controller.js";

export type PreviewServerOptions = {
  systemRoot: string;
  port?: number;
  tentName?: string;
  host?: string;
};

export type PreviewServerHandle = {
  port: number;
  host: string;
  url: string;
  controller: WorkspaceController;
  close: () => Promise<void>;
};

export async function startMarkdownPreviewServer(
  options: PreviewServerOptions
): Promise<PreviewServerHandle> {
  const systemRoot = path.resolve(options.systemRoot);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const fs = new NodeFs(systemRoot);
  const env = {
    fs,
    clock: { now: () => new Date().toISOString() },
    tentName: options.tentName ?? (path.basename(path.dirname(systemRoot)) || "tent"),
    tentRoot: systemRoot,
  };
  const docs = new CoreDocsClient(env);
  const controller = new WorkspaceController(docs);
  await controller.refreshTree();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, controller);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind preview server");
  }

  return {
    port: address.port,
    host,
    url: `http://${host}:${address.port}/`,
    controller,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: WorkspaceController
): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "POST" && url.pathname === "/action") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    await applyAction(controller, params);
    const cx = params.get("cx");
    const loc = cx ? `/?open=${encodeURIComponent(cx)}` : "/";
    res.writeHead(303, { Location: loc });
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const open = url.searchParams.get("open");
    const q = url.searchParams.get("q");
    if (q !== null) await controller.search(q);
    if (open) {
      try {
        await controller.openNode(open);
      } catch (err) {
        await controller.search(open);
        const hit = controller.getSnapshot().searchHits[0];
        if (hit) await controller.openNode(hit.nodeId);
        else throw err;
      }
    }
    const html = renderWorkspacePage(controller);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tree") {
    await controller.refreshTree();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(controller.getSnapshot().tree, null, 2));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

async function applyAction(controller: WorkspaceController, params: URLSearchParams): Promise<void> {
  const op = params.get("op") || "";
  const cx = params.get("cx") || "";
  switch (op) {
    case "createNote": {
      const name = (params.get("name") || "").trim();
      if (name) await controller.createNote(name);
      break;
    }
    case "save":
      if (cx) await controller.save(cx);
      break;
    case "updateAndSave":
      if (cx) {
        controller.updateBuffer(cx, params.get("buffer") || "");
        await controller.save(cx);
      }
      break;
    case "setMode":
      if (cx) controller.setMode(cx, params.get("mode") === "preview" ? "preview" : "source");
      break;
    case "loadDisk":
      if (cx) controller.loadDiskVersion(cx);
      break;
    case "overwrite":
      if (cx) await controller.overwriteWithMine(cx);
      break;
    case "discard":
      if (cx) controller.discard(cx);
      break;
    default:
      break;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// CLI entry
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("preview-server.ts");

if (isMain) {
  const args = process.argv.slice(2);
  const systemRoot = args.find((a) => !a.startsWith("--"));
  if (!systemRoot) {
    console.error("Usage: npx tsx src/markdown/preview-server.ts <tentSystemRoot> [--port N]");
    process.exit(1);
  }
  let port = 8765;
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0 && args[portIdx + 1]) port = Number(args[portIdx + 1]) || 8765;

  const handle = await startMarkdownPreviewServer({ systemRoot, port });
  console.log(`Markdown node workspace preview: ${handle.url}`);
  console.log(`System root: ${systemRoot}`);
}
