import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import { TYPE_COLORS, typeColorValue } from "./colors.js";

export type RegistrySection = "type" | "kind" | "roles";

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

export function createRegistryPaneState(): RegistryPaneState {
  return {
    markedRoles: new Set<string>(),
    markedTypes: new Set<string>(),
    collapsed: { type: false, kind: false, roles: false },
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
