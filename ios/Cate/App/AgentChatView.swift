// An agent as a chat. A new chat starts empty: say what to do, pick what
// runs it in the box, send. Your message shows at once and stays where it
// is; the chat's last slot says what the agent does from then until its turn
// ended, shimmering (thinking, the step it last completed, stopping), and
// replies come in line by line (ChatPresentation). The same screen then
// follows the agent; a conversation that takes a moment to load shows a
// spinner in the middle, one shown before shows at once. Each turn's steps
// show between the replies they came between. What you send while the agent
// works waits in the runtime's queue until it can take it, even with this app
// away; a prompt the agent did not take shows as failed, as it may still be
// in its terminal's input, and holds the queue until a turn starts or it is
// taken back. A permission or question is answered in the panel it runs in
// (the live terminal), one tap away in the toolbar.
// Review opens the workspace's review panel filtered to this agent's panel.
// The runtime pushes the conversation as it changes (AgentConversation);
// while the agent works the send button stops its turn.

import SwiftUI

/// A new agent chat in a workspace; from a canvas, its panel goes there.
struct NewAgentRoute: Hashable {
    let workspaceId: String
    var placement: Placement?
}

struct AgentChatView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    let workspaceId: String
    /// Where a new agent's panel goes; nil for the dock.
    let placement: Placement?
    /// The agent's panel; nil until a new chat's agent started.
    @State private var panelId: String?
    /// The followed conversation; nil until the chat has an agent.
    @State private var conversation: AgentConversation?
    /// A new chat's first prompt while its agent starts.
    @State private var starting: String?
    /// What is typed: kept out of this view's body, so a keystroke redraws
    /// the composer and not the conversation.
    @State private var input = ChatInput()
    @State private var sending = false
    /// When this chat started its agent: until it shows up, it is starting.
    @State private var startedAt: Date?
    @State private var startFailure: String?
    @State private var options = AgentChoiceOptions()
    @State private var attachments = ComposerAttachments()
    @AppStorage("agents.agent") private var remembered = ""
    @AppStorage("agents.worktree") private var worktree = true
    @State private var failure: OpFailure?
    @State private var reviewing: PanelRoute?
    @State private var interrupting = false
    /// The composer has the keyboard.
    @FocusState private var typing: Bool

    /// How long a started agent may take to show up before the chat stops
    /// waiting for it.
    private static let startWindow: TimeInterval = 60

    init(workspaceId: String, panelId: String?, placement: Placement? = nil) {
        self.workspaceId = workspaceId
        self.placement = placement
        _panelId = State(initialValue: panelId)
    }

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let agent = panelId.flatMap { id in workspace?.agents.first { $0.panelId == id } }
        let panel = panelId.flatMap { id in workspace?.panels?.first { $0.id == id } }
        let title: String = agent?.title ?? panel?.title ?? (panelId == nil ? "New Agent" : "Agent")
        // While its turn runs here, the agent works: its state from the
        // agent list may end the turn before the reply showed.
        let subtitle: String = agent.map { agent in
            let state = agent.needsYou || conversation?.turn == nil ? AgentState.label(agent) : "Working"
            return "\(agent.where) · \(state)"
        } ?? workspace?.name ?? ""
        let connected = workspace?.connection.kind == .connected
        content(workspace, agent, panel)
            .navigationTitle(title)
            .navigationSubtitle(subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar(agent, panel) }
            .navigationDestination(item: $reviewing) { PanelView(route: $0) }
            .alert(item: $failure) { Alert(title: Text($0.message)) }
            .task { _ = await core.connected(workspaceId) }
            .task(id: connected && panelId == nil) { await loadOptions(connected) }
            .onChange(of: options.selected) { _, agentId in if let agentId { remembered = agentId } }
            .task(id: panelId) { await follow(panelId) }
            .task(id: startedAt) { await expireStart() }
            .onChange(of: panelId, initial: true) { _, id in watch(id) }
            .onDisappear { unwatch() }
            // A link in a reply opens where the core says, never by itself.
            .environment(\.openURL, OpenURLAction { url in
                core.openMarkdownLink(url.absoluteString, workspaceId: workspaceId, panelId: panelId)
                return .handled
            })
    }

    private func loadOptions(_ connected: Bool) async {
        guard connected, panelId == nil else { return }
        await options.load(core, workspaceId: workspaceId, remembered: remembered)
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
        // Back from the terminal or review: the same conversation follows
        // on, so what was read stays on screen instead of starting blank.
        let followed = conversation.flatMap { $0.panelId == panelId ? $0 : nil } ?? AgentConversation(panelId: panelId)
        conversation = followed
        let first = starting
        starting = nil
        await followed.run(core, workspaceId: workspaceId, pending: first)
    }

    @ViewBuilder
    private func content(_ workspace: Workspace?, _ agent: Agent?, _ panel: Panel?) -> some View {
        let isNew = panelId == nil && starting == nil
        ConversationList(
            conversation: conversation,
            starting: conversation == nil ? starting : nil,
            tail: tail(workspace, agent, panel),
            startFailure: startFailure,
            attention: agent?.needsYou == true ? agent : nil,
            workspaceId: workspaceId,
            input: input,
            attachments: attachments
        )
        .overlay { DelayedSpinner(active: loading(workspace)) }
        .scrollDismissesKeyboard(.interactively)
        // A tap anywhere on the conversation puts the keyboard away, also
        // on its empty space and on text that can be selected.
        .contentShape(.rect)
        .simultaneousGesture(TapGesture().onEnded { if typing { typing = false } })
        .overlay {
            if isNew { NewChatPrompt(workspaceName: workspace?.name, input: input) }
        }
        // An inset, not a bar: it rises with the keyboard.
        .safeAreaInset(edge: .bottom, spacing: 0) { composer(workspace, agent) }
        .onChange(of: conversation?.turn == nil) { _, ended in if ended { interrupting = false } }
    }

    /// The conversation is on its way and there is nothing to show yet.
    private func loading(_ workspace: Workspace?) -> Bool {
        guard panelId != nil, workspace?.connection.kind == .connected else { return false }
        guard let conversation else { return starting == nil }
        return !conversation.loaded && conversation.items.isEmpty
    }

    /// What the chat's last slot says: what the agent does while its turn
    /// runs, else why nothing more happens here.
    private func tail(_ workspace: Workspace?, _ agent: Agent?, _ panel: Panel?) -> TailContent? {
        let connected = workspace?.connection.kind == .connected
        // A new chat's agent starting.
        guard panelId != nil else { return sending ? .waiting : nil }
        if connected, let turn = conversation?.turn, alive(agent) {
            if interrupting { return .stopping }
            if let step = turn.step {
                return .step([step.tool, step.subject].compactMap(\.self).joined(separator: " · "))
            }
            return .waiting
        }
        if connected, sending { return .waiting }
        // Started here and not heard from yet: it is on its way.
        if connected, startedAt != nil, conversation?.loaded != true { return .waiting }
        return note(workspace, agent, panel).map { .note($0) }
    }

    /// The agent can still answer: it is there, or one started here has
    /// not shown up yet.
    private func alive(_ agent: Agent?) -> Bool {
        guard let agent else { return startedAt != nil || conversation?.working == true }
        return agent.present || agent.status == "running"
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
        @Bindable var input = input
        let connected = workspace?.connection.kind == .connected
        if panelId == nil {
            AgentComposer(
                text: $input.text,
                placeholder: "What should the agent do?",
                canSend: connected && options.ready != nil,
                sending: sending,
                workspaceId: workspaceId,
                attachments: attachments,
                options: options,
                worktree: $worktree,
                send: start,
                typing: $typing
            )
        } else {
            let canSend = connected && agent?.present == true && conversation?.status != nil
            let stop: (() -> Void)? = connected && conversation?.working == true ? { interrupt() } : nil
            AgentComposer(
                text: $input.text,
                placeholder: composerHint(agent),
                canSend: canSend,
                sending: sending,
                workspaceId: workspaceId,
                searchRoot: agent?.checkout,
                attachments: attachments,
                send: reply,
                stop: stop,
                typing: $typing
            )
        }
    }

    private func composerHint(_ agent: Agent?) -> String {
        guard let agent else { return "Reply" }
        guard agent.present, conversation?.status != nil else { return "The agent is not running" }
        if conversation?.canReceivePrompt == true { return "Reply to \(agent.name)" }
        return agent.needsYou ? "Queue a reply for after you answer" : "Queue a reply"
    }

    @ToolbarContentBuilder
    private func toolbar(_ agent: Agent?, _ panel: Panel?) -> some ToolbarContent {
        if let panelId, agent != nil || panel != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Review", systemImage: "arrow.left.arrow.right") { review() }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: PanelRoute(workspaceId: workspaceId, panelId: panelId)) {
                    Label("Open Terminal", systemImage: "terminal")
                }
            }
        }
    }

    // MARK: Prompts

    /// Starts the agent; its panel goes where the chat was asked from.
    private func start() {
        guard let agentId = options.ready?.agentId, attachments.ready else { return }
        let prompt = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let paths = attachments.paths
        guard !prompt.isEmpty || !paths.isEmpty else { return }
        starting = prompt.isEmpty ? ComposerAttachments.onlyPrompt : prompt
        input.text = ""
        attachments.clear()
        startFailure = nil
        sending = true
        Task {
            var params: [String: Any] = [
                "workspaceId": workspaceId,
                "prompt": prompt,
                "attachments": paths,
                "agentId": agentId,
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
                input.text = prompt
                attachments.restore(paths)
                startFailure = result.message ?? "The agent could not start."
            }
        }
    }

    private func reply() {
        guard let panelId, let conversation, attachments.ready else { return }
        let prompt = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let paths = attachments.paths
        guard !prompt.isEmpty || !paths.isEmpty else { return }
        input.text = ""
        attachments.clear()
        // The runtime sends it once the agent can take it and the chat shows
        // where it is; back in the box only if no agent can take it.
        sending = true
        Task {
            let result = await core.action("agents.send", [
                "workspaceId": workspaceId, "panelId": panelId, "prompt": prompt, "attachments": paths,
            ])
            sending = false
            if !result.ok {
                if input.text.isEmpty { input.text = prompt }
                attachments.restore(paths)
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
            // Until the turn ends (`content`), or the agent ignored it.
            try? await Task.sleep(for: .seconds(10))
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

/// What is typed in the composer.
@MainActor
@Observable
final class ChatInput {
    var text = ""
}

/// The conversation: its items (prompts, replies, each turn's steps between
/// them), what the agent does, the prompts not taken and the one queued. Its own view, so typing and
/// the keyboard redraw the composer and leave this be.
private struct ConversationList: View {
    @Environment(CoreHost.self) private var core
    let conversation: AgentConversation?
    /// A new chat's first prompt while its agent starts.
    let starting: String?
    let tail: TailContent?
    let startFailure: String?
    /// The agent when it waits for you.
    let attention: Agent?
    let workspaceId: String
    let input: ChatInput
    let attachments: ComposerAttachments
    /// The chat follows its end: what comes in stays in view. Only your
    /// scrolling changes it (up: off; back to the end: on), never the chat
    /// growing past the screen.
    @State private var following = true
    /// You are scrolling it (dragging, or flicked and it still moves).
    @State private var scrolling = false
    /// The top is near: earlier items are asked for as you scroll there.
    @State private var nearTop = false
    /// Earlier items were asked for while this was the first: what shows
    /// stays where it is when they come in above it.
    @State private var earlierFrom: String?
    /// Something came in below while you read further up.
    @State private var unseen = false
    /// The items fade in once, when the first ones come.
    @State private var listShown = false

    /// How far above the top earlier items are asked for.
    private static let ahead: CGFloat = 600

    var body: some View {
        let items = conversation?.items ?? []
        ScrollViewReader { proxy in
            ScrollView {
                // Not lazy: rows measured as they scroll in would move the
                // conversation under the reader.
                VStack(alignment: .leading, spacing: 16) {
                    Group {
                        if conversation?.earlier == true {
                            ProgressView().frame(maxWidth: .infinity)
                        }
                        ForEach(items) { item in
                            ItemRow(item: item)
                        }
                    }
                    .opacity(listShown ? 1 : 0)
                    if let starting {
                        UserBubble(text: starting)
                    }
                    TailSlot(wanted: tail)
                    ForEach(conversation?.failed ?? []) { prompt in
                        FailedBubble(prompt: prompt, edit: { withdraw(prompt.id, edit: true) }, dismiss: { withdraw(prompt.id, edit: false) })
                    }
                    ForEach(conversation?.queued ?? []) { queued in
                        QueuedBubble(text: queued.text) { withdraw(queued.id, edit: true) }
                    }
                    if let startFailure {
                        Label(startFailure, systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .foregroundStyle(.red)
                    }
                    if let attention {
                        AttentionCard(agent: attention, open: PanelRoute(workspaceId: workspaceId, panelId: attention.panelId))
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding()
            }
            // Growth keeps the end in view while it follows, frame by frame
            // as a reply reveals, and the spot you read at while you
            // scrolled up.
            .onScrollPhaseChange { _, phase in
                scrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                // Let go at the end while it follows: catch up with what grew.
                if !scrolling, following { proxy.scrollTo("end", anchor: .bottom) }
                if scrolling, nearTop { loadEarlier() }
            }
            .onScrollGeometryChange(for: Bool.self) { $0.visibleRect.minY < Self.ahead } action: { _, near in
                nearTop = near
                if near, scrolling { loadEarlier() }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 48
            } action: { _, end in
                if end {
                    following = true
                    unseen = false
                } else if scrolling {
                    following = false
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                if following, !scrolling, new != old { proxy.scrollTo("end", anchor: .bottom) }
                // Earlier items came in above (and were kept out of the way):
                // still near the top, the page before them too.
                if let from = earlierFrom, items.first?.id != from {
                    earlierFrom = nil
                    if nearTop, scrolling { loadEarlier() }
                }
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            // Never moved under your finger: growth while you scroll stays
            // below, and earlier items come in above what shows.
            .defaultScrollAnchor((following && !scrolling) || earlierFrom != nil ? .bottom : .top, for: .sizeChanges)
            .environment(\.chatScrolling, scrolling)
            .onAppear { listShown = !items.isEmpty }
            .onChange(of: items.isEmpty) { _, empty in
                guard !empty, !listShown else { return }
                // What was on screen already (a prompt sent here) does not fade.
                if items.contains(where: \.live) {
                    listShown = true
                } else {
                    withAnimation(.easeOut(duration: 0.25)) { listShown = true }
                }
            }
            .onChange(of: items.last?.id) { _, _ in
                if !following { unseen = true }
            }
            // Your prompt went out: to the end, where it shows.
            .onChange(of: items.last { $0.kind == .prompt && !$0.sent }?.id) { _, id in
                if id != nil { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
            .overlay(alignment: .bottom) {
                if unseen {
                    Button("New", systemImage: "arrow.down") {
                        withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                    }
                    .buttonStyle(.glass)
                    .font(.footnote.weight(.semibold))
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .animation(.snappy, value: unseen)
        }
    }

    /// Asks for the page before the items, once at a time.
    private func loadEarlier() {
        guard let conversation, conversation.earlier, earlierFrom == nil, let first = conversation.items.first else { return }
        earlierFrom = first.id
        conversation.more(core)
    }

    /// Takes a queued or failed prompt back from the runtime; `edit` puts it
    /// back in the box.
    private func withdraw(_ promptId: String, edit: Bool) {
        guard let conversation else { return }
        Task {
            let params = ["workspaceId": workspaceId, "panelId": conversation.panelId, "promptId": promptId]
            guard let queued = try? await core.call("agents.withdraw", params, as: QueuedPrompt?.self), edit else { return }
            let prompt = queued.prompt
            if !prompt.isEmpty { input.text = input.text.isEmpty ? prompt : "\(prompt)\n\n\(input.text)" }
            attachments.restore(queued.attachments)
        }
    }
}

/// An empty chat: what to ask, and a few prompts to start from.
private struct NewChatPrompt: View {
    let workspaceName: String?
    let input: ChatInput

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
                        input.text = suggestion.text
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
                Label("Answer in the Terminal", systemImage: "terminal")
            }
            .buttonStyle(.glassProminent)
            .tint(.orange)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: .rect(cornerRadius: 20))
    }
}

/// An item: the person's prompts in a bubble on the right, the agent's
/// replies as Markdown across the screen (ReplyView), a turn's steps. Reads
/// its item, so a growing reply redraws only its own row. Your own prompts
/// show at once: they were on screen already, as sent. Long press copies a
/// message.
private struct ItemRow: View {
    let item: AgentConversation.Item

    var body: some View {
        switch item.kind {
        case .prompt:
            UserBubble(text: item.text).contextMenu { copy }
        case .reply:
            ReplyView(item: item).contextMenu { copy }
        case .steps:
            AgentStepsRow(item: item)
        }
    }

    private var copy: some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text }
    }
}

/// A prompt waiting for the agent to be at its prompt; it can be taken back.
private struct QueuedBubble: View {
    let text: String
    let unqueue: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            UserBubble(text: text).opacity(0.55)
            HStack(spacing: 6) {
                Image(systemName: "clock")
                Text("Queued")
                Button("Edit", action: unqueue).buttonStyle(.borderless)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A prompt the agent did not take: it may still be in its terminal's input,
/// and nothing more is typed there until a turn starts or it is taken back.
/// Edit puts it back in the box; Dismiss lets it go. Either way the text may
/// still be in the terminal, to clear there.
private struct FailedBubble: View {
    let prompt: OutgoingPrompt
    let edit: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            UserBubble(text: prompt.text).opacity(0.55)
            Group {
                Label(prompt.message ?? "The agent did not take it.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.trailing)
                Text("If you edit or dismiss it, clear it from the terminal too.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                HStack(spacing: 12) {
                    Button("Edit", action: edit)
                    Button("Dismiss", action: dismiss)
                }
                .buttonStyle(.borderless)
            }
            .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(markdown)
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
