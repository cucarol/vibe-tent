/** Batch-1 production shell has one stage: Canvas. Outline and Focus are trays. */
export type AppSurfaceId = "canvas";

export const APP_SURFACE_IDS: readonly AppSurfaceId[] = ["canvas"] as const;

export type AppSurfaceMeta = {
  id: AppSurfaceId;
  label: string;
  defaultStage: true;
};

export const APP_SURFACES: readonly AppSurfaceMeta[] = [
  { id: "canvas", label: "画布", defaultStage: true },
] as const;

export function isAppSurfaceId(value: string): value is AppSurfaceId {
  return value === "canvas";
}

export function defaultAppSurface(): AppSurfaceId {
  return "canvas";
}
