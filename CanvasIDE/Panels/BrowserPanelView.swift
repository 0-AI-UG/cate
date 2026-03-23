import AppKit
import WebKit

// MARK: - BrowserPanelView
//
// Composite NSView:  [address bar, 30px] / [WKWebView, fills remainder]
// The WKWebView is owned by BrowserPanel; we embed it here directly.

final class BrowserPanelView: NSView {

    // MARK: Constants

    private static let addressBarHeight: CGFloat = 30
    private static let barBackground = NSColor(white: 0.12, alpha: 1.0)
    private static let barBorderColor = NSColor(white: 1.0, alpha: 0.08)

    // MARK: Subviews

    private let addressBar: NSTextField
    private let goBackButton: NSButton
    private let goForwardButton: NSButton
    private let webView: WKWebView

    // MARK: Model

    private let panel: BrowserPanel

    // MARK: Init

    init(panel: BrowserPanel) {
        self.panel = panel
        self.webView = panel.contentWebView
        self.addressBar = NSTextField()
        self.goBackButton = NSButton()
        self.goForwardButton = NSButton()

        super.init(frame: .zero)
        setupViews()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Setup

    private func setupViews() {
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0x1E / 255.0,
                                         green: 0x1E / 255.0,
                                         blue: 0x24 / 255.0,
                                         alpha: 1.0).cgColor

        // ── Navigation bar container ──────────────────────────────────────

        let navBar = NSView()
        navBar.wantsLayer = true
        navBar.layer?.backgroundColor = Self.barBackground.cgColor
        navBar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(navBar)

        // Bottom border on nav bar
        let separator = NSView()
        separator.wantsLayer = true
        separator.layer?.backgroundColor = Self.barBorderColor.cgColor
        separator.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(separator)

        // ── Back / Forward buttons ────────────────────────────────────────

        configureNavButton(goBackButton,  title: "‹", action: #selector(goBack))
        configureNavButton(goForwardButton, title: "›", action: #selector(goForward))
        navBar.addSubview(goBackButton)
        navBar.addSubview(goForwardButton)

        // ── Address bar ───────────────────────────────────────────────────

        addressBar.isBezeled = false
        addressBar.bezelStyle = .roundedBezel
        addressBar.isBordered = true
        addressBar.focusRingType = .none
        addressBar.font = .systemFont(ofSize: 12)
        addressBar.textColor = .white
        addressBar.backgroundColor = NSColor(white: 0.18, alpha: 1.0)
        addressBar.drawsBackground = true
        addressBar.placeholderString = "Enter URL…"
        addressBar.delegate = self
        if let u = panel.url {
            addressBar.stringValue = u.absoluteString
        }
        addressBar.translatesAutoresizingMaskIntoConstraints = false
        navBar.addSubview(addressBar)

        // ── WebView ───────────────────────────────────────────────────────

        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)

        // ── Constraints ───────────────────────────────────────────────────

        NSLayoutConstraint.activate([
            // Nav bar: pinned to top
            navBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            navBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            navBar.topAnchor.constraint(equalTo: topAnchor),
            navBar.heightAnchor.constraint(equalToConstant: Self.addressBarHeight),

            // Separator at bottom of nav bar
            separator.leadingAnchor.constraint(equalTo: navBar.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: navBar.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: navBar.bottomAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1),

            // Back button
            goBackButton.leadingAnchor.constraint(equalTo: navBar.leadingAnchor, constant: 6),
            goBackButton.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            goBackButton.widthAnchor.constraint(equalToConstant: 22),

            // Forward button
            goForwardButton.leadingAnchor.constraint(equalTo: goBackButton.trailingAnchor, constant: 2),
            goForwardButton.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            goForwardButton.widthAnchor.constraint(equalToConstant: 22),

            // Address bar: between forward button and right edge
            addressBar.leadingAnchor.constraint(equalTo: goForwardButton.trailingAnchor, constant: 6),
            addressBar.trailingAnchor.constraint(equalTo: navBar.trailingAnchor, constant: -8),
            addressBar.centerYAnchor.constraint(equalTo: navBar.centerYAnchor),
            addressBar.heightAnchor.constraint(equalToConstant: 20),

            // WebView: fills below nav bar
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: navBar.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func configureNavButton(_ button: NSButton, title: String, action: Selector) {
        button.title = title
        button.font = .systemFont(ofSize: 16, weight: .medium)
        button.isBordered = false
        button.contentTintColor = NSColor(white: 0.7, alpha: 1.0)
        button.target = self
        button.action = action
        button.translatesAutoresizingMaskIntoConstraints = false
    }

    // MARK: Actions

    @objc private func goBack() {
        webView.goBack()
    }

    @objc private func goForward() {
        webView.goForward()
    }

    private func commitAddress() {
        let raw = addressBar.stringValue.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return }

        // Prepend scheme if missing
        let urlString = raw.hasPrefix("http://") || raw.hasPrefix("https://") ? raw : "https://\(raw)"
        if let url = URL(string: urlString) {
            panel.navigate(to: url)
        }
    }
}

// MARK: - NSTextFieldDelegate

extension BrowserPanelView: NSTextFieldDelegate {
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            commitAddress()
            return true
        }
        return false
    }
}
