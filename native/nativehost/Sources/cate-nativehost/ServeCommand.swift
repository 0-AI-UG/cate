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
    private var inputInjector: InputInjector?
    private var appPid: pid_t = 0
    private var displayOrigin: CGPoint = .zero
    private var displayPointSize: CGSize = .zero
    // Set when a resize arrives before capture has started; applied once ready.
    private let stateLock = NSLock()
    private var pendingResize: (w: Int, h: Int)?
    private var lastAppliedSize: (w: Int, h: Int)?
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
        socket.onMessage = { [weak self] type, payload in
            self?.handleClientMessage(type: type, payload: payload)
        }

        log("listening on \(options.socketPath), waiting for client...")
        do {
            try socket.acceptClient()
        } catch {
            log("FATAL: accept() failed: \(error)")
            cleanupAndExit(1)
        }
        log("client connected.")

        // 2. Headless virtual display — Retina (2×) so the app renders crisp;
        // fall back to a plain 1× display if HiDPI construction fails on this
        // OS build.
        let widthMM = UInt32(max(1, Int((Double(options.width) / 96.0 * 25.4).rounded())))
        let heightMM = UInt32(max(1, Int((Double(options.height) / 96.0 * 25.4).rounded())))
        let handle = createReverseEngineeredVirtualDisplay(
            name: "Cate Native App Display",
            pointsWide: UInt32(options.width),
            pointsHigh: UInt32(options.height),
            scale: 2,
            widthMM: widthMM,
            heightMM: heightMM
        ) ?? createReverseEngineeredVirtualDisplay(
            name: "Cate Native App Display",
            pointsWide: UInt32(options.width),
            pointsHigh: UInt32(options.height),
            scale: 1,
            widthMM: widthMM,
            heightMM: heightMM
        )
        guard let handle = handle else {
            socket.sendJSON(["t": "error", "message": "failed to create headless CGVirtualDisplay (see stderr for diagnostics)"])
            log("FATAL: createReverseEngineeredVirtualDisplay failed.")
            cleanupAndExit(1)
        }
        self.displayHandle = handle
        let displayID = handle.displayID
        let bounds = CGDisplayBounds(displayID)
        displayOrigin = bounds.origin
        displayPointSize = bounds.size
        if let mode = CGDisplayCopyDisplayMode(displayID) {
            let scale = mode.width > 0 ? Double(mode.pixelWidth) / Double(mode.width) : 0
            log("virtual display created: displayID=\(displayID) bounds=\(bounds) points=\(mode.width)x\(mode.height) pixels=\(mode.pixelWidth)x\(mode.pixelHeight) scale=\(scale)")
        } else {
            log("virtual display created: displayID=\(displayID) bounds=\(bounds) (mode unavailable)")
        }

        // Place the app window at a normal logical size at the display origin —
        // NOT filling the whole (large, Retina) display. On a 2× display a
        // 1440×900-point window captures at 2880×1800 px: crisp, but ~5 MP/frame
        // rather than the whole display's ~20 MP.
        let windowRect = CGRect(
            x: bounds.origin.x, y: bounds.origin.y,
            width: CGFloat(min(options.width, Int(bounds.width))),
            height: CGFloat(min(options.height, Int(bounds.height)))
        )

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
        self.appPid = pid
        log("launched \(options.bundleID) as PID=\(pid)")

        socket.sendJSON(["t": "ready", "displayId": displayID, "appPid": pid])

        // 4. Place the app's main window on the virtual display, with retry
        // (apps take time to build their AX tree). Never fatal.
        let placement = AppLauncher.placeMainWindow(pid: pid, bounds: windowRect)
        log("placement: placed=\(placement.placed) detail=\(placement.detail) rect=\(windowRect)")

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
                try await session.start(displayID: displayID, pid: pid, fallbackWidth: options.width, fallbackHeight: options.height, fps: options.fps)
            } catch {
                captureStartError = "\(error)"
            }
            captureSema.signal()
        }
        captureSema.wait()

        // Create the input injector using the window's actual frame (fall back
        // to the requested rect). Its geometry is refreshed on every resize.
        let initialFrame = AppLauncher.mainWindow(pid: pid).flatMap { AppLauncher.windowFrame($0) } ?? windowRect
        inputInjector = InputInjector(pid: pid, geometry: WindowGeometry(globalOrigin: initialFrame.origin, pointSize: initialFrame.size))

        // A resize requested before capture was ready is applied now.
        stateLock.lock(); let pending = pendingResize; pendingResize = nil; stateLock.unlock()
        if let pending = pending {
            applyResize(width: pending.w, height: pending.h)
        }

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

    /// Handles an inbound framed message from the client (runs on the socket
    /// read queue): input events (0x10) and resize commands (0x11).
    private func handleClientMessage(type: ControlMessageType, payload: Data) {
        switch type {
        case .input:
            guard let injector = inputInjector,
                  let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
            injector.handle(obj)
        case .resize:
            guard let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let w = (obj["w"] as? NSNumber)?.intValue,
                  let h = (obj["h"] as? NSNumber)?.intValue else { return }
            if captureSession != nil && inputInjector != nil {
                applyResize(width: w, height: h)
            } else {
                stateLock.lock(); pendingResize = (w, h); stateLock.unlock()
            }
        default:
            break
        }
    }

    /// Resizes the real app window to `width`×`height` points (pinned to the
    /// display origin so it stays off the real desktop), refreshes the input
    /// injector's geometry, and reconfigures capture to the new size. Clamped
    /// to the display and a sane minimum; a no-op if the size is unchanged.
    private func applyResize(width: Int, height: Int) {
        let w = max(200, min(width, Int(displayPointSize.width)))
        let h = max(150, min(height, Int(displayPointSize.height)))
        stateLock.lock()
        if let last = lastAppliedSize, last.w == w, last.h == h { stateLock.unlock(); return }
        lastAppliedSize = (w, h)
        stateLock.unlock()

        let frame = AppLauncher.resizeMainWindow(pid: appPid, size: CGSize(width: w, height: h), origin: displayOrigin)
        let geomRect = frame ?? CGRect(origin: displayOrigin, size: CGSize(width: w, height: h))
        inputInjector?.updateGeometry(WindowGeometry(globalOrigin: geomRect.origin, pointSize: geomRect.size))
        Task { await captureSession?.updateSize(pointWidth: w, pointHeight: h) }
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
