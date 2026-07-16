// DocsClient over Local Service JSON-RPC — desktop renderer/main never touch core FS.

import type { DocsClient } from "../../markdown/docs-client.js";
import type {
  ArtifactRef,
  BacklinkHit,
  ConceptEditSnapshot,
  ConceptProjection,
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

  async list(parentPath?: string): Promise<ConceptProjection[]> {
    const result = await this.rpc.call<{ concepts: ConceptProjection[] }>("docs.list", {
      workspaceId: this.workspaceId,
      parentPath,
    });
    const roots = (result.concepts ?? []).map(normalizeProjection);
    if (!parentPath) return roots;
    const parent = findByPath(roots, parentPath.replace(/\\/g, "/"));
    return parent?.children ?? [];
  }

  async get(cxOrPath: string): Promise<ConceptProjection | null> {
    try {
      const result = await this.rpc.call<{ concept: ConceptProjection }>("docs.get", {
        workspaceId: this.workspaceId,
        ...idOrPathParams(cxOrPath),
      });
      return result.concept ? normalizeProjection(result.concept) : null;
    } catch (err) {
      if (err instanceof ServiceRpcError && err.code === -32004) return null;
      throw err;
    }
  }

  async readForEdit(cxOrPath: string): Promise<ConceptEditSnapshot> {
    const result = await this.rpc.call<{
      id: string;
      cx?: string;
      path: string;
      name?: string;
      type?: string;
      coordination?: boolean;
      body: string;
      raw?: string;
      etag: string;
      frontmatter: Record<string, unknown>;
      artifactRefs?: ArtifactRef[];
    }>("docs.readForEdit", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath),
    });

    const cx = result.cx ?? result.id;
    const raw =
      result.raw ??
      reconstructRaw(result.frontmatter ?? {}, result.body ?? "");
    const name =
      result.name ??
      (typeof result.frontmatter?.name === "string"
        ? result.frontmatter.name
        : result.path.split("/").pop() || result.path);
    const type =
      result.type ??
      (typeof result.frontmatter?.type === "string" ? result.frontmatter.type : "note");
    const coordination =
      result.coordination ??
      (type === "goal" ||
        type.startsWith("goal-") ||
        type === "prompt" ||
        type.startsWith("prompt-") ||
        type === "output" ||
        type.startsWith("output-"));

    return {
      cx,
      path: result.path,
      name,
      type,
      coordination,
      body: result.body,
      frontmatter: result.frontmatter ?? {},
      raw,
      etag: result.etag,
      artifactRefs: result.artifactRefs ?? parseArtifactRefs(result.frontmatter ?? {}),
    };
  }

  async write(input: DocsWriteInput): Promise<DocsWriteResult> {
    try {
      const params: Record<string, unknown> = {
        workspaceId: this.workspaceId,
        id: input.cx,
        baseEtag: input.baseEtag,
      };
      if (input.raw !== undefined) params.raw = input.raw;
      if (input.body !== undefined) params.body = input.body;
      if (input.frontmatter !== undefined) params.frontmatter = input.frontmatter;

      const result = await this.rpc.call<{
        id: string;
        cx?: string;
        path: string;
        etag: string;
      }>("docs.write", params);

      return {
        ok: true,
        etag: result.etag,
        cx: result.cx ?? result.id,
        path: result.path,
      };
    } catch (err) {
      if (err instanceof ServiceRpcError) {
        if (err.code === -32009) {
          let disk: ConceptEditSnapshot | undefined;
          try {
            disk = await this.readForEdit(input.cx);
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

  async createNote(input: CreateNoteInput): Promise<{ cx: string; path: string }> {
    const result = await this.rpc.call<{ id: string; path: string }>("docs.createNote", {
      workspaceId: this.workspaceId,
      name: input.name,
      type: input.type ?? "note",
      parentPath: input.parentPath ?? "",
      body: input.body,
    });
    return { cx: result.id, path: result.path };
  }

  async promote(
    cxOrPath: string,
    toType: string
  ): Promise<{ cx: string; path: string; fromType: string; toType: string }> {
    const result = await this.rpc.call<{
      id: string;
      path: string;
      fromType: string;
      toType: string;
    }>("docs.promote", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath),
      toType,
    });
    return {
      cx: result.id,
      path: result.path,
      fromType: result.fromType,
      toType: result.toType,
    };
  }

  async fork(cxOrPath: string): Promise<{ cx: string }> {
    const result = await this.rpc.call<{ id: string }>("docs.fork", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath),
    });
    return { cx: result.id };
  }

  async search(query: string): Promise<SearchHit[]> {
    const result = await this.rpc.call<{ hits: SearchHit[] }>("docs.search", {
      workspaceId: this.workspaceId,
      query,
    });
    return result.hits ?? [];
  }

  async backlinks(cxOrPath: string): Promise<BacklinkHit[]> {
    const result = await this.rpc.call<{ backlinks: BacklinkHit[] }>("docs.backlinks", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath),
    });
    return result.backlinks ?? [];
  }

  async resolveLink(_fromCxOrPath: string, raw: string): Promise<ResolvedLink> {
    // MVP: resolve via search title match; full graph resolve remains markdown package.
    const hits = await this.search(raw);
    const exact = hits.find((h) => h.name === raw || h.path.endsWith(raw));
    if (exact) {
      return { raw, kind: "wiki", targetCx: exact.cx, targetPath: exact.path, label: exact.name };
    }
    return { raw, kind: "unresolved" };
  }

  async importAttachment(
    cx: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string; artifactRef?: ArtifactRef }> {
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
      artifactRef?: ArtifactRef;
    }>("docs.importAttachment", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cx),
      fileName,
      bytesBase64,
    });

    return {
      relativePath: result.relativePath,
      markdown: result.markdown,
      artifactRef: result.artifactRef,
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

function idOrPathParams(cxOrPath: string): Record<string, string> {
  const key = cxOrPath.trim().replace(/\\/g, "/");
  if (key.startsWith("cx-") || key.startsWith("bx-")) return { id: key };
  return { path: key };
}

function normalizeProjection(c: ConceptProjection): ConceptProjection {
  return {
    ...c,
    children: (c.children ?? []).map(normalizeProjection),
    tags: c.tags ?? [],
    archived: !!c.archived,
    invalid: !!c.invalid,
  };
}

function findByPath(nodes: ConceptProjection[], path: string): ConceptProjection | null {
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

function parseArtifactRefs(data: Record<string, unknown>): ArtifactRef[] {
  const raw = data.artifactRefs;
  if (!Array.isArray(raw)) return [];
  const out: ArtifactRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const target = rec.target;
    if (
      (kind === "path" || kind === "dir" || kind === "commit" || kind === "url" || kind === "other") &&
      typeof target === "string"
    ) {
      out.push({
        kind,
        target,
        label: typeof rec.label === "string" ? rec.label : undefined,
      });
    }
  }
  return out;
}
