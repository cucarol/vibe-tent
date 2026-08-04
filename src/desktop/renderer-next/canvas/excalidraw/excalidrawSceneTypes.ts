/** Serializable scene boundary owned by the renderer-local V5 Canvas. */
export type ExcalidrawSceneSnapshot = {
  /** Opaque Excalidraw elements; interpreted only by the scene adapter. */
  elements: readonly unknown[];
  /** Durable appState subset for restore; transient selection is excluded. */
  appState?: Record<string, unknown>;
  /** Binary file map retained by id. */
  files?: Record<string, unknown>;
  /** User presentation preference; independent from Canvas background mode. */
  layerVisible?: boolean;
};
