# ADR · Isolated React next renderer foundation

Status: **accepted, then promoted to production entry by protocol-4 UI batch 1**
Date: 2026-07-23  
Task: `tk-6cmb2j2g` / `cx-gmcryd`

## Context

Tent Desktop’s original renderer was a vanilla TypeScript workbench. The Canvas-first React tree was initially isolated; protocol-4 UI batch 1 later promoted it to the main-window production entry after adding named Service projections, fail-closed bootstrap, local Canvas persistence, and Excalidraw V5.

Frozen product boundaries (not reopened here):

- Canvas-first, multi-surface, single window
- Outline is default-collapsed drawer/overlay chrome (rail/chrome invoke; not a permanent grid column)
- Focus Workspace hosts Markdown + collaboration context
- Service is the sole fact and mutation authority
- Events only invalidate projections
- `entityRef` ≠ `placementId`
- `CanvasDocument` is local UI state
- Layout / reversible-domain / lifecycle intents stay separate

## Decision

1. **New tree** at `src/desktop/renderer-next/` — isolated from `src/desktop/renderer/`.
2. **Production build** emits `desktop/dist/renderer-next/`; the main Electron window now loads that exact entry. The float window remains independent.
3. **Dependencies:** `react`, `react-dom`, `@excalidraw/excalidraw`, and their required build assets are **devDependencies** used to produce the Desktop bundle, not runtime dependencies of the published CLI package. No X6/React Flow, Tailwind, Redux/Zustand, or theme kits. The `renderer-next` esbuild target always sets `NODE_ENV=production` + minify so tracked `desktop/dist/renderer-next/main.js` never embeds React development builds.
4. **Boundary modules:**
   - `ServiceGateway` + projection invalidation
   - `UiIntent` + `undoPolicy`
   - Excalidraw V5 scene adapter with Tent Node embeddables
   - Semantic token CSS (roles only; no locked brand palette)
   - `OutlineChromeState` + open/expand/locate helpers (local chrome only)
5. **App shell** exposes the production Canvas stage with Outline and Focus trays. **Outline** is a collapsible workbench tray with `aria-expanded` / `aria-controls`, Esc, explicit close, and tree keyboard navigation; secondary surfaces remain outside this production batch.

## Consequences

- Product UI can iterate on the production shell while the protocol-4 Service remains the sole fact authority.
- Excalidraw owns generic drawing tools; Tent owns Node/Canvas domain actions through the adapter boundary.
- The main-window production entry is `renderer-next`; Storybook fixtures are not used by that bootstrap.
- Outline open/expand/locate interfaces are ready for a real tree projection without inventing one in this task.

### Excalidraw embeddable link badge (P2)

This Excalidraw version requires a non-empty link to activate its public
`renderEmbeddable` seam and paints the small link badge directly on the scene
canvas. There is no supported prop or `UIOptions` switch for that badge. Tent
therefore keeps an exact internal `tent://node/<id>` link, validates it, and
prevents browser navigation in `onLinkOpen`; the action only selects the Node
and opens Focus. A future upstream option or narrowly maintained adapter fork
may remove the badge. Do not null the link after mount, patch `node_modules`, or
cover it with a zoom-dependent overlay.

## Non-goals (this ADR)

- Reintroducing legacy secondary surfaces while the production entry is switched
- Replacing the Excalidraw V5 engine or adding a Markdown editor in this batch
- Copying backend lifecycle state machines into the client
- Hard-coding draft projection field lists from exploration fixtures
