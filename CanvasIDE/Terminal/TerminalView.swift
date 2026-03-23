import AppKit
import QuartzCore

/// NSView that hosts a Ghostty terminal rendered via Metal.
/// This IS the surface view — Ghostty renders directly into its CAMetalLayer.
final class TerminalView: NSView {

    // MARK: - State

    private(set) var surface: ghostty_surface_t?
    private var hasSurface: Bool { surface != nil }

    // MARK: - NSView Overrides

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        wantsLayer = true
    }

    // Use CAMetalLayer as the backing layer so Ghostty can render via Metal
    override func makeBackingLayer() -> CALayer {
        let metalLayer = CAMetalLayer()
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.isOpaque = true
        metalLayer.framebufferOnly = false
        return metalLayer
    }

    // MARK: - Surface Lifecycle

    /// Attach a Ghostty surface to this view. Call once after the view has a window.
    func attachSurface() {
        guard surface == nil else { return }
        surface = GhosttyAppManager.shared.createSurface(in: self)
        if surface == nil {
            print("TerminalView: failed to create Ghostty surface")
        }
        updateSurfaceSize()
    }

    /// Tear down the surface. The view becomes blank after this.
    func detachSurface() {
        guard let s = surface else { return }
        ghostty_surface_free(s)
        surface = nil
    }

    deinit {
        // ghostty_surface_free is safe to call from deinit on main thread
        if let s = surface {
            ghostty_surface_free(s)
        }
    }

    // MARK: - Layout

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, !hasSurface {
            attachSurface()
        }
        updateSurfaceSize()
    }

    override func layout() {
        super.layout()
        updateSurfaceSize()
    }

    private func updateSurfaceSize() {
        guard let surface else { return }
        let scale = window?.backingScaleFactor ?? 2.0
        let w = UInt32(bounds.width  * scale)
        let h = UInt32(bounds.height * scale)
        guard w > 0, h > 0 else { return }
        // TODO: verify ghostty_surface_set_size exists in linked GhosttyKit version
        ghostty_surface_set_size(surface, w, h)
    }

    // MARK: - Focus

    @discardableResult
    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if let surface { ghostty_surface_set_focus(surface, true) }
        return result
    }

    @discardableResult
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if let surface { ghostty_surface_set_focus(surface, false) }
        return result
    }

    // MARK: - Keyboard Events

    override func keyDown(with event: NSEvent) {
        guard let surface else { super.keyDown(with: event); return }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action   = GHOSTTY_ACTION_PRESS
        keyEvent.keycode  = UInt32(event.keyCode)
        keyEvent.mods     = ghosttyMods(from: event.modifierFlags)
        keyEvent.consumed_mods = ghostty_input_mods_e(rawValue: 0)
        keyEvent.unshifted_codepoint = 0
        keyEvent.composing = false

        // Pass the UTF-8 text for printable characters
        if let chars = event.characters {
            chars.withCString { ptr in
                keyEvent.text = ptr
                ghostty_surface_key(surface, keyEvent)
            }
        } else {
            ghostty_surface_key(surface, keyEvent)
        }
    }

    override func keyUp(with event: NSEvent) {
        guard let surface else { super.keyUp(with: event); return }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action   = GHOSTTY_ACTION_RELEASE
        keyEvent.keycode  = UInt32(event.keyCode)
        keyEvent.mods     = ghosttyMods(from: event.modifierFlags)
        keyEvent.consumed_mods = ghostty_input_mods_e(rawValue: 0)
        keyEvent.unshifted_codepoint = 0
        keyEvent.composing = false
        ghostty_surface_key(surface, keyEvent)
    }

    override func flagsChanged(with event: NSEvent) {
        // Modifier-only key events (Shift, Ctrl, etc.)
        guard let surface else { super.flagsChanged(with: event); return }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action   = GHOSTTY_ACTION_PRESS
        keyEvent.keycode  = UInt32(event.keyCode)
        keyEvent.mods     = ghosttyMods(from: event.modifierFlags)
        keyEvent.consumed_mods = ghostty_input_mods_e(rawValue: 0)
        keyEvent.unshifted_codepoint = 0
        keyEvent.composing = false
        ghostty_surface_key(surface, keyEvent)
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
        ghostty_surface_mouse_button(
            surface,
            GHOSTTY_MOUSE_PRESS,
            GHOSTTY_MOUSE_LEFT,
            ghosttyMods(from: event.modifierFlags)
        )
    }

    override func mouseUp(with event: NSEvent) {
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
        ghostty_surface_mouse_button(
            surface,
            GHOSTTY_MOUSE_RELEASE,
            GHOSTTY_MOUSE_LEFT,
            ghosttyMods(from: event.modifierFlags)
        )
    }

    override func rightMouseDown(with event: NSEvent) {
        guard let surface else { super.rightMouseDown(with: event); return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
        ghostty_surface_mouse_button(
            surface,
            GHOSTTY_MOUSE_PRESS,
            GHOSTTY_MOUSE_RIGHT,
            ghosttyMods(from: event.modifierFlags)
        )
    }

    override func rightMouseUp(with event: NSEvent) {
        guard let surface else { super.rightMouseUp(with: event); return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
        ghostty_surface_mouse_button(
            surface,
            GHOSTTY_MOUSE_RELEASE,
            GHOSTTY_MOUSE_RIGHT,
            ghosttyMods(from: event.modifierFlags)
        )
    }

    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        let xDelta = event.scrollingDeltaX
        let yDelta = event.scrollingDeltaY
        // ghostty_input_scroll_mods_t is an int bitmask of keyboard mods.
        // Precision (pixel vs line) is communicated via hasPreciseScrollingDeltas
        // by scaling the deltas appropriately before passing them.
        // When hasPreciseScrollingDeltas is false, deltas are already in line units.
        let scrollMods: ghostty_input_scroll_mods_t = ghostty_input_scroll_mods_t(ghosttyMods(from: event.modifierFlags).rawValue)
        ghostty_surface_mouse_scroll(
            surface,
            Double(xDelta),
            Double(yDelta),
            scrollMods
        )
    }

    // MARK: - Helpers

    private func ghosttyMods(from flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift)   { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue  }
        if flags.contains(.option)  { mods |= GHOSTTY_MODS_ALT.rawValue   }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock){ mods |= GHOSTTY_MODS_CAPS.rawValue  }
        return ghostty_input_mods_e(rawValue: UInt32(mods))
    }
}
