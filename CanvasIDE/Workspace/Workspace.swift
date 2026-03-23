import AppKit
import Combine

// MARK: - AnyPanel
//
// Type-erasing box so heterogeneous Panel values (class + struct) can live
// in a single [UUID: AnyPanel] dictionary without existential boxing issues.

final class AnyPanel {
    let id: UUID
    let panelType: PanelType
    let title: String
    private let _makeContentView: () -> NSView
    private let _focus: () -> Void
    private let _unfocus: () -> Void

    init<P: Panel>(_ panel: P) {
        self.id = panel.id
        self.panelType = panel.panelType
        self.title = panel.title
        self._makeContentView = { panel.makeContentView() }
        self._focus = { panel.focus() }
        self._unfocus = { panel.unfocus() }
    }

    func makeContentView() -> NSView { _makeContentView() }
    func focus() { _focus() }
    func unfocus() { _unfocus() }
}

// MARK: - Workspace

@MainActor
final class Workspace: ObservableObject, Identifiable {
    let id = UUID()
    @Published var name: String
    @Published var color: NSColor
    @Published var rootPath: String?

    let canvasState = CanvasState()

    // Panel storage: UUID → type-erased panel wrapper
    @Published private(set) var panels: [UUID: AnyPanel] = [:]

    // File tree
    let fileTreeModel = FileTreeModel()

    // MARK: - Init

    init(name: String, color: NSColor = .systemBlue, rootPath: String? = nil) {
        self.name = name
        self.color = color
        self.rootPath = rootPath
        if let rootPath { fileTreeModel.setRoot(rootPath) }
    }

    // MARK: - Panel CRUD

    @discardableResult
    func createTerminal() -> UUID {
        // TerminalPanel is a struct — it doesn't conform to Panel, so we
        // manage it separately and create a TerminalView directly.
        let panelId = UUID()
        let origin = findFreePosition(for: .terminal)
        let size = CanvasLayoutEngine.defaultSize(for: .terminal)
        canvasState.addNode(panelId: panelId, at: origin, size: size)
        return panelId
    }

    @discardableResult
    func createBrowser(url: URL? = nil) -> UUID {
        let panel = BrowserPanel(url: url)
        panels[panel.id] = AnyPanel(panel)
        let origin = findFreePosition(for: .browser)
        let size = CanvasLayoutEngine.defaultSize(for: .browser)
        canvasState.addNode(panelId: panel.id, at: origin, size: size)
        return panel.id
    }

    @discardableResult
    func createEditor(filePath: String? = nil) -> UUID {
        let panel = EditorPanel(filePath: filePath)
        panels[panel.id] = AnyPanel(panel)
        let origin = findFreePosition(for: .editor)
        let size = CanvasLayoutEngine.defaultSize(for: .editor)
        canvasState.addNode(panelId: panel.id, at: origin, size: size)
        return panel.id
    }

    func closePanel(_ panelId: UUID) {
        panels.removeValue(forKey: panelId)
        if let nodeId = canvasState.nodeForPanel(panelId) {
            canvasState.removeNode(nodeId)
        }
    }

    // MARK: - Private helpers

    private func findFreePosition(for type: PanelType) -> CGPoint {
        let existingRects = canvasState.nodes.values.map {
            CGRect(origin: $0.origin, size: $0.size)
        }
        let defaultSize = CanvasLayoutEngine.defaultSize(for: type)
        if let focusedId = canvasState.focusedNodeId,
           let focused = canvasState.nodes[focusedId] {
            return CanvasLayoutEngine.findFreePosition(
                near: CGRect(origin: focused.origin, size: focused.size),
                existingRects: existingRects,
                defaultSize: defaultSize
            )
        }
        let near = existingRects.last ?? CGRect(origin: CGPoint(x: 100, y: 100), size: defaultSize)
        return CanvasLayoutEngine.findFreePosition(
            near: near,
            existingRects: existingRects,
            defaultSize: defaultSize
        )
    }
}
