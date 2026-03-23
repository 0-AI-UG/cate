# Settings Window + Snap-to-Grid

## Summary

Add a standard macOS Settings window (Cmd+,) to CanvasIDE with general IDE settings. Wire the existing `CanvasLayoutEngine.snapToGrid()` into drag/resize handlers, controlled by a setting. Move `gridStyle` and `minimapVisible` from per-workspace `CanvasState` to global `AppSettings`.

## Settings Model

`AppSettings` — a `@MainActor ObservableObject` singleton backed by `UserDefaults` via `@AppStorage`.

### Canvas Settings
| Setting | Type | Default | Notes |
|---------|------|---------|-------|
| Grid style | `CanvasGridStyle` (blank/dots/lines) | `.lines` | Moved from `CanvasState.gridStyle` |
| Snap to grid | `Bool` | `true` | New |
| Grid spacing | `Int` (10/20/40) | `20` | Currently hardcoded in `CanvasLayoutEngine` |
| Show minimap | `Bool` | `true` | Moved from `CanvasState.minimapVisible` |

### General Settings
| Setting | Type | Default | Notes |
|---------|------|---------|-------|
| Restore session on launch | `Bool` | `true` | New |
| Default shell path | `String` | `/bin/zsh` | New |

### Appearance Settings
| Setting | Type | Default | Notes |
|---------|------|---------|-------|
| Editor font size | `Double` | `13` | New |

## Settings Window

SwiftUI `Settings` scene added to `CanvasIDEApp.body`. Uses `TabView` with labeled tabs and SF Symbol icons:
- General (gear icon)
- Canvas (square.grid.3x3 icon)
- Appearance (paintbrush icon)

Standard macOS settings layout: labels on the left, controls on the right, grouped with `Form`.

## Snap-to-Grid Wiring

Existing functions in `CanvasLayoutEngine`: `snapToGrid(_:gridSize:)`, `snapToEdges(_:neighbors:threshold:)`, `snap(_:neighbors:gridSize:edgeThreshold:)`.

Currently only used by `findFreePosition`. Wire into:

1. **Title bar drag end** — snap final origin via `CanvasLayoutEngine.snap()`
2. **Body drag end** — same
3. **Resize drag end** — snap origin and size to grid

Snap on drag-end only (not continuously) for smooth dragging. Reads `AppSettings.shared.snapToGridEnabled` and `AppSettings.shared.gridSpacing`.

## Migration

- Remove `gridStyle` from `CanvasState` — `CanvasView.drawGrid()` reads `AppSettings.shared.gridStyle`
- Remove `minimapVisible` from `CanvasState` — `WorkspaceContentView` reads `AppSettings.shared.showMinimap`
- Grid spacing in `CanvasView.drawGrid()` reads `AppSettings.shared.gridSpacing` instead of hardcoded `20.0`
- `CanvasLayoutEngine.findFreePosition()` reads `AppSettings.shared.gridSpacing`

## Files Changed

| File | Change |
|------|--------|
| `CanvasIDE/Settings/AppSettings.swift` | New — settings model |
| `CanvasIDE/Settings/SettingsView.swift` | New — settings window UI |
| `CanvasIDE/CanvasIDEApp.swift` | Add `Settings` scene |
| `CanvasIDE/Canvas/CanvasState.swift` | Remove `gridStyle`, `minimapVisible` |
| `CanvasIDE/Canvas/CanvasView.swift` | Read grid settings from `AppSettings` |
| `CanvasIDE/Canvas/CanvasLayoutEngine.swift` | Read grid spacing from `AppSettings` |
| `CanvasIDE/Workspace/WorkspaceContentView.swift` | Read minimap from `AppSettings`, wire snap into drag handlers |
| `project.yml` | Add new files to sources (if needed — XcodeGen globs should pick them up) |
