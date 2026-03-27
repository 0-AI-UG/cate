# Context Menus + Workspace Creation Dialog

## Overview

Add right-click context menus across the app (sidebar workspaces, canvas background, canvas nodes) and replace the bare "+" workspace button with a creation dialog offering folder selection.

## 1. Workspace Creation Dialog

Triggered by the "+" button in ProjectListView. A small modal sheet/popover:

- **Title:** "New Workspace"
- **"Open Folder..." button** (prominent) — opens `NSOpenPanel`, creates workspace with that root path. Workspace auto-named from folder name.
- **"Continue without folder" button** (subtle/text) — creates empty workspace as today ("New Workspace" name).

## 2. Workspace Sidebar Context Menu

Right-click on a workspace card in the sidebar shows:

| Item | Action |
|------|--------|
| Open Folder... | Set/change workspace root directory via NSOpenPanel |
| Rename | Inline text editing or rename prompt |
| Duplicate Workspace | Copy workspace with all panels |
| Change Color | Submenu with color options |
| --- | separator |
| Close All Panels | Remove all panels from workspace |
| Delete Workspace | Remove workspace entirely |

Implemented via SwiftUI `.contextMenu` modifier on WorkspaceTabView.

## 3. Canvas Background Context Menu

**Trigger:** Single right-click on empty canvas space (no drag). Right-click + drag continues to pan the canvas as before.

**Detection:** In `rightMouseUp`, check if the mouse moved less than ~3px from `rightMouseDown` location. If stationary, show menu. If moved, it was a pan gesture — no menu.

Menu items:

| Item | Action |
|------|--------|
| New Terminal | Create terminal at click position (canvas coords) |
| New Editor | Create editor at click position |
| New Browser | Create browser at click position |

Panels placed at the right-clicked canvas-space position.

Implemented via `NSMenu` programmatically in CanvasView (AppKit).

## 4. Canvas Node Context Menu

Right-click on a node's title bar shows:

| Item | Action |
|------|--------|
| Rename | Rename panel title |
| Duplicate | Create copy of panel nearby |
| --- | separator |
| Move to Front | Bring to top of z-order |
| Move to Back | Send to bottom of z-order |
| --- | separator |
| Open Folder Here | Terminals only — open folder picker, cd terminal to selected dir |
| Close | Remove panel |

Implemented via `NSMenu` in CanvasNodeTitleBar (AppKit NSView).

## 5. Implementation Approach

- **Sidebar (SwiftUI):** Use `.contextMenu` modifier — native, simple, correct for SwiftUI views.
- **Canvas/Nodes (AppKit NSView):** Use `NSMenu` programmatically — matches the existing NSView event handling.
- **Workspace creation dialog:** SwiftUI sheet presented from ProjectListView.
- **Right-click vs drag detection:** Track mouse movement distance between rightMouseDown and rightMouseUp. Threshold of ~3px distinguishes click from drag.

## 6. Files Changed

| File | Change |
|------|--------|
| `ProjectListView.swift` | "+" triggers sheet instead of direct `addWorkspace()` |
| `WorkspaceTabView.swift` | Add `.contextMenu` with workspace operations |
| `CanvasView.swift` | Distinguish right-click vs right-drag; show NSMenu on stationary click |
| `CanvasNodeTitleBar.swift` | Add NSMenu on right-click |
| `Workspace.swift` | Add `duplicate()`, `closeAllPanels()` methods |
| `CanvasState.swift` | Add `moveToFront(nodeId:)`, `moveToBack(nodeId:)` |
| New: `NewWorkspaceSheet.swift` | Creation dialog with Open Folder / Continue without |

## 7. New Workspace Methods

### Workspace.swift
- `duplicate() -> Workspace` — creates new workspace copying panels and root path
- `closeAllPanels()` — removes all panels and their canvas nodes
- `rename(_ newName: String)` — sets name (already possible via published property)

### CanvasState.swift
- `moveToFront(nodeId: UUID)` — sets node to highest z-order
- `moveToBack(nodeId: UUID)` — sets node to lowest z-order
