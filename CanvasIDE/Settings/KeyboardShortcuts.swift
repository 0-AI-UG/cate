import AppKit

// MARK: - ShortcutAction

enum ShortcutAction: String, Codable {
    case newTerminal
    case newBrowser
    case newEditor
    case closePanel
    case toggleSidebar
    case toggleFileExplorer
    case toggleMinimap
    case commandPalette
    case zoomIn
    case zoomOut
    case zoomReset
    case focusNext
    case focusPrevious
    case saveFile
}

// MARK: - KeyboardShortcut

struct KeyboardShortcut: Codable, Hashable {
    let key: String            // e.g. "t", "b", "e", "p"
    let modifiers: UInt        // NSEvent.ModifierFlags.rawValue
    let action: ShortcutAction
}

// MARK: - KeyboardShortcutManager

final class KeyboardShortcutManager {
    static let shared = KeyboardShortcutManager()

    var shortcuts: [KeyboardShortcut] = KeyboardShortcutManager.defaultShortcuts

    static let defaultShortcuts: [KeyboardShortcut] = {
        let cmd   = NSEvent.ModifierFlags.command.rawValue
        let shift = NSEvent.ModifierFlags.shift.rawValue
        let ctrl  = NSEvent.ModifierFlags.control.rawValue

        return [
            // Cmd+T: New Terminal
            KeyboardShortcut(key: "t", modifiers: cmd, action: .newTerminal),
            // Cmd+Shift+B: New Browser
            KeyboardShortcut(key: "b", modifiers: cmd | shift, action: .newBrowser),
            // Cmd+Shift+E: New Editor
            KeyboardShortcut(key: "e", modifiers: cmd | shift, action: .newEditor),
            // Cmd+W: Close Panel
            KeyboardShortcut(key: "w", modifiers: cmd, action: .closePanel),
            // Cmd+\: Toggle Sidebar
            KeyboardShortcut(key: "\\", modifiers: cmd, action: .toggleSidebar),
            // Cmd+Shift+F: Toggle File Explorer
            KeyboardShortcut(key: "f", modifiers: cmd | shift, action: .toggleFileExplorer),
            // Cmd+Shift+M: Toggle Minimap
            KeyboardShortcut(key: "m", modifiers: cmd | shift, action: .toggleMinimap),
            // Cmd+Shift+P: Command Palette
            KeyboardShortcut(key: "p", modifiers: cmd | shift, action: .commandPalette),
            // Cmd+=: Zoom In
            KeyboardShortcut(key: "=", modifiers: cmd, action: .zoomIn),
            // Cmd+-: Zoom Out
            KeyboardShortcut(key: "-", modifiers: cmd, action: .zoomOut),
            // Cmd+0: Reset Zoom
            KeyboardShortcut(key: "0", modifiers: cmd, action: .zoomReset),
            // Ctrl+Tab: Focus Next
            KeyboardShortcut(key: "\t", modifiers: ctrl, action: .focusNext),
            // Ctrl+Shift+Tab: Focus Previous
            KeyboardShortcut(key: "\t", modifiers: ctrl | shift, action: .focusPrevious),
            // Cmd+S: Save File
            KeyboardShortcut(key: "s", modifiers: cmd, action: .saveFile),
        ]
    }()

    // MARK: - Event matching

    func action(for event: NSEvent) -> ShortcutAction? {
        guard let chars = event.charactersIgnoringModifiers?.lowercased() else { return nil }
        let eventModifiers = event.modifierFlags
            .intersection([.command, .shift, .control, .option])
            .rawValue

        return shortcuts.first { shortcut in
            shortcut.key == chars && shortcut.modifiers == eventModifiers
        }?.action
    }
}
