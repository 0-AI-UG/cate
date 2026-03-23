import AppKit
import Foundation

/// The infinite canvas NSView. Coordinate system: isFlipped = true (top-left origin).
/// Canvas logical coords are multiplied by zoomLevel and offset by viewportOffset to get view coords.
final class CanvasView: NSView {

    // MARK: - Properties

    let canvasState: CanvasState

    /// Maps CanvasNodeID → the hosted NSView for that node.
    private var nodeViews: [CanvasNodeID: NSView] = [:]

    // Track right-click drag for panning
    private var lastRightClickDragLocation: CGPoint?

    // MARK: - Init

    init(canvasState: CanvasState) {
        self.canvasState = canvasState
        super.init(frame: .zero)
        commonInit()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported — use init(canvasState:)")
    }

    private func commonInit() {
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0.110, green: 0.110, blue: 0.129, alpha: 1.0).cgColor
        layer?.masksToBounds = true  // Clip grid dots and node shadows to canvas bounds

        // Accept scroll/magnify/click events
        allowedTouchTypes = [.indirect]

        // Add magnify (pinch) gesture recognizer
        let magnify = NSMagnificationGestureRecognizer(
            target: self,
            action: #selector(handleMagnification(_:))
        )
        addGestureRecognizer(magnify)
    }

    // MARK: - Flipped coordinate system

    override var isFlipped: Bool { true }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawGrid(in: dirtyRect)
    }

    private func drawGrid(in dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        let gridSize: CGFloat = 20.0
        let dotRadius: CGFloat = 1.0
        let dotAlpha: CGFloat = 0.15

        context.setFillColor(NSColor.white.withAlphaComponent(dotAlpha).cgColor)

        // Convert dirtyRect bounds to canvas coords to determine which grid lines are visible
        let topLeft = canvasState.viewToCanvas(CGPoint(x: dirtyRect.minX, y: dirtyRect.minY))
        let bottomRight = canvasState.viewToCanvas(CGPoint(x: dirtyRect.maxX, y: dirtyRect.maxY))

        let startX = (floor(topLeft.x / gridSize) * gridSize)
        let startY = (floor(topLeft.y / gridSize) * gridSize)

        var canvasY = startY
        while canvasY <= bottomRight.y {
            var canvasX = startX
            while canvasX <= bottomRight.x {
                let viewPoint = canvasState.canvasToView(CGPoint(x: canvasX, y: canvasY))
                let dotRect = CGRect(
                    x: viewPoint.x - dotRadius,
                    y: viewPoint.y - dotRadius,
                    width: dotRadius * 2,
                    height: dotRadius * 2
                )
                context.fillEllipse(in: dotRect)
                canvasX += gridSize
            }
            canvasY += gridSize
        }
    }

    // MARK: - Layout

    override func layout() {
        super.layout()
        repositionNodeViews()
    }

    private func repositionNodeViews() {
        for (nodeId, nodeView) in nodeViews {
            if let frame = canvasState.viewFrame(for: nodeId) {
                nodeView.frame = frame
            }
        }
    }

    /// Call this whenever canvasState changes (zoom, pan) to refresh all node positions and redraw.
    func invalidateCanvas() {
        needsLayout = true
        needsDisplay = true
    }

    // MARK: - Node view management

    /// Add a hosted NSView for the given canvas node.
    func addNodeView(_ view: NSView, for nodeId: CanvasNodeID) {
        guard nodeViews[nodeId] == nil else { return }
        nodeViews[nodeId] = view
        addSubview(view)
        if let frame = canvasState.viewFrame(for: nodeId) {
            view.frame = frame
        }
    }

    /// Remove the hosted NSView for the given canvas node.
    func removeNodeView(for nodeId: CanvasNodeID) {
        guard let view = nodeViews.removeValue(forKey: nodeId) else { return }
        view.removeFromSuperview()
    }

    /// Returns the node ID at the given view-coordinate point, or nil if background was hit.
    func nodeId(at viewPoint: CGPoint) -> CanvasNodeID? {
        // Check in reverse zOrder (highest on top)
        let sorted = canvasState.nodes.values.sorted { $0.zOrder > $1.zOrder }
        for node in sorted {
            if let frame = canvasState.viewFrame(for: node.id), frame.contains(viewPoint) {
                return node.id
            }
        }
        return nil
    }

    // MARK: - Scroll (two-finger pan + Cmd+scroll zoom)

    override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            // Cmd + scroll = zoom around cursor
            let scrollDelta = event.scrollingDeltaY
            let zoomDelta = scrollDelta * 0.01
            let cursorInView = convert(event.locationInWindow, from: nil)
            zoomAround(point: cursorInView, by: zoomDelta)
        } else {
            // Two-finger scroll = pan
            let dx = event.scrollingDeltaX
            let dy = event.scrollingDeltaY
            canvasState.viewportOffset = CGPoint(
                x: canvasState.viewportOffset.x + dx,
                y: canvasState.viewportOffset.y + dy
            )
            invalidateCanvas()
        }
    }

    // MARK: - Pinch zoom

    @objc private func handleMagnification(_ gesture: NSMagnificationGestureRecognizer) {
        let cursorInView = gesture.location(in: self)
        let zoomDelta = gesture.magnification
        gesture.magnification = 0  // reset so deltas don't accumulate
        zoomAround(point: cursorInView, by: zoomDelta)
    }

    private func zoomAround(point viewPoint: CGPoint, by delta: CGFloat) {
        let oldZoom = canvasState.zoomLevel
        let newZoom = min(max(oldZoom + Double(delta), CanvasState.minZoom), CanvasState.maxZoom)
        guard newZoom != oldZoom else { return }

        // Keep viewPoint fixed in canvas space:
        // viewPoint = canvasPoint * oldZoom + oldOffset
        // viewPoint = canvasPoint * newZoom + newOffset
        // => newOffset = viewPoint - canvasPoint * newZoom
        //              = viewPoint - (viewPoint - oldOffset) / oldZoom * newZoom
        let canvasPoint = canvasState.viewToCanvas(viewPoint)
        canvasState.setZoom(newZoom)
        canvasState.viewportOffset = CGPoint(
            x: viewPoint.x - canvasPoint.x * newZoom,
            y: viewPoint.y - canvasPoint.y * newZoom
        )
        invalidateCanvas()
    }

    // MARK: - Right-click drag (pan)

    override func rightMouseDown(with event: NSEvent) {
        lastRightClickDragLocation = convert(event.locationInWindow, from: nil)
    }

    override func rightMouseDragged(with event: NSEvent) {
        let current = convert(event.locationInWindow, from: nil)
        guard let last = lastRightClickDragLocation else {
            lastRightClickDragLocation = current
            return
        }
        let dx = current.x - last.x
        let dy = current.y - last.y
        canvasState.viewportOffset = CGPoint(
            x: canvasState.viewportOffset.x + dx,
            y: canvasState.viewportOffset.y + dy
        )
        lastRightClickDragLocation = current
        invalidateCanvas()
    }

    override func rightMouseUp(with event: NSEvent) {
        lastRightClickDragLocation = nil
    }

    // MARK: - Focus sync

    /// Update the isFocused state on all hosted CanvasNode views.
    func updateFocusState(focusedId: CanvasNodeID?) {
        for (nodeId, view) in nodeViews {
            if let canvasNode = view as? CanvasNode {
                canvasNode.isFocused = (nodeId == focusedId)
            }
        }
    }

    // MARK: - Accept first responder for key events

    override var acceptsFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool { true }
}
