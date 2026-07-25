// 白板生成层:把帐结构吐成 JSON Canvas(jsoncanvas.org,Obsidian 原生格式)。
// v1 用嵌套 group 铺开:顶层根框 = 带色 group,容器框 = group,叶子框 = file 节点指向同名 .md。
// 纯函数、可测;file 路径用 pathPrefix 转成 vault 相对(插件传入)。

import { Box } from "./types.js";
import { LoadedTent, boxNotePath } from "./tree.js";
import { splitType } from "./typeRegistry.js";

export interface CanvasNode {
  id: string;
  type: "group" | "file";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  file?: string;
  color?: string;
}
export interface CanvasData {
  nodes: CanvasNode[];
  edges: never[];
}

const CARD_W = 230;
const CARD_H = 56;
const PAD = 18;
const HEADER = 36;
const GAP = 12;
const COL_GAP = 48;

// JSON Canvas 预设色:1红 2橙 3黄 4绿 5青 6紫（按常见顶层文件夹名/type 名着色，非领域 type chrome）
const ROOT_COLOR: Record<string, string> = {
  goal: "5",
  prompt: "6",
  output: "4",
  temp: "",
  custom: "2",
};

interface Size {
  w: number;
  h: number;
}

export function buildCanvas(tent: LoadedTent, pathPrefix: string): CanvasData {
  const nodes: CanvasNode[] = [];
  let cursorX = 0;
  for (const root of tent.roots) {
    const s = sizeOf(root);
    layout(root, cursorX, 0, nodes, pathPrefix, true);
    cursorX += s.w + COL_GAP;
  }
  return { nodes, edges: [] };
}

function sizeOf(box: Box): Size {
  if (box.children.length === 0) return { w: CARD_W, h: CARD_H };
  let innerW = 0;
  let innerH = 0;
  const sizes = box.children.map(sizeOf);
  for (const s of sizes) {
    innerW = Math.max(innerW, s.w);
    innerH += s.h;
  }
  innerH += GAP * (box.children.length - 1);
  return { w: innerW + PAD * 2, h: innerH + HEADER + PAD };
}

function layout(box: Box, x: number, y: number, out: CanvasNode[], prefix: string, isRoot: boolean): Size {
  const s = sizeOf(box);
  if (box.children.length === 0) {
    out.push({
      id: nodeId(box),
      type: "file",
      x,
      y,
      width: CARD_W,
      height: CARD_H,
      file: filePath(box, prefix),
      color: colorFor(box, isRoot),
    });
    return s;
  }
  out.push({
    id: nodeId(box),
    type: "group",
    x,
    y,
    width: s.w,
    height: s.h,
    label: labelFor(box, isRoot),
    color: colorFor(box, isRoot),
  });
  let cy = y + HEADER;
  for (const c of box.children) {
    const cs = layout(c, x + PAD, cy, out, prefix, false);
    cy += cs.h + GAP;
  }
  return s;
}

function nodeId(box: Box): string {
  return box.id || box.path.replace(/[^a-z0-9]/gi, "-");
}
function filePath(box: Box, prefix: string): string {
  const p = boxNotePath(box.path);
  return prefix ? `${prefix}/${p}` : p;
}
function labelFor(box: Box, isRoot: boolean): string {
  const tag = isRoot ? "" : ` · ${box.type}`;
  return `${box.name}${tag}`;
}
function colorFor(box: Box, isRoot: boolean): string | undefined {
  if (isRoot) return ROOT_COLOR[box.name] || undefined;
  const { base, modifier } = splitType(box.type);
  if (base === "goal") return "5";
  if (base === "prompt") return "6";
  if (base === "output") return "4";
  if (modifier === "asset" || box.type === "asset") return "";
  return undefined;
}

// 保留上次手摆的位置:把旧 canvas 里同 id 顶层根框的位移,整体平移到新生成的对应根子树。
export function preservePositions(fresh: CanvasData, old: CanvasData | null, tent: LoadedTent): CanvasData {
  if (!old) return fresh;
  const oldById = new Map(old.nodes.map((n) => [n.id, n]));
  for (const root of tent.roots) {
    const rid = root.id || root.path;
    const freshRoot = fresh.nodes.find((n) => n.id === rid);
    const oldRoot = oldById.get(rid);
    if (!freshRoot || !oldRoot) continue;
    const dx = oldRoot.x - freshRoot.x;
    const dy = oldRoot.y - freshRoot.y;
    if (dx === 0 && dy === 0) continue;
    const subtreeIds = collectIds(root);
    for (const n of fresh.nodes) {
      if (subtreeIds.has(n.id)) {
        n.x += dx;
        n.y += dy;
      }
    }
  }
  return fresh;
}

function collectIds(box: Box): Set<string> {
  const ids = new Set<string>();
  const walk = (b: Box) => {
    ids.add(b.id || b.path);
    for (const c of b.children) walk(c);
  };
  walk(box);
  return ids;
}

export function canvasToJson(data: CanvasData): string {
  return JSON.stringify(data, null, 2);
}

export function parseCanvas(raw: string): CanvasData | null {
  try {
    const d = JSON.parse(raw);
    if (Array.isArray(d.nodes)) return d;
  } catch {
    /* ignore */
  }
  return null;
}
