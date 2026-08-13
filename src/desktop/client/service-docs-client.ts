// DocsClient over Local Service JSON-RPC — desktop renderer/main never touch core FS.

import type { DocsClient } from "../../markdown/docs-client.js";
import type {
  BacklinkHit,
  NodeEditSnapshot,
  NodeProjection,
  CreateNoteInput,
  DocsWriteInput,
  DocsWriteResult,
  ResolvedLink,
  SearchHit,
} from "../../markdown/types.js";
import type { ServiceRpcClient } from "./rpc-client.js";
import { ServiceRpcError } from "./rpc-client.js";

export type ServiceDocsClientOptions = {
  rpc: ServiceRpcClient;
  workspaceId: string;
};

export class ServiceDocsClient implements DocsClient {
  private readonly rpc: ServiceRpcClient;
  private workspaceId: string;

  constructor(options: ServiceDocsClientOptions) {
    this.rpc = options.rpc;
    this.workspaceId = options.workspaceId;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  setWorkspaceId(workspaceId: string): void {
    this.workspaceId = workspaceId;
  }

  async list(parentPath?: string): Promise<NodeProjection[]> {
    const result = await this.rpc.call<{ nodes: NodeProjection[] }>("docs.list", {
      workspaceId: this.workspaceId,
      parentPath,
    });
    const roots = (result.nodes ?? []).map(normalizeProjection);
    if (!parentPath) return roots;
    const parent = findByPath(roots, parentPath.replace(/\\/g, "/"));
    return parent?.children ?? [];
  }

  async get(nodeId: string): Promise<NodeProjection | null> {
    try {
      const result = await this.rpc.call<{ node: NodeProjection }>("docs.get", {
        workspaceId: this.workspaceId,
        nodeId,
      });
      return result.node ? normalizeProjection(result.node) : null;
    } catch (err) {
      if (err instanceof ServiceRpcError && err.code === -32004) return null;
      throw err;
    }
  }

  async readForEdit(nodeId: string): Promise<NodeEditSnapshot> {
    const result = await this.rpc.call<{
      nodeId: string;
      path: string;
      name?: string;
      type?: string;
      body: string;
      raw?: string;
      etag: string;
      frontmatter: Record<string, unknown>;
    }>("docs.readForEdit", {
      workspaceId: this.workspaceId,
      nodeId,
    });

    const raw =
      result.raw ??
      reconstructRaw(result.frontmatter ?? {}, result.body ?? "");
    const name =
      result.name ??
      (typeof result.frontmatter?.name === "string"
        ? result.frontmatter.name
        : result.path.split("/").pop() || result.path);
    const type = result.type ??
      (typeof result.frontmatter?.type === "string" ? result.frontmatter.type : undefined);

    return {
      nodeId: result.nodeId,
      path: result.path,
      name,
      type,
      body: result.body,
      frontmatter: result.frontmatter ?? {},
      raw,
      etag: result.etag,
    };
  }

  async write(input: DocsWriteInput): Promise<DocsWriteResult> {
    try {
      const params: Record<string, unknown> = {
        workspaceId: this.workspaceId,
        nodeId: input.nodeId,
        baseEtag: input.baseEtag,
      };
      if (input.raw !== undefined) params.raw = input.raw;
      if (input.body !== undefined) params.body = input.body;
      if (input.frontmatter !== undefined) params.frontmatter = input.frontmatter;

      const result = await this.rpc.call<{
        nodeId: string;
        path: string;
        etag: string;
      }>("docs.write", params);

      return {
        ok: true,
        etag: result.etag,
        nodeId: result.nodeId,
        path: result.path,
      };
    } catch (err) {
      if (err instanceof ServiceRpcError) {
        if (err.code === -32008) {
          return {
            ok: false,
            code: "etag_required",
            message: err.message || "docs.write requires baseEtag for existing nodes",
          };
        }
        if (err.code === -32009) {
          let disk: NodeEditSnapshot | undefined;
          try {
            // Optional full snapshot for conflict UI; RPC error itself only carries etag meta.
            disk = await this.readForEdit(input.nodeId);
          } catch {
            /* ignore */
          }
          return {
            ok: false,
            code: "etag_conflict",
            message: err.message || "etag conflict",
            disk,
          };
        }
        if (err.code === -32010) {
          return {
            ok: false,
            code: "collab_field_protected",
            message: err.message,
          };
        }
        if (err.code === -32004) {
          return { ok: false, code: "not_found", message: err.message };
        }
        return { ok: false, code: "invalid", message: err.message };
      }
      throw err;
    }
  }

  async createNote(input: CreateNoteInput): Promise<{ nodeId: string; path: string }> {
    const result = await this.rpc.call<{ nodeId: string; path: string }>("docs.createNote", {
      workspaceId: this.workspaceId,
      name: input.name,
      ...(input.type?.trim() ? { type: input.type.trim() } : {}),
      parentPath: input.parentPath ?? "",
      body: input.body,
    });
    return { nodeId: result.nodeId, path: result.path };
  }

  async fork(nodeId: string): Promise<{ nodeId: string }> {
    const result = await this.rpc.call<{ nodeId: string }>("docs.fork", {
      workspaceId: this.workspaceId,
      nodeId,
    });
    return { nodeId: result.nodeId };
  }

  /**
   * User-only rename of display name / folder (cx- immutable).
   * Pass newName only — never attempt to edit id.
   */
  async rename(
    nodeId: string,
    newName: string,
    actor = "user"
  ): Promise<{ nodeId: string; name: string; path: string }> {
    const result = await this.rpc.call<{
      nodeId: string;
      name: string;
      path: string;
    }>("docs.rename", {
      workspaceId: this.workspaceId,
      nodeId,
      newName,
      actor,
    });
    return { nodeId: result.nodeId, name: result.name, path: result.path };
  }

  async setMode(
    nodeId: string,
    mode: "editable" | "archived"
  ): Promise<unknown> {
    return this.rpc.call("docs.setMode", {
      workspaceId: this.workspaceId,
      nodeId,
      mode,
    });
  }

  async search(query: string): Promise<SearchHit[]> {
    const result = await this.rpc.call<{ hits: SearchHit[] }>("docs.search", {
      workspaceId: this.workspaceId,
      query,
    });
    return result.hits ?? [];
  }

  async backlinks(nodeId: string): Promise<BacklinkHit[]> {
    const result = await this.rpc.call<{ backlinks: BacklinkHit[] }>("docs.backlinks", {
      workspaceId: this.workspaceId,
      nodeId,
    });
    return result.backlinks ?? [];
  }

  async resolveLink(_fromNodeIdOrPath: string, raw: string): Promise<ResolvedLink> {
    // MVP: resolve via search title match; full graph resolve remains markdown package.
    const hits = await this.search(raw);
    const exact = hits.find((h) => h.name === raw || h.path.endsWith(raw));
    if (exact) {
      return { raw, kind: "wiki", targetNodeId: exact.nodeId, targetPath: exact.path, label: exact.name };
    }
    return { raw, kind: "unresolved" };
  }

  async importAttachment(
    nodeId: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string }> {
    const payload =
      typeof bytes === "string"
        ? new TextEncoder().encode(bytes)
        : bytes;
    const bytesBase64 =
      typeof Buffer !== "undefined"
        ? Buffer.from(payload).toString("base64")
        : uint8ToBase64(payload);

    const result = await this.rpc.call<{
      relativePath: string;
      markdown: string;
    }>("docs.importAttachment", {
      workspaceId: this.workspaceId,
      nodeId,
      fileName,
      bytesBase64,
    });

    return {
      relativePath: result.relativePath,
      markdown: result.markdown,
    };
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in Chromium renderer; Node path uses Buffer above.
  return btoa(binary);
}

function normalizeProjection(c: NodeProjection): NodeProjection {
  const mode = c.mode === "archived" ? "archived" : "editable";
  return {
    nodeId: c.nodeId,
    path: c.path,
    name: c.name,
    type: c.type,
    tags: c.tags ?? [],
    title: c.title,
    mode,
    archived: mode === "archived" || !!c.archived,
    invalid: !!c.invalid,
    bodyPreview: c.bodyPreview,
    children: (c.children ?? []).map(normalizeProjection),
  };
}

function findByPath(nodes: NodeProjection[], path: string): NodeProjection | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    const child = findByPath(n.children ?? [], path);
    if (child) return child;
  }
  return null;
}

function reconstructRaw(frontmatter: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}
