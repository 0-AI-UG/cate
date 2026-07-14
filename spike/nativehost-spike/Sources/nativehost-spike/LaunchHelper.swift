//
//  LaunchHelper.swift — optional `launch <bundleID-or-path> <displayID>` subcommand.
//
//  Launches an app via NSWorkspace, waits briefly, then attempts to reposition its
//  main window onto the given CGVirtualDisplay's bounds using the Accessibility API
//  (AXUIElementSetAttributeValue kAXPositionAttribute). Best-effort: AX-based window
//  placement is itself one of the risks this spike needs to surface, so failures are
//  reported clearly rather than retried/hidden.
//
//  NOTE: ApplicationServices (AXUIElement) is not in the brief's core "system
//  frameworks only" list (ScreenCaptureKit/CoreGraphics/CoreMedia/CoreVideo/
//  IOSurface/AppKit/ImageIO), but the brief's own "Launching an app onto the
//  virtual display" section explicitly requires AXUIElement + kAXPositionAttribute,
//  so it is used here for this one subcommand only.
//

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

func runLaunch(bundleIDOrPath: String, displayIDArg: String) {
    guard let displayID = UInt32(displayIDArg) else {
        print("[launch] ERROR: displayID must be numeric (the CGDirectDisplayID printed by 'virtualdisplay').")
        return
    }

    print("[launch] Resolving app for '\(bundleIDOrPath)'...")
    let appURL: URL?
    if bundleIDOrPath.hasPrefix("/") {
        appURL = URL(fileURLWithPath: bundleIDOrPath)
    } else {
        appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIDOrPath)
    }
    guard let url = appURL else {
        print("[launch] ERROR: could not resolve an app URL for '\(bundleIDOrPath)'.")
        print("[launch] Pass either an absolute .app path or a bundle identifier (e.g. com.apple.TextEdit).")
        return
    }
    print("[launch] Launching \(url.path) ...")

    let sema = DispatchSemaphore(value: 0)
    var launchedApp: NSRunningApplication?
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
        if let error = error {
            print("[launch] ERROR: openApplication failed: \(error)")
        }
        launchedApp = app
        sema.signal()
    }
    sema.wait()

    guard let app = launchedApp else {
        print("[launch] ERROR: app did not report as launched.")
        return
    }
    print("[launch] Launched PID=\(app.processIdentifier). Waiting 2s for the app to create its main window...")
    Thread.sleep(forTimeInterval: 2.0)

    guard let bounds = displayBounds(for: displayID) else {
        print("[launch] ERROR: could not resolve bounds for displayID \(displayID).")
        print("[launch] Note: CGVirtualDisplay's lifetime is tied to the process that created it — 'launch'")
        print("[launch] cannot target a display created by a separate, already-exited 'virtualdisplay' run.")
        print("[launch] This subcommand is best exercised by extending 'virtualdisplay' to also launch (a")
        print("[launch] follow-up if this spike goes GO), or by running both probes in one process.")
        return
    }
    print("[launch] Target display bounds: \(bounds)")

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var mainWindowRef: CFTypeRef?
    let mainWindowResult = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainWindowRef)
    guard mainWindowResult == .success, let mainWindowRef = mainWindowRef else {
        print("[launch] ERROR: AXUIElementCopyAttributeValue(kAXMainWindowAttribute) failed with \(mainWindowResult.rawValue).")
        print("[launch] This likely means Accessibility permission has not been granted to this process, or")
        print("[launch] the target app has no main window yet. Grant Accessibility in System Settings and retry.")
        return
    }
    // Safe: AXUIElementCopyAttributeValue for kAXMainWindowAttribute returns an AXUIElement.
    let axWindow = unsafeBitCast(mainWindowRef, to: AXUIElement.self)

    var point = bounds.origin
    guard let positionValue = AXValueCreate(.cgPoint, &point) else {
        print("[launch] ERROR: AXValueCreate(.cgPoint) failed.")
        return
    }
    let setResult = AXUIElementSetAttributeValue(axWindow, kAXPositionAttribute as CFString, positionValue)
    if setResult == .success {
        print("[launch] AXUIElementSetAttributeValue(kAXPositionAttribute) reported SUCCESS.")
    } else {
        print("[launch] AXUIElementSetAttributeValue(kAXPositionAttribute) FAILED with \(setResult.rawValue).")
        print("[launch] Window placement via AX is a known risk area for this feature — see FINDINGS.md.")
    }
    print("[launch] OBSERVE: did the app's window visually move onto the phantom display bounds?")
}

private func displayBounds(for displayID: CGDirectDisplayID) -> CGRect? {
    guard isKnownDisplay(displayID) else { return nil }
    return CGDisplayBounds(displayID)
}

private func isKnownDisplay(_ displayID: CGDirectDisplayID) -> Bool {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    guard displayCount > 0 else { return false }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    CGGetActiveDisplayList(displayCount, &displays, &displayCount)
    return displays.contains(displayID)
}
