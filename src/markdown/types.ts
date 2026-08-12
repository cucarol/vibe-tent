// Markdown workspace wire types — aligned with docs/desktop/node-model.md §8
// and architecture EventEnvelope shapes (docs client surface only).

export type NodeMode = "editable" | "archived";

export type NodeProjection = {
  nodeId: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  title?: string;
  mode: NodeMode;
  archived: boolean;
  invalid: boolean;
  bodyPreview?: string;
  children: NodeProjection[];
};

export type NodeEditSnapshot = {
  nodeId: string;
  path: string;
  name: string;
  type: string;
  body: string;
  frontmatter: Record<string, unknown>;
  raw: string;
  etag: string;
};

export type DocsWriteInput = {
  nodeId: string;
  baseEtag: string;
  /** Full raw file (frontmatter + body), or body-only with frontmatter patch. */
  raw?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};

export type DocsWriteResult =
  | { ok: true; etag: string; nodeId: string; path: string }
  | {
      ok: false;
      code:
        | "etag_required"
        | "etag_conflict"
        | "collab_field_protected"
        | "not_found"
        | "invalid";
      message: string;
      disk?: NodeEditSnapshot;
    };

export type CreateNoteInput = {
  parentPath?: string;
  name: string;
  type?: string;
  body?: string;
};

export type SearchHit = {
  nodeId: string;
  path: string;
  name: string;
  title?: string;
  snippet: string;
  match: "title" | "body" | "path";
};

export type ResolvedLink = {
  raw: string;
  kind: "wiki" | "md" | "artifact" | "unresolved";
  targetNodeId?: string;
  targetPath?: string;
  label?: string;
};

export type BacklinkHit = {
  fromNodeId: string;
  fromPath: string;
  fromName: string;
  raw: string;
  kind: "wiki" | "md";
};

export type OutLink = {
  raw: string;
  kind: "wiki" | "md" | "artifact";
  targetNodeId?: string;
  targetPath?: string;
  label?: string;
};

/** Retired collaboration frontmatter fields that Node writes must not revive. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;

export type ProtectedCollabField = (typeof PROTECTED_COLLAB_FIELDS)[number];
