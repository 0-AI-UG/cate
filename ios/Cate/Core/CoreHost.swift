// The client core: the portable TypeScript client running headless in a
// hidden web view. The app reads its state (`state`, pushed on every change)
// and asks it to act (`call`, the core API in src/shells/mobile/contract.ts).

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

enum CoreError: LocalizedError {
    case badReply(String)
    var errorDescription: String? {
        switch self {
        case .badReply(let method): "The core gave no answer to \(method)."
        }
    }
}
