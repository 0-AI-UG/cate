// The agents of every paired workspace, in one feed: those blocked on the
// person first, then those at work, then those waiting for a prompt, and finished tasks to decide about.
// It connects to every workspace so the feed is whole; New Task starts one.

import SwiftUI

struct AgentsHomeView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let join: () -> Void
    @State private var composing = false
    @State private var started: AgentRoute?

    private struct Item: Identifiable {
        let workspace: Workspace
        let agent: Agent
        var id: String { workspace.id + "/" + agent.panelId }
        var route: AgentRoute { AgentRoute(workspaceId: workspace.id, panelId: agent.panelId) }
    }

    private struct Decision: Identifiable {
        let workspace: Workspace
        let task: AgentTask
        var id: String { workspace.id + "/" + task.id }
    }

    var body: some View {
        let workspaces = core.state.workspaces
        let items = workspaces.flatMap { workspace in workspace.agents.map { Item(workspace: workspace, agent: $0) } }
            .sorted { $0.agent.since > $1.agent.since }
        let needsYou = items.filter { $0.agent.needsYou }
        let working = items.filter { $0.agent.working }
        let waiting = items.filter { !$0.agent.needsYou && !$0.agent.working }
        let decisions = workspaces.flatMap { workspace in workspace.tasks.filter(\.awaitsDecision).map { Decision(workspace: workspace, task: $0) } }
        let unreachable = workspaces.filter { $0.connection.kind != .connected && $0.connection.kind != .connecting }

        Group {
            if !core.ready {
                ProgressView()
            } else if workspaces.isEmpty {
                ContentUnavailableView {
                    Label("No workspaces", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair this phone with a workspace open on your computer, then follow and steer its agents from here.")
                } actions: {
                    Button("Join a workspace", action: join).buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    if items.isEmpty && decisions.isEmpty {
                        Section {
                            ContentUnavailableView {
                                Label("No agents running", systemImage: "sparkles")
                            } description: {
                                Text("Start a task here, or run an agent in a terminal or chat on your computer.")
                            } actions: {
                                Button("New Task", systemImage: "plus") { composing = true }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(!workspaces.contains { $0.connection.kind == .connected })
                            }
                        }
                    }
                    if !needsYou.isEmpty {
                        Section("Needs you") {
                            ForEach(needsYou) { item in AgentRow(workspace: item.workspace, agent: item.agent) }
                        }
                    }
                    if !decisions.isEmpty {
                        Section("Finished tasks") {
                            ForEach(decisions) { decision in
                                NavigationLink(value: ShipRoute(workspaceId: decision.workspace.id, checkout: decision.task.checkout, taskId: decision.task.id)) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(decision.task.title.isEmpty ? decision.task.agentName : decision.task.title).font(.headline).lineLimit(2)
                                        Text("\(decision.task.agentName) · \(decision.workspace.name) · ready to review")
                                            .font(.subheadline).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    if !working.isEmpty {
                        Section("Working") {
                            ForEach(working) { item in AgentRow(workspace: item.workspace, agent: item.agent) }
                        }
                    }
                    if !waiting.isEmpty {
                        Section("Waiting for a prompt") {
                            ForEach(waiting) { item in AgentRow(workspace: item.workspace, agent: item.agent) }
                        }
                    }
                    if !unreachable.isEmpty {
                        Section("Not connected") {
                            ForEach(unreachable) { workspace in
                                NavigationLink(value: workspace.id) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(workspace.name).font(.headline)
                                        ConnectionLabel(connection: workspace.connection)
                                    }
                                }
                            }
                        }
                    }
                }
                .refreshable { await core.openAll() }
            }
        }
        .navigationTitle("Agents")
        .navigationDestination(for: String.self) { WorkspaceView(workspaceId: $0) }
        .navigationDestination(item: $started) { AgentSessionView(route: $0) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Task", systemImage: "plus") { composing = true }
                    .disabled(!workspaces.contains { $0.connection.kind == .connected })
            }
        }
        .sheet(isPresented: $composing) {
            TaskComposerView { route in
                composing = false
                started = route
            }
        }
        .task(id: core.ready) { if core.ready { await core.openAll() } }
        .onChange(of: workspaces.isEmpty, initial: true) { _, empty in if !empty { notifier.askIfNeeded() } }
    }
}

/// One agent: what it is, where, its state and for how long, and what it
/// asked for while it waits on the person.
struct AgentRow: View {
    let workspace: Workspace
    let agent: Agent

    var body: some View {
        NavigationLink(value: AgentRoute(workspaceId: workspace.id, panelId: agent.panelId)) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(agent.title).font(.headline).lineLimit(1)
                    Spacer()
                    StatusChip(agent: agent)
                }
                HStack(spacing: 4) {
                    Text("\(agent.name) · \(workspace.name) ·")
                    Text(agent.sinceDate, style: .relative)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                if let attention = agent.attention {
                    Text(attention).font(.callout).lineLimit(3)
                }
            }
            .padding(.vertical, 2)
        }
    }
}

struct StatusChip: View {
    let agent: Agent

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        if agent.needsYou { return "Needs you" }
        switch agent.status {
        case "running": return "Working"
        case "waitingForInput", "finished": return "Your turn"
        default: return agent.present ? "Idle" : "Stopped"
        }
    }

    private var color: Color {
        if agent.needsYou { return .orange }
        switch agent.status {
        case "running": return .blue
        case "waitingForInput", "finished": return .green
        default: return .secondary
        }
    }
}
