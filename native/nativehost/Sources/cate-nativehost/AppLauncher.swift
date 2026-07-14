//
//  AppLauncher.swift
//
//  Launches an app onto a headless virtual display and attempts to place its
//  main window on that display's bounds via the Accessibility API, with
//  retry — apps can take a few seconds to build their AX tree after launch,
//  so a single immediate attempt is unreliable (this was observed as a
//  ~2s-sleep-then-single-try in the throwaway spike; here we poll instead).
//
//  Placement is a known-flaky area (AX permission, sandboxing, apps that
//  don't expose kAXPositionAttribute as settable, etc.) — failure here is
//  reported, never treated as fatal. The caller proceeds to capture
//  regardless so the rest of the pipeline stays exercised.
//

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

enum AppLauncherError: Error, CustomStringConvertible {
    case appNotResolvable(String)
    case launchFailed(String)

    var description: String {
        switch self {
        case .appNotResolvable(let id): return "could not resolve an application URL for bundle id '\(id)'"
        case .launchFailed(let reason): return "NSWorkspace failed to launch the application: \(reason)"
        }
    }
}

struct PlacementResult {
    let placed: Bool
    let detail: String
}

enum AppLauncher {
    /// Launches `bundleID` via NSWorkspace and returns the running app once
    /// NSWorkspace reports it launched (does not wait for a main window).
    static func launch(bundleID: String) throws -> NSRunningApplication {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            throw AppLauncherError.appNotResolvable(bundleID)
        }

        let sema = DispatchSemaphore(value: 0)
        var result: NSRunningApplication?
        var launchError: String?
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, error in
            if let error = error {
                launchError = "\(error)"
            }
            result = app
            sema.signal()
        }
        sema.wait()

        if let app = result {
            return app
        }
        throw AppLauncherError.launchFailed(launchError ?? "unknown error, NSWorkspace returned no NSRunningApplication")
    }

    /// Polls for the app's AX main window and sets its position + size to
    /// match `bounds`, retrying until it sticks or `timeout` elapses. Apps
    /// build their AX tree asynchronously after launch, so the first few
    /// attempts commonly fail with "no main window yet" — that is expected,
    /// not an error condition, until the timeout is reached.
    static func placeMainWindow(
        pid: pid_t,
        bounds: CGRect,
        timeout: TimeInterval = 8.0,
        pollInterval: TimeInterval = 0.3
    ) -> PlacementResult {
        let axApp = AXUIElementCreateApplication(pid)
        let deadline = Date().addingTimeInterval(timeout)
        var lastDetail = "no attempt made"

        while Date() < deadline {
            var mainWindowRef: CFTypeRef?
            let mainWindowResult = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainWindowRef)
            guard mainWindowResult == .success, let mainWindowRef = mainWindowRef else {
                lastDetail = "kAXMainWindowAttribute unavailable (AXError=\(mainWindowResult.rawValue))"
                Thread.sleep(forTimeInterval: pollInterval)
                continue
            }
            // Safe: kAXMainWindowAttribute returns an AXUIElement.
            let axWindow = unsafeBitCast(mainWindowRef, to: AXUIElement.self)

            var point = bounds.origin
            var size = bounds.size
            guard let positionValue = AXValueCreate(.cgPoint, &point),
                  let sizeValue = AXValueCreate(.cgSize, &size)
            else {
                lastDetail = "AXValueCreate failed"
                Thread.sleep(forTimeInterval: pollInterval)
                continue
            }

            let posResult = AXUIElementSetAttributeValue(axWindow, kAXPositionAttribute as CFString, positionValue)
            let sizeResult = AXUIElementSetAttributeValue(axWindow, kAXSizeAttribute as CFString, sizeValue)

            if posResult == .success && sizeResult == .success {
                return PlacementResult(placed: true, detail: "kAXPositionAttribute + kAXSizeAttribute set successfully")
            }
            lastDetail = "AXUIElementSetAttributeValue failed (position=\(posResult.rawValue), size=\(sizeResult.rawValue))"
            Thread.sleep(forTimeInterval: pollInterval)
        }

        return PlacementResult(placed: false, detail: "timed out after \(timeout)s: \(lastDetail)")
    }

    /// Confirms a window owned by `pid` currently intersects `bounds`, via
    /// CGWindowListCopyWindowInfo (does not depend on AX permission).
    static func isOnDisplay(pid: pid_t, bounds: CGRect) -> Bool {
        guard let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        for info in list where (info[kCGWindowOwnerPID as String] as? Int32) == pid {
            var rect = CGRect.zero
            if let boundsDict = info[kCGWindowBounds as String] as? [String: Any] {
                _ = CGRectMakeWithDictionaryRepresentation(boundsDict as CFDictionary, &rect)
            }
            if rect.intersects(bounds) {
                return true
            }
        }
        return false
    }

    /// Terminates the launched app. Best-effort: tries a graceful terminate
    /// first, then force-terminate if it hasn't exited shortly after.
    static func terminate(_ app: NSRunningApplication) {
        guard !app.isTerminated else { return }
        app.terminate()
        let deadline = Date().addingTimeInterval(2.0)
        while !app.isTerminated && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if !app.isTerminated {
            app.forceTerminate()
        }
    }
}
