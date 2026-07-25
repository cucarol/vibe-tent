// In-process DocsClient over tent-core (B3 interim until B2 service attach lands).

import type { OpsEnv } from "../core/ops-context.js";
import { createBox, forkNode } from "../core/ops.js";
import { parseFrontmatter, serializeFrontmatter, BOX_FRONTMATTER_KEY_ORDER } from "../core/frontmatter.js";
import { loadTent, boxNotePath, type LoadedTent } from "../core/tree.js";
import { envelopeIsActiveOccupation } from "../core/claim.js";
import { loadTaskEnvelopes } from "../core/task.js";
import type { Box } from "../core/types.js";
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
  indexFromBoxes,
  resolveOutLink,
} from "./links.js";
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
} from "./types.js";
import { PROTECTED_COLLAB_FIELDS } from "./types.js";

export class CoreDocsClient implements DocsClient {
  constructor(private readonly env: OpsEnv) {}

  async list(parentPath?: string): Promise<ConceptProjection[]> {
    const tent = await loadTent(this.env.fs);
    if (!parentPath) {
      return tent.roots.map((b) => toProjection(b, true));
    }
    const parent = tent.byPath.get(parentPath.replace(/\\/g, "/"));
    if (!parent) return [];
    return parent.children.map((b) => toProjection(b, true));
  }

  async get(cxOrPath: string): Promise<ConceptProjection | null> {
    const tent = await loadTent(this.env.fs);
    const box = resolveBox(tent, cxOrPath);
    return box ? toProjection(box, true) : null;
  }

  async readForEdit(cxOrPath: string): Promise<ConceptEditSnapshot> {
    const tent = await loadTent(this.env.fs);
    const box = resolveBox(tent, cxOrPath);
    if (!box) throw new Error(`Concept not found: ${cxOrPath}`);
    const notePath = boxNotePath(box.path);
    const raw = await this.env.fs.readFile(notePath);
    const { data, body } = parseFrontmatter(raw);
    return {
      cx: box.id,
      path: box.path,
      name: box.name,
      type: box.type,
      body,
      frontmatter: data,
      raw,
      etag: contentEtag(raw),
      artifactRefs: parseArtifactRefs(data),
    };
  }

  async write(input: DocsWriteInput): Promise<DocsWriteResult> {
    return withTentMutation(this.env.fs, async () => {
      const tent = await loadTent(this.env.fs);
      const box = resolveBox(tent, input.cx);
      if (!box) {
        return { ok: false, code: "not_found", message: `Concept not found: ${input.cx}` };
      }
      if (!input.baseEtag || !String(input.baseEtag).trim()) {
        return {
          ok: false,
          code: "etag_required",
          message: "docs.write requires baseEtag for existing nodes",
        };
      }
      const notePath = boxNotePath(box.path);
      const diskRaw = await this.env.fs.readFile(notePath);
      const diskEtag = contentEtag(diskRaw);
      if (diskEtag !== input.baseEtag) {
        const { data, body } = parseFrontmatter(diskRaw);
        return {
          ok: false,
          code: "etag_conflict",
          message: "Disk content changed; refusing silent overwrite.",
          disk: {
            cx: box.id,
            path: box.path,
            name: box.name,
            type: box.type,
            body,
            frontmatter: data,
            raw: diskRaw,
            etag: diskEtag,
            artifactRefs: parseArtifactRefs(data),
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
          keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER
        );
      }

      const diskParsed = parseFrontmatter(diskRaw);
      const nextParsed = parseFrontmatter(nextRaw);
      const active = await hasActiveTask(this.env, tent, box);
      if (active) {
        for (const field of PROTECTED_COLLAB_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(nextParsed.data, field) &&
              !Object.prototype.hasOwnProperty.call(diskParsed.data, field)) {
            continue;
          }
          if (stringifyField(nextParsed.data[field]) !== stringifyField(diskParsed.data[field])) {
            return {
              ok: false,
              code: "collab_field_protected",
              message: `Cannot change ${field} while box has an active task; use Task API.`,
            };
          }
        }
      }

      if (!nextParsed.data.type || String(nextParsed.data.type).trim() === "") {
        return { ok: false, code: "invalid", message: "type must be non-empty." };
      }
      if (!nextParsed.data.id) {
        nextParsed.data.id = box.id;
        nextRaw = serializeFrontmatter(
          nextParsed.data,
          nextParsed.body,
          nextParsed.keyOrder.length ? nextParsed.keyOrder : BOX_FRONTMATTER_KEY_ORDER
        );
      }

      await this.env.fs.writeFile(notePath, nextRaw);
      return { ok: true, etag: contentEtag(nextRaw), cx: box.id, path: box.path };
    });
  }

  async createNote(input: CreateNoteInput): Promise<{ cx: string; path: string }> {
    // V0.2 default primary is prompt (no permanent note alias).
    const type = input.type?.trim() || "prompt";
    const cx = await createBox(this.env, {
      parentPath: input.parentPath?.replace(/\\/g, "/") ?? "",
      name: input.name,
      type,
    });
    if (input.body !== undefined) {
      const snap = await this.readForEdit(cx);
      const { data, keyOrder } = parseFrontmatter(snap.raw);
      const raw = serializeFrontmatter(
        data,
        input.body.endsWith("\n") ? input.body : input.body + "\n",
        keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER
      );
      const written = await this.write({ cx, baseEtag: snap.etag, raw });
      if (!written.ok) throw new Error(written.message);
    }
    const got = await this.get(cx);
    return { cx, path: got?.path ?? input.name };
  }

  async fork(cxOrPath: string): Promise<{ cx: string }> {
    const tent = await loadTent(this.env.fs);
    const box = resolveBox(tent, cxOrPath);
    if (!box) throw new Error(`Concept not found: ${cxOrPath}`);
    const cx = await forkNode(this.env, box.id);
    return { cx };
  }

  async search(query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tent = await loadTent(this.env.fs);
    const hits: SearchHit[] = [];
    for (const box of tent.byId.values()) {
      if (box.archived || box.invalid) continue;
      const title = typeof box.fm.title === "string" ? box.fm.title : box.name;
      if (box.name.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
        hits.push({
          cx: box.id,
          path: box.path,
          name: box.name,
          title,
          snippet: title,
          match: "title",
        });
        continue;
      }
      if (box.path.toLowerCase().includes(q)) {
        hits.push({
          cx: box.id,
          path: box.path,
          name: box.name,
          title,
          snippet: box.path,
          match: "path",
        });
        continue;
      }
      const body = box.body ?? "";
      const idx = body.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(body.length, idx + q.length + 40);
        hits.push({
          cx: box.id,
          path: box.path,
          name: box.name,
          title,
          snippet: body.slice(start, end).replace(/\s+/g, " ").trim(),
          match: "body",
        });
      }
    }
    return hits.slice(0, 50);
  }

  async backlinks(cxOrPath: string): Promise<BacklinkHit[]> {
    const tent = await loadTent(this.env.fs);
    const target = resolveBox(tent, cxOrPath);
    if (!target) return [];
    const concepts = [...tent.byId.values()].map((b) => ({
      id: b.id,
      path: b.path,
      name: b.name,
      body: b.body,
      notePath: boxNotePath(b.path),
    }));
    const reverse = buildBacklinkIndex(concepts);
    return reverse.get(target.id) ?? [];
  }

  async resolveLink(fromCxOrPath: string, raw: string): Promise<ResolvedLink> {
    const tent = await loadTent(this.env.fs);
    const from = resolveBox(tent, fromCxOrPath);
    const index = indexFromBoxes(tent.byId.values());
    const link = extractOutLinks(`[[${raw}]]`)[0] ?? { raw, kind: "wiki" as const };
    // Also try as md href
    const asWiki = resolveOutLink(index, link, from ? boxNotePath(from.path) : undefined);
    if (asWiki.kind !== "unresolved") return asWiki;
    return resolveOutLink(
      index,
      { raw, kind: "md" },
      from ? boxNotePath(from.path) : undefined
    );
  }

  async importAttachment(
    cx: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string; artifactRef?: ArtifactRef }> {
    const tent = await loadTent(this.env.fs);
    const box = resolveBox(tent, cx);
    if (!box) throw new Error(`Concept not found: ${cx}`);
    const payload = attachmentBytesFromInput(bytes);
    return storeAttachmentBytes(this.env.fs, box.id, fileName, payload, boxNotePath(box.path));
  }
}

function toProjection(box: Box, withChildren: boolean): ConceptProjection {
  const title = typeof box.fm.title === "string" ? box.fm.title : undefined;
  return {
    id: box.id,
    path: box.path,
    name: box.name,
    type: box.type,
    tags: box.tags,
    title,
    mode: box.mode,
    archived: box.archived,
    invalid: box.invalid,
    bodyPreview: (box.body || "").slice(0, 160).replace(/\s+/g, " ").trim(),
    children: withChildren ? box.children.map((c) => toProjection(c, true)) : [],
    artifactRefs: parseArtifactRefs(box.fm as Record<string, unknown>),
  };
}

function resolveBox(tent: LoadedTent, cxOrPath: string): Box | undefined {
  const key = cxOrPath.trim().replace(/\\/g, "/");
  return tent.byId.get(key) ?? tent.byPath.get(key);
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

async function hasActiveTask(env: OpsEnv, tent: LoadedTent, box: Box): Promise<boolean> {
  // Occupation oracle = active task envelopes only (stale owner is not a write lock).
  const tasks = await loadTaskEnvelopes(env.fs);
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.claims.includes(box.id) || task.claims.includes("root")) return true;
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath(claimed.path, box.path) || isAncestorPath(box.path, claimed.path)) {
        return true;
      }
    }
  }
  return false;
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}

function stringifyField(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}
