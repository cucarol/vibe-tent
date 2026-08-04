import type {
  DesktopDocumentError,
  DesktopDocumentRequest,
  DesktopDocumentResponse,
} from "../../document-ipc.js";
import type { ArtifactRef, ArtifactKind } from "../../../core/artifact.js";

export const DOCUMENT_TIMEOUT_MS = 12_000;

export type FocusDocumentSnapshot = {
  workspaceId: string;
  nodeId: string;
  path: string;
  name: string;
  type: string;
  body: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  etag: string;
  artifactRefs: ArtifactRef[];
};

export type FocusBacklink = {
  fromNodeId: string;
  fromPath: string;
  fromName: string;
  raw: string;
  kind: "wiki" | "md";
};

export type FocusBacklinks = {
  workspaceId: string;
  nodeId: string;
  backlinks: FocusBacklink[];
};

export type FocusDocumentWrite = {
  workspaceId: string;
  nodeId: string;
  path: string;
  etag: string;
};

export type DocumentIssue = DesktopDocumentError | {
  kind: "timeout" | "corrupt" | "request";
  message: string;
  code?: number;
  data?: unknown;
};

export type DocumentRead<T> =
  | { ok: true; workspaceId: string; nodeId: string; value: T; fetchedAt: string }
  | { ok: false; workspaceId: string; nodeId: string; issue: DocumentIssue; failedAt: string };

export type DocumentTransport = (
  request: DesktopDocumentRequest
) => Promise<DesktopDocumentResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "path",
  "directory",
  "commit",
  "url",
]);

function normalizeFocusArtifactRefs(raw: unknown[]): ArtifactRef[] {
  const refs = raw.map((value, index): ArtifactRef => {
    if (!isRecord(value)) {
      throw new Error(`docs.readForEdit artifactRefs[${index}] is not an object`);
    }
    if (Object.keys(value).some((key) => key !== "kind" && key !== "target" && key !== "label")) {
      throw new Error(`docs.readForEdit artifactRefs[${index}] has unknown fields`);
    }
    if (
      typeof value.kind !== "string" ||
      !ARTIFACT_KINDS.has(value.kind as ArtifactKind) ||
      typeof value.target !== "string" ||
      !value.target.trim() ||
      !(value.label === undefined || typeof value.label === "string")
    ) {
      throw new Error(`docs.readForEdit artifactRefs[${index}] is corrupt`);
    }
    const kind = value.kind as ArtifactKind;
    let target = value.target.trim();
    if (kind === "path" || kind === "directory") {
      const portable = target.replaceAll("\\", "/");
      if (
        portable.startsWith("/") ||
        /^[a-zA-Z]:/.test(portable) ||
        portable.includes("\0") ||
        portable.split("/").some((segment) => segment === "..")
      ) {
        throw new Error(`docs.readForEdit artifactRefs[${index}] path escapes the workspace`);
      }
      target = portable.split("/").filter((segment) => segment && segment !== ".").join("/");
      if (!target) throw new Error(`docs.readForEdit artifactRefs[${index}] path is empty`);
    } else if (kind === "commit") {
      target = target.toLowerCase();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target)) {
        throw new Error(`docs.readForEdit artifactRefs[${index}] commit is corrupt`);
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw new Error(`docs.readForEdit artifactRefs[${index}] URL is corrupt`);
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error(`docs.readForEdit artifactRefs[${index}] URL is not allowed`);
      }
      target = parsed.href;
    }
    const label = value.label?.trim();
    return { kind, target, ...(label ? { label } : {}) };
  });
  const identities = new Set<string>();
  for (const ref of refs) {
    const identity = JSON.stringify([ref.kind, ref.target]);
    if (identities.has(identity)) {
      throw new Error("docs.readForEdit artifactRefs contains duplicate targets");
    }
    identities.add(identity);
  }
  return refs;
}

function requireIdentity(
  value: Record<string, unknown>,
  workspaceId: string,
  nodeId: string,
  label: string
): void {
  if (value.workspaceId !== workspaceId || value.nodeId !== nodeId) {
    throw new Error(`${label} workspaceId/nodeId mismatch`);
  }
}

export function normalizeFocusDocumentSnapshot(
  raw: unknown,
  workspaceId: string,
  nodeId: string
): FocusDocumentSnapshot {
  if (!isRecord(raw)) throw new Error("docs.readForEdit payload is not an object");
  requireIdentity(raw, workspaceId, nodeId, "docs.readForEdit");
  if (
    typeof raw.path !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.body !== "string" ||
    typeof raw.raw !== "string" ||
    typeof raw.etag !== "string" ||
    !raw.etag ||
    !isRecord(raw.frontmatter) ||
    !Array.isArray(raw.artifactRefs)
  ) {
    throw new Error("docs.readForEdit payload is corrupt");
  }
  return {
    workspaceId,
    nodeId,
    path: raw.path,
    name: raw.name,
    type: raw.type,
    body: raw.body,
    raw: raw.raw,
    etag: raw.etag,
    frontmatter: { ...raw.frontmatter },
    artifactRefs: normalizeFocusArtifactRefs(raw.artifactRefs),
  };
}

export function normalizeFocusBacklinks(
  raw: unknown,
  workspaceId: string,
  nodeId: string
): FocusBacklinks {
  if (!isRecord(raw)) throw new Error("docs.backlinks payload is not an object");
  requireIdentity(raw, workspaceId, nodeId, "docs.backlinks");
  if (!Array.isArray(raw.backlinks)) {
    throw new Error("docs.backlinks payload is corrupt");
  }
  const backlinks = raw.backlinks.map((value, index): FocusBacklink => {
    if (
      !isRecord(value) ||
      typeof value.fromNodeId !== "string" ||
      !value.fromNodeId ||
      typeof value.fromPath !== "string" ||
      typeof value.fromName !== "string" ||
      typeof value.raw !== "string" ||
      (value.kind !== "wiki" && value.kind !== "md")
    ) {
      throw new Error(`docs.backlinks backlinks[${index}] is corrupt`);
    }
    return {
      fromNodeId: value.fromNodeId,
      fromPath: value.fromPath,
      fromName: value.fromName,
      raw: value.raw,
      kind: value.kind,
    };
  });
  return { workspaceId, nodeId, backlinks };
}

export function normalizeFocusDocumentWrite(
  raw: unknown,
  workspaceId: string,
  nodeId: string
): FocusDocumentWrite {
  if (!isRecord(raw)) throw new Error("docs.write payload is not an object");
  requireIdentity(raw, workspaceId, nodeId, "docs.write");
  if (typeof raw.path !== "string" || typeof raw.etag !== "string" || !raw.etag) {
    throw new Error("docs.write payload is corrupt");
  }
  return { workspaceId, nodeId, path: raw.path, etag: raw.etag };
}

class DocumentTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DocumentTimeoutError(`Document request timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readDocument<T>(args: {
  transport: DocumentTransport;
  request: DesktopDocumentRequest;
  normalize: (raw: unknown) => T;
  timeoutMs: number;
}): Promise<DocumentRead<T>> {
  const { workspaceId, nodeId } = args.request;
  if (!workspaceId.trim() || !nodeId.trim()) {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: { kind: "request", message: "workspaceId and nodeId are required" },
      failedAt: new Date().toISOString(),
    };
  }
  let envelope: unknown;
  try {
    envelope = await withTimeout(args.transport(args.request), args.timeoutMs);
  } catch (cause) {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: cause instanceof DocumentTimeoutError
        ? { kind: "timeout", message: cause.message }
        : {
            kind: "transport",
            message: cause instanceof Error ? cause.message : "Document transport failed",
          },
      failedAt: new Date().toISOString(),
    };
  }
  if (!isRecord(envelope) || typeof envelope.ok !== "boolean") {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: { kind: "corrupt", message: "Document IPC envelope is corrupt" },
      failedAt: new Date().toISOString(),
    };
  }
  if (!envelope.ok) {
    const error = envelope.error;
    if (
      !isRecord(error) ||
      (error.kind !== "rpc" && error.kind !== "transport" && error.kind !== "invalid-request") ||
      typeof error.message !== "string" ||
      !(error.code === undefined || typeof error.code === "number")
    ) {
      return {
        ok: false,
        workspaceId,
        nodeId,
        issue: { kind: "corrupt", message: "Document IPC error envelope is corrupt" },
        failedAt: new Date().toISOString(),
      };
    }
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: {
        kind: error.kind,
        message: error.message,
        ...(typeof error.code === "number" ? { code: error.code } : {}),
        ...(Object.prototype.hasOwnProperty.call(error, "data") ? { data: error.data } : {}),
      },
      failedAt: new Date().toISOString(),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "value")) {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: { kind: "corrupt", message: "Document IPC success envelope is corrupt" },
      failedAt: new Date().toISOString(),
    };
  }
  try {
    const value = args.normalize(envelope.value);
    return {
      ok: true,
      workspaceId,
      nodeId,
      value,
      fetchedAt: new Date().toISOString(),
    };
  } catch (cause) {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: {
        kind: "corrupt",
        message: cause instanceof Error ? cause.message : "Document payload is corrupt",
      },
      failedAt: new Date().toISOString(),
    };
  }
}

export function readFocusDocument(
  transport: DocumentTransport,
  workspaceId: string,
  nodeId: string,
  timeoutMs = DOCUMENT_TIMEOUT_MS
): Promise<DocumentRead<FocusDocumentSnapshot>> {
  return readDocument({
    transport,
    request: { operation: "readForEdit", workspaceId, nodeId },
    normalize: (raw) => normalizeFocusDocumentSnapshot(raw, workspaceId, nodeId),
    timeoutMs,
  });
}

export function readFocusBacklinks(
  transport: DocumentTransport,
  workspaceId: string,
  nodeId: string,
  timeoutMs = DOCUMENT_TIMEOUT_MS
): Promise<DocumentRead<FocusBacklinks>> {
  return readDocument({
    transport,
    request: { operation: "backlinks", workspaceId, nodeId },
    normalize: (raw) => normalizeFocusBacklinks(raw, workspaceId, nodeId),
    timeoutMs,
  });
}

export function writeFocusDocumentBody(
  transport: DocumentTransport,
  workspaceId: string,
  nodeId: string,
  body: string,
  baseEtag: string,
  timeoutMs = DOCUMENT_TIMEOUT_MS
): Promise<DocumentRead<FocusDocumentWrite>> {
  return readDocument({
    transport,
    request: { operation: "writeBody", workspaceId, nodeId, body, baseEtag },
    normalize: (raw) => normalizeFocusDocumentWrite(raw, workspaceId, nodeId),
    timeoutMs,
  });
}
