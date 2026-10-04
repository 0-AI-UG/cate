// One agent, natively: its conversation, what it waits on, and a box to reply
// at its prompt. A permission or question is answered in the panel itself
// (the live terminal or the T3 chat), one tap away, as are its changes and,
// for a task, what to do with its worktree.

import SwiftUI

struct AgentSessionView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let route: AgentRoute
    @State private var messages: [ConversationMessage]?
    @State private var reply = ""
    @State private var sending = false
    @State private var failure: OpFailure?
    @FocusState private var typing: Bool

    var body: some View {
        let workspace = core.workspace(route.workspaceId)
        let agent = workspace?.agents.first { $0.panelId == route.panelId }
        let task = agent?.taskId.flatMap { id in workspace?.tasks.first { $0.id == id } }
        Group {
            if let workspace, let agent {
                content(workspace, agent, task)
            } else if workspace?.connection.kind == .connected {
                ContentUnavailableView("The agent is gone", systemImage: "sparkles",
                                       description: Text("Its panel was closed, or the agent exited."))
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    if let workspace { ConnectionLabel(connection: workspace.connection) }
                }
            }
        }
        .navigationTitle(agent?.title ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar(workspace, agent, task) }
        .alert(item: $failure) { Alert(title: Text($0.message)) }
        .task { _ = await core.connected(route.workspaceId) }
        // Read again whenever the agent's state moves: a turn ended, a
        // prompt went in, a question came up.
        .task(id: agent.map { "\($0.status):\($0.since)" }) { await load(agent) }
        .onAppear { notifier.viewing = route }
        .onDisappear { if notifier.viewing == route { notifier.viewing = nil } }
    }

    @ViewBuilder
    private func content(_ workspace: Workspace, _ agent: Agent, _ task: AgentTask?) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    header(workspace, agent)
                    if let messages {
                        if messages.isEmpty {
                            Text("No messages yet.").foregroundStyle(.secondary)
                        }
                        ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                            MessageBubble(message: message)
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if agent.needsYou {
                        AttentionCard(agent: agent, open: PanelRoute(workspaceId: workspace.id, panelId: agent.panelId))
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding()
            }
            .onChange(of: messages?.count) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: agent.needsYou) { proxy.scrollTo("end", anchor: .bottom) }
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) { composer(agent) }
    }

    private func header(_ workspace: Workspace, _ agent: Agent) -> some View {
        HStack(spacing: 6) {
            StatusChip(agent: agent)
            Text("\(agent.name) · \(workspace.name) ·")
            Text(agent.sinceDate, style: .relative)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private func composer(_ agent: Agent) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(agent.canReceivePrompt ? "Reply to \(agent.name)…" : composerHint(agent), text: $reply, axis: .vertical)
                .lineLimit(1...6)
                .focused($typing)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 18))
                .disabled(!agent.canReceivePrompt || sending)
            Button {
                send(agent)
            } label: {
                Image(systemName: sending ? "ellipsis.circle.fill" : "arrow.up.circle.fill").font(.title)
            }
            .disabled(!agent.canReceivePrompt || sending || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func composerHint(_ agent: Agent) -> String {
        if agent.needsYou { return "Answer the agent above first" }
        if agent.working { return "\(agent.name) is working…" }
        return "The agent is not at its prompt"
    }

    @ToolbarContentBuilder
    private func toolbar(_ workspace: Workspace?, _ agent: Agent?, _ task: AgentTask?) -> some ToolbarContent {
        if let workspace, let agent {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    NavigationLink(value: PanelRoute(workspaceId: workspace.id, panelId: agent.panelId)) {
                        Label(agent.panelType == "chat" ? "Open Chat" : "Open Terminal",
                              systemImage: agent.panelType == "chat" ? "bubble.left.and.text.bubble.right" : "terminal")
                    }
                    NavigationLink(value: ShipRoute(workspaceId: workspace.id, checkout: task?.checkout ?? agent.checkout, taskId: task?.id)) {
                        Label(task?.isolated == true ? "Review Task" : "Review Changes", systemImage: "arrow.left.arrow.right")
                    }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
    }

    private func load(_ agent: Agent?) async {
        guard agent != nil else { return }
        let params: [String: Any] = ["workspaceId": route.workspaceId, "panelId": route.panelId]
        if let list = try? await core.call("agents.conversation", params, as: [ConversationMessage]?.self) {
            messages = list
        } else if messages == nil {
            messages = []
        }
    }

    private func send(_ agent: Agent) {
        let prompt = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        sending = true
        Task {
            let result = await core.action("agents.send", ["workspaceId": route.workspaceId, "panelId": route.panelId, "prompt": prompt])
            sending = false
            if result.ok {
                reply = ""
                messages = (messages ?? []) + [ConversationMessage(role: "user", text: prompt, createdAt: nil)]
            } else {
                failure = OpFailure(message: result.message ?? "The prompt did not go through.")
            }
        }
    }
}

/// What a blocked agent asks, and where to answer it.
private struct AttentionCard: View {
    let agent: Agent
    let open: PanelRoute

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(agent.attention ?? "\(agent.name) is waiting for you.", systemImage: "hand.raised.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)
            NavigationLink(value: open) {
                Label(agent.panelType == "chat" ? "Answer in the chat" : "Answer in the terminal", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct MessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        let mine = message.role == "user"
        HStack {
            if mine { Spacer(minLength: 40) }
            Text(markdown)
                .textSelection(.enabled)
                .padding(10)
                .background(mine ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            if !mine { Spacer(minLength: 20) }
        }
    }

    private var markdown: AttributedString {
        (try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(message.text)
    }
}
