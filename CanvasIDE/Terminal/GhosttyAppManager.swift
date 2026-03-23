import AppKit

/// Singleton that manages the ghostty_app_t lifecycle.
/// Must be used on the main actor since Ghostty is not thread-safe.
@MainActor
final class GhosttyAppManager {
    static let shared = GhosttyAppManager()

    private(set) var app: ghostty_app_t?
    private(set) var config: ghostty_config_t?

    private init() {}

    func initialize() {
        // 1. Initialize the Ghostty library
        let initResult = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        guard initResult == GHOSTTY_SUCCESS else {
            print("GhosttyAppManager: ghostty_init failed with code \(initResult)")
            return
        }

        // 2. Create and finalize config (loads ~/.config/ghostty/config)
        guard let cfg = ghostty_config_new() else {
            print("GhosttyAppManager: ghostty_config_new failed")
            return
        }
        ghostty_config_load_default_files(cfg)
        ghostty_config_finalize(cfg)
        self.config = cfg

        // 3. Build the runtime config with required callbacks
        var runtimeConfig = ghostty_runtime_config_s()
        runtimeConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtimeConfig.supports_selection_clipboard = true

        // Wakeup: called from any thread to request an app tick
        runtimeConfig.wakeup_cb = { _ in
            DispatchQueue.main.async {
                GhosttyAppManager.shared.tick()
            }
        }

        // Action: we handle nothing yet — return false to let Ghostty use defaults
        runtimeConfig.action_cb = { _, _, _ in
            return false
        }

        // Read clipboard: (userdata, clipboard_location, state_opaque_ptr)
        runtimeConfig.read_clipboard_cb = { _, location, state in
            let pb: NSPasteboard
            if location == GHOSTTY_CLIPBOARD_SELECTION {
                pb = NSPasteboard(name: NSPasteboard.Name("com.mitchellh.ghostty.selection"))
            } else {
                pb = .general
            }
            let text = pb.string(forType: .string) ?? ""
            // We don't have the surface pointer here — the state pointer is
            // opaque and Ghostty will route it correctly. For now, this is a
            // simplified version that doesn't complete the request properly.
            // Full integration requires surface-aware clipboard handling.
            _ = text
            _ = state
        }

        // Write clipboard: (userdata, clipboard_location, content_array, count, confirm)
        runtimeConfig.write_clipboard_cb = { _, _, contents, count, _ in
            guard let contents, count > 0 else { return }
            // Use the first content entry's data
            let content = contents.pointee
            guard let data = content.data else { return }
            let text = String(cString: data)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }

        // 4. Create the Ghostty app
        guard let ghosttyApp = ghostty_app_new(&runtimeConfig, cfg) else {
            print("GhosttyAppManager: ghostty_app_new failed")
            return
        }
        self.app = ghosttyApp
    }

    /// Drive the Ghostty event loop.
    func tick() {
        guard let app else { return }
        ghostty_app_tick(app)
    }

    /// Create a new Ghostty surface hosted inside `view`.
    /// The view must already be layer-backed with a CAMetalLayer.
    func createSurface(in view: NSView) -> ghostty_surface_t? {
        guard let app else {
            print("GhosttyAppManager: app not initialized")
            return nil
        }

        var surfaceConfig = ghostty_surface_config_new()
        surfaceConfig.userdata = Unmanaged.passUnretained(view).toOpaque()
        surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
        surfaceConfig.platform.macos.nsview = Unmanaged.passUnretained(view).toOpaque()
        surfaceConfig.scale_factor = Double(view.window?.backingScaleFactor ?? 2.0)

        return ghostty_surface_new(app, &surfaceConfig)
    }
}
