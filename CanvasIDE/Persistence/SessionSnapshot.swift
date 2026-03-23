import Foundation

struct SessionSnapshot: Codable {
    let workspaceName: String
    let rootPath: String?
    let viewportOffset: CGPointCodable
    let zoomLevel: Double
    let nodes: [NodeSnapshot]

    struct NodeSnapshot: Codable {
        let panelId: String       // UUID string
        let panelType: String     // "terminal", "browser", "editor"
        let origin: CGPointCodable
        let size: CGSizeCodable
        let title: String
        // Browser only
        let url: String?
        // Editor only
        let filePath: String?
    }

    struct CGPointCodable: Codable {
        let x: Double, y: Double
        init(_ point: CGPoint) { x = point.x; y = point.y }
        var cgPoint: CGPoint { CGPoint(x: x, y: y) }
    }

    struct CGSizeCodable: Codable {
        let width: Double, height: Double
        init(_ size: CGSize) { width = size.width; height = size.height }
        var cgSize: CGSize { CGSize(width: width, height: height) }
    }

    // MARK: - Snapshot creation

    @MainActor
    static func from(workspace: Workspace) -> SessionSnapshot {
        var nodeSnapshots: [NodeSnapshot] = []

        for node in workspace.canvasState.sortedNodesByCreationOrder() {
            let panelIdStr = node.panelId.uuidString

            if let anyPanel = workspace.panels[node.panelId] {
                // Browser or Editor panel
                let urlStr: String?
                let filePath: String?
                switch anyPanel.panelType {
                case .browser:
                    // Pull the URL from the AnyPanel-wrapped BrowserPanel via title heuristic;
                    // we don't have a direct URL accessor through AnyPanel, so store nil here.
                    // The concrete type is erased — restore will reopen to a blank browser.
                    urlStr = nil
                    filePath = nil
                case .editor:
                    urlStr = nil
                    // Similarly, filePath is only accessible on the concrete EditorPanel.
                    // We store nil; the editor restores as untitled.
                    filePath = nil
                case .terminal:
                    urlStr = nil
                    filePath = nil
                }

                nodeSnapshots.append(NodeSnapshot(
                    panelId: panelIdStr,
                    panelType: anyPanel.panelType.rawValue,
                    origin: CGPointCodable(node.origin),
                    size: CGSizeCodable(node.size),
                    title: anyPanel.title,
                    url: urlStr,
                    filePath: filePath
                ))
            } else {
                // Terminal (struct, not stored in panels dict)
                nodeSnapshots.append(NodeSnapshot(
                    panelId: panelIdStr,
                    panelType: PanelType.terminal.rawValue,
                    origin: CGPointCodable(node.origin),
                    size: CGSizeCodable(node.size),
                    title: "Terminal",
                    url: nil,
                    filePath: nil
                ))
            }
        }

        return SessionSnapshot(
            workspaceName: workspace.name,
            rootPath: workspace.rootPath,
            viewportOffset: CGPointCodable(workspace.canvasState.viewportOffset),
            zoomLevel: workspace.canvasState.zoomLevel,
            nodes: nodeSnapshots
        )
    }

    // MARK: - Restore

    @MainActor
    func restore(into workspace: Workspace) {
        // Restore viewport and zoom
        workspace.canvasState.viewportOffset = viewportOffset.cgPoint
        workspace.canvasState.setZoom(zoomLevel)

        // Restore workspace metadata
        workspace.name = workspaceName
        if let path = rootPath {
            workspace.rootPath = path
        }

        // Recreate panels at saved positions
        for node in nodes {
            guard let panelType = PanelType(rawValue: node.panelType) else { continue }
            let origin = node.origin.cgPoint
            let size = node.size.cgSize

            switch panelType {
            case .terminal:
                let panelId = workspace.createTerminal()
                // Move the freshly created node to the saved position/size
                if let nodeId = workspace.canvasState.nodeForPanel(panelId) {
                    workspace.canvasState.moveNode(nodeId, to: origin)
                    workspace.canvasState.resizeNode(nodeId, to: size)
                }
            case .browser:
                let url = node.url.flatMap { URL(string: $0) }
                let panelId = workspace.createBrowser(url: url)
                if let nodeId = workspace.canvasState.nodeForPanel(panelId) {
                    workspace.canvasState.moveNode(nodeId, to: origin)
                    workspace.canvasState.resizeNode(nodeId, to: size)
                }
            case .editor:
                let panelId = workspace.createEditor(filePath: node.filePath)
                if let nodeId = workspace.canvasState.nodeForPanel(panelId) {
                    workspace.canvasState.moveNode(nodeId, to: origin)
                    workspace.canvasState.resizeNode(nodeId, to: size)
                }
            }
        }
    }
}
