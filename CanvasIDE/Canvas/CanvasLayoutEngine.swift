import Foundation

/// Panel types supported by the canvas. Will be consolidated into Panels/Panel.swift in Phase 4.
enum PanelType: String, Codable {
    case terminal
    case browser
    case editor
}

enum CanvasLayoutEngine {

    // MARK: - Grid snapping

    static func snapToGrid(_ point: CGPoint, gridSize: CGFloat = 20) -> CGPoint {
        CGPoint(
            x: (point.x / gridSize).rounded() * gridSize,
            y: (point.y / gridSize).rounded() * gridSize
        )
    }

    // MARK: - Edge snapping

    static func snapToEdges(
        _ rect: CGRect,
        neighbors: [CGRect],
        threshold: CGFloat = 8
    ) -> CGPoint {
        var x = rect.origin.x
        var y = rect.origin.y
        var bestDX: CGFloat = .greatestFiniteMagnitude
        var bestDY: CGFloat = .greatestFiniteMagnitude

        for neighbor in neighbors {
            let xCandidates: [(CGFloat, CGFloat)] = [
                (abs(rect.minX - neighbor.minX), neighbor.minX),
                (abs(rect.minX - neighbor.maxX), neighbor.maxX),
                (abs(rect.maxX - neighbor.minX), neighbor.minX - rect.width),
                (abs(rect.maxX - neighbor.maxX), neighbor.maxX - rect.width),
            ]
            for (dist, snappedX) in xCandidates where dist < threshold && dist < bestDX {
                bestDX = dist
                x = snappedX
            }

            let yCandidates: [(CGFloat, CGFloat)] = [
                (abs(rect.minY - neighbor.minY), neighbor.minY),
                (abs(rect.minY - neighbor.maxY), neighbor.maxY),
                (abs(rect.maxY - neighbor.minY), neighbor.minY - rect.height),
                (abs(rect.maxY - neighbor.maxY), neighbor.maxY - rect.height),
            ]
            for (dist, snappedY) in yCandidates where dist < threshold && dist < bestDY {
                bestDY = dist
                y = snappedY
            }
        }

        return CGPoint(x: x, y: y)
    }

    // MARK: - Combined snap (grid + edge, best wins)

    static func snap(
        _ rect: CGRect,
        neighbors: [CGRect],
        gridSize: CGFloat = 20,
        edgeThreshold: CGFloat = 8
    ) -> CGPoint {
        let gridOrigin = snapToGrid(rect.origin, gridSize: gridSize)
        let gridRect = CGRect(origin: gridOrigin, size: rect.size)
        let edgeOrigin = snapToEdges(gridRect, neighbors: neighbors, threshold: edgeThreshold)

        let gridDist = hypot(gridOrigin.x - rect.origin.x, gridOrigin.y - rect.origin.y)
        let edgeDist = hypot(edgeOrigin.x - rect.origin.x, edgeOrigin.y - rect.origin.y)

        return edgeDist < gridDist ? edgeOrigin : gridOrigin
    }

    // MARK: - Free position search

    /// Find a non-overlapping position near `near` for a new node of `defaultSize`.
    static func findFreePosition(
        near: CGRect,
        existingRects: [CGRect],
        defaultSize: CGSize,
        gridSize: CGFloat = 20
    ) -> CGPoint {
        let gap: CGFloat = 20

        let rightCandidate = CGPoint(x: near.maxX + gap, y: near.minY)
        if !overlapsAny(CGRect(origin: rightCandidate, size: defaultSize), rects: existingRects) {
            return snapToGrid(rightCandidate, gridSize: gridSize)
        }

        let belowCandidate = CGPoint(x: near.minX, y: near.maxY + gap)
        if !overlapsAny(CGRect(origin: belowCandidate, size: defaultSize), rects: existingRects) {
            return snapToGrid(belowCandidate, gridSize: gridSize)
        }

        for i in 1...50 {
            let scanCandidate = CGPoint(x: near.maxX + gap + 100 * CGFloat(i), y: near.minY)
            if !overlapsAny(CGRect(origin: scanCandidate, size: defaultSize), rects: existingRects) {
                return snapToGrid(scanCandidate, gridSize: gridSize)
            }
        }

        return snapToGrid(CGPoint(x: near.maxX + gap, y: near.minY + gap), gridSize: gridSize)
    }

    // MARK: - Panel size helpers

    static func defaultSize(for panelType: PanelType) -> CGSize {
        switch panelType {
        case .terminal: return CGSize(width: 640, height: 400)
        case .browser:  return CGSize(width: 800, height: 600)
        case .editor:   return CGSize(width: 600, height: 500)
        }
    }

    static func minimumSize(for panelType: PanelType) -> CGSize {
        switch panelType {
        case .terminal: return CGSize(width: 320, height: 200)
        case .browser:  return CGSize(width: 400, height: 300)
        case .editor:   return CGSize(width: 300, height: 250)
        }
    }

    // MARK: - Private helpers

    private static func overlapsAny(_ rect: CGRect, rects: [CGRect]) -> Bool {
        rects.contains { $0.intersects(rect) }
    }
}
