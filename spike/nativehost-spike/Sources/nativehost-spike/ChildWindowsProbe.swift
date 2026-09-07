//
//  ChildWindowsProbe.swift — `childwindows <pid>` subcommand.
//
//  Polls CGWindowListCopyWindowInfo(.optionAll) every 500ms for 20s, printing
//  windows owned by <pid> — so when the human right-clicks the target app, a new
//  context-menu window shows up as a separate entry (Q4).
//

import Foundation
import CoreGraphics

func runChildWindows(pid: Int32) {
    print("[childwindows] Polling CGWindowListCopyWindowInfo(.optionAll) every 500ms for 20s,")
    print("[childwindows] filtering ownerPID == \(pid).")
    print("")
    print("[childwindows] OBSERVE (Q4): right-click inside the target app now — does a NEW window")
    print("[childwindows]              entry (a separate context-menu window) appear below, with a")
    print("[childwindows]              bounds rect positioned near where you clicked?")
    print("")

    var previousWindowNumbers = Set<UInt32>()
    let iterations = 40 // 20s / 500ms

    for i in 0..<iterations {
        guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
            print("[childwindows] ERROR: CGWindowListCopyWindowInfo returned nil (unexpected).")
            break
        }

        let matches = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
        let currentNumbers = Set(matches.compactMap { $0[kCGWindowNumber as String] as? UInt32 })
        let newOnes = currentNumbers.subtracting(previousWindowNumbers)

        let t = String(format: "%.1f", Double(i) * 0.5)
        print("[childwindows] t=\(t)s windows=\(matches.count)\(newOnes.isEmpty ? "" : "  NEW=\(newOnes)")")

        for info in matches {
            let number = info[kCGWindowNumber as String] as? UInt32 ?? 0
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            var rect = CGRect.zero
            if let boundsDict = info[kCGWindowBounds as String] as? [String: Any] {
                _ = CGRectMakeWithDictionaryRepresentation(boundsDict as CFDictionary, &rect)
            }
            let name = info[kCGWindowName as String] as? String ?? "<untitled>"
            let marker = newOnes.contains(number) ? "  <-- NEW" : ""
            print("    #\(number) layer=\(layer) name=\"\(name)\" bounds=\(rect)\(marker)")
        }

        previousWindowNumbers = currentNumbers
        usleep(500_000)
    }

    print("")
    print("[childwindows] Done.")
}
