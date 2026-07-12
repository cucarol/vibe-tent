// Non-destructive link resolve + reverse index for concept bodies.

import { buildConceptIndex, resolveConcept, type OkfConcept } from "../core/okf.js";
import type { Box } from "../core/types.js";
import type { BacklinkHit, OutLink, ResolvedLink } from "./types.js";

const WIKI_RE = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function extractOutLinks(body: string): OutLink[] {
  const out: OutLink[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(WIKI_RE)) {
    const raw = match[1].trim();
    const label = match[2]?.trim();
    const key = `wiki:${raw}|${label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, kind: "wiki", label });
  }

  for (const match of body.matchAll(MD_LINK_RE)) {
    const label = match[1]?.trim() || undefined;
    const href = match[2].trim();
    if (/^(https?:|mailto:|tent-artifact:)/i.test(href)) {
      const key = `artifact:${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ raw: href, kind: "artifact", label });
      continue;
    }
    const key = `md:${href}|${label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: href, kind: "md", label });
  }

  return out;
}

export function indexFromBoxes(boxes: Iterable<Box>): Map<string, OkfConcept[]> {
  return buildConceptIndex(boxes);
}

export function resolveOutLink(
  index: Map<string, OkfConcept[]>,
  link: OutLink,
  fromNotePath?: string
): ResolvedLink {
  if (link.kind === "artifact") {
    return { raw: link.raw, kind: "artifact", label: link.label };
  }
  const target = normalizeTarget(link.raw, fromNotePath);
  const concept = resolveConcept(index, target) ?? resolveConcept(index, link.raw);
  if (!concept) {
    return { raw: link.raw, kind: "unresolved", label: link.label };
  }
  return {
    raw: link.raw,
    kind: link.kind,
    targetCx: concept.id,
    targetPath: concept.path,
    label: link.label ?? concept.name,
  };
}

export function buildBacklinkIndex(
  concepts: Iterable<{ id: string; path: string; name: string; body: string; notePath: string }>
): Map<string, BacklinkHit[]> {
  const boxesAsConcepts: Box[] = [];
  // buildConceptIndex only needs Box-like fields used by toConcept — use thin adapters via cast after index build from real boxes is preferred.
  // Here we re-index from provided projections by synthesizing minimal Box fields via okf helpers through a parallel map.
  const byId = new Map<string, { id: string; path: string; name: string; notePath: string }>();
  const list = [...concepts];
  for (const c of list) byId.set(c.id, c);

  // Use path/name/id keys for resolveConcept via a lightweight index
  const index = new Map<string, OkfConcept[]>();
  for (const c of list) {
    const concept: OkfConcept = {
      id: c.id,
      boxId: c.id,
      path: c.path,
      notePath: c.notePath,
      name: c.name,
      type: "note",
    };
    add(index, concept.id, concept);
    add(index, concept.path, concept);
    add(index, concept.notePath, concept);
    add(index, concept.name, concept);
  }

  const reverse = new Map<string, BacklinkHit[]>();
  for (const c of list) {
    for (const link of extractOutLinks(c.body)) {
      if (link.kind === "artifact") continue;
      const resolved = resolveOutLink(index, link, c.notePath);
      if (!resolved.targetCx) continue;
      const hit: BacklinkHit = {
        fromCx: c.id,
        fromPath: c.path,
        fromName: c.name,
        raw: link.raw,
        kind: link.kind === "wiki" ? "wiki" : "md",
      };
      const arr = reverse.get(resolved.targetCx) ?? [];
      arr.push(hit);
      reverse.set(resolved.targetCx, arr);
    }
  }
  return reverse;
}

function add(index: Map<string, OkfConcept[]>, key: string, concept: OkfConcept): void {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((c) => c.id === concept.id)) list.push(concept);
  index.set(key, list);
  const all = index.get("__all__") ?? [];
  if (!all.some((c) => c.id === concept.id)) all.push(concept);
  index.set("__all__", all);
}

function normalizeTarget(raw: string, fromNotePath?: string): string {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("./") || t.startsWith("../")) {
    if (fromNotePath) {
      const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
      for (const part of t.split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") base.pop();
        else base.push(part);
      }
      t = base.join("/");
    }
  }
  return t.replace(/\.md$/i, "");
}
