// In-process DocsClient over tent-core.

import type { OpsEnv } from "../core/ops-context.js";
import { createNode, forkNode } from "../core/ops.js";
import { parseFrontmatter, serializeFrontmatter, NODE_FRONTMATTER_KEY_ORDER } from "../core/frontmatter.js";
import { loadTent, nodeNotePath, type LoadedTent } from "../core/tree.js";
import type { Node } from "../core/types.js";
import { withTentMutation } from "../core/adapter.js";
import type { DocsClient } from "./docs-client.js";
import { contentEtag } from "./etag.js";
import {
  attachmentBytesFromInput,
  storeAttachmentBytes,
} from "./attachments.js";
import {
  buildBacklinkIndex,
  extractOutLinks,
  indexFromNodes,
  resolveOutLink,
} from "./links.js";
import type {
  BacklinkHit,
  NodeEditSnapshot,
  NodeProjection,
  CreateNoteInput,
  DocsWriteInput,
  DocsWriteResult,
  ResolvedLink,
  SearchHit,
} from "./types.js";
import { PROTECTED_COLLAB_FIELDS } from "./types.js";

export class CoreDocsClient implements DocsClient {
  constructor(private readonly env: OpsEnv) {}

  async list(parentPath?: string): Promise<NodeProjection[]> {
    const tent = await loadTent(this.env.fs);
    if (!parentPath) {
      return tent.roots.map((b) => toProjection(b, true));
    }
    const parent = tent.byPath.get(parentPath.replace(/\\/g, "/"));
    if (!parent) return [];
    return parent.children.map((b) => toProjection(b, true));
  }

  async get(nodeId: string): Promise<NodeProjection | null> {
    const tent = await loadTent(this.env.fs);
    const node = resolveNodeId(tent, nodeId);
    return node ? toProjection(node, true) : null;
  }

  async readForEdit(nodeId: string): Promise<NodeEditSnapshot> {
    const tent = await loadTent(this.env.fs);
    const node = resolveNodeId(tent, nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const notePath = nodeNotePath(node.path);
    const raw = await this.env.fs.readFile(notePath);
    const { data, body } = parseFrontmatter(raw);
    return {
      nodeId: node.id,
      path: node.path,
      name: node.name,
      type: node.type,
      body,
      frontmatter: data,
      raw,
      etag: contentEtag(raw),
    };
  }

  async write(input: DocsWriteInput): Promise<DocsWriteResult> {
    return withTentMutation(this.env.fs, async () => {
      const tent = await loadTent(this.env.fs);
      const node = resolveNodeId(tent, input.nodeId);
      if (!node) {
        return { ok: false, code: "not_found", message: `Node not found: ${input.nodeId}` };
      }
      if (!input.baseEtag || !String(input.baseEtag).trim()) {
        return {
          ok: false,
          code: "etag_required",
          message: "docs.write requires baseEtag for existing nodes",
        };
      }
      const notePath = nodeNotePath(node.path);
      const diskRaw = await this.env.fs.readFile(notePath);
      const diskEtag = contentEtag(diskRaw);
      if (diskEtag !== input.baseEtag) {
        const { data, body } = parseFrontmatter(diskRaw);
        return {
          ok: false,
          code: "etag_conflict",
          message: "Disk content changed; refusing silent overwrite.",
          disk: {
            nodeId: node.id,
            path: node.path,
            name: node.name,
            type: node.type,
            body,
            frontmatter: data,
            raw: diskRaw,
            etag: diskEtag,
          },
        };
      }

      let nextRaw: string;
      if (input.raw !== undefined) {
        nextRaw = input.raw;
      } else {
        const { data, body, keyOrder } = parseFrontmatter(diskRaw);
        const nextBody = input.body !== undefined ? input.body : body;
        const nextFm = { ...data, ...(input.frontmatter ?? {}) };
        nextRaw = serializeFrontmatter(
          nextFm,
          nextBody,
          keyOrder.length ? keyOrder : NODE_FRONTMATTER_KEY_ORDER
        );
      }

      const diskParsed = parseFrontmatter(diskRaw);
      const nextParsed = parseFrontmatter(nextRaw);
      for (const field of PROTECTED_COLLAB_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(nextParsed.data, field) &&
            !Object.prototype.hasOwnProperty.call(diskParsed.data, field)) {
          continue;
        }
        if (stringifyField(nextParsed.data[field]) !== stringifyField(diskParsed.data[field])) {
          return {
            ok: false,
            code: "collab_field_protected",
            message: `Cannot change reserved ${field}; use Task API.`,
          };
        }
      }

      if (!nextParsed.data.id) {
        nextParsed.data.id = node.id;
        nextRaw = serializeFrontmatter(
          nextParsed.data,
          nextParsed.body,
          nextParsed.keyOrder.length ? nextParsed.keyOrder : NODE_FRONTMATTER_KEY_ORDER
        );
      }

      await this.env.fs.writeFile(notePath, nextRaw);
      return { ok: true, etag: contentEtag(nextRaw), nodeId: node.id, path: node.path };
    });
  }

  async createNote(input: CreateNoteInput): Promise<{ nodeId: string; path: string }> {
    const nodeId = await createNode(this.env, {
      parentPath: input.parentPath?.replace(/\\/g, "/") ?? "",
      name: input.name,
      ...(input.type?.trim() ? { type: input.type.trim() } : {}),
    });
    if (input.body !== undefined) {
      const snap = await this.readForEdit(nodeId);
      const { data, keyOrder } = parseFrontmatter(snap.raw);
      const raw = serializeFrontmatter(
        data,
        input.body.endsWith("\n") ? input.body : input.body + "\n",
        keyOrder.length ? keyOrder : NODE_FRONTMATTER_KEY_ORDER
      );
      const written = await this.write({ nodeId: nodeId, baseEtag: snap.etag, raw });
      if (!written.ok) throw new Error(written.message);
    }
    const got = await this.get(nodeId);
    return { nodeId: nodeId, path: got?.path ?? input.name };
  }

  async fork(nodeId: string): Promise<{ nodeId: string }> {
    const tent = await loadTent(this.env.fs);
    const node = resolveNodeId(tent, nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const createdNodeId = await forkNode(this.env, node.id);
    return { nodeId: createdNodeId };
  }

  async search(query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tent = await loadTent(this.env.fs);
    const hits: SearchHit[] = [];
    for (const node of tent.byId.values()) {
      if (node.archived || node.invalid) continue;
      const title = typeof node.fm.title === "string" ? node.fm.title : node.name;
      if (node.name.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
        hits.push({
          nodeId: node.id,
          path: node.path,
          name: node.name,
          title,
          snippet: title,
          match: "title",
        });
        continue;
      }
      if (node.path.toLowerCase().includes(q)) {
        hits.push({
          nodeId: node.id,
          path: node.path,
          name: node.name,
          title,
          snippet: node.path,
          match: "path",
        });
        continue;
      }
      const body = node.body ?? "";
      const idx = body.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(body.length, idx + q.length + 40);
        hits.push({
          nodeId: node.id,
          path: node.path,
          name: node.name,
          title,
          snippet: body.slice(start, end).replace(/\s+/g, " ").trim(),
          match: "body",
        });
      }
    }
    return hits.slice(0, 50);
  }

  async backlinks(nodeId: string): Promise<BacklinkHit[]> {
    const tent = await loadTent(this.env.fs);
    const target = resolveNodeId(tent, nodeId);
    if (!target) return [];
    const nodes = [...tent.byId.values()].map((b) => ({
      id: b.id,
      path: b.path,
      name: b.name,
      body: b.body,
      notePath: nodeNotePath(b.path),
    }));
    const reverse = buildBacklinkIndex(nodes);
    return reverse.get(target.id) ?? [];
  }

  async resolveLink(fromNodeId: string, raw: string): Promise<ResolvedLink> {
    const tent = await loadTent(this.env.fs);
    const from = resolveNodeId(tent, fromNodeId);
    const index = indexFromNodes(tent.byId.values());
    const link = extractOutLinks(`[[${raw}]]`)[0] ?? { raw, kind: "wiki" as const };
    // Also try as md href
    const asWiki = resolveOutLink(index, link, from ? nodeNotePath(from.path) : undefined);
    if (asWiki.kind !== "unresolved") return asWiki;
    return resolveOutLink(
      index,
      { raw, kind: "md" },
      from ? nodeNotePath(from.path) : undefined
    );
  }

  async importAttachment(
    nodeId: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string }> {
    const tent = await loadTent(this.env.fs);
    const node = resolveNodeId(tent, nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const payload = attachmentBytesFromInput(bytes);
    return storeAttachmentBytes(this.env.fs, node.id, fileName, payload, nodeNotePath(node.path));
  }
}

function toProjection(node: Node, withChildren: boolean): NodeProjection {
  const title = typeof node.fm.title === "string" ? node.fm.title : undefined;
  return {
    nodeId: node.id,
    path: node.path,
    name: node.name,
    type: node.type,
    tags: node.tags,
    title,
    mode: node.mode,
    archived: node.archived,
    invalid: node.invalid,
    bodyPreview: (node.body || "").slice(0, 160).replace(/\s+/g, " ").trim(),
    children: withChildren ? node.children.map((c) => toProjection(c, true)) : [],
  };
}

function resolveNodeId(tent: LoadedTent, nodeId: string): Node | undefined {
  return tent.byId.get(nodeId.trim());
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}

function stringifyField(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}
