//
//  CaptureProbe.swift — `capture <displayID|windowID>` subcommand.
//
//  Starts an SCStream on the given target and writes one PNG per second for 60s
//  to spike/nativehost-spike/out/frame-<n>.png. Prints the IOSurfaceID per frame
//  (Q2 transport) so the human can watch for liveness by diffing frames (Q1).
//

import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import IOSurface
import ImageIO

func runCapture(targetArg: String) {
    guard let targetID = UInt32(targetArg) else {
        print("[capture] ERROR: target must be a numeric displayID or windowID (see 'enumerate').")
        return
    }

    // Expected invocation is `cd spike/nativehost-spike && swift run nativehost-spike capture ...`,
    // so "out" relative to the current directory lands at spike/nativehost-spike/out/.
    let resolvedDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("out", isDirectory: true)
    try? FileManager.default.createDirectory(at: resolvedDir, withIntermediateDirectories: true)
    print("[capture] Writing PNGs to \(resolvedDir.path)")
    print("[capture] Target: \(targetID) (will try to match a display first, then a window)")
    print("")

    let sema = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.current

            let filter: SCContentFilter
            let config = SCStreamConfiguration()
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true
            config.queueDepth = 5

            if let display = content.displays.first(where: { $0.displayID == targetID }) {
                print("[capture] Target \(targetID) matched a DISPLAY. Capturing full display.")
                filter = SCContentFilter(display: display, excludingWindows: [])
                config.width = max(2, display.width)
                config.height = max(2, display.height)
            } else if let window = content.windows.first(where: { $0.windowID == targetID }) {
                print("[capture] Target \(targetID) matched a WINDOW (\"\(window.title ?? "<untitled>")\"). Capturing window.")
                filter = SCContentFilter(desktopIndependentWindow: window)
                config.width = max(2, Int(window.frame.width))
                config.height = max(2, Int(window.frame.height))
            } else {
                print("[capture] ERROR: \(targetID) did not match any current display or on-screen window.")
                print("[capture] Run 'enumerate' first to find a valid displayID or windowID.")
                sema.signal()
                return
            }

            let writer = FrameWriter(outputDir: resolvedDir)
            let stream = SCStream(filter: filter, configuration: config, delegate: writer)
            try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.cate.spike.capture"))
            try await stream.startCapture()

            print("[capture] Streaming for 60s, saving ~1 frame/sec.")
            print("[capture] OBSERVE (Q1 liveness): do frame-*.png files keep changing over the full 60s,")
            print("[capture] or do they freeze after a few seconds (App Nap / occlusion)?")
            print("")

            try await Task.sleep(nanoseconds: 60_000_000_000)

            try await stream.stopCapture()
            print("")
            print("[capture] Stopped after 60s. Saved \(writer.savedCount) frame(s) to \(resolvedDir.path)")
        } catch {
            print("[capture] ERROR: \(error)")
            print("[capture] If this is a permission error, run 'enumerate' first to trigger and grant")
            print("[capture] Screen Recording permission, then retry.")
        }
        sema.signal()
    }
    sema.wait()
}

final class FrameWriter: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputDir: URL
    private(set) var savedCount = 0
    private var lastSavedAt: Date = .distantPast
    private let saveInterval: TimeInterval = 1.0

    init(outputDir: URL) {
        self.outputDir = outputDir
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSavedAt) >= saveInterval else { return }
        lastSavedAt = now

        savedCount += 1
        let n = savedCount

        // Q2 (transport): prove the buffer is IOSurface-backed and that a global lookup succeeds.
        if let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue() {
            let surfaceID = IOSurfaceGetID(surface)
            let lookupOK = IOSurfaceLookup(surfaceID) != nil
            print("[capture] frame \(n): IOSurface-backed. IOSurfaceID=\(surfaceID) globalLookupSucceeded=\(lookupOK)")
        } else {
            print("[capture] frame \(n): pixel buffer is NOT IOSurface-backed (unexpected for SCStream output on this OS).")
        }

        guard let cgImage = Self.makeCGImage(from: pixelBuffer) else {
            print("[capture] frame \(n): failed to build CGImage from pixel buffer, skipping PNG write.")
            return
        }

        let url = outputDir.appendingPathComponent("frame-\(n).png")
        if Self.writePNG(cgImage: cgImage, to: url) {
            print("[capture] frame \(n): wrote \(url.path)")
        } else {
            print("[capture] frame \(n): FAILED to write PNG to \(url.path)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[capture] ERROR: stream stopped with error: \(error)")
    }

    private static func makeCGImage(from pixelBuffer: CVPixelBuffer) -> CGImage? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }

        let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        guard pixelFormat == kCVPixelFormatType_32BGRA else {
            print("[capture] WARNING: unexpected pixel format \(pixelFormat) (expected 32BGRA), skipping frame.")
            return nil
        }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let byteCount = bytesPerRow * height

        let data = Data(bytes: baseAddress, count: byteCount)
        guard let provider = CGDataProvider(data: data as CFData) else { return nil }

        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)

        return CGImage(
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
        )
    }

    private static func writePNG(cgImage: CGImage, to url: URL) -> Bool {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            return false
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        return CGImageDestinationFinalize(dest)
    }
}
