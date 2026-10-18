# Dock behavior and test matrix

This document defines the supported dock transitions. Every layout of a host
(a window or a canvas node holds one or more) is one dock tree in the workspace
document (architecture 9.1); a host shows one layout at a time and a panel is
in exactly one dock; a layout is the same shape in a window and in a node, and
moves between them. Placement is shared: a drop is one document op
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
| Layout (chip menu or node strip menu) | Move to Main Window, Move to New Window | The whole layout (tree, panels, name) goes to that host: the main window's switcher, or a new detached window (only with the `windows` feature); the host it leaves goes if it has no other panel; the main window's last layout is not offered | `windows/layoutMenu.test.tsx`, `workspace/document/contract/layouts.test.ts` |
| Any panel | A window's tab strip | The dragged chip floats along the strip (horizontal only) and the chips it passes are pushed aside, opening a gap where the drop lands. A group's anchor chip is pushable too: the gap left of it is a plain tab before the group, the gap right of it the group's first member. The gap moves once the ghost's left edge is nearer another gap by a threshold, so a few pixels back never push a chip straight back. The ghost stops against the strip's left edge and the + button. Drops: a plain tab at that slot, or a new pane beside the neighbouring chip inside a group | `windows/stripModel.test.ts`, `windows/WindowView.drag.test.tsx`, `drag/commit.test.ts` |
| Layout (anchor chip) | Along the tab strip | The whole layout floats and moves to the slot the gap opens at; other groups count as one chip, so it never merges, and it never goes to a dock, canvas or other window | `windows/stripModel.test.ts`, `drag/commit.test.ts`, `windows/WindowView.drag.test.tsx` |
| A pane over its own layout's group | Anywhere inside that group | It reorders like any chip: the gap opens at the slot the ghost's left edge is nearest, and releasing puts it as a pane beside that chip; its original spot drops nothing and leaves the layout untouched. Pulled out of the group it becomes a plain tab | `windows/stripModel.test.ts`, `windows/WindowView.drag.test.tsx` |
| Dock tab | Body of a one-panel window pane (no tab bar) | Split by the nearest edge; a lone panel over its own pane does nothing | `drag/__tests__/scenarios.test.tsx` |
| Sidebar panel row | The workspace tree | Dragged like a strip chip, along y: the row floats (vertical only, stopped at the first and last rows) and the rows it passes make room. A drop is a plain tab between the tree's items, a new pane between the rows of a group (beside the neighbouring row's stack), a tab of a stack between two rows of it, or a node on a canvas (a cursor in a canvas's children area). Its own spot drops nothing | `app/sidebar/WorkspaceRow.drag.test.tsx`, `app/sidebar/useSidebarTree.test.tsx`, `drag/axisModel.test.ts`, `drag/commit.test.ts` |
| Sidebar panel row | A window's tab strip | A plain tab at the slot the strip's gap opens at, or a pane inside a group, as for a strip chip | `app/sidebar/crossDomain.drag.test.tsx` |
| Sidebar panel row | The split | As a dock tab: a tab of the stack whose tab bar it is over, a split on a stack's edge, a node on a canvas. Escape cancels and sends nothing | `app/sidebar/crossDomain.drag.test.tsx`, `app/sidebar/WorkspaceRow.drag.test.tsx` |
| Sidebar layout handle | The workspace tree | A group's rows are regular rows told apart as members by a thick strip floating at their left (and by a faint background while the layout is shown; the shown panel has the active one). The strip moves the whole layout among the tree's items: the group is replaced by one dashed ghost its own size that slides vertically, and the rows it passes make room; click shows it, right-click moves or closes it. A layout of one panel is a plain row, dragged as that panel | `app/sidebar/WorkspaceRow.drag.test.tsx`, `app/sidebar/useSidebarTree.test.tsx` |
| Sidebar layout handle | A window's tab strip | The layout moves to the slot the gap opens at, as when dragged by its anchor chip | `app/sidebar/crossDomain.drag.test.tsx` |
| Sidebar layout handle | The split | Refused: nothing is previewed and releasing changes nothing | `app/sidebar/crossDomain.drag.test.tsx`, `drag/resolve.test.ts` |
| Strip chip / pane grip | The workspace tree | Placed at the tree's slot the cursor opens: a plain tab between the tree's items, a pane beside the neighbouring row's stack in a group, a tab of a stack, a node on a canvas. The panel's own row is the ghost: it floats and leaves its room, so the rows below move up over it | `app/sidebar/crossDomain.drag.test.tsx`, `app/sidebar/useSidebarTree.test.tsx`, `app/sidebar/WorkspaceRow.drag.test.tsx` |
| Strip chip / pane grip | A window's tab strip | See "Any panel" along a window's tab strip above | `windows/WindowView.drag.test.tsx` |
| Strip chip / pane grip | The split | See the dock tab rows above | `drag/__tests__/scenarios.test.tsx` |
| Strip layout anchor | The workspace tree | The whole layout moves among the tree's items; it takes tab slots only, so it never merges into a group | `app/sidebar/crossDomain.drag.test.tsx`, `app/sidebar/useSidebarTree.test.tsx`, `app/sidebar/WorkspaceRow.drag.test.tsx` |
| Strip layout anchor | A window's tab strip | See "Layout (anchor chip)" above | `windows/WindowView.drag.test.tsx` |
| Strip layout anchor | The split | Refused: nothing is previewed and releasing changes nothing | `app/sidebar/crossDomain.drag.test.tsx`, `drag/resolve.test.ts` |
| Any panel | Outside the application window | A new detached window at the drop point (only on clients with the `windows` feature; a selected group never leaves the window) | `drag/commit.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another window of the same workspace | That window claims the drop; the placement op is sent once, from the source window | `drag/__tests__/crossWindow.test.tsx`, `drag/__tests__/scenarios.test.tsx` |
| Canvas panel | A canvas or a canvas-node mini dock | Refused: canvases never nest | `drag/commit.test.ts`, `drag/resolve.test.ts`, `drag/__tests__/scenarios.test.tsx` |
| Any panel | Another workspace | Never a target | `drag/resolve.test.ts` |

The sidebar, the strip and the split are one drag system: a sidebar row
starts the same drag as a strip chip (a dock tab, or a layout, marked as
begun on the sidebar), and Escape or losing focus cancels it anywhere.
Layouts drop only on a strip and on the tree. The tree takes only tab and
layout drags (a sidebar row, a strip chip or anchor, a pane's grip, a
canvas node's tab): a whole canvas node or a drag from another window
resolves nothing over it. A drag that began on the
sidebar and is released outside the window opens no detached window (another
window of the workspace can still claim it).

The ghost is the hovered zone's to draw, and a panel is one chip wherever it
is shown: the zone the cursor is over (the tree, the strip) draws the panel's
own chip or row there as the ghost, restyled and floating, and no look-alike
float is drawn beside it (a panel or layout with no chip in that zone floats as
a look-alike). The tree and the strip open a gap where the drop lands; the
split shows its edge indicator under the shared floating chip. A drag leaves
every other zone as it is until that zone takes the drop: the tree's row, the
strip's chip or group and a stack's tab stay standing while the cursor is
elsewhere, wherever the drag began. Over the split (the dock takes the drop), the
panel's own tab is hidden, and a strip-started chip is hidden too. In the tree
and the strip, neighbours slide into the gap only once the drag has settled,
50ms after it starts (`drag/settled.test.tsx`), so the lifted row or chip and
its gap appear in the same frame without motion.

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
