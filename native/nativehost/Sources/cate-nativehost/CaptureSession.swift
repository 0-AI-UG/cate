//
//  CaptureSession.swift
//
//  SCStream capture of a headless virtual display, JPEG-encoding each frame
//  via ImageIO and forwarding it to the control socket. Also tallies
//  SCStreamFrameInfo.status and emits a periodic "status" control message.
//

import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum CaptureSessionError: Error, CustomStringConvertible {
    case virtualDisplayNotVisibleToSCK(displayID: CGDirectDisplayID, knownDisplayIDs: [CGDirectDisplayID])

    var description: String {
        switch self {
        case .virtualDisplayNotVisibleToSCK(let id, let known):
            return "virtual display \(id) was not found in SCShareableContent.current.displays " +
                "(visible display IDs: \(known))"
        }
    }
}

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let socket: ControlSocket
    private let jpegQuality: CGFloat = 0.9
    private var stream: SCStream?

    // Rolling tally, reset each time it's flushed into a "status" message.
    private let tallyLock = NSLock()
    private var frameCount = 0
    private var completeCount = 0
    private var idleCount = 0
    private var suspendedCount = 0
    private var statusTimer: DispatchSourceTimer?

    /// Set when the stream stops with an error (e.g. client/app gone).
    private(set) var stoppedWithError: String?

    init(socket: ControlSocket) {
        self.socket = socket
    }

    /// Picks the app's main window from the shareable-content window list:
    /// a normal (layer 0), reasonably sized window owned by `pid`. Prefers
    /// windows that land on the virtual display; among the candidates, the
    /// largest by area (the document/content window, not a small palette).
    private func resolveTargetWindow(pid: pid_t, displayBounds: CGRect, in content: SCShareableContent) -> SCWindow? {
        let candidates = content.windows.filter { win in
            win.owningApplication?.processID == pid &&
            win.windowLayer == 0 &&
            win.frame.width >= 50 && win.frame.height >= 50
        }
        let onDisplay = candidates.filter { $0.frame.intersects(displayBounds) }
        let pool = onDisplay.isEmpty ? candidates : onDisplay
        return pool.max(by: { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) })
    }

    /// Starts SCStream capture of the app window owned by `pid` on the virtual
    /// display, at `fps`, writing JPEG frames to the socket as they arrive.
    /// Captures ONLY the app's window (no menu bar / wallpaper / other apps)
    /// at its native pixel size, so a Retina display yields crisp frames. If
    /// the window can't be found, falls back to capturing the whole display
    /// at `fallbackWidth`×`fallbackHeight` so the pipeline still produces
    /// frames rather than going dark.
    func start(displayID: CGDirectDisplayID, pid: pid_t, fallbackWidth: Int, fallbackHeight: Int, fps: Int) async throws {
        let content = try await SCShareableContent.current
        guard let scDisplay = content.displays.first(where: { $0.displayID == displayID }) else {
            throw CaptureSessionError.virtualDisplayNotVisibleToSCK(
                displayID: displayID,
                knownDisplayIDs: content.displays.map { $0.displayID }
            )
        }
        let displayBounds = CGDisplayBounds(displayID)

        // The window may not be enumerable the instant the app launches; retry
        // briefly (placement already ran before capture start, so this usually
        // hits on the first try).
        var targetWindow = resolveTargetWindow(pid: pid, displayBounds: displayBounds, in: content)
        var attempts = 0
        while targetWindow == nil && attempts < 10 {
            try await Task.sleep(nanoseconds: 300_000_000)
            let fresh = try await SCShareableContent.current
            targetWindow = resolveTargetWindow(pid: pid, displayBounds: displayBounds, in: fresh)
            attempts += 1
        }

        let filter: SCContentFilter
        let pxWidth: Int
        let pxHeight: Int
        if let window = targetWindow {
            filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            let rect = filter.contentRect
            pxWidth = max(2, Int((rect.width * scale).rounded()))
            pxHeight = max(2, Int((rect.height * scale).rounded()))
            socket.sendJSON([
                "t": "capture", "mode": "window",
                "windowId": Int(window.windowID),
                "pxWidth": pxWidth, "pxHeight": pxHeight, "scale": Double(scale)
            ])
        } else {
            filter = SCContentFilter(display: scDisplay, excludingWindows: [])
            pxWidth = max(2, fallbackWidth)
            pxHeight = max(2, fallbackHeight)
            socket.sendJSON([
                "t": "capture", "mode": "display-fallback",
                "pxWidth": pxWidth, "pxHeight": pxHeight
            ])
        }

        let config = SCStreamConfiguration()
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 6
        config.width = pxWidth
        config.height = pxHeight
        config.scalesToFit = false
        config.showsCursor = true

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.cate.nativehost.capture"))
        try await stream.startCapture()
        self.stream = stream

        startStatusTimer()
    }

    func stop() async {
        statusTimer?.cancel()
        statusTimer = nil
        if let stream = stream {
            try? await stream.stopCapture()
        }
        stream = nil
    }

    private func startStatusTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "com.cate.nativehost.status"))
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            self?.emitStatus()
        }
        timer.resume()
        statusTimer = timer
    }

    private func emitStatus() {
        tallyLock.lock()
        let frames = frameCount
        let complete = completeCount
        let idle = idleCount
        let suspended = suspendedCount
        tallyLock.unlock()
        socket.sendJSON([
            "t": "status",
            "frames": frames,
            "complete": complete,
            "idle": idle,
            "suspended": suspended
        ])
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else { return }

        var status: SCFrameStatus = .complete
        if let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let attachments = attachmentsArray.first,
           let rawStatus = attachments[.status] as? Int,
           let parsedStatus = SCFrameStatus(rawValue: rawStatus) {
            status = parsedStatus
        }

        tallyLock.lock()
        frameCount += 1
        switch status {
        case .complete: completeCount += 1
        case .idle: idleCount += 1
        case .suspended: suspendedCount += 1
        default: break
        }
        tallyLock.unlock()

        // Only complete/idle frames carry a usable image; skip encoding for
        // blank/suspended/started/stopped statuses (no new pixel data).
        guard status == .complete || status == .idle else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard let jpegData = Self.encodeJPEG(pixelBuffer: pixelBuffer, quality: jpegQuality) else { return }

        socket.sendJPEGFrame(jpegData)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stoppedWithError = "\(error)"
        socket.sendJSON(["t": "error", "message": "SCStream stopped: \(error)"])
    }

    // MARK: - JPEG encoding

    private static func encodeJPEG(pixelBuffer: CVPixelBuffer, quality: CGFloat) -> Data? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else { return nil }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let byteCount = bytesPerRow * height
        guard width > 0, height > 0, byteCount > 0 else { return nil }

        guard let provider = CGDataProvider(dataInfo: nil, data: baseAddress, size: byteCount, releaseData: { _, _, _ in }) else {
            return nil
        }

        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let cgImage = CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ) else { return nil }

        let outData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(outData as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(dest, cgImage, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return outData as Data
    }
}
