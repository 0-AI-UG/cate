// A web view of a workspace, in the workspace's data store. Before a frame
// loads a loopback URL, `route` forwards its port to the runtime's machine
// (LoopbackPorts). The controller owns the web view so it outlives SwiftUI
// updates; `WebPage` puts it on screen.

import SwiftUI
import WebKit

@MainActor
class WebPageController: NSObject {
    let webView: WKWebView
    /// Forwards a loopback URL's port before a frame loads it.
    let route: (URL?) async -> Void

    init(store: WKWebsiteDataStore, route: @escaping (URL?) async -> Void, configure: (WKWebViewConfiguration) -> Void = { _ in }) {
        self.route = route
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        config.allowsInlineMediaPlayback = true
        configure(config)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()
    }
}

struct WebPage: UIViewRepresentable {
    let controller: WebPageController

    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
