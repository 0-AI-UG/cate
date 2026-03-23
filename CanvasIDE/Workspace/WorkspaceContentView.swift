import SwiftUI
import AppKit
import Combine

// MARK: - WorkspaceContentView

struct WorkspaceContentView: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        ZStack {
            // Canvas (NSViewRepresentable wrapping CanvasView + CanvasNode subviews)
            CanvasViewRepresentable(workspace: workspace)
                .ignoresSafeArea()

            // Minimap overlay top-right
            if workspace.canvasState.minimapVisible {
                VStack {
                    HStack {
                        Spacer()
                        CanvasMinimapView(
                            nodes: minimapNodes,
                            viewportOrigin: viewportCanvasOrigin,
                            viewportSize: viewportCanvasSize,
                            canvasBounds: canvasBounds,
                            onJump: { canvasPoint in
                                workspace.canvasState.viewportOffset = CGPoint(
                                    x: -canvasPoint.x * workspace.canvasState.zoomLevel,
                                    y: -canvasPoint.y * workspace.canvasState.zoomLevel
                                )
                            }
                        )
                    }
                    .padding(12)
                    Spacer()
                }
            }

            // Toolbar overlay at bottom-center
            VStack {
                Spacer()
                HStack {
                    CanvasToolbar(
                        zoomLevel: workspace.canvasState.zoomLevel,
                        onNewTerminal: { workspace.createTerminal() },
                        onNewBrowser:  { workspace.createBrowser() },
                        onNewEditor:   { workspace.createEditor() },
                        onZoomIn:  { workspace.canvasState.setZoom(workspace.canvasState.zoomLevel + 0.1) },
                        onZoomOut: { workspace.canvasState.setZoom(workspace.canvasState.zoomLevel - 0.1) }
                    )
                }
                .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Minimap helpers

    private var minimapNodes: [MinimapNodeInfo] {
        workspace.canvasState.nodes.values.map { node in
            MinimapNodeInfo(
                id: node.panelId,
                origin: node.origin,
                size: node.size,
                panelType: panelType(for: node.panelId)
            )
        }
    }

    private func panelType(for panelId: UUID) -> PanelType {
        if let panel = workspace.panels[panelId] {
            return panel.panelType
        }
        // Nodes not in panels dict are terminals (TerminalPanel is a struct, not in panels)
        return .terminal
    }

    private var viewportCanvasOrigin: CGPoint {
        let offset = workspace.canvasState.viewportOffset
        let zoom = workspace.canvasState.zoomLevel
        guard zoom > 0 else { return .zero }
        return CGPoint(x: -offset.x / zoom, y: -offset.y / zoom)
    }

    // We don't have direct access to view size here; use a reasonable default.
    // CanvasViewRepresentable updates this via a binding if needed in the future.
    private var viewportCanvasSize: CGSize {
        let zoom = workspace.canvasState.zoomLevel
        guard zoom > 0 else { return CGSize(width: 1280, height: 800) }
        return CGSize(width: 1280 / zoom, height: 800 / zoom)
    }

    private var canvasBounds: CGRect {
        let rects = workspace.canvasState.nodes.values.map {
            CGRect(origin: $0.origin, size: $0.size)
        }
        guard let first = rects.first else { return .zero }
        return rects.dropFirst().reduce(first) { $0.union($1) }
    }
}

// MARK: - CanvasViewRepresentable

struct CanvasViewRepresentable: NSViewRepresentable {
    @ObservedObject var workspace: Workspace

    func makeNSView(context: Context) -> CanvasView {
        let canvasView = CanvasView(canvasState: workspace.canvasState)
        context.coordinator.canvasView = canvasView
        context.coordinator.syncNodes(workspace: workspace, canvasView: canvasView)
        return canvasView
    }

    func updateNSView(_ canvasView: CanvasView, context: Context) {
        context.coordinator.syncNodes(workspace: workspace, canvasView: canvasView)
        canvasView.invalidateCanvas()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(workspace: workspace)
    }

    // MARK: - Coordinator

    @MainActor final class Coordinator: NSObject {
        private var workspace: Workspace
        weak var canvasView: CanvasView?

        // Track which nodeIds have already been added to the canvas
        private var addedNodeIds: Set<CanvasNodeID> = []

        // Drag guard: defer additions while a drag is in flight
        var isDragging: Bool = false
        private var pendingNodeIds: Set<CanvasNodeID> = []

        // Cancellables for observing CanvasState changes
        private var cancellables = Set<AnyCancellable>()

        init(workspace: Workspace) {
            self.workspace = workspace
            super.init()

            // Observe canvasState node changes to add/remove subviews
            workspace.canvasState.$nodes
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in
                    guard let self, let cv = self.canvasView else { return }
                    self.syncNodes(workspace: self.workspace, canvasView: cv)
                    cv.invalidateCanvas()
                }
                .store(in: &cancellables)

            // Focus sync: forward focusedNodeId changes to CanvasView
            workspace.canvasState.$focusedNodeId
                .receive(on: RunLoop.main)
                .sink { [weak self] focusedId in
                    self?.canvasView?.updateFocusState(focusedId: focusedId)
                }
                .store(in: &cancellables)
        }

        func syncNodes(workspace: Workspace, canvasView: CanvasView) {
            let currentIds = Set(workspace.canvasState.nodes.keys)

            // Remove views for nodes that no longer exist
            let removedIds = addedNodeIds.subtracting(currentIds)
            for nodeId in removedIds {
                canvasView.removeNodeView(for: nodeId)
                addedNodeIds.remove(nodeId)
                pendingNodeIds.remove(nodeId)
            }

            // Determine new nodes to add
            let newIds = currentIds.subtracting(addedNodeIds)

            // If dragging, defer new additions until drag ends
            if isDragging {
                pendingNodeIds.formUnion(newIds)
                return
            }

            // Include any previously deferred nodes
            let idsToAdd = newIds.union(pendingNodeIds)
            pendingNodeIds.removeAll()

            for nodeId in idsToAdd {
                guard let nodeState = workspace.canvasState.nodes[nodeId] else { continue }
                let panelId = nodeState.panelId

                // Determine panel type and title
                let type: PanelType
                let title: String
                if let anyPanel = workspace.panels[panelId] {
                    type = anyPanel.panelType
                    title = anyPanel.title
                } else {
                    type = .terminal
                    title = "Terminal"
                }

                // Build the CanvasNode wrapper
                let canvasNode = CanvasNode(nodeId: nodeId, panelType: type, title: title)

                // Build and embed the content view
                let contentView: NSView
                if let anyPanel = workspace.panels[panelId] {
                    contentView = anyPanel.makeContentView()
                } else {
                    // Terminal: create a TerminalView directly
                    contentView = TerminalView()
                }
                canvasNode.setContentView(contentView)

                // Wire up focus on click
                let click = NodeClickRecognizer(
                    target: self,
                    action: #selector(handleNodeClick(_:)),
                    nodeId: nodeId,
                    canvasState: workspace.canvasState
                )
                canvasNode.addGestureRecognizer(click)

                // Wire title bar drag → move node on canvas
                let capturedNodeId = nodeId
                let capturedState = workspace.canvasState
                canvasNode.titleBar.onDrag = { [weak self, weak capturedState, weak canvasView] delta in
                    self?.isDragging = true
                    guard let state = capturedState,
                          let current = state.nodes[capturedNodeId] else { return }
                    let zoom = state.zoomLevel > 0 ? state.zoomLevel : 1.0
                    let newOrigin = CGPoint(
                        x: current.origin.x + delta.dx / zoom,
                        y: current.origin.y + delta.dy / zoom
                    )
                    state.moveNode(capturedNodeId, to: newOrigin)
                    canvasView?.invalidateCanvas()
                }

                // Wire title bar drag end → flush pending nodes
                canvasNode.titleBar.onDragEnd = { [weak self, weak canvasView] in
                    guard let self, let cv = canvasView else { return }
                    self.isDragging = false
                    if !self.pendingNodeIds.isEmpty {
                        self.syncNodes(workspace: self.workspace, canvasView: cv)
                        cv.invalidateCanvas()
                    }
                }

                // Wire resize callback
                canvasNode.onResize = { [weak capturedState] newSize in
                    guard let state = capturedState else { return }
                    let minSize = CanvasLayoutEngine.minimumSize(for: type)
                    let clampedSize = CGSize(
                        width: max(newSize.width, minSize.width),
                        height: max(newSize.height, minSize.height)
                    )
                    state.resizeNode(capturedNodeId, to: clampedSize)
                }

                canvasView.addNodeView(canvasNode, for: nodeId)
                addedNodeIds.insert(nodeId)
            }
        }

        @objc private func handleNodeClick(_ recognizer: NodeClickRecognizer) {
            recognizer.canvasState.focusNode(recognizer.nodeId)
        }
    }
}

// MARK: - NodeClickRecognizer
// Lightweight gesture recognizer that passes nodeId + canvasState to the action.

private final class NodeClickRecognizer: NSClickGestureRecognizer {
    let nodeId: CanvasNodeID
    let canvasState: CanvasState

    init(target: AnyObject, action: Selector, nodeId: CanvasNodeID, canvasState: CanvasState) {
        self.nodeId = nodeId
        self.canvasState = canvasState
        super.init(target: target, action: action)
        self.numberOfClicksRequired = 1
    }

    required init?(coder: NSCoder) { fatalError("not supported") }
}
