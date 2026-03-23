# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CanvasIDE is a macOS application that provides an infinite zoomable canvas where editor panels, terminal panels, and browser panels float spatially (similar to Figma/Miro, but for coding). Built with SwiftUI + AppKit, targeting macOS 14.0+, Swift 5.9.

## Build System

The project uses **XcodeGen** to generate `CanvasIDE.xcodeproj` from `project.yml`. After modifying `project.yml`, regenerate with:

```
xcodegen generate
```

Build from Xcode or command line:
```
xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build
```

There are no tests currently.

## Dependencies

Managed via Swift Package Manager (defined in `project.yml`):
- **Highlightr** — syntax highlighting for editor panels
- **Sparkle** — auto-update framework
- **GhosttyKit.xcframework** — terminal rendering engine (local symlink, uses Metal via CAMetalLayer)

The Ghostty C API is bridged via `CanvasIDE-Bridging-Header.h` → `ghostty.h`.

## Architecture

### Coordinate System & Canvas

The canvas (`CanvasView.swift` NSView) uses a flipped coordinate system (origin top-left). All panel positions are stored in **canvas-space** and transformed to/from **view-space** via affine transforms combining zoom level and scroll offset. Key conversions: `canvasToView()` / `viewToCanvas()` on `CanvasState`. Zoom range: 0.3x–3.0x.

### Panel System

Panels conform to the `Panel` protocol and are stored heterogeneously via `AnyPanel` type-erased wrapper. Three panel types exist:
- **EditorPanel** — SwiftUI text editor with Highlightr syntax highlighting
- **TerminalPanel** — Ghostty-powered terminal rendered into a CAMetalLayer
- **BrowserPanel** — WKWebView-based web browser

Each panel is wrapped in a `CanvasNode` (NSView) that provides title bar, drag, resize, and close behavior.

### Terminal Integration

Ghostty renders directly into Metal. `GhosttyAppManager` is a singleton managing the `ghostty_app_t` lifecycle with a 16ms timer driving the event loop. Terminal zoom works by adjusting bounds size and content scale on the `TerminalView`, not by overriding the drawable.

### State Hierarchy

`AppState` (global) → `Workspace` (contains panels + `CanvasState`) → `CanvasState` (zoom, offset, node positions). Session persistence saves/restores workspace state as JSON to `~/Library/Application Support/CanvasIDE/Sessions/`.

### Key Patterns

- **MVVM** with `ObservableObject` / `@Published` for reactive state
- **SwiftUI for UI**, **AppKit NSView subclasses** for canvas rendering and terminal
- Mouse/keyboard events handled at the NSView level; keyboard shortcuts via global `NotificationCenter`
- `FileTreeModel` is git-aware (tracks file status) and lazy-loads directories
