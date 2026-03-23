import AppKit
import QuartzCore

/// NSView that hosts a Ghostty terminal rendered via Metal.
/// This IS the surface view — Ghostty renders directly into its CAMetalLayer.
final class TerminalView: NSView {

    // MARK: - State

    private(set) var surface: ghostty_surface_t?
    private var hasSurface: Bool { surface != nil }

    /// The unzoomed canvas-coordinate size of this terminal's content area.
    /// Set by CanvasNode.updateContentZoom() when zoom changes.
    /// Setting this adjusts the view's bounds (not frame) so Ghostty sees the
    /// unzoomed size. AppKit's frame/bounds ratio creates a natural scale transform.
    var canvasSize: CGSize = .zero {
        didSet {
            if canvasSize.width > 0, canvasSize.height > 0 {
                if bounds.size != canvasSize {
                    setBoundsSize(canvasSize)
                    setBoundsOrigin(.zero)
                }
            } else {
                // Reset bounds to match frame (no scaling)
                if bounds.size != frame.size {
                    setBoundsSize(frame.size)
                    setBoundsOrigin(.zero)
                }
            }
        }
    }

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
        guard window != nil else {
            print("TerminalView: attachSurface called before view has a window — skipping")
            return
        }
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
        // ghostty_surface_free must be called on the main thread.
        if let s = surface {
            if Thread.isMainThread {
                ghostty_surface_free(s)
            } else {
                DispatchQueue.main.sync {
                    ghostty_surface_free(s)
                }
            }
        }
    }

    // MARK: - Layout

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            if !hasSurface {
                attachSurface()
            }
            updateSurfaceSize()
        } else {
            // View has been removed from a window — tear down the surface to
            // avoid dangling references to a now-invisible Metal layer.
            detachSurface()
        }
    }

    override func layout() {
        super.layout()
        updateSurfaceSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // When canvasSize is active, bounds are locked to the unzoomed size —
        // frame changes are just visual scaling, no need to update Ghostty.
        if canvasSize == .zero {
            updateSurfaceSize()
        }
    }

    private func updateSurfaceSize() {
        guard let surface else { return }
        let scale = window?.backingScaleFactor ?? 2.0
        // bounds reflects the unzoomed canvas size (set via canvasSize/setBoundsSize)
        // so Ghostty renders at full resolution regardless of zoom
        let w = UInt32(bounds.width * scale)
        let h = UInt32(bounds.height * scale)
        guard w > 0, h > 0 else { return }
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
        guard let surface else { super.mouseDown(with: event); return }
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
        guard let surface else { super.mouseUp(with: event); return }
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
        guard let surface else { super.mouseMoved(with: event); return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let surface else { super.mouseDragged(with: event); return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, Double(pt.x), Double(pt.y), ghosttyMods(from: event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { super.scrollWheel(with: event); return }
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
