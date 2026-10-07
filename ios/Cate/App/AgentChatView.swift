// An agent as a chat. A new chat starts empty: write the task, pick what
// runs it in the box, send. Your message shows at once and the reply line
// shimmers while the agent starts and works; the same screen then follows
// the agent. A permission or question is answered in the panel it runs in
// (the live terminal or the T3 Code chat), one tap away in the toolbar.
// Review opens the workspace's review panel filtered to this agent's panel.
// The runtime pushes the conversation as it changes (AgentConversation);
// while the agent works the send button stops its turn.

import SwiftUI

/// A new agent chat in a workspace; from a canvas panel, its canvas is the
/// place picked first.
struct NewAgentRoute: Hashable {
    let workspaceId: String
    var canvasPanelId: String?
}

struct AgentChatView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let workspaceId: String
    /// The canvas a new agent was asked for from.
    let canvasPanelId: String?
    /// The agent's panel; nil until a new chat's agent started.
    @State private var panelId: String?
    /// The followed conversation; nil until the chat has an agent.
    @State private var conversation: AgentConversation?
    /// A new chat's first prompt while its agent starts.
    @State private var starting: String?
    @State private var draft = ""
    @State private var sending = false
    /// When this chat started its agent: until it shows up, it is starting.
    @State private var startedAt: Date?
    @State private var startFailure: String?
    @State private var options = AgentLaunchOptions()
    @AppStorage("agents.launch") private var remembered = ""
    @AppStorage("agents.worktree") private var worktree = true
    @State private var failure: OpFailure?
    @State private var placing: PendingPlacement?
    @State private var reviewing: PanelRoute?
    @State private var interrupting = false
    /// The conversation is scrolled to its end: what comes in stays in view.
    @State private var atEnd = true

    /// How long a started agent may take to show up before the chat stops
    /// waiting for it.
    private static let startWindow: TimeInterval = 60

    init(workspaceId: String, panelId: String?, canvasPanelId: String? = nil) {
        self.workspaceId = workspaceId
        self.canvasPanelId = canvasPanelId
        _panelId = State(initialValue: panelId)
    }

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let agent = panelId.flatMap { id in workspace?.agents.first { $0.panelId == id } }
        let panel = panelId.flatMap { id in workspace?.panels?.first { $0.id == id } }
        let title: String = agent?.title ?? panel?.title ?? (panelId == nil ? "New Agent" : "Agent")
        let subtitle: String = agent.map { "\($0.where) · \(AgentState.label($0))" } ?? workspace?.name ?? ""
        let connected = workspace?.connection.kind == .connected
        content(workspace, agent, panel)
            .navigationTitle(title)
            .navigationSubtitle(subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar(agent, panel) }
            .navigationDestination(item: $reviewing) { PanelView(route: $0) }
            .alert(item: $failure) { Alert(title: Text($0.message)) }
            .placementSheet($placing, workspaceId: workspaceId)
            .task { _ = await core.connected(workspaceId) }
            .task(id: connected && panelId == nil) { await loadOptions(connected) }
            .onChange(of: options.selected) { _, launch in remember(launch) }
            .task(id: panelId) { await follow(panelId) }
            .task(id: startedAt) { await expireStart() }
            .onChange(of: panelId, initial: true) { _, id in watch(id) }
            .onDisappear { unwatch() }
    }

    private func loadOptions(_ connected: Bool) async {
        guard connected, panelId == nil else { return }
        await options.load(core, workspaceId: workspaceId, remembered: remembered)
    }

    private func remember(_ launch: AgentLaunch?) {
        if let launch { remembered = launch.key }
    }

    private func expireStart() async {
        guard startedAt != nil else { return }
        try? await Task.sleep(for: .seconds(Self.startWindow))
        if !Task.isCancelled { startedAt = nil }
    }

    /// The agent on screen: its notifications stay quiet.
    private func watch(_ panelId: String?) {
        notifier.viewing = panelId.map { AgentRoute(workspaceId: workspaceId, panelId: $0) }
    }

    private func unwatch() {
        if notifier.viewing?.panelId == panelId { notifier.viewing = nil }
    }

    /// Follows the agent's conversation; the runtime pushes each change.
    private func follow(_ panelId: String?) async {
        guard let panelId else { return }
        let followed = AgentConversation()
        conversation = followed
        let first = starting
        starting = nil
        await followed.run(core, workspaceId: workspaceId, panelId: panelId, pending: first)
    }

    @ViewBuilder
    private func content(_ workspace: Workspace?, _ agent: Agent?, _ panel: Panel?) -> some View {
        let pending = conversation?.pending ?? starting
        let isNew = panelId == nil && pending == nil
        ScrollViewReader { proxy in
            ScrollView {
                // Not lazy: rows measured as they scroll in would move the
                // conversation under the reader.
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(conversation?.messages ?? []) { message in
                        MessageRow(message: message)
                    }
                    if let pending {
                        UserBubble(text: pending)
                    }
                    if let activity = activity(workspace, agent) {
                        ShimmerText(text: activity)
                    } else if let note = note(workspace, agent, panel) {
                        Text(note).font(.callout).foregroundStyle(.secondary)
                    }
                    if let startFailure {
                        Label(startFailure, systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .foregroundStyle(.red)
                    }
                    if let agent, agent.needsYou {
                        AttentionCard(agent: agent, open: PanelRoute(workspaceId: workspaceId, panelId: agent.panelId))
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding()
            }
            // Growth keeps the end in view while you are there, and the
            // spot you read at while you scrolled up.
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 48
            } action: { _, end in
                atEnd = end
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(atEnd ? .bottom : .top, for: .sizeChanges)
            .onChange(of: pending) { _, prompt in
                if prompt != nil { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .overlay {
            if isNew { NewChatPrompt(workspaceName: workspace?.name, draft: $draft) }
        }
        .safeAreaBar(edge: .bottom) { composer(workspace, agent) }
    }

    /// What the agent is doing while the reply is on its way; nil when it
    /// waits for you or is not running.
    private func activity(_ workspace: Workspace?, _ agent: Agent?) -> String? {
        guard panelId != nil else { return sending ? "Starting \(options.label)…" : nil }
        let name = agent?.name ?? "The agent"
        if conversation?.working == true { return interrupting ? "Stopping \(name)…" : "\(name) is working…" }
        if let agent {
            // Seen in the terminal, not yet heard from through its hooks.
            if agent.status == "notRunning", agent.present, startedAt != nil { return "Starting \(agent.name)…" }
            return nil
        }
        return startedAt != nil && workspace?.connection.kind == .connected ? "Starting…" : nil
    }

    /// Why nothing more happens here, when the agent is not running.
    private func note(_ workspace: Workspace?, _ agent: Agent?, _ panel: Panel?) -> String? {
        guard panelId != nil, let workspace else { return nil }
        guard workspace.connection.kind == .connected else { return workspace.connection.text }
        if workspace.panels != nil, panel == nil { return "The agent's panel was closed." }
        if agent == nil || agent?.present == false { return "The agent is not running. Open its panel to start it again." }
        return nil
    }

    @ViewBuilder
    private func composer(_ workspace: Workspace?, _ agent: Agent?) -> some View {
        let connected = workspace?.connection.kind == .connected
        if panelId == nil {
            AgentComposer(
                text: $draft,
                placeholder: "What should the agent do?",
                canSend: connected && options.launch != nil,
                sending: sending,
                options: options,
                worktree: $worktree,
                send: start
            )
        } else {
            let canSend = connected && conversation?.canReceivePrompt == true
            let stop: (() -> Void)? = connected && conversation?.working == true ? { interrupt() } : nil
            AgentComposer(
                text: $draft,
                placeholder: canSend ? "Reply to \(agent?.name ?? "the agent")" : composerHint(agent),
                canSend: canSend,
                sending: sending,
                send: reply,
                stop: stop
            )
        }
    }

    private func composerHint(_ agent: Agent?) -> String {
        guard let agent else { return "Reply" }
        if agent.needsYou { return "Answer the agent above first" }
        if conversation?.working == true { return "\(agent.name) is working…" }
        return "The agent is not at its prompt"
    }

    @ToolbarContentBuilder
    private func toolbar(_ agent: Agent?, _ panel: Panel?) -> some ToolbarContent {
        if let panelId, agent != nil || panel != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Review", systemImage: "arrow.left.arrow.right") { review() }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                let chat = (agent?.panelType ?? panel?.type) == "chat"
                NavigationLink(value: PanelRoute(workspaceId: workspaceId, panelId: panelId)) {
                    Label(chat ? "Open Chat" : "Open Terminal", systemImage: chat ? "bubble.left.and.text.bubble.right" : "terminal")
                }
            }
        }
    }

    // MARK: Prompts

    /// Asks where on the canvas the agent's panel goes when started from one;
    /// otherwise it goes to the dock.
    private func start() {
        guard let launch = options.launch else { return }
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        guard let canvasPanelId else { return start(prompt, launch, at: nil) }
        placing = PendingPlacement(title: "Start Agent", action: "Start", canvasPanelId: canvasPanelId) { start(prompt, launch, at: $0) }
    }

    private func start(_ prompt: String, _ launch: AgentLaunch, at placement: Placement?) {
        starting = prompt
        draft = ""
        startFailure = nil
        sending = true
        Task {
            var params: [String: Any] = [
                "workspaceId": workspaceId,
                "prompt": prompt,
                "launch": launch.params,
                "worktree": worktree,
            ]
            if let placement { params["placement"] = placement.params }
            let result = (try? await core.call("agents.start", params, as: StartedAgent.self))
                ?? StartedAgent(ok: false, panelId: nil, message: "The agent could not start.")
            sending = false
            if result.ok, let id = result.panelId {
                startedAt = .now
                panelId = id
            } else {
                starting = nil
                draft = prompt
                startFailure = result.message ?? "The agent could not start."
            }
        }
    }

    private func reply() {
        guard let panelId, let conversation else { return }
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        // Shown at once (pending in the core); back in the box if it does
        // not go through.
        sending = true
        draft = ""
        Task {
            let result = await core.action("agents.send", [
                "viewId": conversation.viewId, "workspaceId": workspaceId, "panelId": panelId, "prompt": prompt,
            ])
            sending = false
            if !result.ok {
                if draft.isEmpty { draft = prompt }
                failure = OpFailure(message: result.message ?? "The prompt did not go through.")
            }
        }
    }

    /// Stops the agent's turn; the agent stays at its prompt.
    private func interrupt() {
        guard let panelId, !interrupting else { return }
        interrupting = true
        Task {
            let result = await core.action("agents.interrupt", ["workspaceId": workspaceId, "panelId": panelId])
            if !result.ok {
                interrupting = false
                failure = OpFailure(message: result.message ?? "The agent did not stop.")
                return
            }
            // Until the turn ends, or the agent ignored it.
            try? await Task.sleep(for: .seconds(5))
            interrupting = false
        }
    }

    private func review() {
        guard let panelId else { return }
        Task {
            if let review = await core.reviewAgent(workspaceId, panelId: panelId) {
                reviewing = review
            } else {
                failure = OpFailure(message: "The agent's changes could not be shown.")
            }
        }
    }
}

/// An empty chat: what to ask, and a few tasks to start from.
private struct NewChatPrompt: View {
    let workspaceName: String?
    @Binding var draft: String

    private static let suggestions: [(symbol: String, text: String)] = [
        ("checkmark.circle", "Run the tests and fix what fails"),
        ("magnifyingglass", "Explain how this project is put together"),
        ("arrow.left.arrow.right", "Review my latest changes"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            VStack(spacing: 6) {
                Text("What should we work on?")
                    .font(.title2.weight(.semibold))
                if let workspaceName {
                    Text(workspaceName).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            Spacer()
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Self.suggestions, id: \.text) { suggestion in
                    Button {
                        draft = suggestion.text
                    } label: {
                        Label(suggestion.text, systemImage: suggestion.symbol)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
    }
}

/// What a blocked agent asks, and where to answer it.
private struct AttentionCard: View {
    let agent: Agent
    let open: PanelRoute

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(agent.attention ?? "\(agent.name) is waiting for you.", systemImage: "hand.raised.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)
            NavigationLink(value: open) {
                Label(agent.panelType == "chat" ? "Answer in the Chat" : "Answer in the Terminal", systemImage: agent.panelSymbol)
            }
            .buttonStyle(.glassProminent)
            .tint(.orange)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: .rect(cornerRadius: 20))
    }
}

/// A turn: the person's prompts in a bubble on the right, the agent's
/// answers as Markdown across the screen. Reads its message's text, so a
/// growing reply redraws only its own row.
private struct MessageRow: View {
    let message: AgentConversation.Message

    var body: some View {
        if message.role == "user" {
            UserBubble(text: message.text)
        } else {
            MarkdownText(text: message.text)
        }
    }
}

private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(markdown)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.fill.secondary, in: .rect(cornerRadius: 20))
        }
    }

    private var markdown: AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
