# Dock behavior and test matrix

This document defines the supported dock state transitions. “Maximize” means a
reversible presentation: a main-dock split is merged into tabs, or one pane of a
canvas node is promoted beside its containing canvas. “Minimize” means restoring
that saved layout. A presentation is restorable only while both its destination
and, for a promoted canvas pane, its source topology remain unchanged.

## Drag and placement rules

| Source | Drop target | Result | Automated coverage |
|---|---|---|---|
| Dock tab | Same stack tab bar | Reorder tabs; a one-tab self-drop is a no-op | `dockStore.rules.test.ts`, `drag/resolve.test.ts`, `drag/commit.test.ts` |
| Dock tab | Another dock stack tab bar | Move into that stack as a tab | `dockStore.presentation.test.ts`, `drag/commit.test.ts` |
| Dock tab | Left/right dock edge | Horizontal split, before/after the target | `dockStore.rules.test.ts`, `three-way-split.spec.ts` |
| Dock tab | Top/bottom dock edge | Vertical split, before/after the target | `dockStore.rules.test.ts`, `drag/commit.test.ts` |
| Dock tab | Empty canvas | Create a canvas node containing the panel | `dock-rules.spec.ts` |
| Dock tab | Canvas-node tab bar | Add the panel as a tab and remove it from the main dock | `drag/commit.test.ts` |
| Dock tab | Canvas-node edge | Add the panel as a split pane and remove it from the main dock | `drag/commit.test.ts` |
| Canvas node/pane | Empty area of the same canvas | Reposition the node; preserve its tabs/splits | `drag-move.spec.ts`, `drag-split.spec.ts` |
| Canvas node/pane | Another canvas-node tab bar | Merge into the target as tabs; remove an emptied source node | `drag-split.spec.ts` |
| Canvas node/pane | Another canvas-node edge | Split the target; remove an emptied source node | `drag-split.spec.ts` |
| Canvas node/pane | Main-dock tab bar | Move into the dock as a tab | `dock-rules.spec.ts` |
| Canvas node/pane | Main-dock edge | Move into the dock as a split | `drag/commit.test.ts` |
| Canvas node/pane | Outside the application window | Detach into a new dock window | `drag-detach.spec.ts` |
| Canvas panel | A canvas node | Reject recursive canvas nesting | `drag-canvas-into-canvas.spec.ts` |
| Detached-window panel | Main dock or canvas | Commit only after receiver acknowledgement; otherwise recover in the detached session | `detached-panels.spec.ts`, `existing-window-drop.test.ts`, `windowPanelSync.test.ts` |

For every split edge, placement order is fixed: left/top inserts before the
target and right/bottom inserts after it. Same-direction splits gain an equal
sibling instead of creating an unnecessary nested split.

## Split, maximize, minimize, and invalidation rules

| Starting state | Action | Defined result | Restore status | Automated coverage |
|---|---|---|---|---|
| One dock stack | Split right | A new surface in a horizontal sibling | Not applicable | `three-way-split.spec.ts`, `dock-rules.spec.ts` |
| Main dock with any split tree | Maximize a leaf | Flatten the zone into one tab stack, keeping deterministic tree order and the selected leaf active | Valid | `dockStore.presentation.test.ts`, `dock-rules.spec.ts` |
| Maximized main dock | Select a merged tab | Only active selection changes | Remains valid | `dockStore.rules.test.ts` |
| Maximized main dock | Resize/toggle another zone, add a panel to another zone, or take a snapshot | Presented topology is unchanged | Remains valid | `dockStore.rules.test.ts` |
| Maximized main dock | Add/remove/reorder/move a presented tab, split/collapse its stack, or restore a snapshot | Keep the user’s new topology | Permanently invalidated | `dockStore.rules.test.ts`, `dock-rules.spec.ts` |
| Maximized main dock, unchanged | Minimize | Restore the exact pre-merge split tree | Consumed | `dockStore.presentation.test.ts`, `dock-rules.spec.ts` |
| Singleton canvas node | Maximize | Remove the empty node and promote its panel beside the canvas | Valid | `CanvasNode.groupDrag.test.tsx` |
| Tabbed or split canvas node | Maximize one pane | Promote only the active pane; preserve the remaining node | Valid | `CanvasNode.groupDrag.test.tsx`, `dock-rules.spec.ts` |
| Promoted canvas pane | Select canvas/promoted tab, resize surrounding split, resize/toggle an unrelated zone, add to another zone, or take a snapshot | No structural change to either saved topology | Remains valid | `dockStore.presentation.test.ts` |
| Promoted canvas pane | Structurally change the source canvas node | Keep both the promoted pane and the edited source | Permanently invalidated | `CanvasNode.groupDrag.test.tsx`, `dock-rules.spec.ts` |
| Promoted canvas pane | Add/remove/reorder/move/split/collapse in the destination, including moving away and back | Keep the user’s new destination | Permanently invalidated | `dockStore.presentation.test.ts`, `dock-rules.spec.ts` |
| Promoted canvas pane, both sides unchanged | Minimize | Restore the exact node id, position, size, tabs, split tree, and active pane | Consumed | `CanvasNode.groupDrag.test.tsx`, `dock-rules.spec.ts` |
| Any active presentation | Maximize another stack/pane | Ignore the second request; presentations never nest | Existing presentation remains valid | `dockStore.presentation.test.ts` |
| Invalidated presentation | Minimize | No-op; the restore control is removed | Unavailable | `dockStore.presentation.test.ts`, `dock-rules.spec.ts` |

The invalidation rule is intentionally structural. Tab selection and split
ratios are presentation details and are safe; panel identity, order, tree shape,
and source-node existence are ownership/topology and cannot be overwritten by a
later restore.
