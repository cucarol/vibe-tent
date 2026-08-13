import { nodeNotePath } from "./paths.js";
import type { Node } from "./types.js";

/** Browser-safe Node identity used by Markdown link resolution. */
export interface OkfNode {
  id: string;
  nodeId: string;
  path: string;
  notePath: string;
  name: string;
  type?: string;
}

export function buildNodeIndex(nodes: Iterable<Node>): Map<string, OkfNode[]> {
  const index = new Map<string, OkfNode[]>();
  for (const node of nodes) {
    const projected = toOkfNode(node);
    addIndex(index, projected.nodeId, projected);
    addIndex(index, projected.id, projected);
    addIndex(index, projected.path, projected);
    addIndex(index, projected.notePath, projected);
    addIndex(index, projected.name, projected);
  }
  return index;
}

export function resolveNode(
  index: Map<string, OkfNode[]>,
  target: string
): OkfNode | undefined {
  const clean = target.trim().replace(/^\.\//, "").replace(/\.md$/i, "");
  const matches =
    index.get(clean) ??
    index.get(`${clean}.md`) ??
    index.get(normalizeLookupKey(clean));
  if (matches?.length === 1) return matches[0];

  const normalized = normalizeLookupKey(clean);
  if (normalized.length >= 4) {
    const all = index.get("__all__") ?? [];
    const fuzzy = all.filter((node) =>
      normalizeLookupKey(node.name).includes(normalized)
    );
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return matches?.length === 1 ? matches[0] : undefined;
}

function toOkfNode(node: Node): OkfNode {
  const notePath = nodeNotePath(node.path);
  return {
    id: notePath.replace(/\.md$/i, ""),
    nodeId: node.id,
    path: node.path,
    notePath,
    name: node.name,
    ...(node.type ? { type: node.type } : {}),
  };
}

function addIndex(index: Map<string, OkfNode[]>, key: string, node: OkfNode): void {
  const clean = key.trim();
  if (!clean) return;
  addRawIndex(index, clean, node);
  addRawIndex(index, normalizeLookupKey(clean), node);
  addRawIndex(index, "__all__", node);
}

function addRawIndex(index: Map<string, OkfNode[]>, key: string, node: OkfNode): void {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((item) => item.id === node.id)) list.push(node);
  index.set(key, list);
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}
