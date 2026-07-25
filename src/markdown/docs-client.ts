// DocsClient — Query/Command surface for Markdown workspace (concept-model §8).
// Transport (in-process core vs B2 JSON-RPC) is an implementation detail.

import type {
  ArtifactRef,
  BacklinkHit,
  ConceptEditSnapshot,
  ConceptProjection,
  CreateNoteInput,
  DocsWriteInput,
  DocsWriteResult,
  ResolvedLink,
  SearchHit,
} from "./types.js";

export interface DocsClient {
  list(parentPath?: string): Promise<ConceptProjection[]>;
  get(cxOrPath: string): Promise<ConceptProjection | null>;
  readForEdit(cxOrPath: string): Promise<ConceptEditSnapshot>;
  write(input: DocsWriteInput): Promise<DocsWriteResult>;
  createNote(input: CreateNoteInput): Promise<{ cx: string; path: string }>;
  fork(cxOrPath: string): Promise<{ cx: string }>;
  search(query: string): Promise<SearchHit[]>;
  backlinks(cxOrPath: string): Promise<BacklinkHit[]>;
  resolveLink(fromCxOrPath: string, raw: string): Promise<ResolvedLink>;
  importAttachment(
    cx: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string; artifactRef?: ArtifactRef }>;
}
