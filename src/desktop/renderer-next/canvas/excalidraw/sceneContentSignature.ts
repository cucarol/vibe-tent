/**
 * Shallow O(n) content signature for Excalidraw scene change detection.
 *
 * - Every element's durable id/version/versionNonce participates (not only the tip).
 * - Files: each id + rolling checksum of payload so replace-under-same-id is visible,
 *   including equal-length base64 with identical prefix/suffix but different middle.
 * - No structuredClone / no payload string copy — checksum walks in place.
 */

export type ElementVersionFields = {
  id?: unknown;
  version?: unknown;
  versionNonce?: unknown;
  isDeleted?: unknown;
  updated?: unknown;
};

/**
 * FNV-1a 32-bit rolling checksum over a string.
 * O(n) time, O(1) space — reads charCodeAt only; never slices/copies the payload.
 * Catches equal-length middle-byte replacements that length+ends tokens miss.
 */
export function rollingStringChecksum(s: string): string {
  let h = 0x811c9dc5;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    h ^= s.charCodeAt(i);
    // Math.imul keeps 32-bit multiply semantics without BigInt.
    h = Math.imul(h, 0x01000193);
  }
  // unsigned hex for stable token text
  return `s${len}:${(h >>> 0).toString(16)}`;
}

/**
 * Bounded rolling checksum for ArrayBuffer-like views.
 * Walks bytes in place; no copy of the buffer.
 */
export function rollingBytesChecksum(
  bytes: ArrayLike<number> & { length: number }
): string {
  let h = 0x811c9dc5;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    h ^= bytes[i]! & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return `b${len}:${(h >>> 0).toString(16)}`;
}

/**
 * Build a stable shallow token for one file entry without deep-cloning bytes.
 * Prefer explicit version-ish fields; dataURL/data use rolling checksum.
 */
export function fileEntryToken(entry: unknown): string {
  if (entry == null) return "∅";
  if (typeof entry !== "object") return `p:${typeof entry}`;
  const rec = entry as Record<string, unknown>;
  const id = rec.id != null ? String(rec.id) : "";
  const mime = rec.mimeType != null ? String(rec.mimeType) : "";
  const created = rec.created != null ? String(rec.created) : "";
  const data = rec.dataURL ?? rec.data;
  let dataTok = "";
  if (typeof data === "string") {
    dataTok = rollingStringChecksum(data);
  } else if (data instanceof ArrayBuffer) {
    dataTok = rollingBytesChecksum(new Uint8Array(data));
  } else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    dataTok = rollingBytesChecksum(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    );
  } else if (data && typeof data === "object") {
    const bl = (data as { byteLength?: number }).byteLength;
    dataTok =
      typeof bl === "number"
        ? `o${bl}`
        : `o${Object.keys(data as object).length}`;
  } else if (data != null) {
    dataTok = `t${typeof data}`;
  }
  return `${id}|${mime}|${created}|${dataTok}`;
}

/**
 * O(n) shallow signature over all elements + all file entries.
 * Order of elements matters (Excalidraw z-order). File keys are sorted for stability.
 */
export function sceneContentSignature(
  elements: readonly unknown[],
  files: Record<string, unknown> | null | undefined
): string {
  const elParts: string[] = new Array(elements.length);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as ElementVersionFields | null | undefined;
    if (!el || typeof el !== "object") {
      elParts[i] = `?${i}`;
      continue;
    }
    elParts[i] = [
      el.id ?? "",
      el.version ?? "",
      el.versionNonce ?? "",
      el.isDeleted === true ? "1" : "0",
      el.updated ?? "",
    ].join(":");
  }

  const fileMap = files ?? {};
  const keys = Object.keys(fileMap).sort();
  const fileParts: string[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    fileParts[i] = `${k}=${fileEntryToken(fileMap[k])}`;
  }

  return `e${elements.length}[${elParts.join(";")}]|f${keys.length}{${fileParts.join(";")}}`;
}
