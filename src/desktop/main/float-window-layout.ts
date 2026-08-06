export type FloatWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const FLOAT_WINDOW_BOUNDS = {
  defaultWidth: 328,
  defaultHeight: 280,
  minWidth: 300,
  maxWidth: 360,
  minHeight: 240,
  maxHeight: 360,
  edgeMargin: 24,
} as const;

function clampFinite(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const finite = Number.isFinite(value) ? Math.round(value!) : fallback;
  return Math.min(Math.max(finite, min), max);
}

export function normalizeFloatWindowBounds(
  saved: FloatWindowRect | undefined,
  workArea: FloatWindowRect
): FloatWindowRect {
  const width = clampFinite(
    saved?.width,
    FLOAT_WINDOW_BOUNDS.defaultWidth,
    FLOAT_WINDOW_BOUNDS.minWidth,
    Math.min(FLOAT_WINDOW_BOUNDS.maxWidth, workArea.width)
  );
  const height = clampFinite(
    saved?.height,
    FLOAT_WINDOW_BOUNDS.defaultHeight,
    FLOAT_WINDOW_BOUNDS.minHeight,
    Math.min(FLOAT_WINDOW_BOUNDS.maxHeight, workArea.height)
  );
  const fallbackX =
    workArea.x + workArea.width - width - FLOAT_WINDOW_BOUNDS.edgeMargin;
  const fallbackY = workArea.y + FLOAT_WINDOW_BOUNDS.edgeMargin;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    width,
    height,
    x: clampFinite(saved?.x, fallbackX, workArea.x, Math.max(workArea.x, maxX)),
    y: clampFinite(saved?.y, fallbackY, workArea.y, Math.max(workArea.y, maxY)),
  };
}
