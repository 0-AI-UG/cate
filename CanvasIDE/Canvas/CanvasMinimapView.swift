import SwiftUI

// MARK: - MinimapNodeInfo

struct MinimapNodeInfo: Identifiable {
    let id: UUID
    let origin: CGPoint   // canvas coordinates
    let size: CGSize      // canvas coordinates
    let panelType: PanelType
}

// MARK: - CanvasMinimapView

struct CanvasMinimapView: View {

    let nodes: [MinimapNodeInfo]
    let viewportOrigin: CGPoint  // canvas coords of current viewport top-left
    let viewportSize: CGSize     // canvas coords of visible area
    let canvasBounds: CGRect     // bounding rect of all nodes
    var onJump: ((CGPoint) -> Void)?

    // Fixed minimap display dimensions
    private let minimapWidth: CGFloat = 150
    private let minimapHeight: CGFloat = 100
    private let padding: CGFloat = 6

    // The full rect we need to represent: union of canvasBounds and viewport
    private var totalBounds: CGRect {
        let viewportRect = CGRect(origin: viewportOrigin, size: viewportSize)
        guard !canvasBounds.isNull && !canvasBounds.isEmpty else { return viewportRect }
        return canvasBounds.union(viewportRect)
    }

    // Scale factors mapping canvas coords → minimap display coords
    private var scaleX: CGFloat {
        let usable = minimapWidth - padding * 2
        guard totalBounds.width > 0 else { return 1 }
        return usable / totalBounds.width
    }

    private var scaleY: CGFloat {
        let usable = minimapHeight - padding * 2
        guard totalBounds.height > 0 else { return 1 }
        return usable / totalBounds.height
    }

    // Uniform scale to preserve aspect ratio
    private var scale: CGFloat { min(scaleX, scaleY) }

    // Offset so that totalBounds.origin maps to (padding, padding) in minimap space,
    // centered horizontally/vertically when one axis has slack.
    private var offsetX: CGFloat {
        let usable = minimapWidth - padding * 2
        let scaled = totalBounds.width * scale
        return padding + (usable - scaled) / 2 - totalBounds.minX * scale
    }

    private var offsetY: CGFloat {
        let usable = minimapHeight - padding * 2
        let scaled = totalBounds.height * scale
        return padding + (usable - scaled) / 2 - totalBounds.minY * scale
    }

    // MARK: Coordinate helpers

    private func minimapPoint(from canvasPoint: CGPoint) -> CGPoint {
        CGPoint(
            x: canvasPoint.x * scale + offsetX,
            y: canvasPoint.y * scale + offsetY
        )
    }

    private func minimapRect(origin: CGPoint, size: CGSize) -> CGRect {
        let topLeft = minimapPoint(from: origin)
        return CGRect(
            x: topLeft.x,
            y: topLeft.y,
            width: max(size.width * scale, 2),
            height: max(size.height * scale, 2)
        )
    }

    private func canvasPoint(from minimapPoint: CGPoint) -> CGPoint {
        CGPoint(
            x: (minimapPoint.x - offsetX) / scale,
            y: (minimapPoint.y - offsetY) / scale
        )
    }

    // MARK: Node color

    private func color(for type: PanelType) -> Color {
        switch type {
        case .terminal: return Color.green.opacity(0.7)
        case .browser:  return Color.blue.opacity(0.7)
        case .editor:   return Color.orange.opacity(0.7)
        }
    }

    // MARK: Body

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Background
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.black.opacity(0.6))

            // Node rects
            Canvas { context, _ in
                for node in nodes {
                    let rect = minimapRect(origin: node.origin, size: node.size)
                    let path = Path(roundedRect: rect, cornerRadius: 1.5)
                    context.fill(path, with: .color(color(for: node.panelType)))
                }

                // Viewport frame
                let vpRect = minimapRect(origin: viewportOrigin, size: viewportSize)
                let vpPath = Path(vpRect)
                context.stroke(vpPath, with: .color(.white.opacity(0.5)), lineWidth: 1)
            }
            .frame(width: minimapWidth, height: minimapHeight)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .frame(width: minimapWidth, height: minimapHeight)
        .contentShape(Rectangle())
        .onTapGesture { location in
            let canvas = canvasPoint(from: location)
            onJump?(canvas)
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview {
    let nodes: [MinimapNodeInfo] = [
        MinimapNodeInfo(id: UUID(), origin: CGPoint(x: 100, y: 80),  size: CGSize(width: 320, height: 200), panelType: .editor),
        MinimapNodeInfo(id: UUID(), origin: CGPoint(x: 500, y: 50),  size: CGSize(width: 280, height: 160), panelType: .terminal),
        MinimapNodeInfo(id: UUID(), origin: CGPoint(x: 300, y: 350), size: CGSize(width: 300, height: 220), panelType: .browser),
    ]
    let allRects = nodes.map { CGRect(origin: $0.origin, size: $0.size) }
    let bounds = allRects.dropFirst().reduce(allRects[0]) { $0.union($1) }

    CanvasMinimapView(
        nodes: nodes,
        viewportOrigin: CGPoint(x: 80, y: 40),
        viewportSize: CGSize(width: 600, height: 400),
        canvasBounds: bounds,
        onJump: { point in print("Jump to \(point)") }
    )
    .padding()
    .background(Color.gray.opacity(0.2))
}
#endif
