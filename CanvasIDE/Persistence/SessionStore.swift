import Foundation

@MainActor
final class SessionStore {
    private static let sessionDirectory: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("CanvasIDE/Sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    static func save(_ snapshot: SessionSnapshot) {
        let url = sessionDirectory.appendingPathComponent("session.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(snapshot) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load() -> SessionSnapshot? {
        let url = sessionDirectory.appendingPathComponent("session.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SessionSnapshot.self, from: data)
    }

    static func saveWorkspace(_ workspace: Workspace) {
        let snapshot = SessionSnapshot.from(workspace: workspace)
        save(snapshot)
    }

    static func restoreInto(_ workspace: Workspace) {
        guard let snapshot = load() else { return }
        snapshot.restore(into: workspace)
    }
}
