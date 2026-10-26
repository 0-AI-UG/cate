// The paired workspaces with their connection state, the app's home. It
// connects to every workspace, so their agents' notifications arrive while
// the app runs. The list shows as remembered while the core starts. This
// device's settings open from here: they hold for every workspace.

import SwiftUI

struct WorkspacesView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let join: () -> Void
    @State private var disconnecting: String?

    var body: some View {
        Group {
            if core.workspaces.isEmpty && !core.ready {
                ProgressView()
            } else if core.workspaces.isEmpty {
                ContentUnavailableView {
                    Label("No workspaces", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair this phone with a workspace open on your computer, then follow and steer its agents from here.")
                } actions: {
                    Button("Join a workspace", action: join).buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    ForEach(core.workspaces) { workspace in
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
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink(value: DeviceSettingsRoute()) {
                    Label("Settings", systemImage: "gearshape")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Join a workspace", systemImage: "plus", action: join).disabled(!core.ready)
            }
        }
        .task(id: core.ready) { if core.ready { await core.openAll() } }
        .onChange(of: core.workspaces.isEmpty, initial: true) { _, empty in if !empty { notifier.askIfNeeded() } }
    }
}

struct DeviceSettingsRoute: Hashable {}

/// This device's settings, the same in every workspace: the canvas grid,
/// where tapped links open and the saved connection labels.
struct DeviceSettingsView: View {
    @Environment(CoreHost.self) private var core
    @AppStorage(MapGrid.key) private var grid = MapGrid.lines

    var body: some View {
        List {
            Section {
                Picker(selection: $grid) {
                    ForEach(MapGrid.allCases, id: \.self) { Text($0.title).tag($0) }
                } label: {
                    Label("Canvas grid", systemImage: "grid")
                }
                Picker(selection: Binding(get: { core.linkOpenTarget }, set: { core.setLinkOpenTarget($0) })) {
                    Text("Ask Each Time").tag("ask")
                    Text("In Cate").tag("cate")
                    Text("In Safari").tag("external")
                } label: {
                    Label("Open links", systemImage: "link")
                }
                NavigationLink {
                    SavedRelationLabels()
                } label: {
                    LabeledContent {
                        Text("\(core.savedRelationLabels.count)")
                    } label: {
                        Label("Saved connections", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    }
                }
            }
        }
        .navigationTitle("Settings")
    }
}

/// This device's saved connection labels: renamed with a tap, removed with a
/// swipe. Connections keep the labels they have.
private struct SavedRelationLabels: View {
    @Environment(CoreHost.self) private var core
    @State private var renaming: String?
    @State private var draft = ""

    var body: some View {
        List {
            ForEach(core.savedRelationLabels, id: \.self) { label in
                Button(label) {
                    draft = label
                    renaming = label
                }
                .foregroundStyle(.primary)
            }
            .onDelete { offsets in
                for label in offsets.map({ core.savedRelationLabels[$0] }) {
                    Task { await core.call("relations.forgetLabel", ["label": label]) }
                }
            }
        }
        .overlay {
            if core.savedRelationLabels.isEmpty {
                ContentUnavailableView("No saved connections", systemImage: "point.topleft.down.to.point.bottomright.curvepath", description: Text("Give a connection words of its own with Custom… in its menu."))
            }
        }
        .navigationTitle("Saved Connections")
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { label in
            TextField("Label", text: $draft)
            Button("Save") {
                Task { await core.call("relations.renameLabel", ["label": label, "to": draft]) }
            }
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) {}
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

extension EnvironmentValues {
    /// Opens the join sheet (pairing again from a refused workspace).
    @Entry var joinWorkspace: () -> Void = {}
    /// Opens a route's screen on the app's navigation stack.
    @Entry var navigate: (any Hashable) -> Void = { _ in }
}

/// The actions the core offers for a connection state, main action first.
struct ConnectionActions: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.joinWorkspace) private var join
    let workspace: Workspace
    var compact = false
    /// Asking before an update ends the workspace's terminals and agents.
    @State private var confirmingUpdate = false
    @State private var updateFailure: String?

    var body: some View {
        if workspace.connection.updating {
            ProgressView(compact ? "Updating" : "Updating the runtime")
                .controlSize(compact ? .small : .regular)
        } else {
            ForEach(Array(workspace.connection.actions.enumerated()), id: \.element) { index, action in
                button(action)
                    .buttonStyle(index == 0 && !compact ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
                    .controlSize(compact ? .small : .regular)
            }
            .confirmationDialog("Update the runtime?", isPresented: $confirmingUpdate, titleVisibility: .visible) {
                Button("Update Runtime", role: .destructive) { updateRuntime() }
            } message: {
                Text("Updating ends the workspace's terminals and running agents for everyone connected to it.")
            }
            .alert("The runtime was not updated", isPresented: Binding(get: { updateFailure != nil }, set: { if !$0 { updateFailure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(updateFailure ?? "")
            }
        }
    }

    private func updateRuntime() {
        Task {
            let result = await core.updateRuntime(workspace.id)
            if !result.ok { updateFailure = result.message ?? "The runtime did not answer." }
        }
    }

    @ViewBuilder private func button(_ action: Connection.Action) -> some View {
        switch action {
        case .updateRuntime: Button(compact ? "Update" : "Update Runtime") { confirmingUpdate = true }
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
