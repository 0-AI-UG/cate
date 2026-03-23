import Foundation

/// Data model for a terminal panel instance on the canvas.
struct TerminalPanel: Identifiable {
    let id: UUID
    var title: String
    var workingDirectory: String?

    /// The live Ghostty surface wrapper. Nil until the panel's view is on screen.
    var surface: TerminalSurface?

    // MARK: - Init

    init(
        id: UUID = UUID(),
        title: String = "Terminal",
        workingDirectory: String? = nil
    ) {
        self.id               = id
        self.title            = title
        self.workingDirectory = workingDirectory
    }
}
