//
//  ServeCommand.swift
//
//  `serve --bundle <bundleID> --socket <path> [--width N] [--height N] [--fps N]`
//
//  Creates a headless virtual display, launches the target app onto it,
//  attempts AX-based window placement, then streams JPEG-encoded capture
//  frames of the virtual display over a UNIX-domain socket. See
//  PROTOCOL.md for the wire format and CLAUDE.md-adjacent docs for how the
//  Node/Electron side is expected to consume this.
//

import Foundation
import AppKit
import CoreGraphics

struct ServeOptions {
    var bundleID: String
    var socketPath: String
    var width: Int = 1440
    var height: Int = 900
    var fps: Int = 12
}

enum ServeOptionsError: Error, CustomStringConvertible {
    case missingRequired(String)
    case invalidValue(String, String)

    var description: String {
        switch self {
        case .missingRequired(let flag): return "missing required flag \(flag)"
        case .invalidValue(let flag, let value): return "invalid value '\(value)' for \(flag)"
        }
    }
}

enum ServeOptionsParser {
    static func parse(_ args: [String]) throws -> ServeOptions {
        var bundleID: String?
        var socketPath: String?
        var width = 1440
        var height = 900
        var fps = 12

        var i = 0
        while i < args.count {
            switch args[i] {
            case "--bundle":
                i += 1
                guard i < args.count else { throw ServeOptionsError.missingRequired("--bundle") }
                bundleID = args[i]
            case "--socket":
                i += 1
                guard i < args.count else { throw ServeOptionsError.missingRequired("--socket") }
                socketPath = args[i]
            case "--width":
                i += 1
                guard i < args.count, let v = Int(args[i]), v > 0 else {
                    throw ServeOptionsError.invalidValue("--width", i < args.count ? args[i] : "")
                }
                width = v
            case "--height":
                i += 1
                guard i < args.count, let v = Int(args[i]), v > 0 else {
                    throw ServeOptionsError.invalidValue("--height", i < args.count ? args[i] : "")
                }
                height = v
            case "--fps":
                i += 1
                guard i < args.count, let v = Int(args[i]), v > 0 else {
                    throw ServeOptionsError.invalidValue("--fps", i < args.count ? args[i] : "")
                }
                fps = v
            default:
                break
            }
            i += 1
        }

        guard let bundleID = bundleID else { throw ServeOptionsError.missingRequired("--bundle") }
        guard let socketPath = socketPath else { throw ServeOptionsError.missingRequired("--socket") }

        return ServeOptions(bundleID: bundleID, socketPath: socketPath, width: width, height: height, fps: fps)
    }
}

final class ServeRunner {
    private let options: ServeOptions
    private var socket: ControlSocket?
    private var displayHandle: VirtualDisplayHandle?
    private var launchedApp: NSRunningApplication?
    private var captureSession: CaptureSession?
    private let shutdownFlag = AtomicBool()

    init(options: ServeOptions) {
        self.options = options
    }

    func run() {
        log("starting: bundle=\(options.bundleID) socket=\(options.socketPath) size=\(options.width)x\(options.height) fps=\(options.fps)")

        installSignalHandlers()

        // 1. Open the control socket and wait for the one client to connect.
        // Doing this first means a client that connects immediately after we
        // spawn never races a "connection refused".
        let socket: ControlSocket
        do {
            socket = try ControlSocket(path: options.socketPath)
        } catch {
            log("FATAL: failed to create control socket at \(options.socketPath): \(error)")
            exit(1)
        }
        self.socket = socket

        log("listening on \(options.socketPath), waiting for client...")
        do {
            try socket.acceptClient()
        } catch {
            log("FATAL: accept() failed: \(error)")
            cleanupAndExit(1)
        }
        log("client connected.")

        // 2. Headless virtual display.
        let widthMM = UInt32(max(1, Int((Double(options.width) / 96.0 * 25.4).rounded())))
        let heightMM = UInt32(max(1, Int((Double(options.height) / 96.0 * 25.4).rounded())))
        guard let handle = createReverseEngineeredVirtualDisplay(
            name: "Cate Native App Display",
            widthPx: UInt32(options.width),
            heightPx: UInt32(options.height),
            widthMM: widthMM,
            heightMM: heightMM
        ) else {
            socket.sendJSON(["t": "error", "message": "failed to create headless CGVirtualDisplay (see stderr for diagnostics)"])
            log("FATAL: createReverseEngineeredVirtualDisplay failed.")
            cleanupAndExit(1)
        }
        self.displayHandle = handle
        let displayID = handle.displayID
        let bounds = CGDisplayBounds(displayID)
        log("virtual display created: displayID=\(displayID) bounds=\(bounds)")

        // 3. Launch the target app.
        let app: NSRunningApplication
        do {
            app = try AppLauncher.launch(bundleID: options.bundleID)
        } catch {
            socket.sendJSON(["t": "error", "message": "failed to launch \(options.bundleID): \(error)"])
            log("FATAL: launch failed: \(error)")
            cleanupAndExit(1)
        }
        self.launchedApp = app
        let pid = app.processIdentifier
        log("launched \(options.bundleID) as PID=\(pid)")

        socket.sendJSON(["t": "ready", "displayId": displayID, "appPid": pid])

        // 4. Place the app's main window on the virtual display, with retry
        // (apps take time to build their AX tree). Never fatal.
        let placement = AppLauncher.placeMainWindow(pid: pid, bounds: bounds)
        log("placement: placed=\(placement.placed) detail=\(placement.detail)")

        // 5. Confirm on-display via CGWindowListCopyWindowInfo, independent
        // of whether AX reported success.
        let onDisplay = AppLauncher.isOnDisplay(pid: pid, bounds: bounds)
        log("on-display confirmation: \(onDisplay)")
        socket.sendJSON(["t": "placed", "onDisplay": onDisplay])

        // 6. Start SCStream capture + JPEG encode + write frames to socket.
        let session = CaptureSession(socket: socket)
        self.captureSession = session
        let captureSema = DispatchSemaphore(value: 0)
        var captureStartError: String?
        Task {
            do {
                try await session.start(displayID: displayID, width: options.width, height: options.height, fps: options.fps)
            } catch {
                captureStartError = "\(error)"
            }
            captureSema.signal()
        }
        captureSema.wait()

        if let captureStartError = captureStartError {
            socket.sendJSON(["t": "error", "message": "failed to start capture: \(captureStartError)"])
            log("FATAL: capture start failed: \(captureStartError)")
            cleanupAndExit(1)
        }
        log("capture started.")

        // Idle until: SIGTERM/SIGINT (handled below), the client disconnects,
        // or the stream itself reports a fatal error.
        while !shutdownFlag.value {
            if socket.isClientDisconnected {
                log("client disconnected, shutting down.")
                break
            }
            if let err = session.stoppedWithError {
                log("capture stream stopped with error: \(err), shutting down.")
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }

        cleanupAndExit(0)
    }

    private func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSource.setEventHandler { [weak self] in
            self?.log("received SIGTERM, shutting down.")
            self?.shutdownFlag.value = true
        }
        termSource.resume()

        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSource.setEventHandler { [weak self] in
            self?.log("received SIGINT, shutting down.")
            self?.shutdownFlag.value = true
        }
        intSource.resume()

        // Keep the sources alive for the process lifetime.
        Self.retainedSignalSources.append(contentsOf: [termSource, intSource])
    }
    private static var retainedSignalSources: [DispatchSourceSignal] = []

    /// Full teardown, mirroring the lifecycle contract: stop the stream, quit
    /// the launched app, destroy the virtual display, unlink the socket.
    private func cleanupAndExit(_ code: Int32) -> Never {
        log("cleaning up...")

        if let session = captureSession {
            let sema = DispatchSemaphore(value: 0)
            Task {
                await session.stop()
                sema.signal()
            }
            sema.wait()
            log("capture stopped.")
        }

        if let app = launchedApp {
            AppLauncher.terminate(app)
            log("terminated launched app (PID=\(app.processIdentifier)).")
        }

        if let handle = displayHandle {
            withExtendedLifetime(handle.displayObject) {}
            displayHandle = nil
            log("released virtual display.")
        }

        socket?.shutdownAndCleanup()
        log("socket cleaned up. exiting \(code).")
        exit(code)
    }

    private func log(_ message: String) {
        FileHandle.standardError.write("[cate-nativehost] \(message)\n".data(using: .utf8)!)
    }
}
