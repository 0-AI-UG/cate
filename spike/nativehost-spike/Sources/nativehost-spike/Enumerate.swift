//
//  Enumerate.swift — `enumerate` subcommand.
//
//  Lists SCShareableContent.current displays + on-screen windows. First run
//  triggers the Screen-Recording permission prompt (Q5).
//

import Foundation
import ScreenCaptureKit

func runEnumerate() {
    print("[enumerate] Requesting SCShareableContent.current — this may trigger the macOS")
    print("[enumerate] Screen-Recording permission prompt if it hasn't been granted yet.")
    print("[enumerate] OBSERVE (Q5): note which app name the prompt attributes this request to.")
    print("")

    let sema = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.current

            print("=== Displays (\(content.displays.count)) ===")
            for display in content.displays {
                print("  displayID=\(display.displayID) frame=\(display.frame) width=\(display.width) height=\(display.height)")
            }

            print("")
            print("=== On-screen windows (\(content.windows.count)) ===")
            for window in content.windows {
                let title = window.title ?? "<untitled>"
                let owner = window.owningApplication?.applicationName ?? "<unknown>"
                let pid = window.owningApplication?.processID ?? -1
                print("  windowID=\(window.windowID) title=\"\(title)\" owner=\"\(owner)\" ownerPID=\(pid) frame=\(window.frame) onScreen=\(window.isOnScreen) layer=\(window.windowLayer)")
            }

            print("")
            print("[enumerate] Done. Use a windowID above with 'capture', 'input', or a displayID with 'capture'.")
            print("[enumerate] Use an ownerPID above with 'childwindows <pid>'.")
        } catch {
            print("[enumerate] ERROR: SCShareableContent.current failed: \(error)")
            print("[enumerate] This usually means Screen-Recording permission has not been granted to the")
            print("[enumerate] process running this binary. Grant it in System Settings > Privacy & Security >")
            print("[enumerate] Screen Recording, then re-run 'enumerate'.")
        }
        sema.signal()
    }
    sema.wait()
}
