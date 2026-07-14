//
//  LiveCheckProbe.swift — `livecheck [bundleID]` subcommand.
//
//  Answers Q1 (does an app rendered off-screen on a CGVirtualDisplay keep producing
//  LIVE ScreenCaptureKit frames, or does macOS/App Nap freeze it?) in ONE command,
//  with an automatic GO/NO-GO/INCONCLUSIVE verdict — no manual PNG diffing.
//
//  Everything below runs in a single process so the virtual display's lifetime
//  (tied to the owning process, see CGVirtualDisplay.swift) is held for the whole
//  sequence: create display -> launch app -> AX-reposition its window onto the
//  display -> confirm it actually landed there -> SCStream the virtual display for
//  60s, tallying SCFrameStatus per frame -> print a verdict.
//
//  NOTE: like LaunchHelper.swift, this uses ApplicationServices (AXUIElement) for
//  window repositioning, which is outside the brief's core framework list but
//  required by the brief's own "launch onto the virtual display" section.
//

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

private let liveCheckRunSeconds = 60
private let liveCheckTickSeconds = 10
/// Consecutive `.suspended` frames in a row we consider a "sustained" freeze.
private let sustainedSuspendedRunThreshold = 10
/// Gap with zero frames delivered that we consider "stopped arriving entirely".
private let sustainedNoFrameGapSeconds: TimeInterval = 15.0
private let liveStatusFractionThreshold = 0.8

func runLiveCheck(bundleIDArg: String?) {
    let bundleID = bundleIDArg ?? "com.apple.Safari"
    print("[livecheck] === Q1 liveness self-check: virtual display + \(bundleID) + SCStream, one process ===")
    print("")

    // Step 1: create the headless virtual display.
    print("[livecheck] Step 1/5: creating headless 1920x1080 CGVirtualDisplay...")
    guard let handle = createReverseEngineeredVirtualDisplay(
        name: "Cate Spike LiveCheck Display",
        widthPx: 1920,
        heightPx: 1080,
        widthMM: 508,
        heightMM: 285
    ) else {
        print("")
        print("[livecheck] VERDICT: cannot be assessed — virtual display creation FAILED (see diagnostics above).")
        exit(1)
    }
    let displayID = handle.displayID
    let bounds = CGDisplayBounds(displayID)
    print("[livecheck]   CGDirectDisplayID = \(displayID)")
    print("[livecheck]   bounds = \(bounds)")
    print("")

    // Step 2: launch the target app.
    print("[livecheck] Step 2/5: launching \(bundleID)...")
    guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
        print("[livecheck] ERROR: could not resolve an app URL for bundle id '\(bundleID)'.")
        withExtendedLifetime(handle.displayObject) {}
        exit(1)
    }

    let launchSema = DispatchSemaphore(value: 0)
    var launchedApp: NSRunningApplication?
    let openConfig = NSWorkspace.OpenConfiguration()
    openConfig.activates = true
    NSWorkspace.shared.openApplication(at: appURL, configuration: openConfig) { app, error in
        if let error = error {
            print("[livecheck]   ERROR: openApplication failed: \(error)")
        }
        launchedApp = app
        launchSema.signal()
    }
    launchSema.wait()

    guard let app = launchedApp else {
        print("[livecheck] ERROR: app did not report as launched.")
        withExtendedLifetime(handle.displayObject) {}
        exit(1)
    }
    let pid = app.processIdentifier
    print("[livecheck]   launched PID=\(pid). Waiting 2.5s for its main window...")
    Thread.sleep(forTimeInterval: 2.5)
    print("")

    // Step 3: reposition its main window onto the virtual display via Accessibility.
    print("[livecheck] Step 3/5: repositioning main window via Accessibility API...")
    let axApp = AXUIElementCreateApplication(pid)
    var mainWindowRef: CFTypeRef?
    let mainWindowResult = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainWindowRef)
    if mainWindowResult == .success, let mainWindowRef = mainWindowRef {
        // Safe: kAXMainWindowAttribute returns an AXUIElement.
        let axWindow = unsafeBitCast(mainWindowRef, to: AXUIElement.self)
        var point = bounds.origin
        if let positionValue = AXValueCreate(.cgPoint, &point) {
            let setResult = AXUIElementSetAttributeValue(axWindow, kAXPositionAttribute as CFString, positionValue)
            print("[livecheck]   AXUIElementSetAttributeValue(kAXPositionAttribute) \(setResult == .success ? "reported SUCCESS." : "FAILED (\(setResult.rawValue)).")")
        } else {
            print("[livecheck]   ERROR: AXValueCreate(.cgPoint) failed.")
        }
    } else {
        print("[livecheck]   AXUIElementCopyAttributeValue(kAXMainWindowAttribute) FAILED with \(mainWindowResult.rawValue).")
        print("[livecheck]   (likely missing Accessibility permission for this process, or the app has no window yet)")
    }
    print("")

    // Step 4: confirm the app actually landed on the virtual display.
    print("[livecheck] Step 4/5: confirming a window of PID \(pid) intersects the virtual display bounds...")
    var landedOnVirtualDisplay = false
    if let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
        let matches = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
        for info in matches {
            var rect = CGRect.zero
            if let boundsDict = info[kCGWindowBounds as String] as? [String: Any] {
                _ = CGRectMakeWithDictionaryRepresentation(boundsDict as CFDictionary, &rect)
            }
            if rect.intersects(bounds) {
                landedOnVirtualDisplay = true
                print("[livecheck]   window bounds=\(rect) INTERSECTS virtual display bounds -> YES")
                break
            }
        }
    } else {
        print("[livecheck]   ERROR: CGWindowListCopyWindowInfo returned nil (unexpected).")
    }
    if !landedOnVirtualDisplay {
        print("[livecheck]   -> NO. The app is not visibly on the virtual display.")
        print("[livecheck]   The capture below will likely see an empty desktop; result will be INCONCLUSIVE.")
        print("[livecheck]   Proceeding anyway so the capture path itself still gets exercised.")
    }
    print("")

    // Step 5: SCStream the virtual display for 60s, tallying SCFrameStatus + a cheap
    // pixel-subsample hash per frame.
    print("[livecheck] Step 5/5: starting SCStream capture of the virtual display for \(liveCheckRunSeconds)s...")
    let tally = FrameTally()
    let captureSema = DispatchSemaphore(value: 0)
    var captureError: String?

    Task {
        do {
            let content = try await SCShareableContent.current
            guard let scDisplay = content.displays.first(where: { $0.displayID == displayID }) else {
                captureError = "virtual display \(displayID) was not found in SCShareableContent.current.displays " +
                    "(\(content.displays.count) display(s) visible to ScreenCaptureKit: " +
                    "\(content.displays.map { $0.displayID })). This itself is a finding: the virtual " +
                    "display may not be visible to SCK on this OS build/config."
                captureSema.signal()
                return
            }

            let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
            let streamConfig = SCStreamConfiguration()
            streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: 10) // request 10fps
            streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
            streamConfig.queueDepth = 6
            streamConfig.width = max(2, scDisplay.width)
            streamConfig.height = max(2, scDisplay.height)

            let stream = SCStream(filter: filter, configuration: streamConfig, delegate: tally)
            try stream.addStreamOutput(tally, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.cate.spike.livecheck"))
            try await stream.startCapture()

            print("[livecheck]   capture loop started (requesting 10fps). Running for \(liveCheckRunSeconds)s, printing every \(liveCheckTickSeconds)s...")
            print("")

            var tick = liveCheckTickSeconds
            while tick <= liveCheckRunSeconds {
                try await Task.sleep(nanoseconds: UInt64(liveCheckTickSeconds) * 1_000_000_000)
                tally.printSnapshot(atSeconds: tick)
                tick += liveCheckTickSeconds
            }

            try await stream.stopCapture()
        } catch {
            captureError = "\(error)"
        }
        captureSema.signal()
    }
    captureSema.wait()

    print("")
    if let captureError = captureError {
        print("[livecheck] ERROR: \(captureError)")
        print("[livecheck] If this is a permission error, run 'enumerate' first to trigger and grant Screen")
        print("[livecheck] Recording permission to this binary/terminal, then retry 'livecheck'.")
        print("")
        print("[livecheck] ============================================================")
        print("[livecheck] VERDICT: cannot be assessed — capture failed before the stream produced frames.")
        print("[livecheck] ============================================================")
        withExtendedLifetime(handle.displayObject) {}
        return
    }

    print("[livecheck] Final tally: \(tally.summary())")
    print("")
    printVerdict(tally: tally, landedOnVirtualDisplay: landedOnVirtualDisplay)

    // Keep the virtual display object alive until we are fully done observing it.
    withExtendedLifetime(handle.displayObject) {}
}

private func printVerdict(tally: FrameTally, landedOnVirtualDisplay: Bool) {
    print("[livecheck] ============================================================")
    if !landedOnVirtualDisplay {
        print("[livecheck] VERDICT: INCONCLUSIVE")
        print("[livecheck]   Reason: step 4 said the target app never landed on the virtual display, so any")
        print("[livecheck]   frames captured are of an empty/desktop virtual display, not the app under test.")
        print("[livecheck]   Numbers behind it: \(tally.summary())")
        print("[livecheck]   Next step: place a window on the virtual display manually and re-run, or try a")
        print("[livecheck]   different --bundleID app that reliably creates a main window.")
    } else if tally.totalFrames == 0 {
        print("[livecheck] VERDICT: NO-GO/FROZEN (no data)")
        print("[livecheck]   Reason: zero frames were delivered in \(liveCheckRunSeconds)s. Most likely this process")
        print("[livecheck]   lacks Screen Recording permission in this context — expected/fine for an unattended")
        print("[livecheck]   agent run. Grant Screen Recording to this binary/terminal in System Settings and")
        print("[livecheck]   re-run 'livecheck' to get a real verdict.")
    } else if tally.longestSuspendedRun >= sustainedSuspendedRunThreshold {
        print("[livecheck] VERDICT: NO-GO/FROZEN")
        print("[livecheck]   Reason: a sustained run of \(tally.longestSuspendedRun) consecutive .suspended frames")
        print("[livecheck]   (threshold \(sustainedSuspendedRunThreshold)) — the WindowServer stopped updating the off-screen window.")
        print("[livecheck]   Numbers behind it: \(tally.summary())")
    } else if tally.longestGapSeconds >= sustainedNoFrameGapSeconds {
        print("[livecheck] VERDICT: NO-GO/FROZEN")
        print("[livecheck]   Reason: a \(String(format: "%.1f", tally.longestGapSeconds))s gap with zero frames delivered")
        print("[livecheck]   (threshold \(String(format: "%.1f", sustainedNoFrameGapSeconds))s) — frames stopped arriving entirely for a while.")
        print("[livecheck]   Numbers behind it: \(tally.summary())")
    } else {
        let liveFraction = Double(tally.count(.complete) + tally.count(.idle)) / Double(tally.totalFrames)
        if liveFraction >= liveStatusFractionThreshold {
            print("[livecheck] VERDICT: GO/LIVE")
            print("[livecheck]   Reason: \(tally.totalFrames) frames arrived across \(liveCheckRunSeconds)s, \(Int(liveFraction * 100))% were")
            print("[livecheck]   complete/idle (threshold \(Int(liveStatusFractionThreshold * 100))%), \(tally.distinctFrameCount) distinct (content-changed)")
            print("[livecheck]   frames, no sustained suspension or gap. The off-screen window kept being")
            print("[livecheck]   serviced by the WindowServer — App Nap did NOT freeze it.")
            print("[livecheck]   Numbers behind it: \(tally.summary())")
        } else {
            print("[livecheck] VERDICT: NO-GO/FROZEN")
            print("[livecheck]   Reason: \(tally.totalFrames) frames arrived but only \(Int(liveFraction * 100))% were complete/idle")
            print("[livecheck]   (threshold \(Int(liveStatusFractionThreshold * 100))%, dominant status: \(tally.dominantStatusName)) — not clearly live.")
            print("[livecheck]   Numbers behind it: \(tally.summary())")
        }
    }
    print("[livecheck] ============================================================")
}

extension SCFrameStatus {
    fileprivate var name: String {
        switch self {
        case .complete: return "complete"
        case .idle: return "idle"
        case .blank: return "blank"
        case .suspended: return "suspended"
        case .started: return "started"
        case .stopped: return "stopped"
        default: return "unknown(\(rawValue))"
        }
    }
}

private let allFrameStatuses: [SCFrameStatus] = [.complete, .idle, .blank, .suspended, .started, .stopped]

/// Tallies SCFrameStatus counts + a cheap subsample hash across frames to detect
/// visually-distinct frames, without doing full frame diffing/PNG writes.
final class FrameTally: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private var counts: [SCFrameStatus: Int] = [:]
    private(set) var totalFrames = 0
    private(set) var distinctFrameCount = 0
    private var previousHash: UInt64?
    private var currentSuspendedRun = 0
    private(set) var longestSuspendedRun = 0
    private var lastFrameAt: Date?
    private(set) var longestGapSeconds: TimeInterval = 0
    private var lastPrintedTotal = 0

    func count(_ status: SCFrameStatus) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[status] ?? 0
    }

    var dominantStatusName: String {
        lock.lock(); defer { lock.unlock() }
        return counts.max(by: { $0.value < $1.value })?.key.name ?? "none"
    }

    func summary() -> String {
        lock.lock()
        let parts = allFrameStatuses.map { "\($0.name)=\(counts[$0] ?? 0)" }.joined(separator: " ")
        let s = "total=\(totalFrames) distinct=\(distinctFrameCount) longestSuspendedRun=\(longestSuspendedRun) " +
            "longestGap=\(String(format: "%.1f", longestGapSeconds))s [\(parts)]"
        lock.unlock()
        return s
    }

    func printSnapshot(atSeconds seconds: Int) {
        lock.lock()
        let delta = totalFrames - lastPrintedTotal
        lastPrintedTotal = totalFrames
        lock.unlock()
        print("[livecheck]   t=\(seconds)s (+\(delta) frames since last tick): \(summary())")
    }

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

        lock.lock()
        totalFrames += 1
        counts[status, default: 0] += 1
        let now = Date()
        if let last = lastFrameAt {
            let gap = now.timeIntervalSince(last)
            if gap > longestGapSeconds { longestGapSeconds = gap }
        }
        lastFrameAt = now
        if status == .suspended {
            currentSuspendedRun += 1
            if currentSuspendedRun > longestSuspendedRun { longestSuspendedRun = currentSuspendedRun }
        } else {
            currentSuspendedRun = 0
        }
        lock.unlock()

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let hash = Self.subsampleHash(pixelBuffer) {
            lock.lock()
            if previousHash == nil || previousHash != hash {
                distinctFrameCount += 1
            }
            previousHash = hash
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[livecheck] ERROR: stream stopped with error: \(error)")
    }

    /// FNV-1a hash over a stride-sampled subset of pixel bytes — a cheap liveness
    /// signal, not a full frame diff.
    private static func subsampleHash(_ pixelBuffer: CVPixelBuffer) -> UInt64? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let byteCount = bytesPerRow * height
        guard byteCount > 0 else { return nil }

        let ptr = base.assumingMemoryBound(to: UInt8.self)
        var hash: UInt64 = 0xcbf29ce484222325 // FNV-1a offset basis
        let prime: UInt64 = 0x100000001b3
        let stride = 997 // odd prime stride so we sample across rows, not just column 0
        var i = 0
        while i < byteCount {
            hash ^= UInt64(ptr[i])
            hash = hash &* prime
            i += stride
        }
        return hash
    }
}
