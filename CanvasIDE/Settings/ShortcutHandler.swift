import AppKit

@MainActor
final class ShortcutHandler {
    weak var workspace: Workspace?

    func handle(_ action: ShortcutAction) {
        guard let workspace else { return }

        switch action {
        case .newTerminal:
            workspace.createTerminal()

        case .newBrowser:
            workspace.createBrowser()

        case .newEditor:
            workspace.createEditor()

        case .closePanel:
            if let focusedId = workspace.canvasState.focusedNodeId,
               let node = workspace.canvasState.nodes[focusedId] {
                workspace.closePanel(node.panelId)
            }

        case .toggleMinimap:
            workspace.canvasState.minimapVisible.toggle()

        case .zoomIn:
            workspace.canvasState.setZoom(workspace.canvasState.zoomLevel + 0.1)

        case .zoomOut:
            workspace.canvasState.setZoom(workspace.canvasState.zoomLevel - 0.1)

        case .zoomReset:
            workspace.canvasState.setZoom(1.0)

        case .focusNext:
            if let current = workspace.canvasState.focusedNodeId,
               let next = workspace.canvasState.nextNode(after: current) {
                workspace.canvasState.focusNode(next)
            }

        case .focusPrevious:
            if let current = workspace.canvasState.focusedNodeId,
               let prev = workspace.canvasState.previousNode(before: current) {
                workspace.canvasState.focusNode(prev)
            }

        case .saveFile:
            // Save the editor in the focused node, if any.
            if let focusedId = workspace.canvasState.focusedNodeId,
               let node = workspace.canvasState.nodes[focusedId],
               let anyPanel = workspace.panels[node.panelId] {
                // EditorPanel has a save() method; we can't call it through
                // AnyPanel directly. Post a notification that EditorPanelView
                // observes, keyed by panelId.
                NotificationCenter.default.post(
                    name: .savePanelFile,
                    object: nil,
                    userInfo: ["panelId": node.panelId]
                )
                _ = anyPanel  // suppress unused-variable warning
            }

        // toggleSidebar and toggleFileExplorer are handled at the window level;
        // the ShortcutHandler forwards them via notification so the view layer
        // can react without a direct reference.
        case .toggleSidebar:
            NotificationCenter.default.post(name: .toggleSidebar, object: nil)

        case .toggleFileExplorer:
            NotificationCenter.default.post(name: .toggleFileExplorer, object: nil)

        case .commandPalette:
            NotificationCenter.default.post(name: .showCommandPalette, object: nil)
        }
    }
}

// MARK: - Notification names

extension Notification.Name {
    static let savePanelFile     = Notification.Name("CanvasIDE.savePanelFile")
    static let toggleSidebar     = Notification.Name("CanvasIDE.toggleSidebar")
    static let toggleFileExplorer = Notification.Name("CanvasIDE.toggleFileExplorer")
    static let showCommandPalette = Notification.Name("CanvasIDE.showCommandPalette")
}
