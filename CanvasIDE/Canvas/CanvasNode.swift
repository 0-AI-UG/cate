import AppKit
import Foundation

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
        }
    }

    // MARK: Subviews

    let titleBar: CanvasNodeTitleBar
    private let contentContainer: NSView

    // MARK: Constants

    private static let titleBarHeight: CGFloat = 28
    private static let cornerRadius: CGFloat = 8
    private static let backgroundColor = NSColor(red: 0x1E / 255.0, green: 0x1E / 255.0, blue: 0x24 / 255.0, alpha: 1.0)
    private static let borderColorFocused = NSColor(red: 0x4A / 255.0, green: 0x9E / 255.0, blue: 0xFF / 255.0, alpha: 1.0)
    private static let borderColorDefault = NSColor(white: 1.0, alpha: 0.10)
    private static let borderWidth: CGFloat = 2

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

        // Use a clip view for the actual masked content
        let clipView = NSView()
        clipView.wantsLayer = true
        clipView.layer?.cornerRadius = Self.cornerRadius
        clipView.layer?.masksToBounds = true

        // Background layer
        layer?.backgroundColor = Self.backgroundColor.cgColor

        // Content clip layer
        clipView.layer?.backgroundColor = Self.backgroundColor.cgColor
        clipView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(clipView)
        NSLayoutConstraint.activate([
            clipView.leadingAnchor.constraint(equalTo: leadingAnchor),
            clipView.trailingAnchor.constraint(equalTo: trailingAnchor),
            clipView.topAnchor.constraint(equalTo: topAnchor),
            clipView.bottomAnchor.constraint(equalTo: bottomAnchor),
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

        // Border layer drawn on top of clip view (not clipped)
        wantsLayer = true

        updateAppearance()
    }

    // MARK: Flipped

    override var isFlipped: Bool { true }

    // MARK: Appearance

    private func updateAppearance() {
        let borderColor = isFocused ? Self.borderColorFocused : Self.borderColorDefault
        layer?.borderColor = borderColor.cgColor
        layer?.borderWidth = Self.borderWidth

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
        // Auto layout handles subview positioning; this override is
        // available for any manual adjustments needed in the future.
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
