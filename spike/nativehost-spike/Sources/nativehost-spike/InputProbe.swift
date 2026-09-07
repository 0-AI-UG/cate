//
//  InputProbe.swift — `input <windowID> <x> <y>` subcommand.
//
//  Posts a CGEvent left-click at window-local (x,y) (mapped to global coords via
//  the window's on-screen frame from CGWindowListCopyWindowInfo), then types the
//  fixed test string "hello". First run triggers the Accessibility prompt (Q5).
//  Q3: does the click/keystroke land in the target window?
//

import Foundation
import CoreGraphics

func runInput(windowID: UInt32, x: Double, y: Double) {
    print("[input] Looking up window \(windowID) via CGWindowListCopyWindowInfo to find its on-screen frame...")
    guard let frame = windowFrame(forWindowID: windowID) else {
        print("[input] ERROR: window \(windowID) not found in CGWindowListCopyWindowInfo(.optionAll).")
        print("[input] Run 'enumerate' or 'childwindows <pid>' to find a valid windowID.")
        return
    }

    let globalPoint = CGPoint(x: frame.origin.x + x, y: frame.origin.y + y)
    print("[input] Window frame = \(frame)")
    print("[input] Window-local (\(x), \(y)) -> global \(globalPoint)")
    print("")
    print("[input] Posting a CGEvent may trigger the macOS Accessibility permission prompt on first run.")
    print("[input] OBSERVE (Q5): note which app name the Accessibility prompt attributes to.")
    print("")

    guard let source = CGEventSource(stateID: .hidSystemState) else {
        print("[input] ERROR: could not create CGEventSource(.hidSystemState). Accessibility permission")
        print("[input] may not be granted to the process running this binary.")
        return
    }

    postClick(at: globalPoint, source: source)
    print("[input] Posted left click at global \(globalPoint).")
    print("[input] OBSERVE (Q3): did the click register in the target window (e.g. focus a text field)?")

    usleep(300_000)
    print("")
    print("[input] Typing test string \"hello\" via CGEvent keyboard events...")
    typeString("hello", source: source)
    print("[input] Done. OBSERVE (Q3): did the keystrokes land in the target window's focused control?")
}

private func postClick(at point: CGPoint, source: CGEventSource) {
    if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
    } else {
        print("[input] ERROR: failed to create mouseDown CGEvent.")
    }
    usleep(50_000)
    if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
        up.post(tap: .cghidEventTap)
    } else {
        print("[input] ERROR: failed to create mouseUp CGEvent.")
    }
}

func windowFrame(forWindowID windowID: UInt32) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return nil }
    for info in list {
        guard let number = info[kCGWindowNumber as String] as? UInt32, number == windowID else { continue }
        guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
        var rect = CGRect.zero
        _ = CGRectMakeWithDictionaryRepresentation(boundsDict as CFDictionary, &rect)
        return rect
    }
    return nil
}

// Minimal US-QWERTY virtual keycode map (HIToolbox kVK_ANSI_* values) sufficient
// for the fixed literal "hello" used by this probe.
private let usKeycodes: [Character: CGKeyCode] = [
    "h": 4, "e": 14, "l": 37, "o": 31
]

func typeString(_ string: String, source: CGEventSource) {
    for char in string {
        guard let keycode = usKeycodes[char] else {
            print("[input] WARNING: no keycode mapping for '\(char)', skipping.")
            continue
        }
        if let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: true) {
            keyDown.post(tap: .cghidEventTap)
        }
        usleep(30_000)
        if let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: false) {
            keyUp.post(tap: .cghidEventTap)
        }
        usleep(30_000)
    }
}
