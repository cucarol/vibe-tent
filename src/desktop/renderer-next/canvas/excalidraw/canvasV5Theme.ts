/**
 * Canvas scene colors that must be available before product CSS is evaluated.
 * UI chrome still consumes semantic CSS tokens; these values only seed
 * Excalidraw appState/elements and stay deliberately neutral.
 */
export const CANVAS_V5_COLORS = Object.freeze({
  blankBackground: "#ffffff",
  accent: "#4b4d52",
  borderStrong: "#8b8d94",
  relationParent: "#6d7078",
  relationSecondary: "#9a9ca3",
});
