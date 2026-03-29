# Welcome Page Design

## Overview

When CanvasIDE starts with no restored workspaces (or an empty session), show a welcome page overlay on the canvas instead of a blank workspace. The welcome page provides quick actions, recent projects, and keyboard shortcuts to help users get started.

## Components

### WelcomePage (`src/renderer/ui/WelcomePage.tsx`)

A centered overlay rendered on the canvas area when the current workspace has zero nodes. Disappears automatically when any panel is created or a folder is opened.

**Layout:**
- Top: App name ("CanvasIDE") + tagline ("Infinite canvas for coding")
- Left column — **Start** actions:
  - Open Folder (opens native folder picker, sets workspace root)
  - New Terminal
  - New Editor
  - New Browser
  - Each action has an icon (lucide-react) and label
- Right column — **Recent Projects**:
  - List of recently opened folder paths (max 10)
  - Each entry shows folder name + abbreviated parent path
  - Clicking opens the folder as workspace root in the current workspace
- Bottom — **Keyboard Shortcuts** cheat sheet:
  - Compact grid of key bindings (Cmd+T, Cmd+Shift+E, etc.)

**Styling:** Dark theme, consistent with existing canvas-bg. Subtle, not flashy. Text in white/gray tones. Action items highlighted on hover.

### Recent Projects Tracking

**Storage:** New electron-store key `recentProjects: string[]` (max 10 entries, most recent first).

**IPC channels:**
- `recent-projects:get` — returns the list
- `recent-projects:add` — adds a path (deduplicates, trims to 10)

**Integration:** `setWorkspaceRootPath` in appStore triggers `recent-projects:add` via the preload API.

### Ephemeral Workspace on Startup

Current behavior creates a default workspace with a welcome terminal when no session restores. Changed behavior:

- Create a default workspace with **no panels** (no welcome terminal)
- The welcome page overlay appears because nodes are empty
- Session save skips workspaces that have no panels AND no rootPath (ephemeral)
- Once the user opens a folder or creates any panel, the workspace becomes persistent

## Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/ui/WelcomePage.tsx` | **Create** — welcome page component |
| `src/renderer/App.tsx` | Render WelcomePage when nodes empty; remove welcome terminal creation |
| `src/main/store.ts` | Add recent projects IPC handlers |
| `src/preload/index.ts` | Expose `recentProjectsGet` and `recentProjectsAdd` |
| `src/shared/electron-api.d.ts` | Type the new preload API |
| `src/shared/ipc-channels.ts` | Add channel constants |
| `src/renderer/lib/session.ts` | Skip ephemeral workspaces in saveSession |
| `src/renderer/stores/appStore.ts` | Call recentProjectsAdd from setWorkspaceRootPath |

## Edge Cases

- **No recent projects:** Hide the Recent section or show "No recent projects"
- **Recent project folder deleted:** Show path but grayed out / skip on click
- **Multiple workspaces, one empty:** Welcome page shows only in the empty workspace's canvas
- **User closes all panels in a workspace:** Welcome page reappears
