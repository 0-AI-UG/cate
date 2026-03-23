import AppKit
import Foundation

struct CanvasNodeID: Hashable, Codable, Sendable {
    let id: UUID
    init() { self.id = UUID() }
    init(id: UUID) { self.id = id }
}

enum LODState: String, Codable {
    case live
    case placeholder
}

enum CanvasNavigationDirection {
    case left, right, up, down
}

struct CanvasNodeState {
    let id: CanvasNodeID
    let panelId: UUID
    var origin: CGPoint
    var size: CGSize
    var zOrder: Int
    var lodState: LODState
    let creationIndex: Int
}

@MainActor
final class CanvasState: ObservableObject {
    static let minZoom: Double = 0.3
    static let maxZoom: Double = 3.0

    @Published private(set) var nodes: [CanvasNodeID: CanvasNodeState] = [:]
    @Published var viewportOffset: CGPoint = .zero
    @Published var zoomLevel: Double = 1.0
    @Published var focusedNodeId: CanvasNodeID?
    @Published var isInteractive: Bool = true
    @Published var minimapVisible: Bool = true

    private var nextCreationIndex: Int = 0
    private var nextZOrder: Int = 0

    @discardableResult
    func addNode(panelId: UUID, at origin: CGPoint, size: CGSize) -> CanvasNodeID {
        let nodeId = CanvasNodeID()
        let lod: LODState = zoomLevel >= 0.2 ? .live : .placeholder
        let node = CanvasNodeState(
            id: nodeId,
            panelId: panelId,
            origin: origin,
            size: size,
            zOrder: nextZOrder,
            lodState: lod,
            creationIndex: nextCreationIndex
        )
        nextZOrder += 1
        nextCreationIndex += 1
        nodes[nodeId] = node
        return nodeId
    }

    func removeNode(_ id: CanvasNodeID) {
        nodes.removeValue(forKey: id)
        if focusedNodeId == id { focusedNodeId = nil }
    }

    func moveNode(_ id: CanvasNodeID, to origin: CGPoint) {
        nodes[id]?.origin = origin
    }

    func resizeNode(_ id: CanvasNodeID, to size: CGSize) {
        nodes[id]?.size = size
    }

    func focusNode(_ id: CanvasNodeID) {
        guard nodes[id] != nil else { return }
        nodes[id]?.zOrder = nextZOrder
        nextZOrder += 1
        focusedNodeId = id
    }

    func setZoom(_ level: Double) {
        zoomLevel = min(max(level, Self.minZoom), Self.maxZoom)
        for key in nodes.keys {
            nodes[key]?.lodState = zoomLevel >= 0.2 ? .live : .placeholder
        }
    }

    func nodeForPanel(_ panelId: UUID) -> CanvasNodeID? {
        nodes.values.first(where: { $0.panelId == panelId })?.id
    }

    func sortedNodesByCreationOrder() -> [CanvasNodeState] {
        nodes.values.sorted { $0.creationIndex < $1.creationIndex }
    }

    func nextNode(after id: CanvasNodeID) -> CanvasNodeID? {
        let sorted = sortedNodesByCreationOrder()
        guard let index = sorted.firstIndex(where: { $0.id == id }) else { return nil }
        return sorted[(index + 1) % sorted.count].id
    }

    func previousNode(before id: CanvasNodeID) -> CanvasNodeID? {
        let sorted = sortedNodesByCreationOrder()
        guard let index = sorted.firstIndex(where: { $0.id == id }) else { return nil }
        return sorted[(index - 1 + sorted.count) % sorted.count].id
    }

    func canvasToView(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: point.x * zoomLevel + viewportOffset.x,
            y: point.y * zoomLevel + viewportOffset.y
        )
    }

    func viewToCanvas(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: (point.x - viewportOffset.x) / zoomLevel,
            y: (point.y - viewportOffset.y) / zoomLevel
        )
    }

    func viewFrame(for nodeId: CanvasNodeID) -> CGRect? {
        guard let node = nodes[nodeId] else { return nil }
        let viewOrigin = canvasToView(node.origin)
        return CGRect(
            x: viewOrigin.x,
            y: viewOrigin.y,
            width: node.size.width * zoomLevel,
            height: node.size.height * zoomLevel
        )
    }
}
