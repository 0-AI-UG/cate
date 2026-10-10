// A panel opened from its workspace, or shown in it from the title menu: the
// view of its type. One that runs in a checkout moves to another from the
// toolbar (Worktrees).
// Connections are made on a canvas's map.

import SwiftUI

struct PanelRoute: Hashable {
    let workspaceId: String
    let panelId: String
}

/// A panel opened from the workspace: the view of its type.
struct PanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    @Environment(\.panelOnScreen) private var onScreen
    let route: PanelRoute
    /// Shown in the workspace's screen, whose title picks it.
    var inWorkspace = false
    /// The panel as last seen: it stays open while the connection is down.
    @State private var known: Panel?

    var body: some View {
        let workspace = core.workspace(route.workspaceId)
        let panels = workspace?.panels
        let panel = panels.map { $0.first { $0.id == route.panelId } } ?? known
        let agent = workspace?.agents.first { $0.panelId == route.panelId }
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
        .environment(\.panelInWorkspace, inWorkspace)
        .environment(\.panelMark, panel.map { PanelMark(panel: $0, agent: agent) })
        .onChange(of: panel, initial: true) { known = panel }
        .toolbar {
            if onScreen, let panel, let worktrees = workspace?.worktrees, !worktrees.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    WorktreeMenu(panel: panel, worktrees: worktrees)
                }
            }
        }
        // Outside the toolbar, so its worktree menu has the switch too.
        .worktreeSwitching(route.workspaceId)
        // The agent in this panel is in view: its notifications stay quiet.
        .onChange(of: onScreen, initial: true) { _, shown in
            if shown { notifier.viewing = viewing } else if notifier.viewing == viewing { notifier.viewing = nil }
        }
        .onDisappear {
            if notifier.viewing == viewing { notifier.viewing = nil }
        }
    }

    private var viewing: AgentRoute {
        AgentRoute(workspaceId: route.workspaceId, panelId: route.panelId)
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
                .panelTitle(panel.title)
        }
    }
}

extension EnvironmentValues {
    /// The panel is shown in its workspace's screen, whose title names it and
    /// whose title menu picks it.
    @Entry var panelInWorkspace = false
    /// What the panel's title shows besides its words.
    @Entry var panelMark: PanelMark?
    /// False while the workspace's screen keeps the panel behind the one on
    /// screen: its toolbar items stay out of the bar.
    @Entry var panelOnScreen = true
}

/// A panel's title as the desktop's tabs show it: a panel that takes prompts
/// (a terminal, a chat) carries its icon, or its agent's logo while one
/// stands in for it, and the agent's status mark.
struct PanelMark: Equatable {
    let panel: Panel
    let agent: Agent?
}

extension View {
    /// A panel view's title, unless its workspace's screen shows it.
    func panelTitle(_ title: String) -> some View {
        modifier(PanelTitle(title: title))
    }
}

private struct PanelTitle: ViewModifier {
    @Environment(\.panelInWorkspace) private var inWorkspace
    @Environment(\.panelMark) private var mark
    let title: String

    func body(content: Content) -> some View {
        if inWorkspace {
            content
        } else if let mark, mark.panel.execution {
            let words = mark.agent?.title ?? title
            content
                .navigationTitle(words)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 6) {
                            PanelGlyph(icon: mark.panel.icon, logo: mark.agent?.logo)
                                .foregroundStyle(.primary)
                                .frame(width: 18, height: 18)
                            if let agent = mark.agent { AgentStatusMark(status: agent.status, size: 11) }
                            Text(words).font(.headline).lineLimit(1)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// A panel's icon, or its agent's logo while one stands in for it; the
/// desktop's logos, T3's for a chat, else the icon's symbol.
struct PanelGlyph: View {
    let icon: String
    let logo: String?

    var body: some View {
        if let logo {
            Image("agent-\(logo)").resizable().scaledToFit()
        } else if icon == "t3" {
            Image("t3-logo").resizable().scaledToFit()
        } else {
            Image(systemName: PanelIcon.symbol(icon)).resizable().scaledToFit()
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
