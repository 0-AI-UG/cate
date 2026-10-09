// A followed agent chat (`agents.watch`): the messages, the agent's state
// read with them, and the prompt sent from here until it shows. Each message
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
        fileprivate(set) var streaming: Bool

        init(id: Int, _ message: ConversationMessage) {
            self.id = id
            role = message.role
            text = message.text
            streaming = message.streaming == true
        }
    }

    private(set) var messages: [Message] = []
    /// The agent's state; nil while the panel hosts no agent.
    private(set) var status: String?
    private(set) var canReceivePrompt = false
    private(set) var pending: String?
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
        guard event.from <= messages.count else { return }
        let end = event.from + event.messages.count
        if end < messages.count { messages.removeSubrange(end...) }
        for (offset, message) in event.messages.enumerated() {
            let index = event.from + offset
            if index < messages.count, messages[index].role == message.role {
                let existing = messages[index]
                if existing.text != message.text { existing.text = message.text }
                if existing.streaming != (message.streaming == true) { existing.streaming = message.streaming == true }
            } else if index < messages.count {
                messages[index] = Message(id: index, message)
            } else {
                messages.append(Message(id: index, message))
            }
        }
    }
}
