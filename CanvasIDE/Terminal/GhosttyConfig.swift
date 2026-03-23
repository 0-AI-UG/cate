import AppKit

/// Lightweight parser for Ghostty's config file.
/// Only extracts the handful of values CanvasIDE cares about for its own UI;
/// the real Ghostty config is loaded via ghostty_config_load_default_files().
struct GhosttyConfig {
    var fontFamily: String = "Menlo"
    var fontSize: CGFloat = 12
    var backgroundColor: NSColor = NSColor(red: 0.15, green: 0.15, blue: 0.17, alpha: 1)
    var foregroundColor: NSColor = .white

    // MARK: - Loading

    static func load() -> GhosttyConfig {
        var config = GhosttyConfig()
        let rawPaths = ["~/.config/ghostty/config"]
        let paths = rawPaths.map { NSString(string: $0).expandingTildeInPath }
        for path in paths {
            guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            config.parse(contents)
        }
        return config
    }

    // MARK: - Parsing

    mutating func parse(_ contents: String) {
        for line in contents.components(separatedBy: .newlines) {
            // Strip comments and whitespace
            let stripped = line.components(separatedBy: "#").first?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !stripped.isEmpty else { continue }

            let parts = stripped.components(separatedBy: "=")
            guard parts.count >= 2 else { continue }

            let key = parts[0].trimmingCharacters(in: .whitespaces)
            let value = parts.dropFirst().joined(separator: "=").trimmingCharacters(in: .whitespaces)

            switch key {
            case "font-family":
                fontFamily = value

            case "font-size":
                if let size = Double(value) {
                    fontSize = CGFloat(size)
                }

            case "background":
                if let color = Self.parseColor(value) {
                    backgroundColor = color
                }

            case "foreground":
                if let color = Self.parseColor(value) {
                    foregroundColor = color
                }

            default:
                break
            }
        }
    }

    // MARK: - Color Helpers

    /// Parses a Ghostty color value. Accepts:
    ///   - 6-digit hex:  #rrggbb
    ///   - 3-digit hex:  #rgb
    ///   - Bare hex (no #)
    private static func parseColor(_ string: String) -> NSColor? {
        var hex = string.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") { hex = String(hex.dropFirst()) }

        // Expand 3-digit shorthand
        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }

        guard hex.count == 6,
              let value = UInt64(hex, radix: 16) else { return nil }

        let r = CGFloat((value >> 16) & 0xFF) / 255
        let g = CGFloat((value >> 8)  & 0xFF) / 255
        let b = CGFloat( value        & 0xFF) / 255
        return NSColor(red: r, green: g, blue: b, alpha: 1)
    }
}
