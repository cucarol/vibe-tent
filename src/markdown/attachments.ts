// Attachment storage helpers for docs.importAttachment.
// Disk always holds original bytes; RPC may carry base64 on the wire.

import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import type { FsAdapter } from "../core/adapter.js";
import { ATTACHMENTS_DIR } from "../core/paths.js";
import type { ArtifactRef } from "./types.js";

/**
 * Hard cap for a single attachment import (decoded bytes).
 * 25 MiB keeps JSON-RPC base64 payloads and desktop memory use bounded.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type ImportAttachmentResult = {
  /** Path relative to tent system root (`.tent/`), posix. */
  relativePath: string;
  /** Markdown image/file link using the system-root-relative path. */
  markdown: string;
  artifactRef: ArtifactRef;
};

/**
 * Sanitize a user-supplied file name for use as a single path segment.
 * Strips directories, rejects traversal, and neutralizes Windows-invalid names.
 */
export function sanitizeAttachmentFileName(fileName: string): string {
  const source = fileName.normalize("NFKC");
  if (!source.trim()) throw new Error("Attachment file name is required");
  if (source.includes("/") || source.includes("\\") || source === "." || source === "..") {
    throw new Error("Attachment file name must be a single path segment");
  }
  let clean = source.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  if (!clean || clean === "." || clean === "..") clean = "file";

  if (clean.length > 120) {
    const ext = nodePath.posix.extname(clean).slice(0, 20);
    const stem = clean.slice(0, Math.max(1, 120 - ext.length));
    clean = `${stem}${ext}`;
  }

  const ext = nodePath.posix.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
    clean = `file-${clean}`;
  }
  return clean;
}

/** UTF-8 string → bytes, or pass-through Uint8Array (copied for safety). */
export function attachmentBytesFromInput(bytes: Uint8Array | string): Uint8Array {
  if (typeof bytes === "string") {
    return new TextEncoder().encode(bytes);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
}

/**
 * Strict standard base64 decode (optional whitespace ignored).
 * Rejects missing padding / non-alphabet characters via Buffer + round-trip check.
 */
export function decodeBase64Strict(b64: string): Uint8Array {
  const compact = b64.replace(/\s+/g, "");
  if (!compact) throw new Error("Invalid base64: empty payload");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error("Invalid base64: non-alphabet characters");
  }
  if (compact.length % 4 !== 0) {
    throw new Error("Invalid base64: length must be a multiple of 4");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(compact, "base64");
  } catch {
    throw new Error("Invalid base64: decode failed");
  }
  // Buffer.from is lenient; require a strict re-encode match (normalize padding).
  const reencoded = buf.toString("base64");
  if (reencoded !== compact) {
    throw new Error("Invalid base64: strict decode mismatch");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function assertAttachmentSize(byteLength: number): void {
  if (byteLength < 0 || !Number.isFinite(byteLength)) {
    throw new Error("Invalid attachment size");
  }
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes (${byteLength} bytes)`
    );
  }
}

function contentId(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 12);
}

function attachmentRelativePath(conceptId: string, safeName: string, bytes: Uint8Array): string {
  const id = contentId(bytes);
  const ext = nodePath.posix.extname(safeName);
  const base = nodePath.posix.basename(safeName, ext) || "file";
  return `${ATTACHMENTS_DIR}/${conceptId}/${base}-${id}${ext}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Store attachment bytes under `attachments/<conceptId>/…` (system-root relative).
 * Identical content + fileName → same path (idempotent; skips rewrite when bytes match).
 */
export async function storeAttachmentBytes(
  fs: FsAdapter,
  conceptId: string,
  fileName: string,
  bytes: Uint8Array,
  sourceNotePath?: string
): Promise<ImportAttachmentResult> {
  if (!conceptId.trim()) throw new Error("Concept id is required");
  const safe = sanitizeAttachmentFileName(fileName);
  assertAttachmentSize(bytes.byteLength);

  const rel = attachmentRelativePath(conceptId, safe, bytes);

  // Path must stay under attachments/<conceptId>/ (defense in depth beyond FsAdapter).
  const normalized = rel.replace(/\\/g, "/");
  if (
    normalized.includes("..") ||
    !normalized.startsWith(`${ATTACHMENTS_DIR}/${conceptId}/`) ||
    normalized.split("/").some((p) => p === ".." || p === "")
  ) {
    throw new Error(`Attachment path rejected: ${rel}`);
  }

  if (await fs.exists(rel)) {
    const existing = await fs.readBinary(rel);
    if (!bytesEqual(existing, bytes)) {
      throw new Error(`Attachment content-address collision at ${rel}`);
    }
    return attachmentResult(rel, safe, sourceNotePath);
  }

  await fs.writeBinary(rel, bytes);
  return attachmentResult(rel, safe, sourceNotePath);
}

function attachmentResult(
  relativePath: string,
  label: string,
  sourceNotePath?: string
): ImportAttachmentResult {
  const target = sourceNotePath
    ? nodePath.posix.relative(nodePath.posix.dirname(sourceNotePath.replace(/\\/g, "/")), relativePath)
    : relativePath;
  return {
    relativePath,
    markdown: `![](${target})`,
    artifactRef: { kind: "path", target: relativePath, label },
  };
}
