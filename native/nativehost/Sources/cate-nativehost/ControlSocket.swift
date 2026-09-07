//
//  ControlSocket.swift
//
//  UNIX-domain socket server for the cate-nativehost capture protocol.
//  cate-nativehost is the SERVER: it creates + binds + listens on the path
//  passed via --socket, accepts exactly one client, and then streams
//  length-prefixed messages to it. See PROTOCOL.md at the package root for
//  the on-the-wire framing this implements.
//

import Foundation
#if canImport(Darwin)
import Darwin
#endif

enum ControlSocketError: Error, CustomStringConvertible {
    case socketCreateFailed(errno: Int32)
    case pathTooLong(String)
    case bindFailed(errno: Int32)
    case listenFailed(errno: Int32)
    case acceptFailed(errno: Int32)

    var description: String {
        switch self {
        case .socketCreateFailed(let e): return "socket() failed: errno=\(e) (\(String(cString: strerror(e))))"
        case .pathTooLong(let p): return "socket path too long for sockaddr_un.sun_path: \(p)"
        case .bindFailed(let e): return "bind() failed: errno=\(e) (\(String(cString: strerror(e))))"
        case .listenFailed(let e): return "listen() failed: errno=\(e) (\(String(cString: strerror(e))))"
        case .acceptFailed(let e): return "accept() failed: errno=\(e) (\(String(cString: strerror(e))))"
        }
    }
}

/// Message type byte — see PROTOCOL.md.
enum ControlMessageType: UInt8 {
    case json = 0x01
    case jpegFrame = 0x02
    // Inbound (client → sidecar):
    case input = 0x10   // JSON: a mouse/keyboard/scroll event
    case resize = 0x11  // JSON: { w, h } target window point size
}

/// One-client UNIX-domain socket server implementing the length-prefixed
/// framing protocol: `[UInt32 big-endian payloadLength][UInt8 type][payload]`.
final class ControlSocket {
    let path: String
    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private let writeQueue = DispatchQueue(label: "com.cate.nativehost.socket.write")

    /// Set once a write fails (client gone) or the client closes its end.
    /// Checked by the capture loop to know when to stop.
    private let disconnectedFlag = AtomicBool()
    var isClientDisconnected: Bool { disconnectedFlag.value }

    /// Invoked (on the socket read queue) for each inbound framed message from
    /// the client — input events (0x10) and resize commands (0x11). Set before
    /// acceptClient().
    var onMessage: ((ControlMessageType, Data) -> Void)?

    init(path: String) throws {
        self.path = path

        // Best-effort: remove a stale socket file from a previous unclean exit.
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ControlSocketError.socketCreateFailed(errno: errno) }
        listenFD = fd

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        // sun_path is a fixed-size C char array; leave room for the trailing NUL.
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        guard pathBytes.count <= maxLen else {
            close(fd)
            throw ControlSocketError.pathTooLong(path)
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { rawPtr in
            rawPtr.withMemoryRebound(to: CChar.self, capacity: maxLen + 1) { charPtr in
                for (i, byte) in pathBytes.enumerated() {
                    charPtr[i] = CChar(bitPattern: byte)
                }
                charPtr[pathBytes.count] = 0
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            let e = errno
            close(fd)
            throw ControlSocketError.bindFailed(errno: e)
        }

        guard listen(fd, 1) == 0 else {
            let e = errno
            close(fd)
            unlink(path)
            throw ControlSocketError.listenFailed(errno: e)
        }
    }

    /// Blocks until a client connects (or the listening socket is closed, in
    /// which case it throws). Only one client is ever accepted.
    func acceptClient() throws {
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { throw ControlSocketError.acceptFailed(errno: errno) }
        clientFD = fd

        // Read inbound framed messages (input + resize) from the client, and
        // detect close: read() returning 0 = orderly close, negative = error;
        // either means the client is gone and the capture loop should stop.
        let watchedFD = fd
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.readLoop(fd: watchedFD)
        }
    }

    /// Parses the `[UInt32 BE len][UInt8 type][payload]` framing from the client
    /// stream and dispatches each complete message to `onMessage`. A partial
    /// frame at the end of a read is retained until the rest arrives.
    private func readLoop(fd: Int32) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 {
                disconnectedFlag.value = true
                return
            }
            buffer.append(contentsOf: chunk[0..<n])

            // Drain as many complete frames as the buffer holds.
            while buffer.count >= 5 {
                let len = buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                let total = 5 + Int(len)
                guard buffer.count >= total else { break }
                let typeByte = buffer[buffer.startIndex + 4]
                let payload = buffer.subdata(in: (buffer.startIndex + 5)..<(buffer.startIndex + total))
                buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + total))
                if let type = ControlMessageType(rawValue: typeByte) {
                    onMessage?(type, payload)
                }
            }
        }
    }

    func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
        send(type: .json, payload: data)
    }

    func sendJPEGFrame(_ data: Data) {
        send(type: .jpegFrame, payload: data)
    }

    private func send(type: ControlMessageType, payload: Data) {
        guard !disconnectedFlag.value else { return }
        writeQueue.sync {
            guard clientFD >= 0 else { return }
            var frame = Data(capacity: payload.count + 5)
            var lengthBE = UInt32(payload.count).bigEndian
            withUnsafeBytes(of: &lengthBE) { frame.append(contentsOf: $0) }
            frame.append(type.rawValue)
            frame.append(payload)

            let ok = frame.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
                guard var ptr = raw.baseAddress else { return true }
                var remaining = raw.count
                while remaining > 0 {
                    let n = write(clientFD, ptr, remaining)
                    if n < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                    if n == 0 { return false }
                    remaining -= n
                    ptr = ptr.advanced(by: n)
                }
                return true
            }
            if !ok {
                disconnectedFlag.value = true
            }
        }
    }

    /// Closes the client + listening fds and unlinks the socket file. Safe to
    /// call multiple times.
    func shutdownAndCleanup() {
        writeQueue.sync {
            if clientFD >= 0 {
                close(clientFD)
                clientFD = -1
            }
        }
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        unlink(path)
    }
}

/// Tiny lock-protected bool — avoids pulling in os_unfair_lock/Atomics dependency
/// for a single flag that's read/written across two threads.
final class AtomicBool: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Bool
    init(_ initial: Bool = false) { _value = initial }
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); defer { lock.unlock() }; _value = newValue }
    }
}
