// A browser panel: the session's tabs, each a page this phone loads itself
// with loopback routing (so `localhost` is the runtime's machine). Pages
// follow the session (`load` events) and report what they do (`browser.*`);
// which tab this phone shows is its own, and it follows only its own
// selections and callers' ones.

import SwiftUI
import WebKit

struct BrowserSnapshot: Decodable, Equatable {
    struct Tab: Decodable, Equatable, Identifiable {
        let id: String
        let url: String
        let title: String
        let pinned: Bool
        let nav: Int
        let navSource: String?
    }
    let tabs: [Tab]
    let activeTabId: String
    let activeSource: String?
}

struct BrowserPanelView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<BrowserSnapshot>()
    @State private var pages = BrowserPages()
    @State private var address = ""
    @State private var showingTabs = false
    @FocusState private var editingAddress: Bool

    var body: some View {
        Group {
            if let snapshot = session.snapshot {
                // Like Safari: the page runs under the bars, the controls
                // float at the bottom and rise with the keyboard.
                ZStack(alignment: .bottom) {
                    if let tab = pages.shownTab(in: snapshot), let page = pages.page(for: tab) {
                        WebPage(controller: page)
                            .id(tab.id)
                            .ignoresSafeArea()
                    } else {
                        ContentUnavailableView("New tab", systemImage: "globe", description: Text("Type a URL or a search below."))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    chrome(snapshot)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pages.chromeHeight = $0 }
                }
                .sheet(isPresented: $showingTabs) { tabList }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .panelTitle(panel.title)
        .onChange(of: pages.url) { if !editingAddress { address = pages.url } }
        .onChange(of: editingAddress) { if !editingAddress { address = pages.url } }
        .onChange(of: session.snapshot) {
            if let snapshot = session.snapshot { pages.update(snapshot, clientId: core.state.clientId) }
            if !editingAddress { address = pages.url }
        }
        .task {
            pages.attach(session: session, store: core.webDataStore(workspaceId)) { [core, workspaceId] in await core.routeLoopback(workspaceId, $0) }
            await session.run(core, "browser.open", workspaceId: workspaceId, panelId: panel.id)
        }
    }

    /// Safari's floating controls: a back button, the address capsule and
    /// a menu, each a piece of glass over the page.
    private func chrome(_ snapshot: BrowserSnapshot) -> some View {
        VStack(spacing: 8) {
            if let error = pages.loadError, !editingAddress {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .lineLimit(2)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .glass(Capsule())
            }
            HStack(spacing: 10) {
                if !editingAddress {
                    Button { pages.shownPage?.webView.goBack() } label: {
                        Image(systemName: "chevron.backward").circleControl()
                    }
                    .disabled(!pages.canGoBack)
                    .glass(Circle())
                    .transition(.scale.combined(with: .opacity))
                }
                addressCapsule(snapshot)
                if editingAddress {
                    Button { editingAddress = false } label: {
                        Image(systemName: "xmark").circleControl()
                    }
                    .glass(Circle())
                    .transition(.scale.combined(with: .opacity))
                } else {
                    menu(snapshot)
                        .glass(Circle())
                        .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, editingAddress ? 8 : 0)
        .animation(.snappy(duration: 0.25), value: editingAddress)
    }

    private static let placeholder = "Search or enter website name"

    private func addressCapsule(_ snapshot: BrowserSnapshot) -> some View {
        ZStack {
            // The field stays in place to take focus; while not editing
            // the capsule shows the site, like Safari.
            TextField(Self.placeholder, text: $address)
                .keyboardType(.webSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($editingAddress)
                .opacity(editingAddress ? 1 : 0)
                // Like Safari: the whole address is selected to type over.
                .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
                    guard let field = note.object as? UITextField, field.placeholder == Self.placeholder else { return }
                    DispatchQueue.main.async { field.selectAll(nil) }
                }
                .onSubmit(submit)
                .padding(.horizontal, 18)
            if !editingAddress { siteLabel(snapshot) }
        }
        .frame(height: 50)
        .frame(maxWidth: .infinity)
        .contentShape(Capsule())
        .onTapGesture { editingAddress = true }
        .overlay(alignment: .bottom) { progressLine }
        .glass(Capsule())
    }

    private func siteLabel(_ snapshot: BrowserSnapshot) -> some View {
        HStack(spacing: 6) {
            Button { showingTabs = true } label: {
                Image(systemName: snapshot.tabs.count > 1 ? "square.on.square" : "square")
                    .overlay {
                        if snapshot.tabs.count > 1 {
                            Text("\(snapshot.tabs.count)")
                                .font(.system(size: 8, weight: .bold))
                                .offset(x: 2, y: 2)
                        }
                    }
                    .frame(width: 36, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Tabs")
            Spacer(minLength: 0)
            if let url = URL(string: pages.url), url.host() != nil {
                Text(Self.site(url)).lineLimit(1)
            } else {
                Text(Self.placeholder).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                if pages.loading { pages.shownPage?.webView.stopLoading() } else { pages.shownPage?.webView.reload() }
            } label: {
                Image(systemName: pages.loading ? "xmark" : "arrow.clockwise")
                    .frame(width: 36, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(pages.shownPage == nil)
            .accessibilityLabel(pages.loading ? "Stop" : "Reload")
        }
        .font(.body.weight(.medium))
        .padding(.horizontal, 8)
    }

    @ViewBuilder
    private var progressLine: some View {
        if pages.loading {
            GeometryReader { proxy in
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: proxy.size.width * max(pages.progress, 0.05), height: 2)
                    .animation(.linear(duration: 0.15), value: pages.progress)
            }
            .frame(height: 2)
            .padding(.horizontal, 22)
            .padding(.bottom, 1)
        }
    }

    private func menu(_ snapshot: BrowserSnapshot) -> some View {
        Menu {
            Button("Forward", systemImage: "chevron.forward") { pages.shownPage?.webView.goForward() }
                .disabled(!pages.canGoForward)
            if let url = URL(string: pages.url), url.host() != nil {
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
            }
            Divider()
            Button("New Tab", systemImage: "plus.square.on.square") { newTab() }
            Button("All Tabs", systemImage: "square.on.square") { showingTabs = true }
        } label: {
            Image(systemName: "ellipsis").circleControl()
        }
        .accessibilityLabel("More")
    }

    private var tabList: some View {
        NavigationStack {
            List {
                if let snapshot = session.snapshot {
                    ForEach(snapshot.tabs) { tab in
                        Button {
                            pages.show(tab.id)
                            Task { await session.send(["kind": "selectTab", "tabId": tab.id]) }
                            showingTabs = false
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: tab.pinned ? "pin.fill" : "globe")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Self.label(tab)).lineLimit(1)
                                    if let host = URL(string: tab.url)?.host() {
                                        Text(host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                Spacer()
                                if tab.id == pages.shownTabId {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Close", systemImage: "xmark", role: .destructive) { close(tab) }
                        }
                        .contextMenu {
                            Button(tab.pinned ? "Unpin" : "Pin", systemImage: "pin") {
                                Task { await session.send(["kind": "pin", "tabId": tab.id, "pinned": !tab.pinned]) }
                            }
                            Button("Close tab", systemImage: "xmark", role: .destructive) { close(tab) }
                        }
                    }
                }
            }
            .navigationTitle("Tabs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("New tab", systemImage: "plus") {
                        newTab()
                        showingTabs = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingTabs = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() {
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        var op: [String: Any] = ["kind": "navigate", "input": input]
        if let tabId = pages.shownTabId { op["tabId"] = tabId }
        Task { await session.send(op) }
    }

    private func newTab() {
        Task { await session.send(["kind": "newTab"]) }
    }

    private func close(_ tab: BrowserSnapshot.Tab) {
        Task { await session.send(["kind": "closeTab", "tabId": tab.id]) }
    }

    /// The site as Safari shows it: the host without `www.`.
    private static func site(_ url: URL) -> String {
        let host = url.host() ?? ""
        let site = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        guard let port = url.port else { return site }
        return "\(site):\(port)"
    }

    private static func label(_ tab: BrowserSnapshot.Tab) -> String {
        if !tab.title.isEmpty { return tab.title }
        return URL(string: tab.url)?.host() ?? "New tab"
    }
}

private extension View {
    /// A round control of the floating chrome.
    func circleControl() -> some View {
        font(.body.weight(.medium))
            .frame(width: 50, height: 50)
            .contentShape(Circle())
    }

    /// A piece of interactive Liquid Glass.
    func glass<S: Shape>(_ shape: S) -> some View {
        glassEffect(.regular.interactive(), in: shape)
    }
}

/// The pages of one browser panel on this phone: one web view per tab,
/// created when the tab is first shown.
@MainActor
@Observable
final class BrowserPages {
    private(set) var shownTabId: String?
    private(set) var url = ""
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var loading = false
    private(set) var loadError: String?
    private(set) var progress = 0.0
    /// The height of the controls floating over the page, kept clear at
    /// the bottom of every page's scroll view.
    var chromeHeight: CGFloat = 0 {
        didSet { if chromeHeight != oldValue { pages.values.forEach { $0.bottomInset = chromeHeight } } }
    }
    @ObservationIgnored private var pages: [String: BrowserPage] = [:]
    @ObservationIgnored private var store: WKWebsiteDataStore?
    @ObservationIgnored private var route: (URL?) async -> Void = { _ in }
    @ObservationIgnored private weak var session: PanelSession<BrowserSnapshot>?
    @ObservationIgnored private var followed: (tabId: String, source: String?)?

    var shownPage: BrowserPage? { shownTabId.flatMap { pages[$0] } }

    func attach(session: PanelSession<BrowserSnapshot>, store: WKWebsiteDataStore, route: @escaping (URL?) async -> Void) {
        self.session = session
        self.store = store
        self.route = route
        session.onEvent = { [weak self] event in
            guard case .load(let tabId, let url) = event, let page = self?.pages[tabId], let target = URL(string: url) else { return }
            page.webView.load(URLRequest(url: target))
        }
    }

    func shownTab(in snapshot: BrowserSnapshot) -> BrowserSnapshot.Tab? {
        snapshot.tabs.first { $0.id == shownTabId } ?? snapshot.tabs.first { $0.id == snapshot.activeTabId }
    }

    /// Follows this phone's own selections and callers' ones, never another
    /// client's; drops the pages of closed tabs.
    func update(_ snapshot: BrowserSnapshot, clientId: String) {
        if followed?.tabId != snapshot.activeTabId || followed?.source != snapshot.activeSource {
            followed = (snapshot.activeTabId, snapshot.activeSource)
            if snapshot.activeSource == nil || snapshot.activeSource == clientId || shownTabId == nil {
                show(snapshot.activeTabId)
            }
        }
        let open = Set(snapshot.tabs.map(\.id))
        for id in pages.keys where !open.contains(id) { pages[id] = nil }
        if let shownTabId, !open.contains(shownTabId) { show(snapshot.activeTabId) }
    }

    func show(_ tabId: String) {
        guard tabId != shownTabId else { return }
        shownTabId = tabId
        refresh()
    }

    /// The tab's page, loading the tab's URL when it is first shown.
    func page(for tab: BrowserSnapshot.Tab) -> BrowserPage? {
        if let page = pages[tab.id] { return page }
        guard let store, let session, Self.loadable(tab.url), let target = URL(string: tab.url) else { return nil }
        let page = BrowserPage(tabId: tab.id, store: store, route: route, session: session) { [weak self] page in
            if page.tabId == self?.shownTabId { self?.refresh() }
        }
        page.bottomInset = chromeHeight
        pages[tab.id] = page
        page.webView.load(URLRequest(url: target))
        return page
    }

    private func refresh() {
        let page = shownPage
        url = page?.webView.url?.absoluteString ?? ""
        canGoBack = page?.webView.canGoBack ?? false
        canGoForward = page?.webView.canGoForward ?? false
        loading = page?.webView.isLoading ?? false
        progress = page?.webView.estimatedProgress ?? 0
        loadError = page?.loadError
    }

    static func loadable(_ url: String) -> Bool {
        !url.hasPrefix("cate://") && url != "about:blank" && !url.isEmpty
    }
}

/// One tab's web view, reporting its navigations, title and loading.
@MainActor
final class BrowserPage: WebPageController, WKNavigationDelegate, WKUIDelegate {
    let tabId: String
    private(set) var loadError: String?
    /// Clear space under the page for the controls over it; the scroll view
    /// adds the bars' safe area itself.
    var bottomInset: CGFloat = 0 {
        didSet {
            webView.scrollView.contentInset.bottom = bottomInset
            webView.scrollView.verticalScrollIndicatorInsets.bottom = bottomInset
        }
    }
    private weak var session: PanelSession<BrowserSnapshot>?
    private let changed: (BrowserPage) -> Void
    private var observations: [NSKeyValueObservation] = []
    /// A main-frame navigation is under way; a URL change outside one is in
    /// the page (pushState, a fragment).
    private var navigating = false

    init(tabId: String, store: WKWebsiteDataStore, route: @escaping (URL?) async -> Void, session: PanelSession<BrowserSnapshot>, changed: @escaping (BrowserPage) -> Void) {
        self.tabId = tabId
        self.session = session
        self.changed = changed
        super.init(store: store, route: route)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observations = [
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.urlChanged() }
            },
            webView.observe(\.title, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated {
                    guard let self, let title = view.title, !title.isEmpty else { return }
                    self.session?.call("browser.title", ["tabId": self.tabId, "title": title])
                }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { if let self { self.changed(self) } }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { if let self { self.changed(self) } }
            },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { if let self { self.changed(self) } }
            },
        ]
    }

    private func urlChanged() {
        changed(self)
        if !navigating { report(inPage: true) }
    }

    private func report(inPage: Bool) {
        guard let url = webView.url?.absoluteString else { return }
        session?.call("browser.navigated", [
            "tabId": tabId, "url": url, "title": webView.title ?? "", "inPage": inPage,
            "canGoBack": webView.canGoBack, "canGoForward": webView.canGoForward,
        ])
    }

    private func reportLoad(_ loading: Bool, error: String? = nil) {
        loadError = error
        session?.call("browser.loading", ["tabId": tabId, "loading": loading, "loadError": error ?? NSNull()])
        changed(self)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        await route(action.request.url)
        return .allow
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigating = true
        reportLoad(true)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        report(inPage: false)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigating = false
        reportLoad(false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        navigating = false
        // A load cancelled by another one is not a page error.
        let cancelled = (error as NSError).code == NSURLErrorCancelled
        reportLoad(false, error: cancelled ? nil : error.localizedDescription)
    }

    // MARK: WKUIDelegate

    /// Links that open a new window open in this tab.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }
}
