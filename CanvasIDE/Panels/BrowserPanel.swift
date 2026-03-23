import AppKit
import WebKit

// MARK: - BrowserPanel

final class BrowserPanel: NSObject, Panel {
    let id = UUID()
    let panelType: PanelType = .browser
    private(set) var title: String
    var isDirty: Bool = false

    private(set) var url: URL?

    private lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()
        // Note: Uses WebKit (not Chromium). Chrome cookie/password sharing is not feasible due to encrypted storage.
        config.websiteDataStore = WKWebsiteDataStore.default()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        return wv
    }()

    init(url: URL? = nil) {
        self.title = "Browser"
        self.url = url ?? URL(string: "https://google.com")
        super.init()
        if let u = self.url {
            webView.load(URLRequest(url: u))
        }
    }

    func makeContentView() -> NSView {
        BrowserPanelView(panel: self)
    }

    func focus() {
        webView.window?.makeFirstResponder(webView)
    }

    func unfocus() {}

    func navigate(to url: URL) {
        self.url = url
        webView.load(URLRequest(url: url))
    }

    // Internal accessor so BrowserPanelView can embed the WKWebView directly.
    var contentWebView: WKWebView { webView }
}

// MARK: - WKNavigationDelegate

extension BrowserPanel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        title = webView.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Browser"
    }
}
