/**
 * Canvas scene colors that must be available before product CSS is evaluated.
 * UI chrome still consumes semantic CSS tokens; these values only seed
 * Excalidraw appState/elements and stay deliberately neutral.
 */
export const CANVAS_V5_COLORS = Object.freeze({
  gridBackground: "#ebe9e5",
  blankBackground: "#f7f6f3",
  accent: "#a34a33",
  borderStrong: "#8f8982",
  relationParent: "#716b65",
  relationSecondary: "#918b84",
});
