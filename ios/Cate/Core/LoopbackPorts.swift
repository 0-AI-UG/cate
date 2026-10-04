// Loopback routing for the workspace web views (architecture 12.3). In the
// browser and chat panels `localhost` is the runtime's machine, but WebKit
// connects to loopback hosts directly and never through a proxy. So before a
// page loads a loopback URL, this phone's loopback listens at the same port
// (IPv4 and IPv6) and each connection becomes a stream to that port on the
// runtime's machine, through the workspace connection (`stream.*`). URLs are
// never rewritten, so origins and cookies behave as on the runtime's machine.
// The workspace that asked last owns a port.

import Foundation
import Network

@MainActor
final class LoopbackPorts {
    weak var core: CoreHost?
    private var forwards: [Int: Forward] = [:]

    /// Forwards `port` to the workspace's runtime; resolves once this phone
    /// listens there (or could not: something else holds the port).
    func forward(_ port: Int, to workspaceId: String) async {
        guard let core, let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)), port > 0 else { return }
        let forward = forwards[port] ?? Forward(port: port, nwPort: nwPort, core: core)
        forwards[port] = forward
        forward.owner = workspaceId
        await forward.ready()
    }
}

/// One port: its listeners and the connections they accepted.
@MainActor
private final class Forward {
    var owner = ""
    private let port: Int
    private weak var core: CoreHost?
    private var listeners: [NWListener] = []
    private var pending = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var pipes: Set<Pipe> = []

    init(port: Int, nwPort: NWEndpoint.Port, core: CoreHost) {
        self.port = port
        self.core = core
        for host in ["127.0.0.1", "::1"] {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: nwPort)
            guard let listener = try? NWListener(using: parameters) else { continue }
            pending += 1
            listeners.append(listener)
            listener.newConnectionHandler = { [weak self] connection in
                MainActor.assumeIsolated { self?.accept(connection) }
            }
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                MainActor.assumeIsolated {
                    switch state {
                    case .ready:
                        self?.settled()
                    case .failed(let error):
                        print("loopback \(host):\(port) not forwarded: \(error)")
                        listener?.cancel()
                        self?.settled()
                    default:
                        break
                    }
                }
            }
            // The listeners run on the main queue.
            listener.start(queue: .main)
        }
    }

    func ready() async {
        if pending == 0 { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func settled() {
        pending = max(0, pending - 1)
        guard pending == 0 else { return }
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard let core else {
            connection.cancel()
            return
        }
        let pipe = Pipe(client: connection, workspaceId: owner, port: port, core: core) { [weak self] done in
            self?.pipes.remove(done)
        }
        pipes.insert(pipe)
        pipe.start()
    }
}

/// One forwarded connection: bytes both ways until either side ends.
@MainActor
private final class Pipe: Hashable {
    private let client: NWConnection
    private let workspaceId: String
    private let port: Int
    private weak var core: CoreHost?
    private let onFinish: (Pipe) -> Void
    private let streamId = UUID().uuidString
    private var opened = false
    private var finished = false

    init(client: NWConnection, workspaceId: String, port: Int, core: CoreHost, onFinish: @escaping (Pipe) -> Void) {
        self.client = client
        self.workspaceId = workspaceId
        self.port = port
        self.core = core
        self.onFinish = onFinish
    }

    nonisolated static func == (a: Pipe, b: Pipe) -> Bool { a === b }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }

    func start() {
        client.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                switch state {
                case .failed, .cancelled: self?.finish()
                default: break
                }
            }
        }
        client.start(queue: .main)
        Task { await open() }
    }

    private func open() async {
        guard let core else { return finish() }
        do {
            try await core.openStream(streamId, workspaceId: workspaceId, port: port) { [weak self] (event: StreamEvent) in
                switch event {
                case .data(let data): self?.send(data)
                case .end: self?.finishAfterSending()
                }
            }
        } catch {
            return finish()
        }
        opened = true
        if finished {
            core.closeStream(streamId)
            return
        }
        receive()
    }

    /// The page's bytes to the runtime, once the stream is open.
    private func receive() {
        client.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, !self.finished else { return }
                if let data, !data.isEmpty { self.core?.writeStream(self.streamId, data) }
                if complete || error != nil {
                    self.finish()
                } else {
                    self.receive()
                }
            }
        }
    }

    private func send(_ data: Data) {
        guard !finished else { return }
        client.send(content: data, completion: .contentProcessed { _ in })
    }

    /// The runtime side ended: close once what it sent went out.
    private func finishAfterSending() {
        guard !finished else { return }
        client.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        })
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        if opened { core?.closeStream(streamId) }
        client.cancel()
        onFinish(self)
    }
}
