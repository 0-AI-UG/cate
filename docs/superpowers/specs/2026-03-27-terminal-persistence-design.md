# Terminal Persistence Design Spec

## Problem

Two issues with terminal stability in CanvasIDE:

1. **Workspace switching:** All terminals go blank (lose all content) when switching between projects and switching back. The ZStack opacity-based keep-alive mechanism fails because SwiftUI recreates `CanvasViewRepresentable` instances.

2. **App restart:** Terminals are recreated as empty shells. No scrollback history, working directory, or position context is restored beyond basic canvas layout.

## Goals

- Terminals retain full content across workspace switches (no blanking)
- On app restart, terminals restore at their saved canvas positions with full scrollback history and correct working directory
- Storage is bounded and efficient even with many terminals across many workspaces
- Graceful handling of app crashes (logs survive on disk)

## Non-Goals

- Restoring live running processes (e.g. a running `npm start` — only scrollback + cwd)
- Restoring shell state like environment variables, aliases, or shell functions
- Syncing terminal state across devices

---

## Design

### Part 1: Fix terminals blanking on workspace switch

**Root cause:** SwiftUI destroys and recreates `CanvasViewRepresentable` when the active workspace changes, even though the ZStack keeps views at opacity 0. This deallocates `TerminalView` instances and their Ghostty surfaces.

**Fix:**
- Add explicit `.id(workspace.id)` to each workspace's `CanvasViewRepresentable` in the ZStack to ensure stable SwiftUI identity
- Verify the `Coordinator` is not being recreated on workspace switch (`makeCoordinator` should only fire once per workspace)
- **Fallback:** If SwiftUI still tears down views, move to AppKit-managed hosting: keep `CanvasView` instances in a dictionary keyed by workspace ID, swap them in/out of the window manually instead of relying on SwiftUI lifecycle

**Validation:** Switch workspaces back and forth — terminals must retain their full output.

### Part 2: PTY output logging

#### TerminalOutputLogger (new file)

A class that captures all terminal output to per-terminal log files on disk.

**Storage location:** `~/Library/Application Support/CanvasIDE/TerminalLogs/{workspaceId}/{terminalId}.log`

**Capture mechanism:**
- Hook into the Ghostty surface output path. When bytes arrive from the PTY, tee them to the log file.
- If Ghostty's C API doesn't expose an output callback, interpose at the PTY file descriptor level: duplicate the fd and read from it on a background thread.

**Buffered I/O:**
- Buffer writes, flush every ~1 second or every 4KB, whichever comes first
- Prevents disk thrash with many active terminals

**Log rotation:**
- Cap each terminal log at ~2MB
- When exceeded, truncate the oldest half
- Bounds total storage even with many terminals across workspaces

**Lifecycle:**
- Logger created when terminal surface attaches
- Logger destroyed when terminal is explicitly closed by the user (log file deleted)
- Logger flushes on workspace save and app termination

#### Working directory tracking

**Primary method:** Parse OSC 7 escape sequences from the PTY output stream. Modern shells (bash, zsh, fish) emit these to report the current working directory. The logger already sees all output bytes, so this adds minimal overhead.

**Fallback method:** Periodically poll the shell process's cwd via `proc_pidinfo` (Darwin API). `ProcessMonitor` already detects shell PIDs.

**Storage:** Latest cwd stored on `TerminalPanel` and included in `SessionSnapshot`.

### Part 3: Enhanced session snapshot

Extend `NodeSnapshot` for terminal panels:

```
NodeSnapshot {
  // existing fields
  panelId: String
  panelType: String
  origin: { x, y }
  size: { width, height }
  title: String

  // new terminal-specific fields
  workingDirectory: String?     // shell's current working directory
  terminalLogFile: String?      // relative path to scrollback log
}
```

### Part 4: Restore flow on app restart

1. Load `SessionSnapshot` — positions, sizes, working directories, log file paths
2. For each terminal node:
   a. Create `TerminalView` at saved position/size
   b. Set working directory so the new shell starts in the correct location
   c. Once surface attaches, write the log file contents into the terminal surface as display data (via `ghostty_surface_write` or equivalent input-injection API)
   d. Terminal shows full scrollback with a live shell prompt at the bottom
3. Start fresh logging for the new session (new log file, old one can be deleted after successful replay)

### Part 5: Cleanup and lifecycle

| Event | Action |
|-------|--------|
| Terminal closed by user | Delete log file, remove from snapshot |
| Workspace deleted | Delete entire `TerminalLogs/{workspaceId}/` directory |
| App crash | Logs survive on disk; next launch restores from session + logs |
| App launch | Prune orphaned log files not referenced by any saved session |

---

## File Changes

| File | Change |
|------|--------|
| **New: `Terminal/TerminalOutputLogger.swift`** | PTY output capture, buffered file writing, log rotation, OSC 7 parsing |
| `Persistence/SessionSnapshot.swift` | Add `workingDirectory`, `terminalLogFile` to `NodeSnapshot` |
| `Persistence/SessionStore.swift` | Include terminal log paths in save/restore |
| `Terminal/TerminalView.swift` | Hook output path to logger; replay log on restore; fix surface lifecycle |
| `Workspace/WorkspaceContentView.swift` | Fix SwiftUI identity for workspace views; pass restore data to terminal creation |
| `Workspace/Workspace.swift` | Store working directories per terminal; enhanced `createTerminal` for restore mode |
| `Terminal/GhosttyAppManager.swift` | Expose output callback hook and `surface_write` for replay |
| `MainWindowView.swift` | Verify/fix ZStack identity stability |
| `Panels/TerminalPanel.swift` | Add `workingDirectory`, `loggerRef` fields |

## Technical Risks

1. **Ghostty C API surface:** Need to verify `ghostty_surface_write` or equivalent exists for replaying output. If not, may need to write to the PTY master fd directly (which would be interpreted as user input, not display output).
2. **PTY output interception:** If Ghostty doesn't expose an output callback, fd duplication adds complexity (background reader thread, synchronization).
3. **Large scrollback replay:** Writing 2MB of terminal escape sequences on restore could take noticeable time. May need to show a loading indicator or stream progressively.
4. **OSC 7 availability:** Not all shell configurations emit OSC 7. The `proc_pidinfo` fallback covers this but is less responsive.
