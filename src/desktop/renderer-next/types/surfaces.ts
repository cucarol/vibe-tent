/**
 * App surfaces for the Canvas-first single-window shell.
 * Outline is drawer/overlay chrome (default collapsed), not a stage surface.
 */

export type AppSurfaceId =
  | "canvas"
  | "focus-workspace"
  | "inbox"
  | "search"
  | "settings"
  | "activity";

export const APP_SURFACE_IDS: readonly AppSurfaceId[] = [
  "canvas",
  "focus-workspace",
  "inbox",
  "search",
  "settings",
  "activity",
] as const;

export type AppSurfaceMeta = {
  id: AppSurfaceId;
  /** Stable UI label key — Chinese product copy lives in shell placeholders. */
  label: string;
  /** Whether this surface is the default stage host. */
  defaultStage?: boolean;
};

export const APP_SURFACES: readonly AppSurfaceMeta[] = [
  { id: "canvas", label: "Canvas", defaultStage: true },
  { id: "focus-workspace", label: "Focus Workspace" },
  { id: "inbox", label: "Inbox" },
  { id: "search", label: "Search" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
] as const;

export function isAppSurfaceId(value: string): value is AppSurfaceId {
  return (APP_SURFACE_IDS as readonly string[]).includes(value);
}

export function defaultAppSurface(): AppSurfaceId {
  return "canvas";
}
