// Deterministic concept link graph: extract, resolve, reverse-index.
// Scope is graph/backlinks/resolveLink — not the preview renderer.
//
// Contract notes:
// - Standard Markdown via mdast (CommonMark); wiki links only in prose text
//   nodes (code / inlineCode / html excluded). Images / wiki embeds never
//   create concept edges. External schemes, pure anchors, attachments skipped.
// - Wiki `#heading` / `^block` suffixes resolve the concept target; `raw` keeps
//   the authoring form.

import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Definition as MdastDefinition,
  Link as MdastLink,
  LinkReference as MdastLinkReference,
  Nodes,
  Root,
} from "mdast";
import { buildConceptIndex, resolveConcept, type OkfConcept } from "../core/okf.js";
import { ATTACHMENTS_DIR } from "../core/paths.js";
import type { Box } from "../core/types.js";
import type { BacklinkHit, OutLink, ResolvedLink } from "./types.js";

const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const ARTIFACT_SCHEME_RE = /^(https?:|mailto:|tent-artifact:)/i;

/** Optional graph metadata retained on outbound links. */
export type OutLinkMeta = {
  /** URL/wiki fragment after `#` (wiki heading or md fragment). */
  fragment?: string;
  /** Wiki block ref after `^` (without the caret). */
  blockRef?: string;
  /** Destination with query/fragment stripped; still relative/raw form. */
  conceptTarget?: string;
};

export type ExtractedOutLink = OutLink & OutLinkMeta;

export function extractOutLinks(body: string): OutLink[] {
  return extractOutLinksDetailed(body).map(toPublicOutLink);
}

/** Full extraction with graph metadata (tests / advanced callers). */
export function extractOutLinksDetailed(body: string): ExtractedOutLink[] {
  const tree: Root = fromMarkdown(body);
  const out: ExtractedOutLink[] = [];
  const seen = new Set<string>();
  const definitions = collectDefinitions(tree);

  walk(tree, (node) => {
    if (node.type === "link") {
      const link = outLinkFromMdast(node);
      if (link) pushLink(out, seen, link);
      return "skip"; // do not scan wiki inside link labels
    }
    if (node.type === "linkReference") {
      const definition = definitions.get(normalizeIdentifier(node.identifier));
      const link = definition ? outLinkFromReference(node, definition) : null;
      if (link) pushLink(out, seen, link);
      return "skip";
    }
    if (node.type === "image") return "skip";
    if (node.type === "text") {
      // Source offsets preserve escapes that mdast unescapes in node.value.
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      const text = start != null && end != null ? body.slice(start, end) : node.value;
      scanWikiInProse(text, out, seen);
    }
  });

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

  const meta = link as ExtractedOutLink;
  const resolutionRaw =
    meta.conceptTarget ??
    (link.kind === "wiki" ? stripWikiSuffix(link.raw).target : splitHref(link.raw).pathPart);
  const target = normalizeTarget(resolutionRaw, fromNotePath);

  if (!isConceptCandidate(target) && !isConceptCandidate(resolutionRaw)) {
    return { raw: link.raw, kind: "unresolved", label: link.label };
  }

  const concept = resolveConcept(index, target) ?? resolveConcept(index, resolutionRaw);
  if (!concept) return { raw: link.raw, kind: "unresolved", label: link.label };
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
  const list = [...concepts];
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
    for (const link of extractOutLinksDetailed(c.body)) {
      if (link.kind === "artifact") continue;
      const resolved = resolveOutLink(index, link, c.notePath);
      if (!resolved.targetCx) continue;
      const arr = reverse.get(resolved.targetCx) ?? [];
      arr.push({
        fromCx: c.id,
        fromPath: c.path,
        fromName: c.name,
        raw: link.raw,
        kind: link.kind === "wiki" ? "wiki" : "md",
      });
      reverse.set(resolved.targetCx, arr);
    }
  }
  return reverse;
}

export function normalizeTarget(raw: string, fromNotePath?: string): string {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  t = safePercentDecode(t);
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();

  if ((t.startsWith("./") || t.startsWith("../")) && fromNotePath) {
    const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of t.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    t = base.join("/");
  }
  return t.replace(/\.md$/i, "");
}

// --- AST walk + extraction -------------------------------------------------

function walk(node: Nodes, visit: (node: Nodes) => "skip" | void): void {
  if (visit(node) === "skip") return;
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) walk(child as Nodes, visit);
  }
}

function outLinkFromMdast(node: MdastLink): ExtractedOutLink | null {
  return outLinkFromHref(node.url, collectText(node));
}

function outLinkFromReference(
  node: MdastLinkReference,
  definition: MdastDefinition
): ExtractedOutLink | null {
  return outLinkFromHref(definition.url, collectText(node));
}

function outLinkFromHref(url: string, rawLabel: string): ExtractedOutLink | null {
  const href = (url ?? "").trim();
  if (!href) return null;
  const label = rawLabel.replace(/\s+/g, " ").trim() || undefined;

  if (ARTIFACT_SCHEME_RE.test(href) || isExternalHref(href)) {
    return { raw: href, kind: "artifact", label, conceptTarget: href };
  }
  if (isPureAnchor(href)) return null;

  const { pathPart, fragment } = splitHref(href);
  if (!pathPart || isAttachmentPath(pathPart)) return null;
  return { raw: href, kind: "md", label, fragment, conceptTarget: pathPart };
}

function collectDefinitions(tree: Root): Map<string, MdastDefinition> {
  const definitions = new Map<string, MdastDefinition>();
  walk(tree, (node) => {
    if (node.type === "definition") {
      const key = normalizeIdentifier(node.identifier);
      if (!definitions.has(key)) definitions.set(key, node);
    }
  });
  return definitions;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(collectText).join("");
  }
  return "";
}

function scanWikiInProse(text: string, out: ExtractedOutLink[], seen: Set<string>): void {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    // Wiki embed — never a concept edge.
    if (text[i] === "!" && text[i + 1] === "[" && text[i + 2] === "[") {
      const embedEnd = findWikiEnd(text, i + 2);
      i = embedEnd === -1 ? i + 3 : embedEnd + 1;
      continue;
    }
    if (text[i] === "[" && text[i + 1] === "[") {
      const parsed = tryParseWikiLink(text, i);
      if (parsed) {
        if (parsed.link) pushLink(out, seen, parsed.link);
        i = parsed.next;
        continue;
      }
    }
    i += 1;
  }
}

function tryParseWikiLink(
  text: string,
  start: number
): { link: ExtractedOutLink | null; next: number } | null {
  if (text[start] !== "[" || text[start + 1] !== "[" || isEscaped(text, start)) return null;
  const end = findWikiEnd(text, start + 2);
  if (end === -1) return null;
  const next = end + 1;
  const inner = text.slice(start + 2, end);
  if (!inner) return { link: null, next };

  let targetPart = inner;
  let label: string | undefined;
  const pipe = findUnescapedChar(inner, "|");
  if (pipe !== -1) {
    targetPart = inner.slice(0, pipe);
    label = inner.slice(pipe + 1).trim() || undefined;
  }

  const rawTarget = targetPart.trim();
  if (!rawTarget) return { link: null, next };

  const { target, fragment, blockRef } = stripWikiSuffix(rawTarget);
  if (!target || isAttachmentPath(target) || isPureAnchor(target) || isExternalHref(target)) {
    return { link: null, next };
  }
  return {
    link: { raw: rawTarget, kind: "wiki", label, fragment, blockRef, conceptTarget: target },
    next,
  };
}

function findWikiEnd(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] === "]" && text[i + 1] === "]" && !isEscaped(text, i)) return i;
    if (text[i] === "[" && text[i + 1] === "[" && !isEscaped(text, i)) return -1;
  }
  return -1;
}

// --- shared helpers --------------------------------------------------------

function toPublicOutLink(link: ExtractedOutLink): OutLink {
  return {
    raw: link.raw,
    kind: link.kind,
    label: link.label,
    targetCx: link.targetCx,
    targetPath: link.targetPath,
  };
}

function pushLink(out: ExtractedOutLink[], seen: Set<string>, link: ExtractedOutLink): void {
  const key = `${link.kind}:${link.raw}|${link.label ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(link);
}

function stripWikiSuffix(raw: string): {
  target: string;
  fragment?: string;
  blockRef?: string;
} {
  const t = raw.trim();
  const caret = t.lastIndexOf("^");
  if (caret > 0) {
    const blockRef = t.slice(caret + 1).trim() || undefined;
    const before = t.slice(0, caret);
    const hash = before.indexOf("#");
    if (hash >= 0) {
      return {
        target: before.slice(0, hash).trim(),
        fragment: before.slice(hash + 1).trim() || undefined,
        blockRef,
      };
    }
    return { target: before.trim(), blockRef };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) {
    return { target: t.slice(0, hash).trim(), fragment: t.slice(hash + 1).trim() || undefined };
  }
  return { target: t };
}

function splitHref(href: string): { pathPart: string; fragment?: string } {
  const t = href.trim();
  const q = t.indexOf("?");
  const h = t.indexOf("#");
  let pathEnd = t.length;
  if (q >= 0) pathEnd = Math.min(pathEnd, q);
  if (h >= 0) pathEnd = Math.min(pathEnd, h);
  return {
    pathPart: t.slice(0, pathEnd),
    fragment: h >= 0 ? t.slice(h + 1).split("?")[0] || undefined : undefined,
  };
}

function isConceptCandidate(target: string): boolean {
  const t = target.trim();
  return Boolean(t) && !isPureAnchor(t) && !isExternalHref(t) && !isAttachmentPath(t);
}

function isPureAnchor(href: string): boolean {
  const t = href.trim();
  return t.startsWith("#") || t === "";
}

function isExternalHref(href: string): boolean {
  const t = href.trim();
  return t.startsWith("//") || ARTIFACT_SCHEME_RE.test(t) || EXTERNAL_SCHEME_RE.test(t);
}

function isAttachmentPath(href: string): boolean {
  const t = href.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t) return false;
  if (t === ATTACHMENTS_DIR || t.startsWith(`${ATTACHMENTS_DIR}/`)) return true;
  if (t.includes(`/${ATTACHMENTS_DIR}/`)) return true;
  const stack: string[] = [];
  for (const p of t.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack[0] === ATTACHMENTS_DIR;
}

function safePercentDecode(value: string): string {
  try {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isEscaped(text: string, index: number): boolean {
  let bs = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) bs += 1;
  return bs % 2 === 1;
}

function findUnescapedChar(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch && !isEscaped(text, i)) return i;
  }
  return -1;
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
