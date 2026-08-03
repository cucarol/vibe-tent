import path from "node:path";

export const ARTIFACT_KINDS = ["path", "directory", "commit", "url"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactRef = {
  kind: ArtifactKind;
  target: string;
  label?: string;
};

export class ArtifactRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRefError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkspaceTarget(value: string): string {
  const target = value.trim();
  if (!target) throw new ArtifactRefError("Artifact path target must not be empty.");
  if (target.includes("\0")) throw new ArtifactRefError("Artifact path target must not contain NUL.");
  if (
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target) ||
    /^[a-zA-Z]:/.test(target) ||
    target.startsWith("\\\\") ||
    target.startsWith("//")
  ) {
    throw new ArtifactRefError("Artifact path target must be workspace-relative.");
  }

  const portable = target.replace(/\\/g, "/");
  if (portable.split("/").some((segment) => segment === "..")) {
    throw new ArtifactRefError("Artifact path target must stay inside the workspace.");
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new ArtifactRefError("Artifact path target must name workspace content.");
  }
  return normalized;
}

function normalizeCommit(value: string): string {
  const target = value.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target)) {
    throw new ArtifactRefError("Artifact commit target must be a full 40- or 64-character hex id.");
  }
  return target;
}

function normalizeUrl(value: string): string {
  const target = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ArtifactRefError("Artifact URL target must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArtifactRefError("Artifact URL target must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new ArtifactRefError("Artifact URL target must not contain credentials.");
  }
  return parsed.href;
}

export function normalizeArtifactRef(value: unknown): ArtifactRef {
  if (!isRecord(value)) throw new ArtifactRefError("Artifact ref must be an object.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "kind" && key !== "target" && key !== "label")) {
    throw new ArtifactRefError("Artifact ref contains unknown fields.");
  }
  if (typeof value.kind !== "string" || !ARTIFACT_KINDS.includes(value.kind as ArtifactKind)) {
    throw new ArtifactRefError(`Artifact kind must be one of: ${ARTIFACT_KINDS.join(", ")}.`);
  }
  if (typeof value.target !== "string") {
    throw new ArtifactRefError("Artifact target must be a string.");
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    throw new ArtifactRefError("Artifact label must be a string when present.");
  }

  const kind = value.kind as ArtifactKind;
  const target =
    kind === "path" || kind === "directory"
      ? normalizeWorkspaceTarget(value.target)
      : kind === "commit"
        ? normalizeCommit(value.target)
        : normalizeUrl(value.target);
  const label = value.label?.trim();
  return { kind, target, ...(label ? { label } : {}) };
}

export function normalizeArtifactRefs(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) throw new ArtifactRefError("Artifact refs must be an array.");
  const byIdentity = new Map<string, ArtifactRef>();
  for (const item of value) {
    const ref = normalizeArtifactRef(item);
    const key = artifactRefIdentity(ref);
    const previous = byIdentity.get(key);
    if (previous && previous.label !== ref.label) {
      throw new ArtifactRefError(
        `Artifact ref has conflicting labels for the same target: ${ref.kind} ${ref.target}.`
      );
    }
    byIdentity.set(key, ref);
  }
  return [...byIdentity.values()].sort((a, b) => {
    for (const [left, right] of [
      [a.kind, b.kind],
      [a.target, b.target],
    ] as const) {
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  });
}

export function artifactRefIdentity(ref: ArtifactRef): string {
  const normalized = normalizeArtifactRef(ref);
  return JSON.stringify([normalized.kind, normalized.target]);
}
