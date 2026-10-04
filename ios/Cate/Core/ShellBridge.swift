// The native side of the bridge (`MobileBridgeMethods` in
// src/shells/mobile/contract.ts): the core posts `{method, params}` and gets
// a promise of the reply. Only native primitives cross it, plus the core
// telling the app it is ready and what its state is.

import UIKit
import WebKit

@MainActor
final class ShellBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "cate"

    private weak var host: CoreHost?
    private let files = DeviceFiles()
    private let keychain = Keychain(service: "com.0ai.cate.ios")

    init(host: CoreHost) {
        self.host = host
    }

    struct BridgeError: Error, CustomStringConvertible {
        let description: String
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            return (nil, "bad bridge message")
        }
        let params = body["params"] as? [String: Any] ?? [:]
        do {
            return (try await handle(method, params), nil)
        } catch {
            return (nil, String(describing: error))
        }
    }

    private func handle(_ method: String, _ params: [String: Any]) async throws -> Any? {
        func string(_ key: String) throws -> String {
            guard let value = params[key] as? String else { throw BridgeError(description: "\(method): missing \(key)") }
            return value
        }
        switch method {
        case "app.info":
            // The client features this device has (12.2).
            // Web views route loopback through the workspace (LoopbackProxy).
            return ["device": UIDevice.current.name, "features": ["webview"] + (QRScanner.isAvailable ? ["camera"] : [])]
        case "device.get":
            return try files.get(try string("name")) ?? NSNull()
        case "device.set":
            try files.set(try string("name"), json: try string("json"))
            return NSNull()
        case "keychain.get":
            return try keychain.get(try string("name")) ?? NSNull()
        case "keychain.set":
            try keychain.set(try string("name"), value: try string("value"))
            return NSNull()
        case "mdns.discover":
            let timeout = (params["timeoutMs"] as? Double ?? 3_000) / 1_000
            return await Discovery.addresses(runtimeId: try string("runtimeId"), timeout: timeout)
        case "core.ready":
            host?.coreReady()
            return NSNull()
        case "core.failed":
            host?.coreFailed(try string("message"))
            return NSNull()
        case "core.state":
            host?.coreState(json: try string("json"))
            return NSNull()
        case "terminal.event":
            // Answered once the view has the output: the core's flow control.
            let terminalId = try string("terminalId")
            switch try string("kind") {
            case "size":
                guard let cols = params["cols"] as? Int, let rows = params["rows"] as? Int, let fitted = params["fitted"] as? Bool else {
                    throw BridgeError(description: "terminal.event: bad size")
                }
                host?.terminalEvent(terminalId, .size(cols: cols, rows: rows, fitted: fitted))
            case "reset":
                host?.terminalEvent(terminalId, .reset)
            case "output":
                guard let data = Data(base64Encoded: try string("data")) else { throw BridgeError(description: "terminal.event: bad output") }
                host?.terminalEvent(terminalId, .output(data))
            case "state":
                host?.terminalEvent(terminalId, .state(status: try string("status"), text: params["text"] as? String))
            case let kind:
                throw BridgeError(description: "terminal.event: unknown kind \(kind)")
            }
            return NSNull()
        case "view.event":
            host?.viewEvent(try string("viewId"), json: try string("json"))
            return NSNull()
        case "stream.event":
            // Answered once the proxy took the bytes: the core's flow control.
            let streamId = try string("streamId")
            switch try string("kind") {
            case "data":
                guard let data = Data(base64Encoded: try string("data")) else { throw BridgeError(description: "stream.event: bad data") }
                host?.streamEvent(streamId, .data(data))
            case "end":
                host?.streamEvent(streamId, .end)
            case let kind:
                throw BridgeError(description: "stream.event: unknown kind \(kind)")
            }
            return NSNull()
        case "notification.show":
            let data = try JSONSerialization.data(withJSONObject: params)
            host?.notification(json: String(decoding: data, as: UTF8.self))
            return NSNull()
        case "notification.withdraw":
            host?.withdrawNotification?(try string("id"))
            return NSNull()
        case "app.openUrl":
            guard let url = URL(string: try string("url")), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                throw BridgeError(description: "app.openUrl: not a web URL")
            }
            await UIApplication.shared.open(url)
            return NSNull()
        default:
            throw BridgeError(description: "unsupported: \(method)")
        }
    }
}
