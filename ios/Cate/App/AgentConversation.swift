// A followed agent chat (`agents.watch`): its items as the core lays them out
// (`chatTimeline.ts`), the agent's state, the prompts the runtime keeps on
// their way (queued until the agent can take one, failed when not taken),
// and the turn in progress. Each item is its own object under an
// id that stays while the chat grows: a reply that grows changes that one
// item's text, so only its row redraws, and the prompt sent from here is the
// same row once the conversation shows it. Events are decoded off the main
// thread, in order. What was last shown is kept (`ChatCache`), so a chat
// opened again shows at once and the runtime's answer updates it in place.

import SwiftUI

@MainActor
@Observable
final class AgentConversation {
    @MainActor
    @Observable
    final class Item: Identifiable {
        enum Kind: String {
            case prompt, reply, steps
        }

        let id: String
        let kind: Kind
        fileprivate(set) var text: String
        /// A prompt the conversation shows (false: on its way).
        fileprivate(set) var sent: Bool
        fileprivate(set) var steps: [AgentStep]
        fileprivate(set) var ghost: Bool
        /// Came in while the chat was on screen: a reply reveals its blocks.
        let live: Bool

        fileprivate init?(_ data: ChatItemData, live: Bool) {
            guard let kind = Kind(rawValue: data.kind) else { return nil }
            id = data.id
            self.kind = kind
            text = data.text ?? ""
            sent = data.sent ?? true
            steps = data.steps ?? []
            ghost = data.ghost ?? false
            self.live = live
        }

        fileprivate func update(_ data: ChatItemData) {
            if let next = data.text, next != text { text = next }
            if let next = data.sent, next != sent { sent = next }
            if let next = data.steps, next != steps { steps = next }
            if let next = data.ghost, next != ghost { ghost = next }
        }

        fileprivate var data: ChatItemData {
            ChatItemData(kind: kind.rawValue, id: id, text: text, sent: sent, steps: steps, ghost: ghost)
        }
    }

    private(set) var items: [Item] = []
    /// The agent's state; nil while the panel hosts no agent.
    private(set) var status: String?
    private(set) var canReceivePrompt = false
    private(set) var queued: [OutgoingPrompt] = []
    private(set) var failed: [OutgoingPrompt] = []
    /// The turn in progress; nil between turns.
    private(set) var turn: ChatTurn?
    /// The runtime's conversation came in (what shows before may be cached).
    private(set) var loaded = false
    @ObservationIgnored let viewId = UUID().uuidString
    /// The agent's panel.
    @ObservationIgnored let panelId: String
    @ObservationIgnored private var cacheKey = ""

    private static let decoding = DispatchQueue(label: "cate.chat.decode", qos: .userInitiated)

    init(panelId: String) {
        self.panelId = panelId
    }

    var working: Bool { status == "running" }

    /// Follows the panel's conversation until cancelled.
    func run(_ core: CoreHost, workspaceId: String, pending: String?) async {
        cacheKey = "\(workspaceId)-\(panelId)"
        if items.isEmpty, let cached = ChatCache.load(cacheKey) {
            items = cached.compactMap { Item($0, live: false) }
        }
        if let pending, items.isEmpty, let item = Item(ChatItemData(kind: "prompt", id: "m0", text: pending, sent: false, steps: nil, ghost: nil), live: true) {
            items = [item]
        }
        core.watchAgent(viewId, workspaceId: workspaceId, panelId: panelId, pending: pending) { [weak self] data in
            Self.decoding.async {
                guard let event = try? JSONDecoder().decode(ChatEvent.self, from: data), event.kind == "chat" else { return }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.apply(event) }
                }
            }
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3_600))
        }
        core.unwatchAgent(viewId)
    }

    private func apply(_ event: ChatEvent) {
        // Before the conversation came in, an item is what was shown already
        // (cached, or the prompt on its way); after, it is new.
        let live = loaded || !items.isEmpty
        if event.loaded, !loaded { loaded = true }
        if status != event.status { status = event.status }
        if canReceivePrompt != event.canReceivePrompt { canReceivePrompt = event.canReceivePrompt }
        if queued != event.queued { queued = event.queued }
        if failed != event.failed { failed = event.failed }
        if turn != event.turn { turn = event.turn }
        // While it is not read, the items are the prompt on its way at most:
        // what is cached stays.
        if !event.loaded, event.items.isEmpty { return }
        let from = min(event.from, items.count)
        var old: [String: Item] = [:]
        for item in items[from...] { old[item.id] = item }
        let tail = event.items.compactMap { data -> Item? in
            if let item = old[data.id], item.kind.rawValue == data.kind {
                item.update(data)
                return item
            }
            return Item(data, live: live)
        }
        if items[from...].map(\.id) != tail.map(\.id) || zip(items[from...], tail).contains(where: { $0 !== $1 }) {
            items = Array(items[..<from]) + tail
        }
        if event.loaded { ChatCache.save(cacheKey, items.map(\.data)) }
    }
}

/// The chats last shown, by workspace and panel: in memory, and on disk for
/// the next launch. Saved a moment after the last change.
@MainActor
enum ChatCache {
    private static var memory: [String: [ChatItemData]] = [:]
    private static var saving: [String: Task<Void, Never>] = [:]
    /// The latest items a chat keeps: enough for a screen and some.
    private static let kept = 120

    private static func file(_ key: String) -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" }
        return caches.appending(path: "chats", directoryHint: .isDirectory).appending(path: String(safe) + ".json")
    }

    static func load(_ key: String) -> [ChatItemData]? {
        if let items = memory[key] { return items }
        guard let url = file(key), let data = try? Data(contentsOf: url),
              let items = try? JSONDecoder().decode([ChatItemData].self, from: data) else { return nil }
        memory[key] = items
        return items
    }

    static func save(_ key: String, _ items: [ChatItemData]) {
        // A prompt on its way is not kept: it may not go through.
        let items = Array(items.filter { $0.sent != false }.suffix(kept))
        memory[key] = items
        saving[key]?.cancel()
        saving[key] = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let url = file(key) else { return }
            await Task.detached(priority: .utility) {
                guard let data = try? JSONEncoder().encode(items) else { return }
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: url, options: .atomic)
            }.value
        }
    }
}
