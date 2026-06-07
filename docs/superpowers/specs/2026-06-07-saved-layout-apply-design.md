# Fix: saved layouts apply to the wrong canvas (and lose sizes / agent panels)

## Problem

Loading a saved layout does not reproduce the layout on the canvas the user is
looking at. Reported symptoms: the layout lands on a *different* canvas than the
active/nested one, panels come back at default sizes, and some panels are missing.

The most common trigger is opening a new, empty canvas (which shows the
empty-canvas layout picker) and choosing a layout — the panels appear on the
workspace's center canvas instead of the empty one.

## Root cause

`recreateNodes` (`src/renderer/lib/layouts.ts`) recreates each saved panel with
**no `placement`**, so every panel routes through `placePanel` →
`getWorkspaceCanvasOps(workspaceId)` to the workspace's **primary/center**
canvas — regardless of which canvas the load was meant for. Setting the active
panel (as both load functions already do) has no effect, because `placePanel`
routes by `placement.canvasPanelId`, not by active state. The `PanelPlacement`
type comment (`appStore.ts:165-170`) documents this exact trap: "Without it,
placement routes to the workspace's primary canvas … wrong for an interactive
create on a secondary/nested canvas."

Two secondary defects in the same function:

- **Sizes lost** — `buildLayoutSnapshot` saves `node.size`, but `recreateNodes`
  only forwards `origin`. `addNode` already accepts a `size`, but the
  create → `placePanel` → `addNodeAndFocus` → `addNode` chain never forwards
  one. Passing the saved size also keeps **positions** exact, because
  `findFreePosition` (`placement.ts:46-56`) uses the node's size for its
  overlap/nudge check — default-sized nodes get spuriously nudged off their
  saved origins.
- **`agent` panels dropped** — `recreateNodes` handles only
  `terminal`/`editor`/`document`/`browser`. The only other panel type that can
  exist as a canvas node is `agent` (`canvas` is refused at `addNode:41`, so it
  never appears in a snapshot). Agent panels silently vanish.

## Design

### 1. Thread target canvas + size through placement

- `PanelPlacement` canvas variant (`appStore.ts:170`): add `size?: Size`.
- `placePanel` (`appStore.ts:374-385`): forward `placement.size` (when
  `target === 'canvas'`) into `ops.addNodeAndFocus(...)`.
- `CanvasOperations.addNodeAndFocus` (`canvasBridge.ts:19,50`): accept an
  optional `size` and pass it to `addNode` (already supports it).

### 2. Make `recreateNodes` honor the target canvas, size, and agent type

`recreateNodes(wsId, canvasPanelId, snap)`:

- For each node, build
  `placement = { target: 'canvas', canvasPanelId, position: node.origin, size: node.size }`
  and pass it to the create call.
- Add `case 'agent': createAgent(wsId, node.origin, placement)`.
- Guard editor/document recreation on a non-empty `filePath` (skip junk).

### 3. Unify both load paths to "load into the active canvas"

Per product decision, the manager dialog, the native Layouts menu, and the
empty-canvas overlay all load a layout into the **active canvas**, replacing that
canvas's contents (other canvases and dock panels untouched).

Core helper:

```
applyLayoutToCanvas(wsId, canvasPanelId, storeApi, snap):
  // clear: dispose every panel currently on this canvas
  const panelIds = nodes(storeApi).map(n => n.panelId)   // snapshot first
  for (pid of panelIds) app.closePanel(wsId, pid)
  setActivePanel(canvasPanelId)
  recreateNodes(wsId, canvasPanelId, snap)
  storeApi.getState().zoomToFit()
```

Public entry points:

- `loadLayoutIntoActiveCanvas(name)` — resolves the active canvas via
  `getActiveCanvasPanelId()`, gets its `storeApi` via
  `ensureCanvasOpsForPanel(...)`, delegates to `applyLayoutToCanvas`. Used by the
  manager dialog (`SavedLayoutsDialog`) and the native menu (`useShortcuts`).
- `loadLayoutIntoCanvas(name, wsId, canvasPanelId, storeApi)` — kept for the
  empty-canvas overlay (explicit target); delegates to `applyLayoutToCanvas`.
  Clearing is a harmless no-op on an empty canvas.

`loadLayoutReplacingWorkspace` (whole-workspace wipe + center rebuild) is
removed; its two callers move to `loadLayoutIntoActiveCanvas`.

Zoom/viewport: keep `zoomToFit()` (saved zoom/viewport intentionally not
restored).

## Testing (Vitest)

- Save → load round-trip routes nodes onto the **target** canvas store (not the
  workspace primary) with correct origins **and** sizes.
- An `agent` node in a snapshot is recreated (not dropped).
- Loading into a non-empty canvas clears the prior nodes first (no leftovers).

## Out of scope

- Restoring saved zoom level / viewport offset (kept as zoom-to-fit).
- Persisting agent thread / terminal session contents (structure only).
