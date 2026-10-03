// The paired workspaces with their connection state.

import SwiftUI

struct WorkspacesView: View {
    @Environment(CoreHost.self) private var core
    let join: () -> Void

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
                                Button("Disconnect") { Task { await core.close(workspace.id) } }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Cate")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Join a workspace", systemImage: "plus", action: join).disabled(!core.ready)
            }
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
