/**
 * Headless scale bench (no browser). Measures synthetic graph build + document size.
 * Run: npm run bench
 */
import { buildSyntheticWorkingSet, countEdgeKinds } from "../src/model/syntheticGraph.ts";
import { assertCanvasDocumentShape } from "../src/model/canvasDocument.ts";

const t0 = performance.now();
const snap = buildSyntheticWorkingSet({ seed: 7 });
const buildMs = performance.now() - t0;

assertCanvasDocumentShape(snap.document);
const kinds = countEdgeKinds(snap.edges);
const json = JSON.stringify(snap.document);
const domainJson = JSON.stringify(snap.domainNodes);

const report = {
  buildMs: Math.round(buildMs * 10) / 10,
  domainNodes: snap.domainNodes.length,
  placements: snap.document.placements.length,
  edges: snap.edges.length,
  edgeKinds: kinds,
  canvasDocumentBytes: json.length,
  domainProjectionBytes: domainJson.length,
  visualGroups: snap.document.visualGroups.length,
  annotations: snap.document.annotations.length,
  samplePlacement: snap.document.placements[0],
  note: "entityRef != placementId; CanvasDocument excludes domain tree/body",
};

console.log(JSON.stringify(report, null, 2));
