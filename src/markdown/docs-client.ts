// DocsClient — Query/Command surface for Markdown workspace (node-model §8).
// Transport (in-process core vs B2 JSON-RPC) is an implementation detail.

import type {
  BacklinkHit,
  NodeEditSnapshot,
  NodeProjection,
  CreateNoteInput,
  DocsWriteInput,
  DocsWriteResult,
  ResolvedLink,
  SearchHit,
} from "./types.js";

export interface DocsClient {
  list(parentPath?: string): Promise<NodeProjection[]>;
  get(nodeId: string): Promise<NodeProjection | null>;
  readForEdit(nodeId: string): Promise<NodeEditSnapshot>;
  write(input: DocsWriteInput): Promise<DocsWriteResult>;
  createNote(input: CreateNoteInput): Promise<{ nodeId: string; path: string }>;
  fork(nodeId: string): Promise<{ nodeId: string }>;
  search(query: string): Promise<SearchHit[]>;
  backlinks(nodeId: string): Promise<BacklinkHit[]>;
  resolveLink(fromNodeId: string, raw: string): Promise<ResolvedLink>;
  importAttachment(
    nodeId: string,
    fileName: string,
    bytes: Uint8Array | string
  ): Promise<{ relativePath: string; markdown: string }>;
}
