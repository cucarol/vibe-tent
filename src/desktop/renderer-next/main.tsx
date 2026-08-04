/**
 * Isolated next renderer entry.
 * Built to desktop/dist/renderer-next/ — not the default Electron load path.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ensureExcalidrawAssetPath } from "./canvas/excalidraw/excalidrawAssetPath.js";
// CSS is loaded via index.html <link> (copied by build-desktop); not bundled into JS.

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("renderer-next: #root missing");
}

ensureExcalidrawAssetPath();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
