# Dock behavior and test matrix

This document defines the supported dock transitions. Every layout of a window
(a window has one or more) is one dock tree in the workspace document
(architecture 9.1); a window shows one layout at a time and a panel is in
exactly one dock; a canvas node holds a
mini dock of the same shape. Placement is shared: a drop is one document op
(`placePanel`, `setNodeRects`, or a batch), and every client of the workspace
sees it. Which tab of a stack is active is client state.

Maximize is client state, so it changes only what this client draws: a
maximized window stack is drawn alone in its window, and a maximized canvas
node fills its canvas's area. The document, and every other client's layout,
stay as they are.

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
| Any panel | Header chip of another layout | Move into that layout's first stack and show that layout (the layout it left stays, empty); hovering the chip mid-drag shows that layout after a short delay, like a tab; the chip of the layout the panel is already in does nothing (and keeps the header's new-layout drop away) | `windows/WindowView.layouts.test.tsx` |
| Any panel | Empty part of a window header | A new layout holding the panel (a dashed ghost chip previews it); the shown layout switches to it, and the one the panel left stays, empty, with its creation menu | `windows/WindowView.layouts.test.tsx` |
| Any panel | Outside the application window | A new detached window at the drop point (only on clients with the `windows` feature; a selected group never leaves the window) | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another window of the same workspace | That window claims the drop; the placement op is sent once, from the source window | `drag/__tests__/crossWindow.test.tsx`, `drag/__tests__/scenarios.test.tsx` |
| Canvas panel | A canvas or a canvas-node mini dock | Refused: canvases never nest | `drag/commit.test.ts`, `drag/resolve.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another workspace | Never a target | `drag/resolve.test.ts` |

For every split edge, placement order is fixed: left/top inserts before the
target and right/bottom inserts after it. Same-direction splits gain an equal
sibling instead of creating an unnecessary nested split. Stacks, splits, nodes
and detached windows emptied by an op are removed by the runtime as part of
that op.

## Maximize and restore

Coverage: `src/client/document/clientState.test.ts` (the state),
`src/client/layout/dock/DockView.test.tsx` (window stacks) and
`src/client/layout/canvas/CanvasView.test.tsx` (canvas nodes).

| Starting state | Action | Defined result |
|---|---|---|
| Window dock with a split tree | Maximize a stack | Only that stack is drawn, filling the window; the other stacks stay mounted, hidden |
| Window dock with a single stack | Maximize | Nothing to maximize; no button |
| Canvas node | Maximize (from any of its stacks) | The node's mini dock fills the canvas's area; the canvas stays mounted underneath |
| Maximized stack or node | Restore | The layout is drawn as the document has it |
| Maximized stack or node | Any document change, from any client | Applies; the maximize stays while its stack or node exists |
| Maximized stack or node | Its stack or node is removed | The layout is drawn as it is; nothing to restore |

One stack per window and one node per canvas can be maximized. Maximize is
not undoable: it never was a document change.
