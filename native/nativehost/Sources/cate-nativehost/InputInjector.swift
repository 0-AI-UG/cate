//
//  InputInjector.swift
//
//  Injects mouse + keyboard events into the captured app via CGEvent, posted
//  directly to the app's PID (CGEventPostToPid) so they land even though the
//  window lives on a headless virtual display and is never frontmost.
//
//  The renderer sends pointer positions as NORMALIZED coordinates (0…1) over
//  the captured window content; we convert them to global display points using
//  the window's live frame (origin + point size), kept up to date by the
//  resize path. Keyboard events arrive as macOS virtual key codes + modifier
//  flags (the renderer maps the physical `KeyboardEvent.code` → key code), so
//  both text entry and shortcuts (⌘C, arrows, …) reproduce correctly.
//

import Foundation
import CoreGraphics

struct WindowGeometry {
    var globalOrigin: CGPoint   // window top-left in global display points
    var pointSize: CGSize       // window size in points
}

final class InputInjector {
    private let pid: pid_t
    private let lock = NSLock()
    private var geometry: WindowGeometry
    private var leftDown = false
    private var rightDown = false

    init(pid: pid_t, geometry: WindowGeometry) {
        self.pid = pid
        self.geometry = geometry
    }

    func updateGeometry(_ g: WindowGeometry) {
        lock.lock(); geometry = g; lock.unlock()
    }

    private func globalPoint(nx: Double, ny: Double) -> CGPoint {
        lock.lock(); let g = geometry; lock.unlock()
        return CGPoint(
            x: g.globalOrigin.x + CGFloat(nx) * g.pointSize.width,
            y: g.globalOrigin.y + CGFloat(ny) * g.pointSize.height
        )
    }

    /// Entry point for an inbound 0x10 input payload (already JSON-parsed).
    func handle(_ j: [String: Any]) {
        switch j["k"] as? String {
        case "m": handleMouse(j)
        case "s": handleScroll(j)
        case "k": handleKey(j)
        default: break
        }
    }

    // MARK: - Mouse

    private func handleMouse(_ j: [String: Any]) {
        guard let action = j["a"] as? String,
              let nx = j["nx"] as? Double, let ny = j["ny"] as? Double else { return }
        let button = (j["b"] as? Int) ?? 0
        let pt = globalPoint(nx: nx, ny: ny)

        let type: CGEventType
        let cgButton: CGMouseButton
        switch (action, button) {
        case ("down", 1): type = .rightMouseDown; cgButton = .right; rightDown = true
        case ("up", 1):   type = .rightMouseUp;   cgButton = .right; rightDown = false
        case ("down", _): type = .leftMouseDown;  cgButton = .left;  leftDown = true
        case ("up", _):   type = .leftMouseUp;    cgButton = .left;  leftDown = false
        case ("move", _), ("drag", _):
            if leftDown { type = .leftMouseDragged; cgButton = .left }
            else if rightDown { type = .rightMouseDragged; cgButton = .right }
            else { type = .mouseMoved; cgButton = .left }
        default: return
        }

        guard let ev = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: pt, mouseButton: cgButton) else { return }
        if let clicks = j["clicks"] as? Int, clicks > 1 {
            ev.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        }
        ev.flags = flags(from: j)
        ev.postToPid(pid)
    }

    // MARK: - Scroll

    private func handleScroll(_ j: [String: Any]) {
        let dy = Int32(clamping: Int((j["dy"] as? Double) ?? 0))
        let dx = Int32(clamping: Int((j["dx"] as? Double) ?? 0))
        guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
        ev.postToPid(pid)
    }

    // MARK: - Keyboard

    private func handleKey(_ j: [String: Any]) {
        let down = (j["a"] as? String) == "down"
        let f = flags(from: j)

        if let code = j["code"] as? Int, code >= 0 {
            guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else { return }
            ev.flags = f
            ev.postToPid(pid)
            return
        }
        // Fallback: unicode text (no key code available for this character).
        if let text = j["text"] as? String, !text.isEmpty {
            guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { return }
            var utf16 = Array(text.utf16)
            ev.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            ev.flags = f
            ev.postToPid(pid)
        }
    }

    // MARK: - Modifier flags

    private func flags(from j: [String: Any]) -> CGEventFlags {
        var f = CGEventFlags()
        if (j["cmd"] as? Bool) == true { f.insert(.maskCommand) }
        if (j["shift"] as? Bool) == true { f.insert(.maskShift) }
        if (j["opt"] as? Bool) == true { f.insert(.maskAlternate) }
        if (j["ctrl"] as? Bool) == true { f.insert(.maskControl) }
        return f
    }
}
