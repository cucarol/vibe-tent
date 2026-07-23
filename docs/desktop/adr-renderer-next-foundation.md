# ADR · Isolated React next renderer foundation

Status: **accepted** (foundation only)  
Date: 2026-07-23  
Task: `tk-6cmb2j2g` / `cx-gmcryd`

## Context

Tent Desktop’s current renderer is a vanilla TypeScript workbench. A Canvas-first UI rewrite needs React structure without flipping the default Electron entry or dragging in graph/theme/state libraries.

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
2. **Independent build** emits `desktop/dist/renderer-next/`; default `index.html` / Electron load path **unchanged**.
3. **Dependencies:** `react`, `react-dom`, and their types only — as **devDependencies** (desktop build tools; not runtime deps of the published Obsidian/CLI package). No X6, Tailwind, Redux/Zustand, or theme kits. The `renderer-next` esbuild target always sets `NODE_ENV=production` + minify so tracked `desktop/dist/renderer-next/main.js` never embeds React development builds.
4. **Boundary modules:**
   - `ServiceGateway` + projection invalidation
   - `UiIntent` + `undoPolicy`
   - `CanvasEngine` adapter (placeholder implementation)
   - Semantic token CSS (roles only; no locked brand palette)
   - `OutlineChromeState` + open/expand/locate helpers (local chrome only)
5. **App shell** places rail surfaces and stage placeholders: Canvas, Focus Workspace, Inbox, Search, Settings, Activity. **Outline** is a default-collapsed drawer/overlay opened from rail or chrome, with `aria-expanded` / `aria-controls`, Esc, and explicit close — not a permanent grid column.

## Consequences

- Product UI can iterate on the next shell without regressing the shipping workbench.
- X6 or other engines plug in via `CanvasEngine` later (`cx-y2tdtp`); foundation does not choose one.
- Default `npm run desktop:dev` still opens the current renderer until an explicit switch.
- Outline open/expand/locate interfaces are ready for a real tree projection without inventing one in this task.

## Non-goals (this ADR)

- Switching Electron default entry
- Implementing real Canvas engine, tree, or editor
- Copying backend lifecycle state machines into the client
- Hard-coding draft projection field lists from exploration boxes
