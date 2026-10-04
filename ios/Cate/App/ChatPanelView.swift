// A chat panel: the T3 page of the panel's conversation, loaded from the
// runtime's machine through loopback routing with the harness's session
// cookie. The core keeps the binding (`chat.*`): it says where the
// page may go, adopts a conversation the page starts, follows one another
// client moved the panel to (in place, with `script` events), and answers
// the page's `__cateHost` requests. The title menu switches the panel to
// another conversation of its checkout, starts one, or renames it.

import SwiftUI
import WebKit

struct ChatSnapshot: Decodable, Equatable {
    let phase: String
    let error: String?
    let loadId: Int
    let connected: Bool?
    let agentName: String?
    let checkout: String
    let threadId: String?
}

/// A conversation of the panel's checkout (`chat.conversations`).
struct ChatConversation: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
}

struct ChatPanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.colorScheme) private var colorScheme
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<ChatSnapshot>()
    @State private var page: ChatPageController?
    @State private var loadFailure: String?
    /// T3's background, behind the page where it does not reach (around
    /// the keyboard).
    @State private var background: Color?
    @State private var conversations: [ChatConversation] = []
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var failure: OpFailure?

    var body: some View {
        Group {
            if let snapshot = session.snapshot {
                if snapshot.phase == "error" {
                    ContentUnavailableView {
                        Label("T3 Code unavailable", systemImage: "bubble.left.and.exclamationmark.bubble.right")
                    } description: {
                        Text(snapshot.error ?? "")
                    } actions: {
                        Button("Retry") { Task { await session.send(["kind": "retry"]) } }
                    }
                } else if snapshot.phase == "ready", let page {
                    ZStack(alignment: .bottom) {
                        // T3 lays itself out in the safe area (env()), so
                        // the page fills the screen under the bars.
                        WebPage(controller: page)
                            // Under the bars, but above the keyboard: the
                            // page shrinks for it instead of scrolling.
                            .ignoresSafeArea(.container)
                        if snapshot.connected == false {
                            Label("T3 Code activity disconnected. Reconnecting", systemImage: "wifi.exclamationmark")
                                .font(.footnote)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(.regularMaterial, in: Capsule())
                                .padding(8)
                        }
                    }
                    .background { background?.ignoresSafeArea() }
                } else {
                    ProgressView("Starting T3 Code")
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarTitleMenu { conversationMenu }
        .alert("Rename Conversation", isPresented: $renaming) {
            TextField("Name", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { rename() }
                .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .alert(item: $failure) { Alert(title: Text($0.message)) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Restart T3 Code", systemImage: "arrow.clockwise") { Task { await session.send(["kind": "retry"]) } }
            }
        }
        // A new binding or a restarted harness is a fresh load.
        .task(id: session.snapshot.map { "\($0.phase):\($0.loadId)" }) { await load() }
        .task { await session.run(core, "chat.open", workspaceId: workspaceId, panelId: panel.id) }
        // The list as of the conversation shown (a new one the page started
        // joins it).
        .task(id: session.snapshot.map { "\($0.checkout):\($0.threadId ?? "")" }) { await loadConversations() }
    }

    @ViewBuilder
    private var conversationMenu: some View {
        let current = session.snapshot?.threadId
        Button("New Conversation", systemImage: "square.and.pencil") { select(nil) }
        if current != nil {
            Button("Rename…", systemImage: "pencil") {
                newTitle = conversations.first { $0.id == current }?.title ?? panel.title
                renaming = true
            }
        }
        if !conversations.isEmpty {
            Section("Conversations") {
                ForEach(conversations) { conversation in
                    Button { select(conversation) } label: {
                        if conversation.id == current {
                            Label(conversation.title, systemImage: "checkmark")
                        } else {
                            Text(conversation.title)
                        }
                    }
                }
            }
        }
    }

    private func loadConversations() async {
        guard session.snapshot != nil else { return }
        if let list = try? await session.call("chat.conversations", [:], as: [ChatConversation].self) {
            conversations = list
        }
    }

    private func select(_ conversation: ChatConversation?) {
        guard let snapshot = session.snapshot, conversation?.id != snapshot.threadId else { return }
        var op: [String: Any] = ["kind": "selectThread", "threadId": conversation?.id ?? NSNull(), "checkout": snapshot.checkout]
        if let conversation { op["title"] = conversation.title }
        Task { await session.send(op) }
    }

    private func rename() {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        Task {
            let reply = await session.send(["kind": "renameConversation", "title": title])
            if reply.ok {
                await loadConversations()
            } else {
                failure = OpFailure(message: reply.message ?? "Could not rename the conversation.")
            }
        }
    }

    private func load() async {
        guard let snapshot = session.snapshot, snapshot.phase == "ready" else { return }
        guard let chatPage = try? await session.call("chat.page", ["dark": colorScheme == .dark], as: ChatPage?.self) else { return }
        let controller = ChatPageController(page: chatPage, store: core.webDataStore(workspaceId), session: session) { [core, workspaceId] in
            await core.routeLoopback(workspaceId, $0)
        }
        await controller.installCookie()
        controller.start()
        controller.onBackground = { background = Color(uiColor: $0) }
        page = controller
    }
}

/// The page of one load.
@MainActor
final class ChatPageController: WebPageController, WKNavigationDelegate, WKScriptMessageHandler {
    private static let hostHandler = "cateChatHost"
    private static let backgroundHandler = "cateChatBackground"
    var onBackground: ((UIColor) -> Void)?
    private let chatPage: ChatPage
    private weak var session: PanelSession<ChatSnapshot>?
    private var observation: NSKeyValueObservation?
    private var offsetObservation: NSKeyValueObservation?

    init(page: ChatPage, store: WKWebsiteDataStore, session: PanelSession<ChatSnapshot>, route: @escaping (URL?) async -> Void) {
        self.chatPage = page
        self.session = session
        let style = "const style = document.createElement('style'); style.textContent = \(Self.jsString(page.css)); document.head.appendChild(style);"
        // The page logs its bridge requests; WebKit has no console event, so
        // they are forwarded to the app.
        let forward = """
        (() => {
          const info = console.info.bind(console);
          console.info = (...args) => {
            if (typeof args[0] === 'string' && args[0].startsWith('cate-chat-host:')) {
              window.webkit.messageHandlers.\(Self.hostHandler).postMessage(args[0]);
            }
            info(...args);
          };
        })();
        """
        super.init(store: store, route: route) { config in
            let scripts = config.userContentController
            scripts.addUserScript(WKUserScript(source: forward, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            scripts.addUserScript(WKUserScript(source: style + "\n" + page.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            scripts.addUserScript(WKUserScript(source: Self.native, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: Self.hostHandler)
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: Self.backgroundHandler)
        // The page pads itself by env(safe-area-inset-*); an adjusted scroll
        // view would inset it twice.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        // The page is an app, not a document: it never zooms or scrolls as a
        // whole (its own scrollers still do), and links have no previews.
        let scrollView = webView.scrollView
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        scrollView.bouncesZoom = false
        scrollView.bounces = false
        scrollView.isScrollEnabled = false
        scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsLinkPreview = false
        webView.hideKeyboardAccessoryBar()
        webView.backgroundColor = .clear
        // Nothing scrolls under the bar (the page pads itself below it), so
        // the bar's edge fade would only darken the top of the page.
        if #available(iOS 26, *) {
            webView.scrollView.topEdgeEffect.isHidden = true
        }
        webView.navigationDelegate = self
        // WebKit scrolls the page to reveal a focused field; it already
        // fits the screen, so that would only push it under the bar.
        offsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { view, _ in
            MainActor.assumeIsolated {
                if view.contentOffset != .zero { view.contentOffset = .zero }
            }
        }
        // pushState moves the URL without a navigation.
        observation = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                guard let url = view.url?.absoluteString else { return }
                self?.navigated(url)
            }
        }
        session.onEvent = { [weak self] event in
            if case .script(let script) = event { self?.webView.evaluateJavaScript(script) }
        }
    }

    func installCookie() async {
        guard let origin = URL(string: chatPage.origin), let host = origin.host() else { return }
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: chatPage.cookie.name, .value: chatPage.cookie.value, .domain: host, .path: "/",
        ]
        guard let cookie = HTTPCookie(properties: properties) else { return }
        await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
    }

    func start() { load(chatPage.url) }

    private func load(_ url: String) {
        guard let target = URL(string: url) else { return }
        webView.load(URLRequest(url: target))
    }

    private func navigated(_ url: String) {
        Task { _ = try? await session?.call("chat.navigation", ["url": url, "committed": true], as: NavigationDecision.self) }
    }

    /// Makes the page behave like a native view: a fixed scale (no pinch,
    /// double-tap or focus zoom), no tap highlight or long-press callout,
    /// no selecting the controls' labels, and a page exactly the view's size.
    private static let native = """
    (() => {
      let viewport = document.querySelector('meta[name="viewport"]');
      if (!viewport) {
        viewport = document.createElement('meta');
        viewport.name = 'viewport';
        document.head.appendChild(viewport);
      }
      viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
      const style = document.createElement('style');
      style.textContent = `
        html { -webkit-text-size-adjust: 100%; touch-action: pan-x pan-y; }
        /* T3 grows the page by the top inset (meant for the status bar
         * alone); here that pushes the composer below the screen. The page
         * fills the view exactly, and the strip under the bar takes the
         * chat's color, not T3's chrome color. */
        html, body { min-height: 0 !important; height: 100% !important; background-color: var(--background) !important; }
        /* #root pads itself by the top inset, but its screens are a full
         * viewport tall, so the bottom (the composer) was clipped. */
        #root .h-dvh, #root .h-svh, #root .h-screen { height: calc(100dvh - env(safe-area-inset-top)) !important; }
        * { -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
        button, [role="button"], [role="menuitem"], [role="tab"], a, label, svg { -webkit-user-select: none; user-select: none; }
      `;
      document.head.appendChild(style);
      // The page's background as sRGB (a canvas resolves any CSS color),
      // again whenever the theme changes.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      let reported = '';
      const report = () => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(document.body).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const rgb = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        if (rgb.join() === reported) return;
        reported = rgb.join();
        window.webkit.messageHandlers.\(backgroundHandler).postMessage(rgb);
      };
      report();
      new MutationObserver(report).observe(document.documentElement, { attributes: true });
    })();
    """

    private static func jsString(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard action.targetFrame?.isMainFrame != false, let url = action.request.url?.absoluteString else {
            await route(action.request.url)
            return .allow
        }
        guard let decision = try? await session?.call("chat.navigation", ["url": url, "committed": false], as: NavigationDecision.self) else { return .cancel }
        if !decision.allow, let scheme = action.request.url?.scheme, scheme == "http" || scheme == "https", action.navigationType == .linkActivated,
           let link = action.request.url, URL(string: chatPage.origin)?.host() != link.host() {
            // A link out of the page opens in the system browser.
            await UIApplication.shared.open(link)
        }
        guard decision.allow else { return .cancel }
        await route(action.request.url)
        return .allow
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        Task { await session?.send(["kind": "loadFailed", "loadId": chatPage.loadId, "message": error.localizedDescription]) }
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == Self.backgroundHandler {
            guard let rgb = message.body as? [Double], rgb.count == 3 else { return }
            onBackground?(UIColor(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255, alpha: 1))
            return
        }
        guard let text = message.body as? String else { return }
        Task {
            guard let reply = try? await session?.call("chat.hostMessage", ["message": text], as: String?.self) else { return }
            _ = try? await webView.evaluateJavaScript(reply)
        }
    }
}

/// Script message handlers are retained by the content controller.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

private extension WKWebView {
    /// Hides the bar WebKit puts over the keyboard for a form field
    /// (previous, next, done). WebKit has no API for it: the content view
    /// becomes a subclass whose accessory is nil.
    func hideKeyboardAccessoryBar() {
        guard let content = scrollView.subviews.first(where: { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }) else { return }
        let base: AnyClass = type(of: content)
        let name = NSStringFromClass(base) + "_CateNoAccessory"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let created = objc_allocateClassPair(base, name, 0) {
            let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
            for selector in [#selector(getter: UIResponder.inputAccessoryView), #selector(getter: UIResponder.inputAccessoryViewController)] {
                class_addMethod(created, selector, imp_implementationWithBlock(none), "@@:")
            }
            objc_registerClassPair(created)
            subclass = created
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
