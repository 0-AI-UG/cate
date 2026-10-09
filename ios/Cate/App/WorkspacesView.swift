// The paired workspaces with their connection state, the app's home. It
// connects to every workspace, so their agents' notifications arrive while
// the app runs.

import SwiftUI

struct WorkspacesView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
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
                    Text("Pair this phone with a workspace open on your computer, then follow and steer its agents from here.")
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
                .refreshable { await core.openAll() }
            }
        }
        .navigationTitle("Cate")
        .disconnectDialog($disconnecting)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Join a workspace", systemImage: "plus", action: join).disabled(!core.ready)
            }
        }
        .task(id: core.ready) { if core.ready { await core.openAll() } }
        .onChange(of: core.state.workspaces.isEmpty, initial: true) { _, empty in if !empty { notifier.askIfNeeded() } }
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

extension EnvironmentValues {
    /// Opens the join sheet (pairing again from a refused workspace).
    @Entry var joinWorkspace: () -> Void = {}
}

/// The actions the core offers for a connection state, main action first.
struct ConnectionActions: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.joinWorkspace) private var join
    let workspace: Workspace
    var compact = false

    var body: some View {
        ForEach(Array(workspace.connection.actions.enumerated()), id: \.element) { index, action in
            button(action)
                .buttonStyle(index == 0 && !compact ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
                .controlSize(compact ? .small : .regular)
        }
    }

    @ViewBuilder private func button(_ action: Connection.Action) -> some View {
        switch action {
        case .retry: Button(compact ? "Retry" : "Try Again") { Task { await core.retry(workspace.id) } }
        case .pair: Button("Pair Again", action: join)
        case .forget: Button("Forget", role: .destructive) { Task { await core.forget(workspace.id) } }
        }
    }
}

/// A type-erased button style, to pick one per button.
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
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
