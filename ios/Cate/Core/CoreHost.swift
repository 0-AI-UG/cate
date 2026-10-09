// The client core: the portable TypeScript client running headless in a
// hidden web view. The app reads its state (`state`, pushed on every change)
// and asks it to act (`call`, the core API in src/shells/mobile/contract.ts).

import CryptoKit
import Foundation
import Observation
import WebKit

@MainActor
@Observable
final class CoreHost {
    private(set) var state = CoreState()
    private(set) var ready = false
    /// Set when the core could not start; the app shows it instead.
    private(set) var failure: String?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private var readyWaiters: [CheckedContinuation<Void, Never>] = []
    /// The open terminal views by their `terminalId`.
    @ObservationIgnored private var terminals: [String: (TerminalEvent) -> Void] = [:]
    /// Keystrokes reach the core in the order they were typed.
    @ObservationIgnored private var input: Task<Void, Never>?
    /// The open panel and buffer views by their `viewId`: each gets its events
    /// as JSON.
    @ObservationIgnored private var views: [String: (Data) -> Void] = [:]
    /// The open loopback streams by their `streamId`.
    @ObservationIgnored private var streams: [String: (StreamEvent) -> Void] = [:]
    /// Calls that must reach the core in order (edits of one buffer, writes to
    /// one stream), by key.
    @ObservationIgnored private var queues: [String: Task<Void, Never>] = [:]
    /// Each workspace's web data store (cookies and storage per workspace).
    @ObservationIgnored private var dataStores: [String: WKWebsiteDataStore] = [:]
    /// Loopback routing for the web views (LoopbackPorts).
    @ObservationIgnored let loopback = LoopbackPorts()
    /// Shows the notifications the core hands over (Notifier).
    @ObservationIgnored var notifications: ((CoreNotification) -> Void)?
    /// Removes a shown notification by id: its agent works again.
    @ObservationIgnored var withdrawNotification: ((String) -> Void)?

    init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
        #if DEBUG
        webView.isInspectable = true
        #endif
        let bridge = ShellBridge(host: self)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: ShellBridge.name)
        webView.load(URLRequest(url: AppSchemeHandler.entry))
        loopback.core = self
    }

    // MARK: From the core

    func coreReady() {
        ready = true
        for waiter in readyWaiters { waiter.resume() }
        readyWaiters.removeAll()
    }

    func coreState(json: String) {
        do {
            let next = try JSONDecoder().decode(CoreState.self, from: Data(json.utf8))
            if next != state { state = next }
        } catch {
            failure = "Unreadable core state: \(error)"
        }
    }

    func coreFailed(_ message: String) {
        failure = message
    }

    func terminalEvent(_ terminalId: String, _ event: TerminalEvent) {
        terminals[terminalId]?(event)
    }

    func notification(json: String) {
        guard let notification = try? JSONDecoder().decode(CoreNotification.self, from: Data(json.utf8)) else { return }
        notifications?(notification)
    }

    func viewEvent(_ viewId: String, json: String) {
        views[viewId]?(Data(json.utf8))
    }

    func streamEvent(_ streamId: String, _ event: StreamEvent) {
        streams[streamId]?(event)
        if case .end = event { streams[streamId] = nil }
    }

    // MARK: To the core

    private func whenReady() async {
        if ready { return }
        await withCheckedContinuation { readyWaiters.append($0) }
    }

    func call<Result: Decodable>(_ method: String, _ params: [String: Any], as _: Result.Type) async throws -> Result {
        await whenReady()
        let paramsJson = String(decoding: try JSONSerialization.data(withJSONObject: params), as: UTF8.self)
        let value = try await webView.callAsyncJavaScript(
            "return await window.cateCore.call(method, params)",
            arguments: ["method": method, "params": paramsJson],
            contentWorld: .page
        )
        guard let text = value as? String else { throw CoreError.badReply(method) }
        return try JSONDecoder().decode(Result.self, from: Data(text.utf8))
    }

    func call(_ method: String, _ params: [String: Any]) async {
        do {
            _ = try await call(method, params, as: Optional<Bool>.self)
        } catch {
            print("core call \(method) failed: \(error)")
        }
    }

    // MARK: Workspaces

    func join(_ input: String) async -> JoinResult {
        do {
            return try await call("workspaces.join", ["input": input], as: JoinResult.self)
        } catch {
            return JoinResult(ok: false, workspaceId: nil, message: error.localizedDescription)
        }
    }

    func open(_ workspaceId: String) async { await call("workspaces.open", ["workspaceId": workspaceId]) }
    func close(_ workspaceId: String) async { await call("workspaces.close", ["workspaceId": workspaceId]) }
    func stop(_ workspaceId: String) async { await call("workspaces.stop", ["workspaceId": workspaceId]) }
    func retry(_ workspaceId: String) async { await call("workspaces.retry", ["workspaceId": workspaceId]) }
    func forget(_ workspaceId: String) async { await call("workspaces.forget", ["workspaceId": workspaceId]) }

    func workspace(_ id: String) -> Workspace? {
        state.workspaces.first { $0.id == id }
    }

    // MARK: Terminals

    /// Shows a terminal panel in a view that holds `cols` x `rows`: `events`
    /// gets the PTY's grid, screen and output until `closeTerminal`.
    func openTerminal(_ terminalId: String, workspaceId: String, panelId: String, cols: Int, rows: Int, events: @escaping (TerminalEvent) -> Void) {
        terminals[terminalId] = events
        Task {
            await call("terminal.open", ["terminalId": terminalId, "workspaceId": workspaceId, "panelId": panelId, "cols": cols, "rows": rows])
        }
    }

    /// The grid the view holds changed.
    func resizeTerminal(_ terminalId: String, cols: Int, rows: Int) {
        Task { await call("terminal.resize", ["terminalId": terminalId, "cols": cols, "rows": rows]) }
    }

    func terminalInput(_ terminalId: String, _ data: String) {
        input = Task { [previous = input] in
            await previous?.value
            await call("terminal.input", ["terminalId": terminalId, "data": data])
        }
    }

    /// Fits the PTY to this view.
    func fitTerminal(_ terminalId: String) {
        Task { await call("terminal.fit", ["terminalId": terminalId]) }
    }

    func closeTerminal(_ terminalId: String) {
        terminals[terminalId] = nil
        Task { await call("terminal.close", ["terminalId": terminalId]) }
    }
}

extension CoreHost {
    // MARK: Panel views

    /// Opens a view of a panel with `method` (`panel.open`, `browser.open`,
    /// `chat.open`): `events` gets its snapshots and events as JSON until
    /// `closeView`.
    func openView(_ method: String, viewId: String, workspaceId: String, panelId: String, events: @escaping (Data) -> Void) {
        views[viewId] = events
        Task { await call(method, ["viewId": viewId, "workspaceId": workspaceId, "panelId": panelId]) }
    }

    func closeView(_ viewId: String) {
        views[viewId] = nil
        Task { await call("panel.close", ["viewId": viewId]) }
    }

    /// Runs one op on the view's session.
    func panelOp<Result: Decodable>(_ viewId: String, _ op: [String: Any], as _: Result.Type = AnyJSON.self) async -> OpReply<Result> {
        do {
            return try await call("panel.op", ["viewId": viewId, "op": op], as: OpReply<Result>.self)
        } catch {
            return OpReply(ok: false, result: nil, message: error.localizedDescription, code: nil)
        }
    }

    /// Closes a panel (a canvas takes the panels on it).
    func removePanel(_ workspaceId: String, panelId: String) async {
        await call("panel.remove", ["workspaceId": workspaceId, "panelId": panelId])
    }

    // MARK: Agent chats

    /// Follows a panel's agent conversation: `events` gets its
    /// `conversation` events until `unwatchAgent`. `pending` is a first
    /// prompt on its way.
    func watchAgent(_ viewId: String, workspaceId: String, panelId: String, pending: String?, events: @escaping (Data) -> Void) {
        views[viewId] = events
        var params: [String: Any] = ["viewId": viewId, "workspaceId": workspaceId, "panelId": panelId]
        if let pending { params["pending"] = pending }
        Task { await call("agents.watch", params) }
    }

    func unwatchAgent(_ viewId: String) {
        views[viewId] = nil
        Task { await call("agents.unwatch", ["viewId": viewId]) }
    }

    // MARK: Buffers

    func openBuffer(_ viewId: String, workspaceId: String, path: String, events: @escaping (Data) -> Void) {
        views[viewId] = events
        Task { await call("buffer.open", ["viewId": viewId, "workspaceId": workspaceId, "path": path]) }
    }

    /// Replaces `length` UTF-16 units at `from`; `done` gets the whole text
    /// after the edit. Edits reach the core in the order they were made.
    func editBuffer(_ viewId: String, from: Int, length: Int, text: String, done: @escaping (String?) -> Void) {
        enqueue(viewId) { [weak self] in
            struct Reply: Decodable { let text: String }
            let reply = try? await self?.call("buffer.edit", ["viewId": viewId, "from": from, "length": length, "text": text], as: Reply.self)
            done(reply?.text)
        }
    }

    func closeBuffer(_ viewId: String) {
        views[viewId] = nil
        enqueue(viewId) { [weak self] in await self?.call("buffer.close", ["viewId": viewId]) }
    }

    private func enqueue(_ key: String, _ work: @escaping @MainActor () async -> Void) {
        let previous = queues[key]
        let task = Task { @MainActor in
            await previous?.value
            await work()
        }
        queues[key] = task
        Task { @MainActor [weak self] in
            await task.value
            if self?.queues[key] == task { self?.queues[key] = nil }
        }
    }

    // MARK: Loopback routing

    /// The web data store of a workspace's browser, chat and preview pages:
    /// its own, persistent, like the desktop's partition per workspace.
    func webDataStore(_ workspaceId: String) -> WKWebsiteDataStore {
        if let store = dataStores[workspaceId] { return store }
        let store = WKWebsiteDataStore(forIdentifier: Self.storeId(workspaceId))
        dataStores[workspaceId] = store
        return store
    }

    private static func storeId(_ workspaceId: String) -> UUID {
        if let id = UUID(uuidString: workspaceId) { return id }
        let digest = Array(SHA256.hash(data: Data(workspaceId.utf8)))
        return UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
                           digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]))
    }

    /// Before a workspace page loads `url`: when its host is loopback, this
    /// phone's loopback forwards its port to the runtime's machine.
    func routeLoopback(_ workspaceId: String, _ url: URL?) async {
        guard let url, url.scheme == "http" || url.scheme == "https" else { return }
        guard let port = try? await call("loopback.port", ["url": url.absoluteString], as: Int?.self) else { return }
        await loopback.forward(port, to: workspaceId)
    }

    /// A stream to `port` on the runtime's machine for one forwarded
    /// connection; `events` gets its bytes and end.
    func openStream(_ streamId: String, workspaceId: String, port: Int, events: @escaping (StreamEvent) -> Void) async throws {
        streams[streamId] = events
        do {
            _ = try await call("stream.open", ["streamId": streamId, "workspaceId": workspaceId, "port": port], as: Optional<Bool>.self)
        } catch {
            streams[streamId] = nil
            throw error
        }
    }

    func writeStream(_ streamId: String, _ data: Data) {
        let encoded = data.base64EncodedString()
        enqueue("stream:" + streamId) { [weak self] in await self?.call("stream.write", ["streamId": streamId, "data": encoded]) }
    }

    func closeStream(_ streamId: String) {
        streams[streamId] = nil
        enqueue("stream:" + streamId) { [weak self] in await self?.call("stream.close", ["streamId": streamId]) }
    }

    // MARK: Actions

    /// Runs an action of the core API that answers ok or what went wrong.
    func action(_ method: String, _ params: [String: Any]) async -> ActionResult {
        do {
            return try await call(method, params, as: ActionResult.self)
        } catch {
            return ActionResult(ok: false, message: error.localizedDescription)
        }
    }

    /// The workspace that runtime serves, if this phone is paired with it.
    func workspace(runtimeId: String) -> Workspace? {
        state.workspaces.first { $0.runtimeId == runtimeId }
    }

    /// Connects to every paired workspace that is not open, so the agents
    /// home sees all of them.
    func openAll() async {
        for workspace in state.workspaces where workspace.connection.kind == .closed {
            await open(workspace.id)
        }
    }

    /// Waits up to `timeout` for the workspace to connect (a notification's
    /// action can arrive before the app reconnected).
    func connected(_ workspaceId: String, timeout: Duration = .seconds(10)) async -> Bool {
        await whenReady()
        if workspace(workspaceId)?.connection.kind == .closed { await open(workspaceId) }
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if workspace(workspaceId)?.connection.kind == .connected { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    // MARK: Lists

    func panelChoices(_ method: String, _ params: [String: Any]) async -> [PanelChoice] {
        (try? await call(method, params, as: [PanelChoice].self)) ?? []
    }
}

enum StreamEvent {
    case data(Data)
    case end
}

enum CoreError: LocalizedError {
    case badReply(String)
    var errorDescription: String? {
        switch self {
        case .badReply(let method): "The core gave no answer to \(method)."
        }
    }
}
