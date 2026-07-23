# ADR · Isolated React next renderer foundation

Status: **accepted** (foundation only)  
Date: 2026-07-23  
Task: `tk-6cmb2j2g` / `cx-gmcryd`

## Context

Tent Desktop’s current renderer is a vanilla TypeScript workbench. A Canvas-first UI rewrite needs React structure without flipping the default Electron entry or dragging in graph/theme/state libraries.

Frozen product boundaries (not reopened here):

- Canvas-first, multi-surface, single window
- Outline always reachable
- Focus Workspace hosts Markdown + collaboration context
- Service is the sole fact and mutation authority
- Events only invalidate projections
- `entityRef` ≠ `placementId`
- `CanvasDocument` is local UI state
- Layout / reversible-domain / lifecycle intents stay separate

## Decision

1. **New tree** at `src/desktop/renderer-next/` — isolated from `src/desktop/renderer/`.
2. **Independent build** emits `desktop/dist/renderer-next/`; default `index.html` / Electron load path **unchanged**.
3. **Dependencies:** `react`, `react-dom`, and their types only. No X6, Tailwind, Redux/Zustand, or theme kits.
4. **Boundary modules:**
   - `ServiceGateway` + projection invalidation
   - `UiIntent` + `undoPolicy`
   - `CanvasEngine` adapter (placeholder implementation)
   - Semantic token CSS (roles only; no locked brand palette)
5. **App shell** places rail surfaces, always-on Outline, and stage placeholders: Canvas, Focus Workspace, Inbox, Search, Settings, Activity.

## Consequences

- Product UI can iterate on the next shell without regressing the shipping workbench.
- X6 or other engines plug in via `CanvasEngine` later (`cx-y2tdtp`); foundation does not choose one.
- Default `npm run desktop:dev` still opens the current renderer until an explicit switch.

## Non-goals (this ADR)

- Switching Electron default entry
- Implementing real Canvas engine, tree, or editor
- Copying backend lifecycle state machines into the client
- Hard-coding draft projection field lists from exploration boxes
