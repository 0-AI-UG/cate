// Finding a runtime on the same network by its runtimeId (architecture 7.5):
// browse `_cate._tcp`, match the `runtimeId` TXT entry, and resolve the
// service to an IPv4 `host:port` the core can open a WebSocket to.

import Foundation
import Network

@MainActor
final class Discovery {
    /// The runtime's addresses, or none when it does not answer in `timeout`.
    static func addresses(runtimeId: String, timeout: TimeInterval) async -> [String] {
        await withCheckedContinuation { continuation in
            let discovery = Discovery(runtimeId: runtimeId) { continuation.resume(returning: $0) }
            discovery.start(timeout: timeout)
        }
    }

    private let runtimeId: String
    private var finish: (([String]) -> Void)?
    private var browser: NWBrowser?
    private var resolving: [NWConnection] = []

    private init(runtimeId: String, finish: @escaping ([String]) -> Void) {
        self.runtimeId = runtimeId
        self.finish = finish
    }

    private func start(timeout: TimeInterval) {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_cate._tcp", domain: nil), using: NWParameters())
        browser.browseResultsChangedHandler = { [self] results, _ in
            MainActor.assumeIsolated {
                for result in results where self.matches(result) { self.resolve(result.endpoint) }
            }
        }
        browser.stateUpdateHandler = { [self] state in
            if case .failed = state { MainActor.assumeIsolated { self.done([]) } }
        }
        self.browser = browser
        browser.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [self] in
            MainActor.assumeIsolated { self.done([]) }
        }
    }

    private func matches(_ result: NWBrowser.Result) -> Bool {
        guard case .bonjour(let txt) = result.metadata else { return false }
        return txt["runtimeId"] == runtimeId
    }

    /// Connecting to the service is how Network resolves it to an address.
    private func resolve(_ endpoint: NWEndpoint) {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: parameters)
        connection.stateUpdateHandler = { [self] state in
            MainActor.assumeIsolated {
                guard case .ready = state else { return }
                if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint {
                    let address = "\(host)".split(separator: "%").first.map(String.init) ?? "\(host)"
                    self.done(["\(address):\(port.rawValue)"])
                }
            }
        }
        resolving.append(connection)
        connection.start(queue: .main)
    }

    private func done(_ addresses: [String]) {
        guard let finish else { return }
        self.finish = nil
        browser?.cancel()
        for connection in resolving { connection.cancel() }
        resolving.removeAll()
        finish(addresses)
    }
}
