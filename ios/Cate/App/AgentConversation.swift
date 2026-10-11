// A followed agent chat (`agents.watch`): the messages, the agent's state
// read with them, the prompt sent from here until it shows and the one
// queued until the agent can take it, and where the steps show. Each message
// is its own object, numbered by its place in the conversation: a reply that
// grows changes that one message's text, so only its row redraws.

import SwiftUI

@MainActor
@Observable
final class AgentConversation {
    @MainActor
    @Observable
    final class Message: Identifiable {
        let id: Int
        let role: String
        fileprivate(set) var text: String

        init(id: Int, _ message: ConversationMessage) {
            self.id = id
            role = message.role
            text = message.text
        }
    }

    private(set) var messages: [Message] = []
    /// The agent's state; nil while the panel hosts no agent.
    private(set) var status: String?
    private(set) var canReceivePrompt = false
    private(set) var pending: String?
    private(set) var queued: String?
    /// The step groups by the message they show before.
    private(set) var steps: [Int: AgentStepGroup] = [:]
    /// The step the running turn last completed.
    private(set) var activity: AgentStep?
    /// The first event came in.
    private(set) var loaded = false
    @ObservationIgnored let viewId = UUID().uuidString

    var working: Bool { status == "running" }

    /// Follows the panel's conversation until cancelled.
    func run(_ core: CoreHost, workspaceId: String, panelId: String, pending: String?) async {
        self.pending = pending
        core.watchAgent(viewId, workspaceId: workspaceId, panelId: panelId, pending: pending) { [weak self] data in
            guard let event = try? JSONDecoder().decode(ConversationEvent.self, from: data), event.kind == "conversation" else { return }
            self?.apply(event)
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3_600))
        }
        core.unwatchAgent(viewId)
    }

    private func apply(_ event: ConversationEvent) {
        loaded = true
        if status != event.status { status = event.status }
        if canReceivePrompt != event.canReceivePrompt { canReceivePrompt = event.canReceivePrompt }
        if pending != event.pending { pending = event.pending }
        if queued != event.queued { queued = event.queued }
        if let next = event.steps {
            let groups = Dictionary(next.groups.map { ($0.before, $0) }, uniquingKeysWith: { _, last in last })
            if steps != groups { steps = groups }
            if activity != next.activity { activity = next.activity }
        }
        guard event.from <= messages.count else { return }
        let end = event.from + event.messages.count
        if end < messages.count { messages.removeSubrange(end...) }
        for (offset, message) in event.messages.enumerated() {
            let index = event.from + offset
            if index < messages.count, messages[index].role == message.role {
                let existing = messages[index]
                if existing.text != message.text { existing.text = message.text }
            } else if index < messages.count {
                messages[index] = Message(id: index, message)
            } else {
                messages.append(Message(id: index, message))
            }
        }
    }
}
