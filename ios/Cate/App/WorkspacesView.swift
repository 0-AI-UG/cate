// The paired workspaces with their connection state.

import SwiftUI

struct WorkspacesView: View {
    @Environment(CoreHost.self) private var core
    let join: () -> Void
    @State private var disconnecting: String?

    var body: some View {
        Group {
            if !core.ready {
                ProgressView()
            } else if core.state.workspaces.isEmpty {
                ContentUnavailableView {
                    Label("No workspaces", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair this phone with a workspace open on your computer.")
                } actions: {
                    Button("Join a workspace", action: join).buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    ForEach(core.state.workspaces) { workspace in
                        NavigationLink(value: workspace.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(workspace.name).font(.headline)
                                ConnectionLabel(connection: workspace.connection)
                            }
                            .padding(.vertical, 2)
                        }
                        .swipeActions {
                            Button("Forget", role: .destructive) { Task { await core.forget(workspace.id) } }
                            if workspace.connection.kind != .closed {
                                Button("Disconnect") { disconnecting = workspace.id }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Cate")
        .disconnectDialog($disconnecting)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Join a workspace", systemImage: "plus", action: join).disabled(!core.ready)
            }
        }
    }
}

extension View {
    /// Asks whether to also stop the workspace's runtime when disconnecting.
    /// A runtime with network access on keeps running without clients.
    func disconnectDialog(_ workspaceId: Binding<String?>) -> some View {
        modifier(DisconnectDialog(workspaceId: workspaceId))
    }
}

private struct DisconnectDialog: ViewModifier {
    @Environment(CoreHost.self) private var core
    @Binding var workspaceId: String?

    func body(content: Content) -> some View {
        content.alert(
            "Disconnect",
            isPresented: Binding(get: { workspaceId != nil }, set: { if !$0 { workspaceId = nil } }),
            presenting: workspaceId
        ) { id in
            Button("Disconnect") { Task { await core.close(id) } }
            Button("Disconnect and Stop Runtime", role: .destructive) { Task { await core.stop(id) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The runtime keeps running for other devices. Stopping it ends every terminal and agent of this workspace for everyone.")
        }
    }
}

struct ConnectionLabel: View {
    let connection: Connection

    var body: some View {
        Label {
            Text(connection.text).lineLimit(2)
        } icon: {
            Circle().fill(color).frame(width: 8, height: 8)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private var color: Color {
        switch connection.kind {
        case .connected: .green
        case .connecting: .orange
        case .closed, .stopped: .gray
        case .offline, .incompatible, .refused: .red
        }
    }
}
