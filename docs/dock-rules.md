# Dock behavior and test matrix

This document defines the supported dock transitions. Every window has one
dock tree in the workspace document (architecture 9.1); a canvas node holds a
mini dock of the same shape. Placement is shared: a drop is one document op
(`placePanel`, `setNodeRects`, or a batch), and every client of the workspace
sees it. Which tab of a stack is active is client state.

"Maximize" and "minimize" are client state too (`src/client/layout/dock/presentation.ts`):
they change how this client draws a dock, never the document. Maximize a pane
of a main-dock split to **merge** the window's tree into one stack of all its
tabs; maximize a pane of a canvas node to **promote** it as a tab beside its
canvas. Minimize drops the presentation, which shows the document's own
layout again.

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

## Maximize, minimize, and invalidation rules

Coverage for this table is `src/client/layout/dock/presentation.test.ts`.

| Starting state | Action | Defined result | Restore status |
|---|---|---|---|
| Window dock with a split tree | Maximize a stack | Draw the whole tree as that stack's tabs, in tree order; the document is untouched | Valid |
| Window dock with a single stack | Maximize | Nothing to merge; ignored | Not applicable |
| Merged window dock | Select a tab, or change a split ratio elsewhere (another client) | Only presentation details change | Remains valid |
| Merged window dock | A structural change to the window's tree (from any client) | Show the document's new tree | Consumed for good |
| Merged window dock | Drag, close or split through the merged stack | The merge is first made real (one stack in the drawn order), then the edit applies, so the user keeps the topology they saw | Consumed |
| Merged window dock, unchanged | Minimize | Show the exact pre-merge tree | Consumed |
| Merged window dock | Maximize another stack or pane | Ignored: merges never nest | Existing presentation remains valid |
| Canvas node pane | Maximize | Draw the pane as a tab after its canvas panel and leave it out of the node; a singleton node disappears from the canvas while promoted | Valid |
| Promoted pane | A structural change to its source node or to the destination dock | Show the document's layout | Consumed for good |
| Promoted pane | An edit through the promoted tab | Made real first: the pane becomes a real tab after the canvas | Consumed |
| Promoted pane, both sides unchanged | Minimize | Show the exact node again | Consumed |
| One or more promoted panes | Maximize another canvas pane | Promote it too, with its own restore target | Every unchanged promotion remains independently restorable |

The invalidation rule is structural. Tab selection and split ratios are
presentation details and are safe; panel identity, order, tree shape and
source-node existence are topology, and a later restore never overwrites them.
