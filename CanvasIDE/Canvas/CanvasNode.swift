import AppKit
import Foundation

// MARK: - ResizeHandle

/// A small 12×12 drag handle placed at the bottom-right corner of a CanvasNode.
/// It shows a resize cursor on hover and fires `onResize` with the new desired
/// total node size as the user drags.
final class ResizeHandle: NSView {

    // MARK: Callback

    /// Called continuously during a drag.  The argument is the *new* desired
    /// total size of the containing CanvasNode (current size + pointer delta,
    /// already divided by the canvas zoom scale supplied at drag-start).
    var onResize: ((CGSize) -> Void)?

    // MARK: Constants

    static let size: CGFloat = 12

    // MARK: Private state

    private var trackingArea: NSTrackingArea?
    private var dragStartLocation: NSPoint = .zero
    private var dragStartNodeSize: CGSize = .zero

    /// The canvas zoom scale at the moment the drag begins.  The coordinator
    /// sets this before the first `mouseDragged` fires.
    var zoomScaleAtDragStart: CGFloat = 1.0

    // MARK: Init

    init() {
        let side = ResizeHandle.size
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        isHidden = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Tracking area

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .cursorUpdate],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    private static let resizeCursor: NSCursor = {
        if #available(macOS 15.0, *) {
            return NSCursor.frameResize(position: .bottomRight, directions: [.inward, .outward])
        }
        return NSCursor.crosshair
    }()

    override func cursorUpdate(with event: NSEvent) {
        Self.resizeCursor.set()
    }

    override func mouseEntered(with event: NSEvent) {
        Self.resizeCursor.set()
    }

    override func mouseExited(with event: NSEvent) {
        NSCursor.arrow.set()
    }

    // MARK: Drag

    override func mouseDown(with event: NSEvent) {
        guard let node = enclosingCanvasNode else { return }
        dragStartLocation = convert(event.locationInWindow, from: nil)
        dragStartNodeSize = node.frame.size
        zoomScaleAtDragStart = node.enclosingZoomScale
    }

    override func mouseDragged(with event: NSEvent) {
        guard let node = enclosingCanvasNode else { return }
        let current = convert(event.locationInWindow, from: nil)
        let deltaX = (current.x - dragStartLocation.x) / zoomScaleAtDragStart
        let deltaY = (current.y - dragStartLocation.y) / zoomScaleAtDragStart

        // isFlipped on CanvasNode means positive-Y is downward, so dragging
        // the bottom-right corner right/down should increase both dimensions.
        let newWidth  = dragStartNodeSize.width  + deltaX
        let newHeight = dragStartNodeSize.height - deltaY   // window coords: up = +Y

        onResize?(CGSize(width: newWidth, height: newHeight))
    }

    override func mouseUp(with event: NSEvent) {
        // Nothing extra needed; coordinator has already updated state via onResize.
    }

    // MARK: Helpers

    private var enclosingCanvasNode: CanvasNode? {
        var view: NSView? = superview
        while let v = view {
            if let node = v as? CanvasNode { return node }
            view = v.superview
        }
        return nil
    }
}

// MARK: - NSView convenience

private extension NSView {
    /// Walks up the view hierarchy to find the effective zoom scale of the
    /// enclosing canvas scroll view, if any.  Falls back to 1.0.
    var enclosingZoomScale: CGFloat {
        var view: NSView? = superview
        while let v = view {
            if let scrollView = v as? NSScrollView {
                return scrollView.magnification
            }
            view = v.superview
        }
        return 1.0
    }
}

// MARK: - CanvasNode

// Note: PanelType is defined in CanvasLayoutEngine.swift (same module).

final class CanvasNode: NSView {

    // MARK: Properties

    let nodeId: CanvasNodeID
    let panelType: PanelType

    var isFocused: Bool = false {
        didSet {
            guard isFocused != oldValue else { return }
            updateAppearance()
            updateResizeHandleVisibility()
        }
    }

    /// Called during a resize drag.  Argument is the new desired total size.
    /// The caller (Coordinator) is responsible for clamping and state updates.
    var onResize: ((CGSize) -> Void)? {
        didSet { resizeHandle.onResize = onResize }
    }

    // MARK: Subviews

    let titleBar: CanvasNodeTitleBar
    private let contentContainer: NSView
    private let resizeHandle: ResizeHandle = ResizeHandle()
    /// Semi-transparent overlay shown on unfocused nodes to visually dim the content.
    private let dimOverlay: NSView = NSView()

    // MARK: Constants

    private static let titleBarHeight: CGFloat = 28
    private static let cornerRadius: CGFloat = 8
    private static let backgroundColor = NSColor(red: 0x1E / 255.0, green: 0x1E / 255.0, blue: 0x24 / 255.0, alpha: 1.0)
    private static let borderColorFocused = NSColor(red: 0x4A / 255.0, green: 0x9E / 255.0, blue: 0xFF / 255.0, alpha: 1.0)
    private static let borderColorDefault = NSColor(white: 1.0, alpha: 0.18)
    private static let borderWidth: CGFloat = 3

    // MARK: Hover tracking

    private var hoverTrackingArea: NSTrackingArea?
    private var isHovered: Bool = false {
        didSet {
            guard isHovered != oldValue else { return }
            updateResizeHandleVisibility()
        }
    }

    // MARK: Init

    init(nodeId: CanvasNodeID, panelType: PanelType, title: String? = nil) {
        self.nodeId = nodeId
        self.panelType = panelType
        self.titleBar = CanvasNodeTitleBar(panelType: panelType, title: title ?? panelType.defaultTitle)
        self.contentContainer = NSView()

        super.init(frame: .zero)
        commonInit()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Setup

    private func commonInit() {
        wantsLayer = true
        layer?.cornerRadius = Self.cornerRadius
        layer?.masksToBounds = false // allow shadow to show outside bounds

        // The border is drawn on self.layer, but CALayer borders are rendered
        // INSIDE the bounds, so a clip view filling 100% would cover them.
        // Inset the clip view by borderWidth so the border ring is visible.
        let inset = Self.borderWidth

        // Use a clip view for the actual masked content
        let clipView = NSView()
        clipView.wantsLayer = true
        clipView.layer?.cornerRadius = max(0, Self.cornerRadius - inset)
        clipView.layer?.masksToBounds = true

        // Background on self (shows as border background)
        layer?.backgroundColor = Self.backgroundColor.cgColor

        // Content clip layer
        clipView.layer?.backgroundColor = Self.backgroundColor.cgColor
        clipView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(clipView)
        NSLayoutConstraint.activate([
            clipView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
            clipView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset),
            clipView.topAnchor.constraint(equalTo: topAnchor, constant: inset),
            clipView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -inset),
        ])

        // Title bar
        titleBar.translatesAutoresizingMaskIntoConstraints = false
        clipView.addSubview(titleBar)
        NSLayoutConstraint.activate([
            titleBar.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            titleBar.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
            titleBar.topAnchor.constraint(equalTo: clipView.topAnchor),
            titleBar.heightAnchor.constraint(equalToConstant: Self.titleBarHeight),
        ])

        // Content container
        contentContainer.wantsLayer = true
        contentContainer.layer?.backgroundColor = Self.backgroundColor.cgColor
        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        clipView.addSubview(contentContainer)
        NSLayoutConstraint.activate([
            contentContainer.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
            contentContainer.topAnchor.constraint(equalTo: titleBar.bottomAnchor),
            contentContainer.bottomAnchor.constraint(equalTo: clipView.bottomAnchor),
        ])

        // Dim overlay — sits above content, below title bar, to indicate unfocused state
        dimOverlay.wantsLayer = true
        dimOverlay.layer?.backgroundColor = NSColor(white: 0, alpha: 0.15).cgColor
        dimOverlay.translatesAutoresizingMaskIntoConstraints = false
        dimOverlay.isHidden = false  // shown when unfocused; hidden when focused
        // Add to clipView so it is masked along with content
        clipView.addSubview(dimOverlay)
        NSLayoutConstraint.activate([
            dimOverlay.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            dimOverlay.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            dimOverlay.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            dimOverlay.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
        ])

        // Resize handle — added directly to self so it sits above the clip mask
        addSubview(resizeHandle)

        updateAppearance()
        updateResizeHandleVisibility()
    }

    // MARK: Flipped

    override var isFlipped: Bool { true }

    // MARK: Tracking areas

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = hoverTrackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hoverTrackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
    }

    // MARK: Appearance

    private func updateAppearance() {
        let borderColor = isFocused ? Self.borderColorFocused : Self.borderColorDefault
        layer?.borderColor = borderColor.cgColor
        layer?.borderWidth = Self.borderWidth

        // Dim overlay hides when focused, shows when unfocused
        dimOverlay.isHidden = isFocused

        if isFocused {
            layer?.shadowColor = NSColor(red: 0x4A / 255.0, green: 0x9E / 255.0, blue: 0xFF / 255.0, alpha: 0.35).cgColor
            layer?.shadowOpacity = 1.0
            layer?.shadowRadius = 12
            layer?.shadowOffset = CGSize(width: 0, height: -4)
        } else {
            layer?.shadowColor = NSColor.black.cgColor
            layer?.shadowOpacity = 0.4
            layer?.shadowRadius = 6
            layer?.shadowOffset = CGSize(width: 0, height: -2)
        }
    }

    private func updateResizeHandleVisibility() {
        resizeHandle.isHidden = !(isHovered || isFocused)
    }

    // MARK: Zoom-based content scaling

    /// Apply a scale transform to the content container's layer so terminal text
    /// and browser content visually scale with canvas zoom. Uses sublayerTransform
    /// which scales child layers without affecting Auto Layout or bounds.
    func updateContentZoom(_ zoomLevel: Double) {
        guard zoomLevel > 0 else { return }
        let containerFrame = contentContainer.frame
        guard containerFrame.width > 0, containerFrame.height > 0 else { return }

        // Always use the unzoomed canvas-coordinate size for terminal content.
        // Ghostty renders at this fixed size; AppKit's frame/bounds ratio handles
        // the visual scaling. This avoids Ghostty reflow lag during zoom.
        let unzoomedSize = CGSize(
            width: containerFrame.width / zoomLevel,
            height: containerFrame.height / zoomLevel
        )
        for subview in contentContainer.subviews {
            if let terminal = subview as? TerminalView {
                terminal.canvasSize = unzoomedSize
            }
        }
    }

    // MARK: Content

    /// Replaces the content of the node's content area with the provided view.
    func setContentView(_ view: NSView) {
        // Remove any existing content subviews
        contentContainer.subviews.forEach { $0.removeFromSuperview() }

        view.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            view.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            view.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
        ])
    }

    // MARK: Layout

    override func layout() {
        super.layout()
        // Position the resize handle at the bottom-right corner.
        // We do this in layout() because bounds may not be final until then.
        let side = ResizeHandle.size
        resizeHandle.frame = NSRect(
            x: bounds.maxX - side,
            y: bounds.maxY - side,
            width: side,
            height: side
        )
    }

    // MARK: Mouse passthrough

    /// When the node is not focused, only the title bar should consume clicks.
    /// Clicks in the content area bubble up to the canvas so the canvas can
    /// focus the node without swallowing the event inside a web/terminal view.
    override func hitTest(_ point: NSPoint) -> NSView? {
        // Always let the resize handle receive its own events.
        let handleHit = resizeHandle.hitTest(convert(point, to: resizeHandle))
        if handleHit != nil {
            return resizeHandle
        }

        guard !isFocused else {
            // Focused: normal hit-testing — content views handle their own events.
            return super.hitTest(point)
        }

        // Unfocused: only the title bar absorbs clicks.
        let titleBarFrame = convert(titleBar.frame, from: titleBar.superview)
        if titleBarFrame.contains(point) {
            return titleBar.hitTest(convert(point, to: titleBar))
        }

        // Return self for content-area clicks so the canvas coordinator gets
        // the event and can focus the node, but subviews are not activated.
        if bounds.contains(point) {
            return self
        }

        return nil
    }

    /// Called when an unfocused node's content area is clicked directly.
    /// We handle focus here so clicking the browser or any content immediately
    /// focuses the node without relying solely on the gesture recognizer.
    var onFocusRequest: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        if !isFocused {
            onFocusRequest?()
        }
        // Don't call super — let the gesture recognizer chain handle it.
    }

    /// When unfocused, forward scroll events to the superview (canvas) so the
    /// canvas can pan while the pointer is over a non-focused node.
    override func scrollWheel(with event: NSEvent) {
        if isFocused {
            super.scrollWheel(with: event)
        } else {
            superview?.scrollWheel(with: event)
        }
    }
}

// MARK: - PanelType helpers

private extension PanelType {
    var defaultTitle: String {
        switch self {
        case .terminal: return "Terminal"
        case .browser:  return "Browser"
        case .editor:   return "Editor"
        }
    }
}
