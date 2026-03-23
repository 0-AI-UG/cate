import AppKit
import Foundation

// MARK: - CanvasNodeTitleBar

final class CanvasNodeTitleBar: NSView {

    // MARK: Callbacks

    /// Called continuously while the user drags the title bar.
    /// The vector is the delta in view-coordinate points since the last event.
    var onDrag: ((CGVector) -> Void)?

    /// Called when the drag gesture ends.
    var onDragEnd: (() -> Void)?

    // MARK: Private state

    private let panelType: PanelType
    private let titleLabel: NSTextField
    private let iconView: NSImageView
    private let closeButton: NSButton
    private var trackingArea: NSTrackingArea?
    private var mouseDownLocation: NSPoint?
    private var isHovering: Bool = false {
        didSet { updateCloseButtonVisibility() }
    }

    // MARK: Constants

    private static let backgroundColor = NSColor(red: 0x25 / 255.0, green: 0x25 / 255.0, blue: 0x30 / 255.0, alpha: 1.0)
    private static let horizontalPadding: CGFloat = 8
    private static let iconSize: CGFloat = 14
    private static let closeButtonSize: CGFloat = 16
    private static let spacing: CGFloat = 6

    // MARK: Init

    init(panelType: PanelType, title: String) {
        self.panelType = panelType

        // Icon
        let symbolConfig = NSImage.SymbolConfiguration(pointSize: Self.iconSize, weight: .regular)
        let symbolImage = NSImage(systemSymbolName: panelType.sfSymbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(symbolConfig)
        iconView = NSImageView(image: symbolImage ?? NSImage())
        iconView.contentTintColor = NSColor(white: 1.0, alpha: 0.7)

        // Title label
        titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 12)
        titleLabel.textColor = NSColor(white: 1.0, alpha: 0.9)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // Close button
        let closeSymbolConfig = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
        let closeImage = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
            .withSymbolConfiguration(closeSymbolConfig)
        closeButton = NSButton(image: closeImage ?? NSImage(), target: nil, action: nil)
        closeButton.isBordered = false
        closeButton.wantsLayer = true
        closeButton.layer?.cornerRadius = Self.closeButtonSize / 2
        closeButton.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.15).cgColor
        closeButton.contentTintColor = NSColor(white: 1.0, alpha: 0.8)
        closeButton.alphaValue = 0

        super.init(frame: .zero)
        commonInit()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Setup

    private func commonInit() {
        wantsLayer = true
        layer?.backgroundColor = Self.backgroundColor.cgColor

        // Layout subviews with Auto Layout
        iconView.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        closeButton.translatesAutoresizingMaskIntoConstraints = false

        addSubview(iconView)
        addSubview(titleLabel)
        addSubview(closeButton)

        NSLayoutConstraint.activate([
            // Icon: left-aligned, vertically centred
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.horizontalPadding),
            iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: Self.iconSize),
            iconView.heightAnchor.constraint(equalToConstant: Self.iconSize),

            // Title: next to icon, stretches to fill
            titleLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: Self.spacing),
            titleLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -Self.spacing),

            // Close button: right-aligned, fixed size, vertically centred
            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.horizontalPadding),
            closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: Self.closeButtonSize),
            closeButton.heightAnchor.constraint(equalToConstant: Self.closeButtonSize),
        ])

        closeButton.target = self
        closeButton.action = #selector(closeButtonClicked)
    }

    // MARK: Flipped

    override var isFlipped: Bool { true }

    // MARK: Tracking area

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
    }

    // MARK: Close button visibility

    private func updateCloseButtonVisibility() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            self.closeButton.animator().alphaValue = isHovering ? 1.0 : 0.0
        }
    }

    // MARK: Close action

    @objc private func closeButtonClicked() {
        // Propagate up the responder chain — parent CanvasNode can intercept
        nextResponder?.tryToPerform(#selector(CanvasNodeTitleBar.closeButtonClicked), with: self)
    }

    // MARK: Mouse drag handling

    override func mouseDown(with event: NSEvent) {
        mouseDownLocation = event.locationInWindow

        if event.clickCount == 2 {
            handleDoubleClick()
        }
    }

    override func mouseDragged(with event: NSEvent) {
        let delta = CGVector(dx: event.deltaX, dy: event.deltaY)
        onDrag?(delta)
    }

    override func mouseUp(with event: NSEvent) {
        if mouseDownLocation != nil {
            onDragEnd?()
        }
        mouseDownLocation = nil
    }

    // MARK: Double-click

    private func handleDoubleClick() {
        // Future: toggle maximize
        print("[CanvasNodeTitleBar] Double-click — maximize toggle not yet implemented for \(panelType.rawValue)")
    }
}

// MARK: - PanelType SF Symbol mapping

private extension PanelType {
    var sfSymbol: String {
        switch self {
        case .terminal: return "terminal.fill"
        case .browser:  return "globe"
        case .editor:   return "doc.text"
        }
    }
}
