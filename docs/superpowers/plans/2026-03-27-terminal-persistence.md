# Terminal Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminals stable across workspace switches (no blanking) and fully restorable on app restart (position, scrollback, working directory, title).

**Architecture:** Two-layer fix: (1) Replace SwiftUI conditional workspace rendering with an AppKit-managed view dictionary so `CanvasView` instances survive workspace switches. (2) Add PTY output logging via Ghostty's `io_write_cb` callback, with scrollback replay via `ghostty_surface_process_output` on restore.

**Tech Stack:** Swift 5.9, SwiftUI, AppKit (NSView/NSViewController), Ghostty C API (ghostty.h), Foundation (FileManager, DispatchQueue)

**Spec:** `docs/superpowers/specs/2026-03-27-terminal-persistence-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| **New: `CanvasIDE/Terminal/TerminalOutputLogger.swift`** | Per-terminal PTY output capture, buffered disk writing, two-file log rotation, OSC 7/0/2 parsing |
| **New: `CanvasIDE/Workspace/WorkspaceContainerView.swift`** | AppKit NSViewController that manages a `[UUID: CanvasView]` dictionary, swapping visibility on workspace switch |
| `CanvasIDE/MainWindowView.swift` | Replace ForEach/opacity ZStack (lines 81-95) with `WorkspaceContainerRepresentable` |
| `CanvasIDE/Terminal/GhosttyAppManager.swift` | Wire `io_write_cb`, `working_directory`, expose `replayOutput()` wrapper |
| `CanvasIDE/Terminal/TerminalView.swift` | Remove `detachSurface()` on window-nil, add replay + "Restoring..." overlay |
| `CanvasIDE/Workspace/WorkspaceContentView.swift` | Pass restore metadata (cwd, log path) when creating terminal nodes |
| `CanvasIDE/Workspace/Workspace.swift` | Enhanced `createTerminal` with restore parameters, terminal metadata storage |
| `CanvasIDE/Panels/TerminalPanel.swift` | Add logger reference field |
| `CanvasIDE/Persistence/SessionSnapshot.swift` | Add `workingDirectory`, `terminalLogFile` to `NodeSnapshot` |
| `CanvasIDE/Persistence/SessionStore.swift` | Multi-workspace save/restore, terminal log path handling |
| `CanvasIDE/CanvasIDEApp.swift` | Wire session save on app termination, restore on launch |

---

## Task 1: Fix `TerminalView` surface teardown on window removal

The root cause of terminals blanking on workspace switch. Currently `viewDidMoveToWindow()` calls `detachSurface()` when `window` becomes nil, destroying the Ghostty surface.

**Files:**
- Modify: `CanvasIDE/Terminal/TerminalView.swift:96-108`

- [ ] **Step 1: Remove the `detachSurface()` call from `viewDidMoveToWindow` when window is nil**

Replace the `viewDidMoveToWindow` method. Surfaces should only be destroyed on explicit close (via `deinit`), not on window detachment. Ghostty handles a missing window gracefully (skips frames).

```swift
// TerminalView.swift:96-108
override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil {
        if !hasSurface {
            attachSurface()
        }
        updateSurfaceSize()
    }
    // Do NOT detach the surface when window becomes nil.
    // The Ghostty surface handles a missing window gracefully (skips frames).
    // Cleanup happens in deinit when the TerminalView is deallocated.
}
```

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add CanvasIDE/Terminal/TerminalView.swift
git commit -m "fix: don't destroy terminal surface on window removal

Surfaces now survive being removed from a window (e.g., during
workspace switching). Cleanup only happens in deinit."
```

---

## Task 2: Create `WorkspaceContainerView` — AppKit-managed workspace switching

Replace the SwiftUI conditional rendering (`if let workspace`) with an AppKit container that keeps all `CanvasView` instances alive and swaps visibility.

**Files:**
- Create: `CanvasIDE/Workspace/WorkspaceContainerView.swift`
- Modify: `CanvasIDE/MainWindowView.swift:78-96` (replace ForEach/opacity ZStack)

- [ ] **Step 1: Create `WorkspaceContainerView.swift`**

This is an `NSViewController` that manages a dictionary of workspace canvas views. When the selected workspace changes, it hides the current view and shows the target.

```swift
import AppKit
import SwiftUI
import Combine

/// AppKit container that manages one CanvasView per workspace.
/// Views are created on first visit and kept alive across workspace switches.
final class WorkspaceContainerViewController: NSViewController {
    private var canvasViews: [UUID: NSView] = [:]  // workspaceId → hosted SwiftUI view
    private var currentWorkspaceId: UUID?
    private var cancellables = Set<AnyCancellable>()

    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override func loadView() {
        self.view = NSView()
        self.view.wantsLayer = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let appState else { return }

        // Observe workspace selection changes
        appState.$selectedWorkspaceId
            .receive(on: RunLoop.main)
            .sink { [weak self] newId in
                self?.switchToWorkspace(newId)
            }
            .store(in: &cancellables)

        // Initial switch
        switchToWorkspace(appState.selectedWorkspaceId)
    }

    private func switchToWorkspace(_ workspaceId: UUID?) {
        // Hide current
        if let currentId = currentWorkspaceId, let currentView = canvasViews[currentId] {
            currentView.isHidden = true
        }

        guard let workspaceId,
              let appState,
              let workspace = appState.workspaces.first(where: { $0.id == workspaceId }) else {
            currentWorkspaceId = nil
            return
        }

        // Show or create
        if let existingView = canvasViews[workspaceId] {
            existingView.isHidden = false
        } else {
            let contentView = WorkspaceContentView(workspace: workspace)
            let hostingView = NSHostingView(rootView: contentView.environmentObject(appState))
            hostingView.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(hostingView)
            NSLayoutConstraint.activate([
                hostingView.topAnchor.constraint(equalTo: view.topAnchor),
                hostingView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                hostingView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                hostingView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            canvasViews[workspaceId] = hostingView
        }

        currentWorkspaceId = workspaceId
    }

    /// Remove cached views for deleted workspaces.
    func pruneDeletedWorkspaces(activeIds: Set<UUID>) {
        for (id, view) in canvasViews where !activeIds.contains(id) {
            view.removeFromSuperview()
            canvasViews.removeValue(forKey: id)
        }
    }
}

/// SwiftUI wrapper for WorkspaceContainerViewController.
struct WorkspaceContainerRepresentable: NSViewControllerRepresentable {
    @EnvironmentObject var appState: AppState

    func makeNSViewController(context: Context) -> WorkspaceContainerViewController {
        WorkspaceContainerViewController(appState: appState)
    }

    func updateNSViewController(_ controller: WorkspaceContainerViewController, context: Context) {
        let activeIds = Set(appState.workspaces.map(\.id))
        controller.pruneDeletedWorkspaces(activeIds: activeIds)
    }
}
```

- [ ] **Step 2: Update `MainWindowView.swift` to use the container**

Replace the ForEach/opacity ZStack block (lines 78-96) with the new representable:

```swift
// MainWindowView.swift — replace lines 78-96:
// Old:
//     // Canvas workspace — keep all workspace views alive so terminal
//     // surfaces survive workspace switches ...
//     ZStack {
//         ForEach(appState.workspaces) { workspace in
//             let isSelected = workspace.id == appState.selectedWorkspaceId
//             WorkspaceContentView(workspace: workspace)
//                 .opacity(isSelected ? 1 : 0)
//                 .allowsHitTesting(isSelected)
//         }
//         if appState.selectedWorkspace == nil { ... }
//     }
//     .frame(maxWidth: .infinity, maxHeight: .infinity)

// New:
ZStack {
    WorkspaceContainerRepresentable()

    if appState.selectedWorkspace == nil {
        Color(nsColor: NSColor(red: 0.11, green: 0.11, blue: 0.13, alpha: 1.0))
        Text("No workspace selected")
            .font(.title2)
            .foregroundStyle(.tertiary)
    }
}
.frame(maxWidth: .infinity, maxHeight: .infinity)
```

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: Manual test — workspace switching**

1. Open app, create a terminal, type something
2. Create a second workspace
3. Switch back to first workspace
4. Verify terminal content is preserved (not blank)

- [ ] **Step 5: Commit**

```bash
git add CanvasIDE/Workspace/WorkspaceContainerView.swift CanvasIDE/MainWindowView.swift
git commit -m "fix: AppKit-managed workspace switching preserves terminal surfaces

Replace SwiftUI conditional workspace rendering with an AppKit
container that keeps CanvasView instances alive across switches."
```

---

## Task 3: Create `TerminalOutputLogger` — PTY output capture and disk persistence

**Files:**
- Create: `CanvasIDE/Terminal/TerminalOutputLogger.swift`

- [ ] **Step 1: Create the logger class**

```swift
import Foundation

/// Captures PTY output from a terminal and writes it to disk for session restore.
/// Uses a two-file rotation scheme: current (.log) and previous (.prev.log).
/// Thread-safe: io_write_cb is called from Ghostty's IO thread, so all mutable
/// state access is serialized through a dedicated dispatch queue.
final class TerminalOutputLogger {

    let terminalId: UUID
    let workspaceId: UUID

    /// Latest working directory parsed from OSC 7 (read from main thread)
    private(set) var currentWorkingDirectory: String?
    /// Latest title parsed from OSC 0/2 (read from main thread)
    private(set) var currentTitle: String?

    private let logDirectory: URL
    private let currentLogURL: URL
    private let previousLogURL: URL

    private var fileHandle: FileHandle?
    private var bufferedBytes: Data = Data()
    private var currentFileSize: UInt64 = 0
    private let maxFileSize: UInt64 = 1_048_576  // 1 MB per file

    // Buffer flush: every 1s or 4KB
    private let flushInterval: TimeInterval = 1.0
    private let flushThreshold: Int = 4096
    private var flushTimer: Timer?

    // OSC parser state
    private var oscBuffer: Data = Data()
    private var inOSC: Bool = false

    /// Serial queue protecting all mutable state (io_write_cb fires from background thread)
    private let queue = DispatchQueue(label: "com.canvaside.terminal-logger", qos: .utility)

    private static let baseDirectory: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("CanvasIDE/TerminalLogs", isDirectory: true)
    }()

    init(terminalId: UUID, workspaceId: UUID) {
        self.terminalId = terminalId
        self.workspaceId = workspaceId
        self.logDirectory = Self.baseDirectory
            .appendingPathComponent(workspaceId.uuidString, isDirectory: true)
        self.currentLogURL = logDirectory
            .appendingPathComponent("\(terminalId.uuidString).log")
        self.previousLogURL = logDirectory
            .appendingPathComponent("\(terminalId.uuidString).prev.log")

        // Create directory
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)

        // Open or create file
        if !FileManager.default.fileExists(atPath: currentLogURL.path) {
            FileManager.default.createFile(atPath: currentLogURL.path, contents: nil)
        }
        fileHandle = FileHandle(forWritingAtPath: currentLogURL.path)
        fileHandle?.seekToEndOfFile()
        currentFileSize = fileHandle?.offsetInFile ?? 0

        // Start flush timer
        flushTimer = Timer.scheduledTimer(withTimeInterval: flushInterval, repeats: true) { [weak self] _ in
            self?.flush()
        }
    }

    deinit {
        flush()
        flushTimer?.invalidate()
        try? fileHandle?.close()
    }

    // MARK: - Append bytes (called from io_write_cb on Ghostty's IO thread)

    func append(_ bytes: UnsafePointer<CChar>, length: Int) {
        let data = Data(bytes: bytes, count: length)
        queue.async { [weak self] in
            guard let self else { return }
            self.bufferedBytes.append(data)

            // Parse OSC sequences from the data
            self.parseOSC(data)

            // Flush if buffer exceeds threshold
            if self.bufferedBytes.count >= self.flushThreshold {
                self._flush()
            }
        }
    }

    // MARK: - Flush

    func flush() {
        queue.sync { [weak self] in
            self?._flush()
        }
    }

    /// Internal flush — must be called on `queue`.
    private func _flush() {
        guard !bufferedBytes.isEmpty else { return }
        fileHandle?.write(bufferedBytes)
        currentFileSize += UInt64(bufferedBytes.count)
        bufferedBytes.removeAll(keepingCapacity: true)

        // Rotate if needed
        if currentFileSize >= maxFileSize {
            rotate()
        }
    }

    // MARK: - Rotation

    private func rotate() {
        try? fileHandle?.close()

        // Delete previous, rename current → previous
        try? FileManager.default.removeItem(at: previousLogURL)
        try? FileManager.default.moveItem(at: currentLogURL, to: previousLogURL)

        // Create fresh current
        FileManager.default.createFile(atPath: currentLogURL.path, contents: nil)
        fileHandle = FileHandle(forWritingAtPath: currentLogURL.path)
        currentFileSize = 0
    }

    // MARK: - Read back for restore

    /// Returns the combined previous + current log data for replay.
    func readLogData() -> Data {
        flush()
        var result = Data()
        if let prevData = try? Data(contentsOf: previousLogURL) {
            result.append(prevData)
        }
        if let curData = try? Data(contentsOf: currentLogURL) {
            result.append(curData)
        }
        return result
    }

    /// Static: read log data from disk given paths (used during restore before logger exists).
    static func readLogData(workspaceId: UUID, terminalId: UUID) -> Data? {
        let dir = baseDirectory.appendingPathComponent(workspaceId.uuidString, isDirectory: true)
        let currentURL = dir.appendingPathComponent("\(terminalId.uuidString).log")
        let previousURL = dir.appendingPathComponent("\(terminalId.uuidString).prev.log")

        var result = Data()
        if let prevData = try? Data(contentsOf: previousURL) {
            result.append(prevData)
        }
        if let curData = try? Data(contentsOf: currentURL) {
            result.append(curData)
        }
        return result.isEmpty ? nil : result
    }

    // MARK: - Cleanup

    func deleteLogFiles() {
        flush()
        flushTimer?.invalidate()
        try? fileHandle?.close()
        fileHandle = nil
        try? FileManager.default.removeItem(at: currentLogURL)
        try? FileManager.default.removeItem(at: previousLogURL)
    }

    static func deleteWorkspaceLogs(workspaceId: UUID) {
        let dir = baseDirectory.appendingPathComponent(workspaceId.uuidString, isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
    }

    /// Remove log files that are not referenced by any session.
    static func pruneOrphanedLogs(activeTerminalIds: Set<UUID>, activeWorkspaceIds: Set<UUID>) {
        let fm = FileManager.default
        guard let workspaceDirs = try? fm.contentsOfDirectory(
            at: baseDirectory, includingPropertiesForKeys: nil
        ) else { return }

        for wsDir in workspaceDirs {
            let wsId = UUID(uuidString: wsDir.lastPathComponent)
            if let wsId, !activeWorkspaceIds.contains(wsId) {
                try? fm.removeItem(at: wsDir)
                continue
            }
            // Prune individual terminal logs
            if let files = try? fm.contentsOfDirectory(at: wsDir, includingPropertiesForKeys: nil) {
                for file in files {
                    let name = file.deletingPathExtension().lastPathComponent
                        .replacingOccurrences(of: ".prev", with: "")
                    if let termId = UUID(uuidString: name), !activeTerminalIds.contains(termId) {
                        try? fm.removeItem(at: file)
                    }
                }
            }
        }
    }

    // MARK: - OSC Parsing

    /// Lightweight parser that extracts OSC 7 (cwd) and OSC 0/2 (title) from output bytes.
    private func parseOSC(_ data: Data) {
        for byte in data {
            if inOSC {
                if byte == 0x07 || byte == 0x9C {
                    // OSC terminated by BEL (0x07) or ST (0x9C)
                    processOSC(oscBuffer)
                    oscBuffer.removeAll(keepingCapacity: true)
                    inOSC = false
                } else if byte == 0x1B {
                    // Possible start of ST (ESC \) — peek handled by next byte
                    oscBuffer.append(byte)
                } else if byte == 0x5C && oscBuffer.last == 0x1B {
                    // ST = ESC \ — remove trailing ESC and process
                    oscBuffer.removeLast()
                    processOSC(oscBuffer)
                    oscBuffer.removeAll(keepingCapacity: true)
                    inOSC = false
                } else {
                    oscBuffer.append(byte)
                }
            } else if byte == 0x1B {
                // Could be start of ESC ] (OSC)
                // We'll check next byte
                oscBuffer.removeAll(keepingCapacity: true)
                oscBuffer.append(byte)
            } else if byte == 0x5D && oscBuffer.count == 1 && oscBuffer[0] == 0x1B {
                // ESC ] — start of OSC
                oscBuffer.removeAll(keepingCapacity: true)
                inOSC = true
            } else {
                oscBuffer.removeAll(keepingCapacity: true)
            }
        }
    }

    private func processOSC(_ data: Data) {
        guard let str = String(data: data, encoding: .utf8) else { return }

        if str.hasPrefix("7;") {
            // OSC 7 — working directory: "7;file://hostname/path"
            let urlStr = String(str.dropFirst(2))
            if let url = URL(string: urlStr) {
                currentWorkingDirectory = url.path
            } else if urlStr.hasPrefix("/") {
                currentWorkingDirectory = urlStr
            }
        } else if str.hasPrefix("0;") || str.hasPrefix("2;") {
            // OSC 0 or 2 — window title
            currentTitle = String(str.dropFirst(2))
        }
    }
}
```

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add CanvasIDE/Terminal/TerminalOutputLogger.swift
git commit -m "feat: add TerminalOutputLogger for PTY output capture

Captures terminal output to disk via two-file rotation. Parses
OSC 7 (cwd) and OSC 0/2 (title) from the output stream."
```

---

## Task 4: Wire `io_write_cb` in `GhosttyAppManager` and add replay support

Connect the output logger to the Ghostty surface creation, and expose a method for replaying log data into a surface.

**Files:**
- Modify: `CanvasIDE/Terminal/GhosttyAppManager.swift:90-103`

- [ ] **Step 1: Update `createSurface` to accept logger and working directory, wire `io_write_cb`**

```swift
// GhosttyAppManager.swift — replace createSurface method (lines 90-103)

/// Create a new Ghostty surface hosted inside `view`.
/// The view must already be layer-backed with a CAMetalLayer.
/// - Parameters:
///   - view: The NSView to render into
///   - workingDirectory: Initial working directory for the shell (nil = default)
///   - logger: Optional output logger to capture PTY output
func createSurface(
    in view: NSView,
    workingDirectory: String? = nil,
    logger: TerminalOutputLogger? = nil
) -> ghostty_surface_t? {
    guard let app else {
        print("GhosttyAppManager: app not initialized")
        return nil
    }

    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.userdata = Unmanaged.passUnretained(view).toOpaque()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
    surfaceConfig.platform.macos.nsview = Unmanaged.passUnretained(view).toOpaque()
    surfaceConfig.scale_factor = Double(view.window?.backingScaleFactor ?? 2.0)

    // Set working directory if provided
    var cwdCString: UnsafeMutablePointer<CChar>?
    if let workingDirectory {
        cwdCString = strdup(workingDirectory)
        surfaceConfig.working_directory = UnsafePointer(cwdCString)
    }

    // Wire io_write_cb if logger provided
    // Uses passUnretained because Workspace.terminalLoggers owns the logger
    // and outlives the surface.
    if let logger {
        let loggerPtr = Unmanaged.passUnretained(logger).toOpaque()
        surfaceConfig.io_write_userdata = loggerPtr
        surfaceConfig.io_write_cb = { userdata, bytes, length in
            guard let userdata, let bytes else { return }
            let logger = Unmanaged<TerminalOutputLogger>.fromOpaque(userdata).takeUnretainedValue()
            logger.append(bytes, length: Int(length))
        }
    }

    let surface = ghostty_surface_new(app, &surfaceConfig)

    // Clean up the strdup'd string
    cwdCString?.deallocate()

    return surface
}

/// Replay captured output data into a terminal surface.
/// Chunks the data in 64KB blocks dispatched async to avoid blocking the main thread.
/// Uses a weak reference to the TerminalView to cancel replay if the terminal is closed.
func replayOutput(
    into surface: ghostty_surface_t,
    data: Data,
    owner: TerminalView,
    chunkSize: Int = 65536,
    completion: @escaping () -> Void
) {
    let totalLength = data.count
    guard totalLength > 0 else {
        completion()
        return
    }

    var offset = 0
    weak var weakOwner = owner

    func replayNextChunk() {
        // Cancel if terminal was closed mid-replay
        guard weakOwner != nil else { return }
        guard offset < totalLength else {
            completion()
            return
        }
        let end = min(offset + chunkSize, totalLength)
        let chunk = data[offset..<end]
        chunk.withUnsafeBytes { buffer in
            if let ptr = buffer.baseAddress?.assumingMemoryBound(to: CChar.self) {
                ghostty_surface_process_output(surface, ptr, UInt(buffer.count))
            }
        }
        offset = end
        // Yield to main run loop between chunks
        DispatchQueue.main.async {
            replayNextChunk()
        }
    }

    replayNextChunk()
}
```

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add CanvasIDE/Terminal/GhosttyAppManager.swift
git commit -m "feat: wire io_write_cb for output logging and add replay support

createSurface now accepts working directory and logger parameters.
replayOutput feeds captured data back into a surface in 64KB chunks."
```

---

## Task 5: Update `TerminalView` with logger integration and replay support

Add a logger property, wire it into surface creation, and support replaying scrollback on restore.

**Files:**
- Modify: `CanvasIDE/Terminal/TerminalView.swift`

- [ ] **Step 1: Add logger and restore properties to `TerminalView`**

Add these properties after the existing state section (after line 27):

```swift
// MARK: - Persistence

/// Output logger for capturing PTY output to disk.
var outputLogger: TerminalOutputLogger?

/// Initial working directory for the shell.
var workingDirectory: String?

/// Log data to replay into the surface after attachment (for session restore).
var replayData: Data?

/// Overlay shown during scrollback replay.
private var restoringOverlay: NSView?
```

- [ ] **Step 2: Update `attachSurface` to use logger and working directory**

Replace the `attachSurface` method:

```swift
func attachSurface() {
    guard surface == nil else { return }
    guard window != nil else {
        print("TerminalView: attachSurface called before view has a window — skipping")
        return
    }
    surface = GhosttyAppManager.shared.createSurface(
        in: self,
        workingDirectory: workingDirectory,
        logger: outputLogger
    )
    if surface == nil {
        print("TerminalView: failed to create Ghostty surface")
        return
    }
    updateSurfaceSize()

    // If we have replay data, show overlay and replay
    if let data = replayData, let surface {
        replayData = nil
        showRestoringOverlay()
        GhosttyAppManager.shared.replayOutput(into: surface, data: data, owner: self) { [weak self] in
            self?.hideRestoringOverlay()
        }
    }
}
```

- [ ] **Step 3: Add restoring overlay helpers**

Add at the end of the class (before the closing `}`):

```swift
// MARK: - Restoring Overlay

private func showRestoringOverlay() {
    let overlay = NSView()
    overlay.wantsLayer = true
    overlay.layer?.backgroundColor = NSColor(white: 0, alpha: 0.6).cgColor
    overlay.frame = bounds
    overlay.autoresizingMask = [.width, .height]

    let label = NSTextField(labelWithString: "Restoring…")
    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.textColor = .white
    label.alignment = .center
    label.sizeToFit()
    label.frame.origin = CGPoint(
        x: (bounds.width - label.frame.width) / 2,
        y: (bounds.height - label.frame.height) / 2
    )
    label.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
    overlay.addSubview(label)

    addSubview(overlay)
    restoringOverlay = overlay
}

private func hideRestoringOverlay() {
    restoringOverlay?.removeFromSuperview()
    restoringOverlay = nil
}
```

- [ ] **Step 4: Update deinit to release logger reference**

Update the deinit to flush the logger before destroying the surface:

```swift
deinit {
    outputLogger?.flush()
    if let s = surface {
        if Thread.isMainThread {
            ghostty_surface_free(s)
        } else {
            DispatchQueue.main.sync {
                ghostty_surface_free(s)
            }
        }
    }
}
```

- [ ] **Step 5: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 6: Commit**

```bash
git add CanvasIDE/Terminal/TerminalView.swift
git commit -m "feat: add output logger and scrollback replay to TerminalView

TerminalView now accepts a logger and working directory, replays
saved scrollback on restore with a 'Restoring...' overlay."
```

---

## Task 6: Update `Workspace` to support terminal restore parameters

Add terminal metadata tracking and a `createTerminal` overload for session restore.

**Files:**
- Modify: `CanvasIDE/Workspace/Workspace.swift:59-68`
- Modify: `CanvasIDE/Panels/TerminalPanel.swift`

- [ ] **Step 1: Add terminal metadata storage to `Workspace`**

Add after the `panels` property (after line 43):

```swift
// Terminal output loggers, keyed by panel UUID
private(set) var terminalLoggers: [UUID: TerminalOutputLogger] = [:]
```

- [ ] **Step 2: Update `createTerminal` to accept restore parameters and create logger**

Replace the `createTerminal` method:

```swift
@discardableResult
func createTerminal(
    at canvasOrigin: CGPoint? = nil,
    workingDirectory: String? = nil,
    replayLogData: Data? = nil,
    savedTitle: String? = nil
) -> UUID {
    let panelId = UUID()
    let origin = canvasOrigin ?? findFreePosition(for: .terminal)
    let size = CanvasLayoutEngine.defaultSize(for: .terminal)
    canvasState.addNode(panelId: panelId, at: origin, size: size)

    // Create output logger
    let logger = TerminalOutputLogger(terminalId: panelId, workspaceId: id)
    terminalLoggers[panelId] = logger

    // Store restore metadata for WorkspaceContentView to pick up
    if workingDirectory != nil || replayLogData != nil {
        terminalRestoreData[panelId] = TerminalRestoreInfo(
            workingDirectory: workingDirectory,
            replayData: replayLogData,
            title: savedTitle
        )
    }

    return panelId
}
```

- [ ] **Step 3: Add restore info struct and storage**

Add after `terminalLoggers`:

```swift
struct TerminalRestoreInfo {
    let workingDirectory: String?
    let replayData: Data?
    let title: String?
}

/// Restore metadata consumed by WorkspaceContentView when creating terminal views.
private(set) var terminalRestoreData: [UUID: TerminalRestoreInfo] = [:]

func consumeTerminalRestoreInfo(for panelId: UUID) -> TerminalRestoreInfo? {
    terminalRestoreData.removeValue(forKey: panelId)
}
```

- [ ] **Step 4: Update `closePanel` and `closeAllPanels` to clean up loggers**

In the `closePanel` method, add logger cleanup:

```swift
func closePanel(_ panelId: UUID) {
    panels.removeValue(forKey: panelId)
    terminalLoggers[panelId]?.deleteLogFiles()
    terminalLoggers.removeValue(forKey: panelId)
    terminalRestoreData.removeValue(forKey: panelId)
    if let nodeId = canvasState.nodeForPanel(panelId) {
        canvasState.removeNode(nodeId)
    }
}
```

Also update `closeAllPanels` to clean up all loggers:

```swift
func closeAllPanels() {
    for panelId in Array(panels.keys) {
        closePanel(panelId)
    }
    // Clean up terminal loggers (terminals are node-only, not in panels dict)
    for (_, logger) in terminalLoggers {
        logger.deleteLogFiles()
    }
    terminalLoggers.removeAll()
    terminalRestoreData.removeAll()
    for nodeId in Array(canvasState.nodes.keys) {
        canvasState.removeNode(nodeId)
    }
}
```

- [ ] **Step 5: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 6: Commit**

```bash
git add CanvasIDE/Workspace/Workspace.swift CanvasIDE/Panels/TerminalPanel.swift
git commit -m "feat: add terminal restore parameters and logger lifecycle to Workspace

createTerminal now accepts working directory, replay data, and title.
Loggers are created per terminal and cleaned up on close."
```

---

## Task 7: Wire logger and restore data in `WorkspaceContentView`

Pass the logger, working directory, and replay data from workspace into the `TerminalView` when nodes are created.

**Files:**
- Modify: `CanvasIDE/Workspace/WorkspaceContentView.swift:210-213`

- [ ] **Step 1: Update terminal creation in `syncNodes`**

Replace the terminal branch in `syncNodes` (around lines 210-213) where `contentView = TerminalView()`:

```swift
// Terminal: create a TerminalView with logger and restore data
let termView = TerminalView()
let panelId = nodeState.panelId

// Wire the logger
if let logger = workspace.terminalLoggers[panelId] {
    termView.outputLogger = logger
}

// Apply restore info if available (working directory, replay data)
if let restoreInfo = workspace.consumeTerminalRestoreInfo(for: panelId) {
    termView.workingDirectory = restoreInfo.workingDirectory
    termView.replayData = restoreInfo.replayData
} else {
    // New terminal: use workspace root as working directory
    termView.workingDirectory = workspace.rootPath
}

contentView = termView
```

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add CanvasIDE/Workspace/WorkspaceContentView.swift
git commit -m "feat: wire terminal logger and restore data in WorkspaceContentView

Terminal views now receive their output logger and restore metadata
(working directory, replay data) from the workspace on creation."
```

---

## Task 8: Enhanced session snapshot with terminal metadata

Update `SessionSnapshot` and `SessionStore` to persist terminal working directory, title, and log file references. Support multi-workspace sessions.

**Files:**
- Modify: `CanvasIDE/Persistence/SessionSnapshot.swift`
- Modify: `CanvasIDE/Persistence/SessionStore.swift`

- [ ] **Step 1: Add terminal fields to `NodeSnapshot`**

Add `workingDirectory` field to `NodeSnapshot` (it already has `url` and `filePath`):

```swift
struct NodeSnapshot: Codable {
    let panelId: String
    let panelType: String
    let origin: CGPointCodable
    let size: CGSizeCodable
    let title: String
    // Browser only
    let url: String?
    // Editor only
    let filePath: String?
    // Terminal only
    let workingDirectory: String?
}
```

- [ ] **Step 2: Update `SessionSnapshot.from(workspace:)` to capture terminal metadata**

Replace the terminal branch in the `from` method (lines 73-84):

```swift
} else {
    // Terminal (not stored in panels dict) — capture logger metadata
    let logger = workspace.terminalLoggers[node.panelId]
    let cwd = logger?.currentWorkingDirectory ?? workspace.rootPath
    let title = logger?.currentTitle ?? "Terminal"

    nodeSnapshots.append(NodeSnapshot(
        panelId: panelIdStr,
        panelType: PanelType.terminal.rawValue,
        origin: CGPointCodable(node.origin),
        size: CGSizeCodable(node.size),
        title: title,
        url: nil,
        filePath: nil,
        workingDirectory: cwd
    ))
}
```

Also update the browser/editor branches to pass `workingDirectory: nil`:

```swift
nodeSnapshots.append(NodeSnapshot(
    panelId: panelIdStr,
    panelType: anyPanel.panelType.rawValue,
    origin: CGPointCodable(node.origin),
    size: CGSizeCodable(node.size),
    title: anyPanel.title,
    url: urlStr,
    filePath: filePath,
    workingDirectory: nil
))
```

- [ ] **Step 3: Update restore to pass terminal metadata**

Replace the terminal case in `restore(into:)`:

```swift
case .terminal:
    // Read log data for replay
    let terminalUUID = UUID(uuidString: node.panelId)
    let replayData: Data? = terminalUUID.flatMap { tid in
        TerminalOutputLogger.readLogData(workspaceId: workspace.id, terminalId: tid)
    }

    let panelId = workspace.createTerminal(
        workingDirectory: node.workingDirectory,
        replayLogData: replayData,
        savedTitle: node.title
    )
    if let nodeId = workspace.canvasState.nodeForPanel(panelId) {
        workspace.canvasState.moveNode(nodeId, to: origin)
        workspace.canvasState.resizeNode(nodeId, to: size)
    }
```

- [ ] **Step 4: Update `SessionStore` for multi-workspace save**

Replace `SessionStore` to save all workspaces:

```swift
import Foundation

@MainActor
final class SessionStore {
    private static let sessionDirectory: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("CanvasIDE/Sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    struct MultiWorkspaceSession: Codable {
        let selectedWorkspaceIndex: Int?
        let workspaces: [SessionSnapshot]
    }

    static func saveAll(_ appState: AppState) {
        // Flush all terminal loggers
        for workspace in appState.workspaces {
            for (_, logger) in workspace.terminalLoggers {
                logger.flush()
            }
        }

        let snapshots = appState.workspaces.map { SessionSnapshot.from(workspace: $0) }
        let selectedIndex = appState.workspaces.firstIndex(where: { $0.id == appState.selectedWorkspaceId })

        let session = MultiWorkspaceSession(
            selectedWorkspaceIndex: selectedIndex,
            workspaces: snapshots
        )

        let url = sessionDirectory.appendingPathComponent("session.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(session) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func restoreAll(into appState: AppState) -> Bool {
        let url = sessionDirectory.appendingPathComponent("session.json")
        guard let data = try? Data(contentsOf: url) else { return false }

        // Try multi-workspace format first, fall back to legacy single-workspace
        if let session = try? JSONDecoder().decode(MultiWorkspaceSession.self, from: data) {
            guard !session.workspaces.isEmpty else { return false }

            appState.workspaces.removeAll()
            for snapshot in session.workspaces {
                let ws = Workspace(name: snapshot.workspaceName, rootPath: snapshot.rootPath)
                snapshot.restore(into: ws)
                appState.workspaces.append(ws)
            }
            if let idx = session.selectedWorkspaceIndex, idx < appState.workspaces.count {
                appState.selectedWorkspaceId = appState.workspaces[idx].id
            } else {
                appState.selectedWorkspaceId = appState.workspaces.first?.id
            }
            return true
        }

        // Legacy single-workspace format
        if let snapshot = try? JSONDecoder().decode(SessionSnapshot.self, from: data) {
            let ws = Workspace(name: snapshot.workspaceName, rootPath: snapshot.rootPath)
            snapshot.restore(into: ws)
            appState.workspaces = [ws]
            appState.selectedWorkspaceId = ws.id
            return true
        }

        return false
    }

    // Keep legacy methods for compatibility
    static func save(_ snapshot: SessionSnapshot) {
        let url = sessionDirectory.appendingPathComponent("session.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(snapshot) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load() -> SessionSnapshot? {
        let url = sessionDirectory.appendingPathComponent("session.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SessionSnapshot.self, from: data)
    }
}
```

- [ ] **Step 5: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 6: Commit**

```bash
git add CanvasIDE/Persistence/SessionSnapshot.swift CanvasIDE/Persistence/SessionStore.swift
git commit -m "feat: enhanced session persistence with terminal metadata

NodeSnapshot now stores working directory for terminals. SessionStore
supports multi-workspace save/restore with legacy format fallback.
Terminal scrollback is replayed from log files on restore."
```

---

## Task 9: Wire session save/restore in `CanvasIDEApp`

Save all workspaces on app termination and restore on launch.

**Files:**
- Modify: `CanvasIDE/CanvasIDEApp.swift`

- [ ] **Step 1: Add session restore to `AppState.init` and save on termination**

Update `CanvasIDEApp` to restore on appear and save on termination:

```swift
import SwiftUI

@main
struct CanvasIDEApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            MainWindowView()
                .environmentObject(appState)
                .frame(minWidth: 800, minHeight: 600)
                .onAppear {
                    GhosttyAppManager.shared.initialize()
                    // Restore previous session
                    if SessionStore.restoreAll(into: appState) {
                        // Prune orphaned terminal log files
                        let activeTerminalIds = Set(appState.workspaces.flatMap { $0.terminalLoggers.keys })
                        let activeWorkspaceIds = Set(appState.workspaces.map(\.id))
                        TerminalOutputLogger.pruneOrphanedLogs(
                            activeTerminalIds: activeTerminalIds,
                            activeWorkspaceIds: activeWorkspaceIds
                        )
                    }
                }
        }
        .windowStyle(.hiddenTitleBar)
    }
}

/// Global app state: manages workspaces and selection.
@MainActor
final class AppState: ObservableObject {
    @Published var workspaces: [Workspace] = []
    @Published var selectedWorkspaceId: UUID?

    private var terminationObserver: Any?

    init() {
        let defaultWorkspace = Workspace(
            name: "Default",
            color: .systemBlue,
            rootPath: FileManager.default.homeDirectoryForCurrentUser.path
        )
        workspaces = [defaultWorkspace]
        selectedWorkspaceId = defaultWorkspace.id

        // Save session on app termination
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            SessionStore.saveAll(self)
        }
    }

    deinit {
        if let observer = terminationObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    var selectedWorkspace: Workspace? {
        workspaces.first { $0.id == selectedWorkspaceId }
    }

    func addWorkspace(name: String = "New Workspace", rootPath: String? = nil) {
        let ws = Workspace(name: name, color: .systemGreen, rootPath: rootPath)
        workspaces.append(ws)
        selectedWorkspaceId = ws.id
    }
}
```

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add CanvasIDE/CanvasIDEApp.swift
git commit -m "feat: wire session save on termination and restore on launch

App now saves all workspace state (including terminal metadata) when
quitting and restores the full session on next launch."
```

---

## Task 10: Add new files to Xcode project and final integration test

Ensure the new files are included in the Xcode project and do a full manual integration test.

**Files:**
- Modify: `project.yml` (if using XcodeGen) or `CanvasIDE.xcodeproj/project.pbxproj`

- [ ] **Step 1: Regenerate Xcode project**

The project uses XcodeGen, so the new `.swift` files in the existing source directories should be picked up automatically:

```bash
cd /Users/paulhorn/Dev/Apps/CanvasIDE && xcodegen generate
```

- [ ] **Step 2: Full build**

Run: `xcodebuild -project CanvasIDE.xcodeproj -scheme CanvasIDE -configuration Debug build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Manual integration test — workspace switching**

1. Open app, create terminal in workspace 1, type `echo "hello from ws1"` and other commands
2. Create workspace 2, create terminal, type `echo "hello from ws2"`
3. Switch back to workspace 1 — verify terminal shows full history (not blank)
4. Switch to workspace 2 — verify its terminal is intact
5. Switch rapidly back and forth several times — verify no blanking

- [ ] **Step 4: Manual integration test — app restart with scrollback**

1. In workspace 1, run several commands in a terminal (e.g. `ls -la`, `cat /etc/hosts`, `pwd`)
2. Note the terminal's working directory and scrollback content
3. Quit the app (Cmd+Q)
4. Relaunch the app
5. Verify: terminal is at saved position on canvas, shows "Restoring..." briefly, then displays full scrollback
6. Verify: shell prompt is in the correct working directory
7. Verify: new commands work normally after restore

- [ ] **Step 5: Manual test — terminal close cleanup**

1. Create a terminal, type some commands (generates log files)
2. Close the terminal (click X on title bar)
3. Check `~/Library/Application Support/CanvasIDE/TerminalLogs/` — the log files for that terminal should be deleted

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: regenerate Xcode project with new terminal persistence files"
```
