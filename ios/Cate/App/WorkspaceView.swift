// One workspace: its agents first, each a chat (start one in a terminal or
// in T3 Code, follow it, answer it, review what it changed), then its
// panels, and the computer it runs on (kept awake, alerts while away). Panels
// on a canvas show inside their canvas panel; every panel opens. A new panel
// made here goes in the dock (one made in a canvas panel goes on it).

import SwiftUI

struct WorkspaceView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    @State private var creatable: [PanelChoice] = []
    @State private var created: PanelRoute?
    @State private var disconnecting: String?

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let connected = workspace?.connection.kind == .connected
        List {
            if let workspace, !connected {
                Section {
                    ConnectionLabel(connection: workspace.connection)
                    if workspace.connection.kind == .closed {
                        Button("Connect") { Task { await core.open(workspaceId) } }
                    } else if workspace.connection.retryable {
                        Button("Retry Now") { Task { await core.retry(workspaceId) } }
                    }
                }
            }
            if let workspace, connected, !workspace.others.isEmpty {
                Section {
                    PresenceRow(others: workspace.others)
                }
            }
            if let workspace, connected {
                Section("Agents") {
                    if workspace.agents.isEmpty {
                        ContentUnavailableView {
                            Label("No agents running", systemImage: "sparkles")
                        } description: {
                            Text("Start one here, or run an agent in a terminal or T3 Code on your computer.")
                        }
                    }
                    ForEach(AgentState.sorted(workspace.agents)) { agent in
                        AgentRow(workspaceId: workspaceId, agent: agent)
                    }
                }
            }
            if let panels = workspace?.panels {
                Section("Panels") {
                    let docked = panels.filter { $0.onCanvas == nil }
                    if docked.isEmpty {
                        Text("No panels open.").foregroundStyle(.secondary)
                    }
                    ForEach(docked) { panel in
                        PanelRow(workspaceId: workspaceId, panel: panel)
                    }
                }
            }
            if let workspace, connected, workspace.power != nil || workspace.push != nil {
                ComputerSection(workspace: workspace)
            }
        }
        .navigationTitle(workspace?.name ?? "Workspace")
        .navigationSubtitle(workspace?.connection.text ?? "")
        .disconnectDialog($disconnecting)
        .toolbar {
            if workspace?.panels != nil, connected {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(creatable) { choice in
                            Button(choice.label, systemImage: PanelIcon.symbol(choice.icon)) { add(choice) }
                        }
                    } label: {
                        Label("New Panel", systemImage: "plus.rectangle.on.rectangle")
                    }
                }
            }
            if workspace != nil, workspace?.connection.kind != .closed {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Disconnect", systemImage: "bolt.horizontal") { disconnecting = workspaceId }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                }
            }
            if connected {
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    NavigationLink(value: NewAgentRoute(workspaceId: workspaceId)) {
                        Label("New Agent", systemImage: "square.and.pencil").labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.glassProminent)
                }
            }
        }
        .navigationDestination(item: $created) { PanelView(route: $0) }
        .task { await core.open(workspaceId) }
        .task { creatable = await core.panelChoices("panel.creatable", ["workspaceId": workspaceId]) }
    }

    private func add(_ choice: PanelChoice) {
        Task {
            if let panelId = await core.createPanel(workspaceId, type: choice.type, at: nil) {
                created = PanelRoute(workspaceId: workspaceId, panelId: panelId)
            }
        }
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

/// A panel in a list: opens it; swipe or long-press closes it.
struct PanelRow: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel

    var body: some View {
        NavigationLink(value: PanelRoute(workspaceId: workspaceId, panelId: panel.id)) {
            Label {
                LabeledContent(panel.title, value: panel.typeLabel)
            } icon: {
                Image(systemName: PanelIcon.symbol(panel.icon))
            }
        }
        .swipeActions {
            Button("Close", systemImage: "xmark", role: .destructive, action: close)
        }
        .contextMenu {
            Button("Close", systemImage: "xmark", role: .destructive, action: close)
        }
    }

    private func close() {
        Task { await core.removePanel(workspaceId, panelId: panel.id) }
    }
}

struct PanelRoute: Hashable {
    let workspaceId: String
    let panelId: String
}

/// A panel opened from the workspace: the view of its type.
struct PanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let route: PanelRoute
    /// The panel as last seen: it stays open while the connection is down.
    @State private var known: Panel?

    var body: some View {
        let panels = core.workspace(route.workspaceId)?.panels
        let panel = panels.map { $0.first { $0.id == route.panelId } } ?? known
        Group {
            if let panel {
                content(panel)
                    // A surface becoming another type is a new view.
                    .id(panel.type)
            } else if panels == nil {
                ProgressView()
            } else {
                ContentUnavailableView("The panel was closed", systemImage: "xmark.rectangle")
            }
        }
        .onChange(of: panel, initial: true) { known = panel }
        // The agent in this panel is in view: its notifications stay quiet.
        .onAppear { notifier.viewing = AgentRoute(workspaceId: route.workspaceId, panelId: route.panelId) }
        .onDisappear {
            if notifier.viewing == AgentRoute(workspaceId: route.workspaceId, panelId: route.panelId) { notifier.viewing = nil }
        }
    }

    @ViewBuilder
    private func content(_ panel: Panel) -> some View {
        let workspaceId = route.workspaceId
        switch panel.type {
        case "terminal": TerminalPanelView(workspaceId: workspaceId, panel: panel)
        case "editor": EditorPanelView(workspaceId: workspaceId, panel: panel)
        case "browser": BrowserPanelView(workspaceId: workspaceId, panel: panel)
        case "chat": ChatPanelView(workspaceId: workspaceId, panel: panel)
        case "review": ReviewPanelView(workspaceId: workspaceId, panel: panel)
        case "canvas": CanvasPanelView(workspaceId: workspaceId, panel: panel)
        case "surface": SurfacePanelView(workspaceId: workspaceId, panel: panel)
        default:
            ContentUnavailableView(panel.typeLabel, systemImage: PanelIcon.symbol(panel.icon), description: Text("This panel cannot be shown on this device."))
                .navigationTitle(panel.title)
        }
    }
}

/// SF Symbols for the core's icon names.
enum PanelIcon {
    static func symbol(_ name: String) -> String {
        switch name {
        case "terminal": "terminal"
        case "folders": "folder"
        case "globe": "globe"
        case "t3": "bubble.left.and.text.bubble.right"
        case "git-compare": "arrow.left.arrow.right"
        case "grid": "square.grid.3x3"
        case "plus": "plus.square.dashed"
        default: "square"
        }
    }
}

/// A view's handle on a panel's session (`panel.open`, `browser.open`,
/// `chat.open`): the snapshot, events, and ops. Open while `run` runs.
@MainActor
@Observable
final class PanelSession<Snapshot: Decodable & Equatable> {
    private(set) var snapshot: Snapshot?
    let viewId = UUID().uuidString
    @ObservationIgnored var onEvent: ((ViewEvent) -> Void)?
    @ObservationIgnored private weak var core: CoreHost?

    /// Opens the view with `method` and keeps it open until cancelled.
    func run(_ core: CoreHost, _ method: String = "panel.open", workspaceId: String, panelId: String) async {
        self.core = core
        core.openView(method, viewId: viewId, workspaceId: workspaceId, panelId: panelId) { [weak self] data in
            self?.received(data)
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3_600))
        }
        core.closeView(viewId)
    }

    private func received(_ data: Data) {
        if let event = try? JSONDecoder().decode(SnapshotEvent<Snapshot>.self, from: data), event.kind == "snapshot" {
            if event.snapshot != snapshot { snapshot = event.snapshot }
        } else if let event = ViewEvent.decode(data) {
            onEvent?(event)
        }
    }

    @discardableResult
    func send(_ op: [String: Any]) async -> OpReply<AnyJSON> {
        await send(op, as: AnyJSON.self)
    }

    func send<Result: Decodable>(_ op: [String: Any], as type: Result.Type) async -> OpReply<Result> {
        guard let core else { return OpReply(ok: false, result: nil, message: "The panel is not open.", code: nil) }
        return await core.panelOp(viewId, op, as: type)
    }

    /// The core API, for calls about this view (`browser.*`, `chat.*`).
    func call<Result: Decodable>(_ method: String, _ params: [String: Any], as type: Result.Type) async throws -> Result {
        guard let core else { throw CoreError.badReply(method) }
        var params = params
        params["viewId"] = viewId
        return try await core.call(method, params, as: type)
    }

    func call(_ method: String, _ params: [String: Any]) {
        guard let core else { return }
        var params = params
        params["viewId"] = viewId
        Task { await core.call(method, params) }
    }
}

/// A failed op as an alert.
struct OpFailure: Identifiable {
    let id = UUID()
    let message: String
}
