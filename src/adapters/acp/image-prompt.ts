// Pure ACP image prompt projection: Markdown image pointers → content blocks.
// Path/MIME/size safety only. No OCR, no workspace scan, no base64 persistence.
// Bytes are process-scoped for one session/prompt — never Task/Node/Session/route disk.
// Gate: live ACP initialize agentCapabilities.promptCapabilities.image === true only.
// Image capability is provider-negotiated, not an Agent Connection toggle.

import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Image as MdastImage, Nodes, Root } from "mdast";
import type { BoundedBinaryRead, FsAdapter } from "../../core/adapter.js";
import { ATTACHMENTS_DIR } from "../../core/paths.js";
import { MAX_ATTACHMENT_BYTES } from "../../markdown/attachments.js";

/** Hard cap for one image projected into ACP prompt (aligned with attachment import). */
export const MAX_ACP_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;

/** Max distinct images projected into one managed bootstrap prompt. */
export const MAX_ACP_IMAGES_PER_PROMPT = 8;

/**
 * Aggregate byte budget for all images in one prompt (decoded).
 * Keeps total ACP payload bounded even when each image is under the per-file cap.
 */
export const MAX_ACP_IMAGES_TOTAL_BYTES = MAX_ATTACHMENT_BYTES;

/** MIME types we will send as ACP ImageContent (extension + magic-byte sniff). */
export const ACP_IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export type AcpTextContentBlock = {
  type: "text";
  text: string;
};

export type AcpImageContentBlock = {
  type: "image";
  data: string;
  mimeType: string;
  /** Optional absolute file URI; only set when system root + relative path resolve cleanly. */
  uri?: string;
};

/** ACP session/prompt content block (text + image subset only). */
export type AcpPromptContentBlock = AcpTextContentBlock | AcpImageContentBlock;

/**
 * Local image reference discovered from Node/task Markdown.
 * Paths only — never base64. Relative paths are system-root relative (FsAdapter root).
 */
export type BootstrapImageRef = {
  /** System-root-relative posix path (or absolute under workspace/system root when resolved). */
  relativePath: string;
  /** Optional alt text from Markdown image. */
  alt?: string;
  /** Source Markdown pointer kept for fallback text (e.g. ![](attachments/…)). */
  markdownPointer?: string;
};

export type ProjectBootstrapImagesInput = {
  /** Managed bootstrap text (Context Card pointer + near-field user prompt). Always sent. */
  bootstrapText: string;
  /** Explicit local image refs (already extracted; no workspace scan here). */
  imageRefs?: readonly BootstrapImageRef[];
  /**
   * Live initialize agentCapabilities.promptCapabilities.image === true.
   * Missing/false/undefined → treat as unsupported (do not guess).
   * Sole pre-send gate — no route-level capability override.
   */
  transportSupportsImage?: boolean;
  /**
   * Read bytes under tent system root (NodeFs). Required only when transport supports
   * image and imageRefs is non-empty. Callers pass FsAdapter rooted at system root.
   */
  readBinaryBounded?: (
    relativePath: string,
    maxBytes: number
  ) => Promise<BoundedBinaryRead>;
  /**
   * Absolute tent system root (`.tent`). When set, image blocks may include a valid
   * `file://` URI for the resolved absolute path. Never invent relative-only URIs.
   */
  systemRoot?: string;
};

export type ProjectBootstrapImagesResult = {
  /** Content blocks for session/prompt. Always starts with one text block. */
  prompt: AcpPromptContentBlock[];
  /** True only when at least one ACP image block was included. */
  imagesAttached: boolean;
  /** Refs that stayed as Markdown pointers (capability off, missing file, unsafe, etc.). */
  fallbackPointers: string[];
  /** Short human reasons (tests / diagnostics; never secrets or base64). */
  notes: string[];
};

/**
 * Extract Markdown image destinations from a single body (mdast).
 * Reuses CommonMark image nodes only — no wiki embeds, no link graph edges.
 * Does not resolve paths or read files.
 */
export function extractMarkdownImageRefs(
  body: string,
  options?: { fromNotePath?: string }
): BootstrapImageRef[] {
  if (!body || !body.trim()) return [];
  const tree: Root = fromMarkdown(body);
  const out: BootstrapImageRef[] = [];
  const seen = new Set<string>();
  const fromNotePath = options?.fromNotePath;

  walkMdast(tree, (node) => {
    if (node.type !== "image") return;
    const img = node as MdastImage;
    const rawUrl = (img.url ?? "").trim();
    if (!rawUrl) return;
    if (isExternalOrDataUrl(rawUrl)) return;

    const resolved = resolveLocalImagePath(rawUrl, fromNotePath);
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const alt =
      typeof img.alt === "string" && img.alt.trim() ? img.alt.trim() : undefined;
    const markdownPointer = alt
      ? `![${alt}](${rawUrl})`
      : `![](${rawUrl})`;
    out.push({
      relativePath: resolved,
      ...(alt ? { alt } : {}),
      markdownPointer,
    });
  });

  return out;
}

/**
 * Pure projection: bootstrap text + optional image refs → ACP content blocks.
 * Gate: transportSupportsImage only. Otherwise keep Markdown pointers in text
 * and append a short note (no OCR, no success masquerade).
 */
export async function projectBootstrapImagesToAcpPrompt(
  input: ProjectBootstrapImagesInput
): Promise<ProjectBootstrapImagesResult> {
  const bootstrapText = input.bootstrapText ?? "";
  const refs = Array.isArray(input.imageRefs) ? input.imageRefs : [];
  const transportOk = input.transportSupportsImage === true;
  const notes: string[] = [];
  const fallbackPointers: string[] = [];

  if (refs.length === 0) {
    return {
      prompt: [{ type: "text", text: bootstrapText }],
      imagesAttached: false,
      fallbackPointers: [],
      notes: [],
    };
  }

  if (!transportOk) {
    for (const ref of refs) {
      const ptr = ref.markdownPointer || ref.relativePath;
      if (ptr) fallbackPointers.push(ptr);
    }
    const reason =
      "ACP transport did not advertise promptCapabilities.image (treated as unsupported)";
    notes.push(reason);
    const text = appendImageFallbackNote(bootstrapText, fallbackPointers, reason);
    return {
      prompt: [{ type: "text", text }],
      imagesAttached: false,
      fallbackPointers,
      notes,
    };
  }

  if (typeof input.readBinaryBounded !== "function") {
    notes.push("bounded image reader unavailable; keeping Markdown image pointers");
    for (const ref of refs) {
      fallbackPointers.push(ref.markdownPointer || ref.relativePath);
    }
    const text = appendImageFallbackNote(
      bootstrapText,
      fallbackPointers,
      "image bytes unavailable"
    );
    return {
      prompt: [{ type: "text", text }],
      imagesAttached: false,
      fallbackPointers,
      notes,
    };
  }

  const imageBlocks: AcpImageContentBlock[] = [];
  const limited = refs.slice(0, MAX_ACP_IMAGES_PER_PROMPT);
  if (refs.length > MAX_ACP_IMAGES_PER_PROMPT) {
    notes.push(
      `image cap: projecting first ${MAX_ACP_IMAGES_PER_PROMPT} of ${refs.length} refs`
    );
    for (const ref of refs.slice(MAX_ACP_IMAGES_PER_PROMPT)) {
      fallbackPointers.push(ref.markdownPointer || ref.relativePath);
    }
  }

  let totalBytes = 0;
  for (const ref of limited) {
    const rel = normalizeSystemRelativePath(ref.relativePath);
    if (!rel) {
      fallbackPointers.push(ref.markdownPointer || ref.relativePath);
      notes.push(`skip unsafe path: ${ref.relativePath}`);
      continue;
    }
    const extMime = mimeFromPath(rel);
    if (!extMime) {
      fallbackPointers.push(ref.markdownPointer || rel);
      notes.push(`skip unsupported image type: ${rel}`);
      continue;
    }
    const remainingTotalBytes = MAX_ACP_IMAGES_TOTAL_BYTES - totalBytes;
    const allowedBytes = Math.min(MAX_ACP_IMAGE_BYTES, remainingTotalBytes);
    let read: BoundedBinaryRead;
    try {
      read = await input.readBinaryBounded(rel, allowedBytes + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fallbackPointers.push(ref.markdownPointer || rel);
      // Path escape / missing file — keep pointer, do not throw the whole bootstrap.
      notes.push(`skip unreadable image ${rel}: ${msg.slice(0, 120)}`);
      continue;
    }
    const { bytes } = read;
    if (read.truncated || bytes.byteLength > allowedBytes) {
      fallbackPointers.push(ref.markdownPointer || rel);
      if (remainingTotalBytes < MAX_ACP_IMAGE_BYTES) {
        notes.push(
          `skip image ${rel}: would exceed total budget ${MAX_ACP_IMAGES_TOTAL_BYTES}`
        );
      } else {
        notes.push(`skip oversized image ${rel}: exceeds ${MAX_ACP_IMAGE_BYTES}`);
      }
      continue;
    }
    if (bytes.byteLength <= 0) {
      fallbackPointers.push(ref.markdownPointer || rel);
      notes.push(`skip empty image: ${rel}`);
      continue;
    }
    // Magic bytes win. Extension alone is not enough; mismatch → skip (no spoofed MIME).
    const sniffed = sniffImageMime(bytes);
    if (!sniffed || !isAllowedImageMime(sniffed)) {
      fallbackPointers.push(ref.markdownPointer || rel);
      notes.push(`skip non-image or magic-mismatch bytes: ${rel}`);
      continue;
    }
    // Extension must agree with sniffed type (or be a known alias for same family).
    if (!mimeExtAgrees(extMime, sniffed)) {
      fallbackPointers.push(ref.markdownPointer || rel);
      notes.push(`skip extension/magic mismatch: ${rel} (${extMime} vs ${sniffed})`);
      continue;
    }
    totalBytes += bytes.byteLength;
    const block: AcpImageContentBlock = {
      type: "image",
      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        "base64"
      ),
      mimeType: sniffed,
    };
    const uri = fileUriForSystemRelative(rel, input.systemRoot);
    if (uri) block.uri = uri;
    imageBlocks.push(block);
  }

  if (imageBlocks.length === 0) {
    const text =
      fallbackPointers.length > 0
        ? appendImageFallbackNote(
            bootstrapText,
            fallbackPointers,
            "no local images could be attached"
          )
        : bootstrapText;
    return {
      prompt: [{ type: "text", text }],
      imagesAttached: false,
      fallbackPointers,
      notes,
    };
  }

  // Text first (stable Context Card + prompt), then image blocks as additional parts.
  // Failed refs stay as Markdown pointers inside the original text body.
  let text = bootstrapText;
  if (fallbackPointers.length > 0) {
    text = appendImageFallbackNote(
      bootstrapText,
      fallbackPointers,
      "some referenced images could not be attached"
    );
  }

  return {
    prompt: [{ type: "text", text }, ...imageBlocks],
    imagesAttached: true,
    fallbackPointers,
    notes,
  };
}

/**
 * Whether ACP initialize advertised image prompt support.
 * Only explicit true counts — omit/false/unknown → unsupported (no guessing).
 */
export function acpTransportSupportsImage(
  agentCapabilities: unknown
): boolean {
  if (!agentCapabilities || typeof agentCapabilities !== "object") return false;
  const caps = agentCapabilities as {
    promptCapabilities?: { image?: unknown };
  };
  return caps.promptCapabilities?.image === true;
}

/** Append a short, stable fallback note (not assistant delivery noise). */
export function appendImageFallbackNote(
  bootstrapText: string,
  pointers: string[],
  reason: string
): string {
  const unique = [...new Set(pointers.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) return bootstrapText;
  const lines = [
    bootstrapText.trimEnd(),
    "",
    "--- Tent image note ---",
    `Local images kept as Markdown pointers (${reason}).`,
    ...unique.map((p) => `- ${p}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Resolve a Markdown image URL to a system-root-relative posix path.
 * Accepts attachments/…, ./attachments/…, and relative paths from a note.
 * Rejects external schemes, data URLs, and empty targets.
 */
export function resolveLocalImagePath(
  rawUrl: string,
  fromNotePath?: string
): string | null {
  let t = rawUrl.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  if (!t || isExternalOrDataUrl(t)) return null;
  // Strip query/fragment.
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();
  if (!t) return null;

  // Workspace-relative `.tent/attachments/…` → system-root `attachments/…`.
  if (t === `.tent/${ATTACHMENTS_DIR}` || t.startsWith(`.tent/${ATTACHMENTS_DIR}/`)) {
    t = t.slice(".tent/".length);
  }
  if (t.startsWith("./")) t = t.slice(2);

  if ((t.startsWith("../") || t.includes("/../") || t.startsWith("./")) && fromNotePath) {
    const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of t.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        // Leaving the system-root (empty base) is escape — reject, do not clamp.
        if (base.length === 0) return null;
        base.pop();
      } else {
        base.push(part);
      }
    }
    t = base.join("/");
  } else if (fromNotePath && !t.startsWith(ATTACHMENTS_DIR) && !nodePath.posix.isAbsolute(t)) {
    // Relative to note directory (system-root relative note path).
    if (t.startsWith("./")) t = t.slice(2);
    if (!t.startsWith("/") && !t.includes(":")) {
      const dir = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      t = dir ? `${dir}/${t}` : t;
    }
  }

  return normalizeSystemRelativePath(t);
}

/** Normalize and reject traversal / absolute / empty paths for FsAdapter. */
export function normalizeSystemRelativePath(raw: string): string | null {
  let t = raw.trim().replace(/\\/g, "/");
  if (!t) return null;
  if (t.startsWith("/") || /^[a-zA-Z]:\//.test(t)) return null;
  if (t.includes("\0")) return null;
  const parts: string[] = [];
  for (const p of t.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(p);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

export function mimeFromPath(relativePath: string): string | undefined {
  const ext = nodePath.posix.extname(relativePath).toLowerCase();
  return ACP_IMAGE_MIME_BY_EXT[ext];
}

export function isAllowedImageMime(mime: string): boolean {
  const m = mime.trim().toLowerCase();
  return Object.values(ACP_IMAGE_MIME_BY_EXT).includes(m);
}

/** Magic-byte sniff; returns undefined when unknown (caller must not trust extension alone). */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 4) return undefined;
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WEBP (RIFF....WEBP)
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return undefined;
}

/**
 * Build a valid absolute file:// URI for an image under system root.
 * Returns undefined when systemRoot is missing or path would escape — never emit
 * relative-only or invalid file URIs on the wire.
 */
export function fileUriForSystemRelative(
  relativePath: string,
  systemRoot?: string
): string | undefined {
  const rel = normalizeSystemRelativePath(relativePath);
  if (!rel || !systemRoot || !systemRoot.trim()) return undefined;
  const root = nodePath.resolve(systemRoot.trim());
  const abs = nodePath.resolve(root, ...rel.split("/"));
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const absCmp = process.platform === "win32" ? abs.toLowerCase() : abs;
  if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + nodePath.sep)) {
    return undefined;
  }
  // Portable absolute file URI only (never relative-only file: targets).
  return pathToFileURL(abs).href;
}

function mimeExtAgrees(extMime: string, sniffed: string): boolean {
  return extMime.trim().toLowerCase() === sniffed.trim().toLowerCase();
}

function isExternalOrDataUrl(href: string): boolean {
  const t = href.trim();
  if (!t) return true;
  if (t.startsWith("//")) return true;
  if (/^data:/i.test(t)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    // Allow only relative / path-like; reject http(s), file:, etc. for extraction.
    // Absolute filesystem paths are rejected later by normalizeSystemRelativePath.
    return true;
  }
  return false;
}

function walkMdast(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) walkMdast(child as Nodes, visit);
  }
}

/**
 * Collect image refs from the Task prompt and referenced Node bodies.
 * Explicit sources only — no workspace scan. Safe read failures are skipped.
 */
export async function collectBootstrapImageRefsFromTask(input: {
  userPrompt: string;
  claimBodies?: ReadonlyArray<{ body: string; notePath?: string }>;
}): Promise<BootstrapImageRef[]> {
  const out: BootstrapImageRef[] = [];
  const seen = new Set<string>();
  const pushAll = (refs: BootstrapImageRef[]) => {
    for (const r of refs) {
      const key = r.relativePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  };
  pushAll(extractMarkdownImageRefs(input.userPrompt || ""));
  for (const claim of input.claimBodies ?? []) {
    pushAll(
      extractMarkdownImageRefs(claim.body || "", {
        fromNotePath: claim.notePath,
      })
    );
  }
  return out.slice(0, MAX_ACP_IMAGES_PER_PROMPT * 2);
}

/** Convenience: FsAdapter → readBinary bound for projection. */
export function bindSystemRootReadBinary(
  fs: { readBinaryBounded(path: string, maxBytes: number): Promise<BoundedBinaryRead> }
): (relativePath: string, maxBytes: number) => Promise<BoundedBinaryRead> {
  return (relativePath: string, maxBytes: number) =>
    fs.readBinaryBounded(relativePath, maxBytes);
}
