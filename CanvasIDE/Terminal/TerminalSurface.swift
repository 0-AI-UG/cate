import Foundation

/// Wraps the ghostty_surface_t lifecycle and ties it to a TerminalView.
/// Owns the surface pointer and frees it on deinit.
final class TerminalSurface: Identifiable {
    let id = UUID()

    private(set) var surface: ghostty_surface_t?

    /// The view that hosts this surface. Weak to avoid a retain cycle
    /// (TerminalView → TerminalSurface → TerminalView).
    weak var view: TerminalView?

    // MARK: - Init / Deinit

    init(surface: ghostty_surface_t, view: TerminalView) {
        self.surface = surface
        self.view    = view
    }

    deinit {
        destroy()
    }

    // MARK: - Lifecycle

    /// Explicitly free the Ghostty surface. Safe to call multiple times.
    func destroy() {
        guard let s = surface else { return }
        ghostty_surface_free(s)
        surface = nil
    }
}
