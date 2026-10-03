// One workspace: its connection, and its panels once the document arrives;
// the ones the app can show open from the list.

import SwiftUI

struct WorkspaceView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String

    var body: some View {
        let workspace = core.workspace(workspaceId)
        List {
            Section {
                if let workspace {
                    ConnectionLabel(connection: workspace.connection)
                    if workspace.connection.kind == .closed {
                        Button("Connect") { Task { await core.open(workspaceId) } }
                    } else {
                        if workspace.connection.retryable {
                            Button("Retry now") { Task { await core.retry(workspaceId) } }
                        }
                        Button("Disconnect") { Task { await core.close(workspaceId) } }
                    }
                }
            }
            if let panels = workspace?.panels {
                Section("Panels") {
                    if panels.isEmpty {
                        Text("No panels open.").foregroundStyle(.secondary)
                    }
                    ForEach(panels) { panel in
                        if PanelView.shows(panel) {
                            NavigationLink(value: PanelRoute(workspaceId: workspaceId, panelId: panel.id)) {
                                LabeledContent(panel.title, value: panel.typeLabel)
                            }
                        } else {
                            LabeledContent(panel.title, value: panel.typeLabel)
                        }
                    }
                }
            }
        }
        .navigationTitle(workspace?.name ?? "Workspace")
        .task { await core.open(workspaceId) }
    }
}

struct PanelRoute: Hashable {
    let workspaceId: String
    let panelId: String
}

/// A panel opened from the workspace, for the panel types the app shows.
struct PanelView: View {
    @Environment(CoreHost.self) private var core
    let route: PanelRoute
    /// The panel as last seen: it stays open while the connection is down.
    @State private var known: Panel?

    static func shows(_ panel: Panel) -> Bool { panel.type == "terminal" }

    var body: some View {
        let panels = core.workspace(route.workspaceId)?.panels
        let panel = panels.map { $0.first { $0.id == route.panelId } } ?? known
        Group {
            if let panel {
                TerminalPanelView(workspaceId: route.workspaceId, panel: panel)
            } else if panels == nil {
                ProgressView()
            } else {
                ContentUnavailableView("The panel was closed", systemImage: "xmark.rectangle")
            }
        }
        .onChange(of: panel, initial: true) { known = panel }
    }
}
