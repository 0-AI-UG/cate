// An agent in a workspace's list: what it is and where it runs, its state and
// what it asked for while it waits on the person. Swipe to review its changes
// or open the panel it runs in.

import SwiftUI

struct AgentRow: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let agent: Agent
    @State private var reviewing: PanelRoute?
    @State private var failure: OpFailure?

    var body: some View {
        NavigationLink(value: AgentRoute(workspaceId: workspaceId, panelId: agent.panelId)) {
            HStack(alignment: .top, spacing: 12) {
                AgentStatusIcon(agent: agent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.title).font(.headline).lineLimit(1)
                    Text(agent.where)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(AgentState.label(agent))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AgentState.color(agent))
                    if let attention = agent.attention {
                        Text(attention).font(.callout).lineLimit(3)
                    }
                }
            }
            .padding(.vertical, 2)
        }
        .swipeActions(edge: .trailing) {
            Button("Review", systemImage: "arrow.left.arrow.right") { review() }
                .tint(.indigo)
        }
        .contextMenu {
            Button("Review Changes", systemImage: "arrow.left.arrow.right") { review() }
            NavigationLink(value: PanelRoute(workspaceId: workspaceId, panelId: agent.panelId)) {
                Label(agent.panelType == "chat" ? "Open Chat" : "Open Terminal", systemImage: agent.panelSymbol)
            }
        }
        .navigationDestination(item: $reviewing) { PanelView(route: $0) }
        .alert(item: $failure) { Alert(title: Text($0.message)) }
    }

    private func review() {
        Task {
            if let route = await core.reviewAgent(workspaceId, panelId: agent.panelId) {
                reviewing = route
            } else {
                failure = OpFailure(message: "The agent's changes could not be shown.")
            }
        }
    }
}

/// The agent's state as a symbol in its color.
struct AgentStatusIcon: View {
    let agent: Agent

    var body: some View {
        Image(systemName: symbol)
            .font(.title3)
            .foregroundStyle(AgentState.color(agent))
            .frame(width: 28, height: 28)
    }

    private var symbol: String {
        if agent.needsYou { return "hand.raised.circle.fill" }
        switch agent.status {
        case "running": return "circle.dotted.circle"
        case "waitingForInput", "finished": return "arrowshape.turn.up.left.circle.fill"
        default: return agent.present ? "pause.circle" : "stop.circle"
        }
    }
}

/// The words and color for an agent's state, the same everywhere.
enum AgentState {
    static func label(_ agent: Agent) -> String {
        if agent.needsYou { return "Needs you" }
        switch agent.status {
        case "running": return "Working"
        case "waitingForInput", "finished": return "Your turn"
        default: return agent.present ? "Idle" : "Stopped"
        }
    }

    static func color(_ agent: Agent) -> Color {
        if agent.needsYou { return .orange }
        switch agent.status {
        case "running": return .blue
        case "waitingForInput", "finished": return .green
        default: return .secondary
        }
    }

    /// Needs you first, then working, then the rest; the latest change
    /// first within each.
    static func sorted(_ agents: [Agent]) -> [Agent] {
        func rank(_ agent: Agent) -> Int {
            if agent.needsYou { return 0 }
            return agent.working ? 1 : 2
        }
        return agents.sorted { (rank($0), -$0.since) < (rank($1), -$1.since) }
    }
}

extension Agent {
    /// The agent and what it runs in: "Codex · Terminal".
    var `where`: String {
        let host = panelType == "chat" ? "T3 Code" : "Terminal"
        return name == host ? host : "\(name) · \(host)"
    }

    var panelSymbol: String { panelType == "chat" ? "bubble.left.and.text.bubble.right" : "terminal" }
}

extension CoreHost {
    /// Shows the agent's changes in a review panel filtered to its panel;
    /// the route to that review, or nil.
    func reviewAgent(_ workspaceId: String, panelId: String) async -> PanelRoute? {
        let params: [String: Any] = ["workspaceId": workspaceId, "panelId": panelId]
        guard let reviewId = try? await call("agents.review", params, as: String?.self) else { return nil }
        return PanelRoute(workspaceId: workspaceId, panelId: reviewId)
    }
}
