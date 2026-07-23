/**
 * Builds a realistic Tent-like working set: nested goals/notes/artifacts,
 * parent edges, resolved & unresolved wiki links, plus visual annotations.
 * Count target: 250–300 domain nodes.
 */

import {
  emptyCanvasDocument,
  upsertAnnotation,
  upsertVisualGroup,
} from "./canvasDocument.js";
import type {
  CanvasDocument,
  DomainNode,
  ExperimentEdge,
  Placement,
  WorkingSetSnapshot,
} from "./types.js";

const TYPES = ["goal", "note", "prompt", "artifact", "goal"] as const;
const STATUSES = ["todo", "doing", "done"] as const;

const TITLE_STEMS = [
  "Tent 独立桌面",
  "Core 契约",
  "Local Service",
  "Agent Runtime",
  "Markdown 子系统",
  "Canvas 投影",
  "Working-set",
  "Focus Workspace",
  "Delivery 审阅",
  "Task 生命周期",
  "ACP Provider",
  "Box 投影",
  "Outline 导航",
  "Placement 模型",
  "Viewport 恢复",
  "协作意图",
  "Context Card",
  "Type Registry",
  "OKF 校验",
  "桌面壳层",
];

function hash(n: number): number {
  let x = (n * 1103515245 + 12345) >>> 0;
  return x;
}

function pick<T>(arr: readonly T[], n: number): T {
  return arr[hash(n) % arr.length]!;
}

export type SyntheticOptions = {
  /** Inclusive target range; default 250–300. */
  minNodes?: number;
  maxNodes?: number;
  seed?: number;
};

/**
 * Deterministic synthetic Tent working-set for scale / interaction tests.
 */
export function buildSyntheticWorkingSet(
  opts: SyntheticOptions = {}
): WorkingSetSnapshot {
  const minNodes = opts.minNodes ?? 250;
  const maxNodes = opts.maxNodes ?? 300;
  const seed = opts.seed ?? 42;
  const target = minNodes + (hash(seed) % (maxNodes - minNodes + 1));

  const domainNodes: DomainNode[] = [];
  const edges: ExperimentEdge[] = [];
  const placements: Placement[] = [];

  // Forest: several roots, then branching children to reach target count.
  const rootCount = 8;
  let created = 0;
  const queue: { entityRef: string; depth: number; col: number; row: number }[] =
    [];

  for (let r = 0; r < rootCount && created < target; r++) {
    const entityRef = `cx-root${String(r).padStart(3, "0")}`;
    const type = r % 3 === 0 ? "goal" : pick(TYPES, seed + r);
    const node: DomainNode = {
      entityRef,
      title: `${pick(TITLE_STEMS, seed + r)} · 根 ${r + 1}`,
      type,
      parentEntityRef: null,
      coordination: type === "goal" || type === "prompt" || type === "artifact",
      status: pick(STATUSES, seed + r * 3),
      assignee: r % 4 === 0 ? "grok-core-worker" : r % 4 === 1 ? "ui-erbao" : undefined,
      tags: ["synthetic", type],
      bodyPreview: `# ${pick(TITLE_STEMS, seed + r)}\n\n根节点 ${r + 1}。\n\n- entityRef: \`${entityRef}\`\n- 这是 Focus Workspace 草稿种子。\n`,
    };
    domainNodes.push(node);
    const col = r % 4;
    const row = Math.floor(r / 4);
    placements.push({
      placementId: `pl-${entityRef}`,
      entityRef,
      x: 80 + col * 520,
      y: 80 + row * 420,
      width: 200,
      height: 72,
    });
    queue.push({ entityRef, depth: 0, col, row });
    created++;
  }

  let childSerial = 0;
  while (created < target && queue.length > 0) {
    const parent = queue.shift()!;
    // Branch factor shrinks with depth to keep a realistic tree shape.
    const branch =
      parent.depth === 0 ? 5 : parent.depth === 1 ? 4 : parent.depth === 2 ? 3 : 2;
    for (let b = 0; b < branch && created < target; b++) {
      childSerial++;
      const entityRef = `cx-n${String(childSerial).padStart(4, "0")}`;
      const type = pick(TYPES, seed + childSerial);
      const node: DomainNode = {
        entityRef,
        title: `${pick(TITLE_STEMS, seed + childSerial * 7)} ${childSerial}`,
        type,
        parentEntityRef: parent.entityRef,
        coordination: type !== "note",
        status: type === "note" ? undefined : pick(STATUSES, childSerial),
        assignee:
          childSerial % 11 === 0
            ? "grok-core-worker"
            : childSerial % 17 === 0
              ? "ui-erbao"
              : undefined,
        tags: ["synthetic", type, `d${parent.depth + 1}`],
        bodyPreview: `# ${pick(TITLE_STEMS, childSerial)}\n\n子节点 ${childSerial} under \`${parent.entityRef}\`.\n\n## 说明\n\n- 父子关系来自 domain，不来自 placement。\n- 拖动画布只改 placement。\n`,
      };
      domainNodes.push(node);

      const angle = (b / Math.max(branch, 1)) * Math.PI * 1.2 - 0.4;
      const dist = 160 + parent.depth * 20 + (hash(childSerial) % 40);
      const px = placements.find((p) => p.entityRef === parent.entityRef);
      const x = (px?.x ?? 0) + Math.cos(angle) * dist + (b % 3) * 24;
      const y = (px?.y ?? 0) + 100 + Math.sin(angle) * dist * 0.35 + parent.depth * 90;

      placements.push({
        placementId: `pl-${entityRef}`,
        entityRef,
        x: Math.round(x),
        y: Math.round(y),
        width: 188,
        height: 68,
      });

      edges.push({
        id: `e-parent-${entityRef}`,
        kind: "parent",
        source: parent.entityRef,
        target: entityRef,
        label: "parent",
      });

      if (parent.depth < 4) {
        queue.push({
          entityRef,
          depth: parent.depth + 1,
          col: parent.col,
          row: parent.row,
        });
      }
      created++;
    }
  }

  // Resolved wiki-style links (entity → entity that exists).
  const resolvedCount = Math.min(80, Math.floor(domainNodes.length * 0.28));
  for (let i = 0; i < resolvedCount; i++) {
    const a = domainNodes[hash(seed + i * 13) % domainNodes.length]!;
    const b = domainNodes[hash(seed + i * 29) % domainNodes.length]!;
    if (a.entityRef === b.entityRef) continue;
    edges.push({
      id: `e-res-${i}`,
      kind: "resolved-link",
      source: a.entityRef,
      target: b.entityRef,
      label: "[[resolved]]",
    });
  }

  // Unresolved links: target is a dangling ref string (not in domain).
  const unresolvedCount = Math.min(40, Math.floor(domainNodes.length * 0.12));
  for (let i = 0; i < unresolvedCount; i++) {
    const a = domainNodes[hash(seed + i * 41) % domainNodes.length]!;
    edges.push({
      id: `e-unres-${i}`,
      kind: "unresolved-link",
      source: a.entityRef,
      target: `cx-missing-${String(i).padStart(3, "0")}`,
      label: "[[unresolved]]",
    });
  }

  // Visual groups + annotations on CanvasDocument only.
  let document: CanvasDocument = emptyCanvasDocument({ x: 40, y: 40, zoom: 0.75 });
  document = {
    ...document,
    placements: placements.map((p) => ({ ...p })),
  };

  const groupA = {
    id: "vg-core",
    label: "视觉分组 · Core 区",
    x: 40,
    y: 40,
    width: 980,
    height: 620,
  };
  const groupB = {
    id: "vg-ui",
    label: "视觉分组 · UI 区",
    x: 1080,
    y: 40,
    width: 980,
    height: 620,
  };
  document = upsertVisualGroup(document, groupA);
  document = upsertVisualGroup(document, groupB);

  // Assign first ~30 placements into groups by x position (visual only).
  document = {
    ...document,
    placements: document.placements.map((p, idx) => {
      if (idx > 40) return p;
      if (p.x < 1000) return { ...p, visualGroupId: "vg-core" };
      return { ...p, visualGroupId: "vg-ui" };
    }),
  };

  const ann1 = {
    id: "ann-note-1",
    text: "视觉批注：拖动只改 placement，不改父子。",
    x: 520,
    y: 20,
    width: 220,
    height: 56,
  };
  const ann2 = {
    id: "ann-note-2",
    text: "四类 edge 仅为实验 overlay，非 Core schema。",
    x: 1200,
    y: 20,
    width: 240,
    height: 56,
  };
  document = upsertAnnotation(document, ann1);
  document = upsertAnnotation(document, ann2);

  // Visual-annotation edges: placement → annotation (canvas-only).
  edges.push({
    id: "e-vann-1",
    kind: "visual-annotation",
    source: document.placements[0]!.placementId,
    target: ann1.id,
    label: "annotate",
  });
  edges.push({
    id: "e-vann-2",
    kind: "visual-annotation",
    source: document.placements[Math.min(12, document.placements.length - 1)]!
      .placementId,
    target: ann2.id,
    label: "annotate",
  });

  return { domainNodes, edges, document };
}

export function countEdgeKinds(edges: ExperimentEdge[]): Record<string, number> {
  const out: Record<string, number> = {
    parent: 0,
    "resolved-link": 0,
    "unresolved-link": 0,
    "visual-annotation": 0,
  };
  for (const e of edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
