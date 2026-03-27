# CanvasIDE Feature Roadmap

> Consolidated feature list for CanvasIDE. Approved 2026-03-27.

---

## Quick Wins (< 1 day each)

### 1. Split Panel
Tile two panels side-by-side (horizontal or vertical split) inside a single canvas node. Useful for editor + terminal combos without placing two separate nodes.

### 2. Zoom-to-Fit
Keyboard shortcut (e.g., Cmd+1 or Cmd+Shift+0) to auto-calculate zoom level and viewport offset so all panels are visible on screen with padding. Solves the "panel off-screen" problem.

### 3. Panel Snapping Guides
When dragging a panel, show thin alignment lines (horizontal and vertical) when the panel's edges align with other panels' edges or centers. Visual guides disappear on drop.

### 4. Drag File from Explorer onto Canvas
Dragging a file from the sidebar file explorer onto the canvas opens a new editor panel at the drop position with that file loaded.

### 5. Middle-Click Pan
Pan the canvas by holding the middle mouse button and dragging. Standard in design tools (Figma, Blender). Supplements existing right-click drag and two-finger scroll panning.

### 6. Fuzzy File Open in Command Palette
Extend the existing Cmd+K command palette with fuzzy file search. Typing a filename filters workspace files and selecting one opens an editor panel. Similar to VS Code's Cmd+P.

### 7. Copy Terminal CWD to Clipboard
Right-click context menu option on workspace cards in the sidebar to copy the terminal's current working directory to the clipboard.

### 8. Pin Panels
Toggle a panel as "pinned" via title bar button or context menu. Pinned panels cannot be dragged or resized, preventing accidental repositioning of important panels.

### 9. Auto-Open Terminal at Project Root
When a workspace has a root path set, newly created terminals automatically `cd` to that root path. Eliminates the manual `cd` step on every new terminal.

### 10. Auto-Focus New Panels
When creating a new panel (terminal, editor, browser), automatically focus it and pan/zoom the canvas so the new panel is centered and visible.

### 11. Open Folder via Drag-and-Drop
Drag a folder from Finder onto the CanvasIDE window to set it as the workspace root path. Triggers the same flow as the "Open Folder" dialog.

---

## Medium Features (1-3 days each)

### 12. Canvas Regions/Groups
Colored rectangle containers on the canvas (like Figma sections/frames). Panels placed on a region are visually grouped with a shared background and label (e.g., "Frontend", "Backend", "Testing").

**Behavior:**
- Regions are canvas objects that sit behind panels (lower z-order)
- Dragging a region moves all panels on it together
- Regions have a label/title, customizable background color, and rounded corners
- Panels can be dragged on/off regions freely
- Right-click canvas to create a region, or use command palette
- Regions can be resized independently of their contents

### 13. Minimap Toggle
Bird's-eye overview of all panels on the canvas, shown as a small overlay in a corner. Clicking on the minimap navigates the viewport to that area.

**Behavior:**
- Off by default
- Toggle via Settings > Canvas and via keyboard shortcut (Cmd+Shift+M already defined)
- Shows colored rectangles representing each panel type
- Current viewport shown as a highlighted rectangle
- Click or drag on minimap to navigate

### 14. Cmd+Tab Panel Switcher
macOS-style panel switcher overlay for quick navigation between open panels.

**Behavior:**
- Hold Cmd+Tab to show all panels as visual cards/thumbnails in a horizontal row
- While holding Cmd, press Tab repeatedly to cycle through panels
- Click a card to jump directly to that panel
- Release Cmd to confirm selection and dismiss the overlay
- Selected panel becomes focused and canvas pans/zooms to show it
- Cards show panel type icon, title, and a small preview/thumbnail

### 15. Panel Stacks/Tabs
Tab multiple panels inside a single canvas node, like browser tabs. Click tabs to switch between panels sharing the same node space.

**Behavior:**
- Drag one panel's title bar onto another panel to create a stack
- Tab bar appears below the title bar showing all stacked panels
- Click a tab to switch the visible panel
- Drag a tab out to un-stack and create a separate node
- Each tab retains its own panel type and state

### 16. Saved Layouts/Templates
Save the current canvas arrangement (panel positions, sizes, types, and regions) as a named template. Restore a template to recreate that layout in the current workspace.

**Behavior:**
- Save via command palette or menu: "Save Layout As..."
- Restore via command palette: "Load Layout > [template name]"
- Templates stored as JSON in electron-store
- Optionally include workspace root path association
- Built-in templates: "Single Terminal", "Editor + Terminal", "Full Stack" (editor + terminal + browser)

### 17. Search Across All Open Editors
Global find (and optionally replace) across all currently open editor panels.

**Behavior:**
- Trigger via Cmd+Shift+F or command palette
- Shows a search panel/overlay with results grouped by file
- Click a result to focus that editor panel and highlight the match
- Optional replace functionality

### 18. Terminal Output Search
Cmd+F within a focused terminal panel to search scrollback history.

**Behavior:**
- Activates xterm.js search addon
- Search bar appears at top of terminal panel
- Highlights matches in scrollback
- Next/Previous navigation
- Dismiss with Escape

### 19. URL Bar for Browser Panels
Address bar with navigation controls for browser panels.

**Behavior:**
- URL input field in the title bar area or just below it
- Back, forward, refresh buttons
- URL updates as user navigates within the webview
- Enter to navigate to typed URL
- Search engine integration for non-URL queries

### 20. Drag-and-Drop Panel Reordering in Sidebar
Reorder workspace cards in the sidebar by dragging them up/down.

### 21. Auto-Layout
Button (in toolbar or command palette) to automatically arrange all panels in a tidy grid or flow layout, respecting panel sizes and spacing.

**Behavior:**
- Arranges panels in rows/columns fitting the current viewport
- Respects minimum sizes and maintains reasonable spacing
- Optionally animate the rearrangement
- Does not affect regions — panels stay on their regions if grouped

---

## Large Features (3+ days each)

### 22. Integrated AI Chat Panel (Paid Feature)
A dedicated Claude chat panel that can reference open files, terminal output, and workspace context.

**Behavior:**
- New panel type: "AI Chat"
- Can send selected code from editor panels as context
- Can read terminal output for debugging assistance
- Conversation persisted per workspace
- **Paid feature** — requires subscription/API key
- Could integrate with Claude Code CLI if installed

### 23. Multi-Window Support
Detach panels from the canvas into separate OS windows. Useful for multi-monitor setups.

**Behavior:**
- Right-click panel > "Detach to Window"
- Detached panel opens in a new Electron BrowserWindow
- Panel state remains synced with the workspace
- Drag panel back onto canvas to re-attach

### 24. Git Integration Panel
Visual git interface as a new panel type.

**Behavior:**
- Shows changed files with diff previews
- Staging area (stage/unstage individual files or hunks)
- Commit message input and commit button
- Branch selector and basic branch operations
- Pull/push with remote status
- Integrates with existing git IPC channels

### 25. Plugin/Extension System
Allow users to create custom panel types and extend CanvasIDE functionality.

**Behavior:**
- Plugin API for registering new panel types
- Plugins loaded from a designated directory
- Sandboxed execution environment
- Plugin settings integrated into Settings window

### 26. Canvas Annotations
Sticky notes, text labels, and freehand drawing directly on the canvas surface.

**Behavior:**
- Sticky notes: small colored cards with text, freely positioned
- Text labels: simple text placed on the canvas (for labeling areas)
- Freehand drawing: pen tool for sketching arrows, circles, highlights
- All annotations are canvas objects (movable, deletable)
- Lower z-order than panels, higher than regions

### 27. Workspace Export/Import
Export a workspace layout as a shareable JSON file that others can import.

**Behavior:**
- Export: saves panel layout, positions, sizes, regions, and optionally file paths
- Import: loads the layout into a new workspace
- Does not include file contents — just the spatial arrangement
- Useful for sharing team development setups
