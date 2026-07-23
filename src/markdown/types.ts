// Markdown workspace wire types — aligned with docs/desktop/concept-model.md §8
// and architecture EventEnvelope shapes (docs client surface only).

/** Structured association to a real deliverable outside concept identity. */
export type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  target: string;
  label?: string;
};

export type NodeMode = "editable" | "read-only" | "archived";

export type ConceptProjection = {
  id: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  coordination: boolean;
  status?: string;
  assignee?: string;
  title?: string;
  mode: NodeMode;
  archived: boolean;
  invalid: boolean;
  bodyPreview?: string;
  children: ConceptProjection[];
  artifactRefs?: ArtifactRef[];
};

export type ConceptEditSnapshot = {
  cx: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  body: string;
  frontmatter: Record<string, unknown>;
  raw: string;
  etag: string;
  artifactRefs: ArtifactRef[];
};

export type DocsWriteInput = {
  cx: string;
  baseEtag: string;
  /** Full raw file (frontmatter + body), or body-only with frontmatter patch. */
  raw?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};

export type DocsWriteResult =
  | { ok: true; etag: string; cx: string; path: string }
  | {
      ok: false;
      code:
        | "etag_required"
        | "etag_conflict"
        | "collab_field_protected"
        | "not_found"
        | "invalid";
      message: string;
      disk?: ConceptEditSnapshot;
    };

export type CreateNoteInput = {
  parentPath?: string;
  name: string;
  type?: string;
  body?: string;
};

export type SearchHit = {
  cx: string;
  path: string;
  name: string;
  title?: string;
  snippet: string;
  match: "title" | "body" | "path";
};

export type ResolvedLink = {
  raw: string;
  kind: "wiki" | "md" | "artifact" | "unresolved";
  targetCx?: string;
  targetPath?: string;
  label?: string;
};

export type BacklinkHit = {
  fromCx: string;
  fromPath: string;
  fromName: string;
  raw: string;
  kind: "wiki" | "md";
};

export type OutLink = {
  raw: string;
  kind: "wiki" | "md" | "artifact";
  targetCx?: string;
  targetPath?: string;
  label?: string;
};

/** Collaboration projection fields protected while a box has an active task. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;

export type ProtectedCollabField = (typeof PROTECTED_COLLAB_FIELDS)[number];
