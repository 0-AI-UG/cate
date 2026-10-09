// One workspace as Cate lays it out: one of its dock's panels on screen at a
// time, picked in the title menu; a canvas panel shows its map (PlaceViews).
// `+` adds a panel to the dock, or on a canvas at a spot picked on its map. On a
// canvas the bottom bar lists the workspace's agents and starts a new one
// there; elsewhere the title menu does. The workspace's own screen shows who
// else is here, the computer it runs on and disconnecting.

import SwiftUI

struct WorkspaceView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    /// The dock panel on screen.
    @State private var selected: String?
    /// The canvas point in the middle of the map on screen.
    @State private var center: CGPoint?
    /// A new panel's type, while it waits for its spot on the canvas.
    @State private var placing: PanelChoice?
    @State private var showingAgents = false
    @State private var startingAgent = false

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let connected = workspace?.connection.kind == .connected
        let docked = (workspace?.panels ?? []).filter { $0.onCanvas == nil }
        let panel = selected.flatMap { id in docked.first { $0.id == id } }
        let canvas = panel?.type == "canvas" ? panel : nil
        let placement = canvas.map { Placement(canvasPanelId: $0.id, point: center) }
        Group {
            if let workspace, workspace.panels != nil {
                Group {
                    if let canvas {
                        PlaceHost(workspaceId: workspaceId) { actions in
                            CanvasPlace(workspaceId: workspaceId, canvasPanel: canvas, actions: actions, center: $center, placing: $placing)
                        }
                    } else if let panel {
                        PanelView(route: PanelRoute(workspaceId: workspaceId, panelId: panel.id), inWorkspace: true)
                    } else {
                        ContentUnavailableView("Nothing in the dock", systemImage: "rectangle.stack", description: Text("Add a panel with +, or start an agent."))
                    }
                }
                .id(panel?.id)
                .safeAreaInset(edge: .top) {
                    if !connected { ConnectionBanner(workspace: workspace) }
                }
            } else if let workspace {
                ConnectionState(workspace: workspace)
            } else {
                ContentUnavailableView("Workspace not found", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            }
        }
        .navigationTitle(workspace?.name ?? "Workspace")
        .navigationSubtitle(workspace?.panels == nil ? workspace?.connection.text ?? "" : panel?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu {
            if workspace?.panels != nil {
                Picker("Panel", selection: $selected) {
                    ForEach(docked) { panel in
                        Label(panel.title, systemImage: PanelIcon.symbol(panel.icon)).tag(Optional(panel.id))
                    }
                }
                if connected, canvas == nil {
                    Section {
                        Button("Agents", systemImage: "sparkles") { showingAgents = true }
                        Button("New Agent", systemImage: "square.and.pencil") { startingAgent = true }
                    }
                }
            }
        }
        .toolbar {
            if let workspace, !workspace.others.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    PresenceAvatars(others: workspace.others)
                }
            }
            if workspace?.panels != nil, connected {
                ToolbarItem(placement: .topBarTrailing) {
                    NewPanelMenu(
                        workspaceId: workspaceId,
                        placement: placement,
                        opened: placement == nil ? { selected = $0 } : nil,
                        pick: placement == nil ? nil : { placing = $0 }
                    )
                }
            }
            if workspace != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: WorkspaceInfoRoute(workspaceId: workspaceId)) {
                        Label("Workspace", systemImage: "desktopcomputer")
                    }
                }
            }
            if let workspace, connected, canvas != nil {
                ToolbarItem(placement: .bottomBar) {
                    let waiting = workspace.agents.filter(\.needsYou).count
                    NavigationLink(value: AgentsRoute(workspaceId: workspaceId)) {
                        Label(waiting > 0 ? "\(waiting) Need You" : "Agents", systemImage: waiting > 0 ? "hand.raised.fill" : "sparkles")
                            .labelStyle(.titleAndIcon)
                    }
                    .tint(waiting > 0 ? .orange : nil)
                }
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    NavigationLink(value: NewAgentRoute(workspaceId: workspaceId, placement: placement)) {
                        Label("New Agent", systemImage: "square.and.pencil").labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.glassProminent)
                }
            }
        }
        .navigationDestination(isPresented: $showingAgents) { AgentsView(workspaceId: workspaceId) }
        .navigationDestination(isPresented: $startingAgent) { AgentChatView(workspaceId: workspaceId, panelId: nil) }
        // The first canvas in the dock, else its first panel, until one is
        // picked; another when the one on screen closes.
        .onChange(of: docked.map(\.id), initial: true) { _, ids in
            guard workspace?.panels != nil, selected.map({ !ids.contains($0) }) ?? true else { return }
            selected = docked.first { $0.type == "canvas" }?.id ?? ids.first
            center = nil
        }
        .onChange(of: selected) {
            center = nil
            placing = nil
        }
        .task { await core.open(workspaceId) }
    }
}

/// While the workspace is not connected: why, and what to do.
private struct ConnectionState: View {
    @Environment(CoreHost.self) private var core
    let workspace: Workspace

    var body: some View {
        if workspace.connection.kind == .connecting {
            ProgressView(workspace.connection.text)
        } else {
            ContentUnavailableView {
                Label(workspace.connection.title.isEmpty ? "Not connected" : workspace.connection.title, systemImage: "bolt.horizontal")
            } description: {
                Text(workspace.connection.text)
            } actions: {
                if workspace.connection.kind == .closed {
                    Button("Connect") { Task { await core.open(workspace.id) } }.buttonStyle(.glassProminent)
                } else {
                    ConnectionActions(workspace: workspace)
                }
            }
        }
    }
}

/// Over the last panels seen while the connection is down.
private struct ConnectionBanner: View {
    @Environment(CoreHost.self) private var core
    let workspace: Workspace

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLabel(connection: workspace.connection)
            ConnectionActions(workspace: workspace, compact: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .padding(.top, 4)
    }
}

struct AgentsRoute: Hashable {
    let workspaceId: String
}

/// The workspace's agents, needs-you first, wherever they sit.
struct AgentsView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String

    var body: some View {
        let workspace = core.workspace(workspaceId)
        List {
            if workspace?.agents.isEmpty != false {
                ContentUnavailableView {
                    Label("No agents running", systemImage: "sparkles")
                } description: {
                    Text("Start one here, or run an agent in a terminal or T3 Code on your computer.")
                }
            }
            ForEach(AgentState.sorted(workspace?.agents ?? [])) { agent in
                AgentRow(workspaceId: workspaceId, agent: agent)
            }
        }
        .navigationTitle("Agents")
        .navigationSubtitle(workspace?.name ?? "")
        .toolbar {
            if workspace?.connection.kind == .connected {
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    NavigationLink(value: NewAgentRoute(workspaceId: workspaceId)) {
                        Label("New Agent", systemImage: "square.and.pencil").labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.glassProminent)
                }
            }
        }
    }
}

struct WorkspaceInfoRoute: Hashable {
    let workspaceId: String
}

/// The workspace itself: its connection, who else is here, the computer it
/// runs on, and disconnecting.
struct WorkspaceInfoView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    @State private var disconnecting: String?

    var body: some View {
        let workspace = core.workspace(workspaceId)
        List {
            if let workspace {
                Section {
                    ConnectionLabel(connection: workspace.connection)
                    if workspace.connection.kind == .closed {
                        Button("Connect") { Task { await core.open(workspaceId) } }
                    } else {
                        ConnectionActions(workspace: workspace, compact: true)
                    }
                }
                if !workspace.others.isEmpty {
                    Section {
                        PresenceRow(others: workspace.others)
                    }
                }
                if workspace.power != nil || workspace.push != nil {
                    ComputerSection(workspace: workspace)
                }
                if workspace.connection.kind != .closed {
                    Section {
                        Button("Disconnect", systemImage: "bolt.horizontal", role: .destructive) { disconnecting = workspaceId }
                    }
                }
            }
        }
        .navigationTitle(workspace?.name ?? "Workspace")
        .disconnectDialog($disconnecting)
    }
}

/// Who else is here, as overlapping initials.
private struct PresenceAvatars: View {
    let others: [OtherClient]

    var body: some View {
        HStack(spacing: -6) {
            ForEach(others.prefix(3)) { client in
                Text(client.initials)
                    .font(.caption2.weight(.semibold))
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Color(.secondarySystemFill)))
                    .opacity(client.attentive ? 1 : 0.6)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Also here: \(others.map(\.name).joined(separator: ", "))")
    }
}


/// Who else is in the workspace: one avatar per other client, its device's
/// initials, faded while it does not have its person's attention.
private struct PresenceRow: View {
    let others: [OtherClient]

    var body: some View {
        LabeledContent {
            HStack(spacing: -4) {
                ForEach(others.prefix(4)) { client in
                    Text(client.initials)
                        .font(.caption2.weight(.semibold))
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(Color(.secondarySystemFill)))
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                        .opacity(client.attentive ? 1 : 0.6)
                }
            }
        } label: {
            Label("Also here", systemImage: "person.2")
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Also here: \(others.map(\.name).joined(separator: ", "))")
    }
}

/// The runtime's machine: keep it awake while you are away, and whether this
/// phone gets alerts from the workspace when the app is closed.
private struct ComputerSection: View {
    @Environment(CoreHost.self) private var core
    let workspace: Workspace
    @State private var failure: OpFailure?

    private static let durations: [(label: String, minutes: Int?)] = [
        ("30 minutes", 30), ("1 hour", 60), ("5 hours", 300), ("Until turned off", nil),
    ]

    var body: some View {
        Section {
            if let power = workspace.power {
                Menu {
                    ForEach(Self.durations, id: \.label) { duration in
                        Button(duration.label) { setPower(duration.minutes.map { $0 as Any } ?? NSNull()) }
                    }
                    if power.requested {
                        Button("Turn Off", role: .destructive) { setPower(false) }
                    }
                } label: {
                    LabeledContent {
                        powerLabel(power)
                    } label: {
                        Label("Keep awake", systemImage: power.holding ? "cup.and.saucer.fill" : "cup.and.saucer")
                    }
                }
                .foregroundStyle(.primary)
            }
            if let push = workspace.push {
                LabeledContent {
                    Text(push.blocked == nil && push.registered ? "On" : push.blocked == "cateConnectOff" ? "Off" : "Unavailable")
                } label: {
                    Label("Alerts while away", systemImage: "bell.badge")
                }
                if push.blocked == "cateConnectOff" {
                    Button("Turn On Cate Connect") {
                        Task {
                            let result = await core.action("push.useCateConnect", ["workspaceId": workspace.id])
                            if !result.ok { failure = OpFailure(message: result.message ?? "Could not turn on Cate Connect.") }
                        }
                    }
                }
            }
        } header: {
            Text("This computer")
        } footer: {
            if workspace.push?.blocked == "cateConnectOff" {
                Text("Alerts reach this phone through Cate Connect when the app is closed. The workspace's network access is on the same network only.")
            } else if workspace.push?.blocked == "serviceUnavailable" {
                Text("Cate Connect is not sending alerts right now. Agents still show here while the app is open.")
            } else if workspace.power?.busy == true {
                Text("Kept awake while agents and terminals are busy.")
            }
        }
        .alert(item: $failure) { Alert(title: Text($0.message)) }
    }

    @ViewBuilder
    private func powerLabel(_ power: PowerState) -> some View {
        if power.requested, let endsAt = power.endsAt {
            Text("until \(Date(timeIntervalSince1970: endsAt / 1_000), style: .time)")
        } else if power.requested {
            Text("On")
        } else if power.busy {
            Text("While busy")
        } else {
            Text("Off")
        }
    }

    private func setPower(_ duration: Any) {
        Task {
            let result = await core.action("power.set", ["workspaceId": workspace.id, "duration": duration])
            if !result.ok { failure = OpFailure(message: result.message ?? "Could not keep the computer awake.") }
        }
    }
}

