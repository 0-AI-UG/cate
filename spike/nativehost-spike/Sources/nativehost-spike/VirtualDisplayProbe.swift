//
//  VirtualDisplayProbe.swift — `virtualdisplay` subcommand.
//
//  Creates a headless CGVirtualDisplay (private API, see CGVirtualDisplay.swift)
//  and holds it alive for 60s so a human can confirm in System Settings > Displays
//  that a phantom display exists and nothing appears on real screens (Q1 support).
//

import Foundation
import CoreGraphics

func runVirtualDisplay() {
    print("[virtualdisplay] Attempting to create a headless CGVirtualDisplay via the private")
    print("[virtualdisplay] CoreGraphics API. This is reverse-engineered, undocumented API —")
    print("[virtualdisplay] see the header comment in CGVirtualDisplay.swift for caveats.")
    print("")

    guard let handle = createReverseEngineeredVirtualDisplay(
        name: "Cate Spike Virtual Display",
        widthPx: 1920,
        heightPx: 1080,
        widthMM: 508,
        heightMM: 285
    ) else {
        print("")
        print("[virtualdisplay] FAILED — see diagnostics above for exactly which class/selector")
        print("[virtualdisplay] could not be located or invoked. This is a valid, actionable spike")
        print("[virtualdisplay] result: the private CGVirtualDisplay interface needs further reverse")
        print("[virtualdisplay] engineering (or an alternative headless-display strategy) before Q1")
        print("[virtualdisplay] can be answered on this macOS build.")
        exit(1)
    }

    print("")
    print("[virtualdisplay] SUCCESS — created virtual display.")
    print("[virtualdisplay]   CGDirectDisplayID = \(handle.displayID)")
    print("[virtualdisplay]   requested bounds  = \(handle.widthPx) x \(handle.heightPx) px")
    let liveBounds = CGDisplayBounds(handle.displayID)
    print("[virtualdisplay]   CGDisplayBounds(\(handle.displayID)) = \(liveBounds)")
    print("")
    print("[virtualdisplay] Holding for 60s. OBSERVE now:")
    print("[virtualdisplay]   1. Open System Settings > Displays — a phantom display named")
    print("[virtualdisplay]      \"Cate Spike Virtual Display\" should be listed there.")
    print("[virtualdisplay]   2. Confirm nothing from it is mirrored onto your real screens.")
    print("[virtualdisplay]   3. Note the CGDirectDisplayID above for use with 'capture <id>' and 'launch'.")
    print("[virtualdisplay] (Q1 support) Press Ctrl-C to stop early; the display tears down when this")
    print("[virtualdisplay] process exits (CGVirtualDisplay's lifetime is tied to the owning process).")

    let deadline = Date().addingTimeInterval(60)
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(1))
    }

    print("[virtualdisplay] Done holding. Releasing virtual display object.")
    withExtendedLifetime(handle.displayObject) {}
}
