# Dock behavior and test matrix

This document defines the supported dock transitions. Every window has one
dock tree in the workspace document (architecture 9.1); a canvas node holds a
mini dock of the same shape. Placement is shared: a drop is one document op
(`placePanel`, `setNodeRects`, or a batch), and every client of the workspace
sees it. Which tab of a stack is active is client state.

Maximize and restore are document ops too, so every client sees them.
`maximizeStack` gathers every tab of a split window into one stack;
`maximizePanel` moves a canvas pane into the window showing its canvas, after
the canvas tab. Either saves the window's previous layout as its restore point
(`DocWindow.maximized`), and `restoreLayout` puts that layout back.

## Drag and placement rules

Drop resolution is `src/client/layout/drag/resolve.ts`; the op each drop sends
is `src/client/layout/drag/commit.ts`.

| Source | Drop target | Result | Automated coverage |
|---|---|---|---|
| Dock tab | Same stack tab bar | Reorder tabs; a lone tab dropped on its own tab bar is a no-op | `drag/commit.test.ts`, `drag/resolve.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Dock tab | Another dock stack tab bar | Move into that stack as a tab | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Dock tab | Left/right stack edge | Horizontal split, before/after the target | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Dock tab | Top/bottom stack edge | Vertical split, before/after the target | `drag/commit.test.ts` |
| Dock tab | Window edge strip | Split the whole window dock on that side | `drag/commit.test.ts` |
| Dock tab | Empty canvas | Create a canvas node containing the panel | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Dock tab | Canvas-node tab bar | Add the panel as a tab of the node | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Dock tab | Canvas-node edge | Add the panel as a split pane of the node | `drag/commit.test.ts` |
| Canvas node | Empty area of the same canvas | Reposition the node (one `setNodeRects`, size kept); a selected group moves together | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Canvas node/pane | Another canvas-node tab bar | Merge into the target as tabs; the emptied source node is removed | `drag/commit.test.ts` |
| Canvas node/pane | Another canvas | Move there; the emptied source node is removed | `drag/__tests__/scenarios.test.tsx` |
| Canvas node/pane | Main-dock tab bar or edge | Move into the dock as a tab or split | `drag/commit.test.ts` |
| Any panel | Outside the application window | A new detached window at the drop point (only on clients with the `windows` feature; a selected group never leaves the window) | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another window of the same workspace | That window claims the drop; the placement op is sent once, from the source window | `drag/__tests__/crossWindow.test.tsx`, `drag/__tests__/scenarios.test.tsx` |
| Canvas panel | A canvas or a canvas-node mini dock | Refused: canvases never nest | `drag/commit.test.ts`, `drag/resolve.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another workspace | Never a target | `drag/resolve.test.ts` |

For every split edge, placement order is fixed: left/top inserts before the
target and right/bottom inserts after it. Same-direction splits gain an equal
sibling instead of creating an unnecessary nested split. Stacks, splits, nodes
and detached windows emptied by an op are removed by the runtime as part of
that op.

## Maximize, restore, and invalidation rules

Coverage for this table is `src/workspace/document/contract/apply.test.ts`
(the reducer) and `src/client/layout/dock/DockView.test.tsx` (the button).

| Starting state | Action | Defined result | Restore point |
|---|---|---|---|
| Window dock with a split tree | Maximize a stack (`maximizeStack`) | The whole tree becomes that stack's tabs, in tree order | Saved: the previous tree |
| Window dock with a single stack | Maximize | Nothing to merge; no button, and the op is rejected | None |
| Canvas node pane | Maximize (`maximizePanel`) | The pane moves to a tab after its canvas panel; a singleton node is removed | Saved: the window's tree and the node as it was |
| Maximized window | Restore (`restoreLayout`) | The saved tree comes back, and the node with it, at its current rect if it still exists | Cleared |
| Maximized window | Any other change to the window's tree, or to the source node's tree (from any client) | The change applies to the maximized layout, which stays | Cleared for good |
| Maximized window | A split ratio change, a node move or resize, a tab selection | Applies | Kept |
| Maximized window | Maximize again | No button; the op is rejected (one maximize per window) | Kept |

Undo of a maximize is a restore, and undo of a restore maximizes again. Undo
of a later edit brings the layout back but not the restore point.
