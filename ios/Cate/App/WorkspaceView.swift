// One workspace: its connection, its agents, the computer it runs on (kept
// awake, alerts while away), and its panels once the document arrives.
// Panels on a canvas show inside their canvas panel; every panel opens.

import SwiftUI

struct WorkspaceView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    @State private var creatable: [PanelChoice] = []
    @State private var created: PanelRoute?
    @State private var disconnecting: String?

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
                        Button("Disconnect") { disconnecting = workspaceId }
                    }
                }
            }
            if let workspace, workspace.connection.kind == .connected {
                if !workspace.agents.isEmpty {
                    Section("Agents") {
                        ForEach(workspace.agents) { agent in
                            AgentRow(workspace: workspace, agent: agent)
                        }
                    }
                }
                ComputerSection(workspace: workspace)
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
        }
        .navigationTitle(workspace?.name ?? "Workspace")
        .disconnectDialog($disconnecting)
        .toolbar {
            if workspace?.panels != nil, workspace?.connection.kind == .connected {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        ForEach(creatable) { choice in
                            Button(choice.label, systemImage: PanelIcon.symbol(choice.icon)) {
                                Task {
                                    if let panelId = try? await core.call("panel.create", ["workspaceId": workspaceId, "type": choice.type], as: String?.self) {
                                        created = PanelRoute(workspaceId: workspaceId, panelId: panelId)
                                    }
                                }
                            }
                        }
                    } label: {
                        Label("New panel", systemImage: "plus")
                    }
                }
            }
        }
        .navigationDestination(item: $created) { PanelView(route: $0) }
        .task { await core.open(workspaceId) }
        .task { creatable = await core.panelChoices("panel.creatable", ["workspaceId": workspaceId]) }
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
