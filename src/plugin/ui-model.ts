import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import { TYPE_COLORS, typeColorValue } from "./colors.js";

export type RegistrySection = "type" | "modifier" | "roles";

export interface RegistryPaneState {
  markedRoles: Set<string>;
  markedTypes: Set<string>;
  collapsed: Record<RegistrySection, boolean>;
  typeCollapsed: boolean;
  newFormOpen: RegistrySection | null;
  openEditor: string | null;
}

export interface RwSegmentState {
  label: string;
  value: boolean | undefined;
  active: boolean;
}

export interface PaneScrollPositions {
  tree: number;
  property: number;
}

export interface BottomTabCountInput {
  pendingDispatches: number;
  pendingProposals: number;
  readyReports: number;
}

export interface StatusCountInput {
  triage: number;
  dispatch: number;
}

export interface TreePendingInput {
  pendingProposals: number;
  pendingDispatches: number;
  owner?: string;
}

export interface TreeCountNode {
  children: TreeCountNode[];
}

export interface LifecycleNode {
  fm: {
    owner?: string;
    status?: string;
  };
}

export interface LifecycleTreeNode extends LifecycleNode {
  children: LifecycleTreeNode[];
}

interface ScrollPaneRoot {
  querySelector(selector: string): { scrollTop: number } | null;
}

export function capturePaneScroll(root: ScrollPaneRoot): PaneScrollPositions {
  return {
    tree: root.querySelector(".tent-tree")?.scrollTop ?? 0,
    property: root.querySelector(".tent-prop")?.scrollTop ?? 0,
  };
}

export function restorePaneScroll(root: ScrollPaneRoot, positions: PaneScrollPositions): void {
  const tree = root.querySelector(".tent-tree");
  const property = root.querySelector(".tent-prop");
  if (tree) tree.scrollTop = positions.tree;
  if (property) property.scrollTop = positions.property;
}

export function visibleTreeCount<T extends TreeCountNode>(
  node: T,
  collapsed: boolean,
  directCount: (node: T) => number
): number {
  if (!collapsed) return directCount(node);
  const subtreeCount = (current: TreeCountNode): number =>
    directCount(current as T) +
    current.children.reduce((total, child) => total + subtreeCount(child), 0);
  return subtreeCount(node);
}

export function showsUnstampedState(node: LifecycleNode): boolean {
  return node.fm.status !== undefined || !!node.fm.owner;
}

export function statuslessDirectChildren<T extends LifecycleTreeNode>(node: T): T["children"] {
  return node.children.filter((child) => child.fm.status === undefined) as T["children"];
}

export function bottomTabCounts(input: BottomTabCountInput): { dispatch: number; triage: number } {
  return {
    dispatch: input.pendingDispatches,
    triage: input.pendingProposals + input.readyReports,
  };
}

export function statusBarText(total: number): string {
  return total > 0 ? `${total} 在办` : "帐内无事";
}

export function statusBarTotal(input: StatusCountInput): number {
  return input.triage + input.dispatch;
}

export function statusIncreaseNoticeDelta(previousTriage: number | null, triage: number): number | null {
  return previousTriage !== null && triage > previousTriage ? triage - previousTriage : null;
}

export function statusIncreaseNoticeText(increase: number): string {
  return `帐内新增 ${increase} 项待裁`;
}

export function hasTreePending(input: TreePendingInput): boolean {
  return input.pendingProposals > 0 || input.pendingDispatches > 0 || !!input.owner;
}

export function bottomTabParts(label: string, count: number): { label: string; count: string } {
  return {
    label,
    count: count > 0 ? `(${count})` : "",
  };
}

export function createRegistryPaneState(): RegistryPaneState {
  return {
    markedRoles: new Set<string>(),
    markedTypes: new Set<string>(),
    collapsed: { type: false, modifier: false, roles: false },
    typeCollapsed: false,
    newFormOpen: null,
    openEditor: null,
  };
}

export function rwSegmentStates(
  declared: boolean | undefined,
  allowInherit = true
): RwSegmentState[] {
  const states: Array<{ label: string; value: boolean | undefined }> = allowInherit
    ? [
        { label: "继承", value: undefined },
        { label: "开", value: true },
        { label: "关", value: false },
      ]
    : [
        { label: "开", value: true },
        { label: "关", value: false },
      ];
  return states.map((state) => ({
    ...state,
    active: declared === state.value,
  }));
}

export function roleColorValue(role: RoleDefinition): string {
  if (role.color) return typeColorValue(role.color);
  const normalized = role.name.toLowerCase();
  if (normalized.includes("planner")) return typeColorValue("purple");
  if (normalized.includes("executor")) return typeColorValue("cyan");
  if (normalized.includes("ui")) return typeColorValue("orange");
  const hash = [...role.name].reduce((total, character) => total + character.charCodeAt(0), 0);
  return typeColorValue(TYPE_COLORS[hash % TYPE_COLORS.length]);
}
