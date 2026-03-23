import SwiftUI

/// Main window: Sidebar | Canvas workspace
struct MainWindowView: View {
    @EnvironmentObject var appState: AppState
    @State private var sidebarWidth: CGFloat = 200
    @State private var isSidebarVisible: Bool = true
    @State private var showFileExplorer: Bool = false
    @State private var showCommandPalette: Bool = false

    var body: some View {
        HStack(spacing: 0) {
            if isSidebarVisible {
                VStack(spacing: 0) {
                    // Titlebar spacing
                    Spacer().frame(height: 28)

                    // Workspace list
                    ProjectListView(
                        workspaces: $appState.workspaces,
                        selectedWorkspaceId: $appState.selectedWorkspaceId,
                        onAddWorkspace: { appState.addWorkspace() }
                    )

                    // File explorer (toggleable)
                    if showFileExplorer, let workspace = appState.selectedWorkspace {
                        Divider()
                        FileExplorerView(
                            model: workspace.fileTreeModel,
                            onFileSelected: { path in
                                workspace.createEditor(filePath: path)
                            }
                        )
                        .frame(maxHeight: 300)
                    }

                    Spacer()

                    // Toggle file explorer button
                    HStack {
                        Button {
                            showFileExplorer.toggle()
                        } label: {
                            Image(systemName: showFileExplorer ? "folder.fill" : "folder")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Toggle File Explorer")

                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .frame(width: sidebarWidth)
                .background(Color(nsColor: .windowBackgroundColor))

                Divider()
            }

            // Canvas workspace
            if let workspace = appState.selectedWorkspace {
                WorkspaceContentView(workspace: workspace)
            } else {
                ZStack {
                    Color(nsColor: NSColor(red: 0.11, green: 0.11, blue: 0.13, alpha: 1.0))
                    Text("No workspace selected")
                        .font(.title2)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .commandPalette(isPresented: $showCommandPalette, items: commandPaletteItems)
        .onReceive(NotificationCenter.default.publisher(for: .showCommandPalette)) { _ in
            showCommandPalette = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .toggleSidebar)) { _ in
            isSidebarVisible.toggle()
        }
        .onReceive(NotificationCenter.default.publisher(for: .toggleFileExplorer)) { _ in
            showFileExplorer.toggle()
        }
    }

    private var commandPaletteItems: [CommandPaletteItem] {
        guard let workspace = appState.selectedWorkspace else { return [] }
        return [
            CommandPaletteItem(title: "New Terminal", subtitle: "Cmd+T", icon: "terminal.fill") {
                workspace.createTerminal()
            },
            CommandPaletteItem(title: "New Browser", subtitle: "Cmd+Shift+B", icon: "globe") {
                workspace.createBrowser()
            },
            CommandPaletteItem(title: "New Editor", subtitle: "Cmd+Shift+E", icon: "doc.text") {
                workspace.createEditor()
            },
            CommandPaletteItem(title: "Toggle Sidebar", subtitle: "Cmd+\\", icon: "sidebar.left") {
                isSidebarVisible.toggle()
            },
            CommandPaletteItem(title: "Toggle File Explorer", subtitle: nil, icon: "folder") {
                showFileExplorer.toggle()
            },
            CommandPaletteItem(title: "Toggle Minimap", subtitle: nil, icon: "map") {
                workspace.canvasState.minimapVisible.toggle()
            },
            CommandPaletteItem(title: "Reset Zoom", subtitle: "Cmd+0", icon: "1.magnifyingglass") {
                workspace.canvasState.setZoom(1.0)
            },
        ]
    }
}
