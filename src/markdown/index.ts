// Markdown / Concept desktop workspace (B3) — public surface.

export type { DocsClient } from "./docs-client.js";
export { CoreDocsClient } from "./core-docs-client.js";
export {
  MAX_ATTACHMENT_BYTES,
  sanitizeAttachmentFileName,
  decodeBase64Strict,
  storeAttachmentBytes,
} from "./attachments.js";

export { contentEtag } from "./etag.js";
export {
  extractOutLinks,
  buildBacklinkIndex,
  resolveOutLink,
  indexFromBoxes,
} from "./links.js";
export { renderMarkdownToHtml, escapeHtml, listWikiTargets } from "./render.js";
export {
  WorkspaceController,
  type TabState,
  type WorkspaceSnapshot,
  type EditorMode,
  type ConflictState,
} from "./workspace-controller.js";
export { renderWorkspacePage } from "./html-shell.js";
export {
  startMarkdownPreviewServer,
  type PreviewServerOptions,
  type PreviewServerHandle,
} from "./preview-server.js";
export type {
  ArtifactRef,
  ConceptProjection,
  ConceptEditSnapshot,
  DocsWriteInput,
  DocsWriteResult,
  CreateNoteInput,
  SearchHit,
  ResolvedLink,
  BacklinkHit,
  OutLink,
} from "./types.js";
export { PROTECTED_COLLAB_FIELDS } from "./types.js";
