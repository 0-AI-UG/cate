import SwiftUI

@main
struct CanvasIDEApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            MainWindowView()
                .environmentObject(appState)
                .frame(minWidth: 800, minHeight: 600)
                .onAppear {
                    GhosttyAppManager.shared.initialize()
                }
        }
        .windowStyle(.hiddenTitleBar)
    }
}

/// Global app state: manages workspaces and selection.
@MainActor
final class AppState: ObservableObject {
    @Published var workspaces: [Workspace] = []
    @Published var selectedWorkspaceId: UUID?

    init() {
        let defaultWorkspace = Workspace(
            name: "Default",
            color: .systemBlue,
            rootPath: FileManager.default.homeDirectoryForCurrentUser.path
        )
        workspaces = [defaultWorkspace]
        selectedWorkspaceId = defaultWorkspace.id
    }

    var selectedWorkspace: Workspace? {
        workspaces.first { $0.id == selectedWorkspaceId }
    }

    func addWorkspace(name: String = "New Workspace", rootPath: String? = nil) {
        let ws = Workspace(name: name, color: .systemGreen, rootPath: rootPath)
        workspaces.append(ws)
        selectedWorkspaceId = ws.id
    }
}
