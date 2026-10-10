// The core's state and results, mirrored from `src/shells/mobile/contract.ts`.

import Foundation

struct CoreState: Decodable, Equatable {
    /// This client's id, as browser sessions name it.
    var clientId = ""
    var workspaces: [WorkspaceState] = []
    /// A workspace that must be trusted before it runs anything; nil when
    /// nothing asks.
    var trustPrompt: TrustPrompt?
}

/// A trust question (`trustPrompt`).
struct TrustPrompt: Decodable, Equatable {
    let workspaceId: String
    /// What the question names: the workspace's folder or name.
    let label: String
}

/// A workspace as the core pushes it (`MobileWorkspace`).
struct WorkspaceState: Decodable, Equatable {
    let id: String
    let name: String
    let runtimeId: String
    let connection: Connection
    let panels: [Panel]?
    let worktrees: [Worktree]
    let relations: [Relation]
    let relationsEnabled: Bool
    let agents: [Agent]
    let power: PowerState?
    let push: PushStatus?
    let others: [OtherClient]
}

/// A paired workspace. Each part is observed on its own, and changes only
/// when the core's push changed it: an agent's status redraws the views
/// that show agents, not every view of the workspace.
@MainActor
@Observable
final class Workspace: Identifiable {
    let id: String
    private(set) var name: String
    private(set) var runtimeId: String
    private(set) var connection: Connection
    /// Nil until the document arrives from the runtime.
    private(set) var panels: [Panel]?
    /// Its ready checkouts, the main one first; empty unless two or more.
    private(set) var worktrees: [Worktree]
    /// Empty while not connected or while relations are off.
    private(set) var relations: [Relation]
    /// The workspace setting `panelRelationsEnabled`.
    private(set) var relationsEnabled: Bool
    /// Empty while not connected.
    private(set) var agents: [Agent]
    /// Keep-awake on the runtime's machine; nil while not connected.
    private(set) var power: PowerState?
    /// This device's pushes from the workspace; nil until registered.
    private(set) var push: PushStatus?
    /// The other clients in the workspace; empty while not connected.
    private(set) var others: [OtherClient]

    init(_ state: WorkspaceState) {
        id = state.id
        name = state.name
        runtimeId = state.runtimeId
        connection = state.connection
        panels = state.panels
        worktrees = state.worktrees
        relations = state.relations
        relationsEnabled = state.relationsEnabled
        agents = state.agents
        power = state.power
        push = state.push
        others = state.others
    }

    /// Takes the parts that changed.
    func update(_ state: WorkspaceState) {
        if name != state.name { name = state.name }
        if runtimeId != state.runtimeId { runtimeId = state.runtimeId }
        if connection != state.connection { connection = state.connection }
        if panels != state.panels { panels = state.panels }
        if worktrees != state.worktrees { worktrees = state.worktrees }
        if relations != state.relations { relations = state.relations }
        if relationsEnabled != state.relationsEnabled { relationsEnabled = state.relationsEnabled }
        if agents != state.agents { agents = state.agents }
        if power != state.power { power = state.power }
        if push != state.push { push = state.push }
        if others != state.others { others = state.others }
    }
}

/// A workspace as the app remembers it between launches: listed at once,
/// connecting, while the core starts.
struct RememberedWorkspace: Codable, Equatable {
    let id: String
    let name: String
    let runtimeId: String

    var state: WorkspaceState {
        WorkspaceState(
            id: id, name: name, runtimeId: runtimeId,
            connection: Connection(kind: .connecting, title: "", text: "Connecting…", actions: []),
            panels: nil, worktrees: [], relations: [], relationsEnabled: false, agents: [],
            power: nil, push: nil, others: []
        )
    }
}

/// Another client in a workspace (`MobileOtherClient`).
struct OtherClient: Decodable, Equatable, Hashable, Identifiable {
    let clientId: String
    let name: String
    let attentive: Bool
    var id: String { clientId }

    /// The device name's initials, for its avatar.
    var initials: String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "'" || $0 == "’" })
        let letters = words.prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
        return letters.isEmpty ? "?" : letters
    }
}

/// An agent a panel hosts (`MobileAgent`).
struct Agent: Decodable, Equatable, Hashable, Identifiable {
    let panelId: String
    /// The hosting panel's type.
    let panelType: String
    let title: String
    let agentId: String?
    let agentName: String?
    /// The agent whose logo marks its panel (a CLI standing in for its
    /// terminal); nil shows the panel's own icon.
    let logo: String?
    /// `notRunning`, `running`, `waitingForInput` or `finished`.
    let status: String
    let present: Bool
    let canReceivePrompt: Bool
    /// What the agent asked for while it waits on the person.
    let attention: String?
    /// When the status last changed, epoch ms.
    let since: Double
    /// The checkout it works in; nil for the workspace root.
    let checkout: String?
    var id: String { panelId }

    /// Blocked on the person: a permission or a question.
    var needsYou: Bool { status == "waitingForInput" && !canReceivePrompt }
    var working: Bool { status == "running" }
    var name: String { agentName ?? "Agent" }
}

/// The runtime's `power` state.
struct PowerState: Decodable, Equatable, Hashable {
    let requested: Bool
    /// Epoch ms when the request lapses; nil while unlimited or off.
    let endsAt: Double?
    let busy: Bool
    let holding: Bool
}

/// The runtime's `push` status for this phone.
struct PushStatus: Decodable, Equatable, Hashable {
    let registered: Bool
    /// `cateConnectOff`, `serviceUnavailable` or nil.
    let blocked: String?
}

struct Connection: Decodable, Equatable, Hashable {
    enum Kind: String, Decodable {
        case connecting, connected, offline, incompatible, stopped, refused, closed
    }
    /// What the app offers for the state, main action first.
    enum Action: String, Decodable {
        case retry, pair, forget
    }
    let kind: Kind
    /// A short heading; empty when connected or closed.
    let title: String
    let text: String
    let actions: [Action]
}

struct Panel: Decodable, Equatable, Identifiable, Hashable {
    let id: String
    let type: String
    let typeLabel: String
    /// The panel type's icon name.
    let icon: String
    let title: String
    /// The canvas the panel sits on; nil for a panel in a window dock.
    let onCanvas: String?
    /// Canvas panels: the canvas they show.
    let canvas: CanvasModel?
    /// It takes prompts (a terminal, a chat): its relations go with them as
    /// context.
    let execution: Bool
    /// `once`, `always` or `off`: when its prompts take its relations'
    /// context.
    let contextMode: String
    /// What it shows, in a few words: a terminal's directory, an editor's
    /// file, a browser's URL.
    let detail: String?
    /// The checkout it belongs to (one of its workspace's `worktrees`).
    let worktreeId: String?
    /// It can be moved to another checkout (`panel.setWorktree`).
    let switchesWorktree: Bool
}

/// A checkout of the workspace's repository (`MobileWorktree`).
struct Worktree: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    /// Its label, else its folder's name; the main checkout is `main`.
    let label: String
    /// A theme palette key: `green`, `brightCyan`, ...
    let color: String
    let isPrimary: Bool
}

/// A relation between two panels (`MobileRelation`).
struct Relation: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let fromPanelId: String
    let toPanelId: String
    /// `use`, `context`, `verify` or `trigger`.
    let kind: String
    /// Its flow, which picks its color; nil when no prompt-taking panel
    /// reaches it.
    let flow: Int?
    /// Its words for its pair: "Reference", "Send findings to".
    let label: String
    /// The meanings it can take, the recommended one first.
    let options: [RelationOption]
}

/// A meaning a new relation can take (`MobileRelationOption`), the
/// recommended one first.
struct RelationOption: Decodable, Hashable, Identifiable {
    let kind: String
    let label: String
    let description: String
    var id: String { kind }
}

struct CanvasModel: Decodable, Equatable, Hashable {
    struct Node: Decodable, Equatable, Hashable, Identifiable {
        struct Rect: Decodable, Equatable, Hashable {
            let x: Double
            let y: Double
            let width: Double
            let height: Double
        }
        let id: String
        let rect: Rect
        /// The node's panels, in tree order.
        let panels: [String]
    }
    let id: String
    let nodes: [Node]
}

/// A panel type people can pick (`MobilePanelChoice`).
struct PanelChoice: Decodable, Identifiable, Hashable {
    let type: String
    let label: String
    let icon: String
    /// It can be placed on a canvas.
    let canvas: Bool
    var id: String { type }
}

/// Where a new panel goes (`MobilePlacement`): on the canvas a canvas panel
/// shows, centred on `point` (canvas coordinates) or where there is room.
/// No placement is the dock.
struct Placement: Hashable {
    let canvasPanelId: String
    var point: CGPoint?
    /// A picked spot's size; else the type's default.
    var size: CGSize?

    var params: [String: Any] {
        var params: [String: Any] = ["canvasPanelId": canvasPanelId]
        if let point { params["point"] = ["x": point.x, "y": point.y] }
        if let size { params["size"] = ["width": size.width, "height": size.height] }
        return params
    }
}

/// A rect in canvas coordinates (`MobileCanvasRect`).
struct CanvasRect: Codable, Hashable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = rect.minX
        y = rect.minY
        width = rect.width
        height = rect.height
    }

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// A file or folder on the runtime's machine (`MobileFileEntry`).
struct FileEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let isDirectory: Bool
    var id: String { path }
}

/// The answer to a panel op (`MobileOpResult`); `result` is the op's own.
struct OpReply<Result: Decodable>: Decodable {
    let ok: Bool
    let result: Result?
    let message: String?
    /// The rpc error code, `dirty` for an op that would lose unsaved work.
    let code: String?
}

extension OpReply: Sendable where Result: Sendable {}

/// Any JSON value, for op results the app ignores.
struct AnyJSON: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
}

/// The answer to an agent action (`MobileActionResult`).
struct ActionResult: Decodable {
    let ok: Bool
    let message: String?
    /// `panel.setWorktree`: the panel is busy; switching stops what runs.
    var dirty: Bool?
}

/// `agents.start`'s answer.
struct StartedAgent: Decodable {
    let ok: Bool
    let panelId: String?
    let message: String?
}

/// One visible turn of an agent's conversation.
struct ConversationMessage: Decodable, Hashable {
    let role: String
    let text: String
    let createdAt: String?
    /// The text is still coming in.
    let streaming: Bool?
}

/// What changed in a followed agent chat (`agents.watch`'s `conversation`
/// event): the agent's state, the prompt sent from it that the conversation
/// does not show yet, and the messages from index `from` on.
struct ConversationEvent: Decodable {
    let kind: String
    /// Nil while the panel hosts no agent.
    let status: String?
    let canReceivePrompt: Bool
    let pending: String?
    let from: Int
    let messages: [ConversationMessage]
}

/// An agent CLI a new agent can run (`MobileAgentChoice`).
struct AgentChoice: Decodable, Hashable, Identifiable {
    let agentId: String
    let displayName: String
    /// Its Cate hooks are on in the workspace.
    let ready: Bool
    /// The T3 provider it runs as; nil when T3 cannot run it.
    let t3Provider: String?
    var id: String { agentId }
}

/// A T3 provider instance a new chat can run on (`T3ProviderModels`).
struct T3Provider: Decodable, Hashable, Identifiable {
    struct Model: Decodable, Hashable, Identifiable {
        let slug: String
        let name: String
        let isDefault: Bool
        var id: String { slug }
    }
    let providerId: String
    let instanceId: String
    let label: String
    /// Installed, enabled and signed in.
    let ready: Bool
    let message: String?
    let models: [Model]
    var id: String { instanceId }
}

/// A notification from a connected workspace (`MobileNotification`).
struct CoreNotification: Decodable {
    let id: String
    let workspaceId: String
    let panelId: String?
    let kind: String
    let title: String
    let body: String
}

struct JoinResult: Decodable {
    let ok: Bool
    let workspaceId: String?
    let message: String?
}

/// What a terminal view is told (`MobileTerminalEvent`).
enum TerminalEvent {
    /// The PTY's grid, which the view draws, and whether the PTY fits this
    /// view: before the screen and on every change.
    case size(cols: Int, rows: Int, fitted: Bool)
    /// Clear the screen; the serialized screen follows as output.
    case reset
    /// Bytes for the terminal; UTF-8 may split between chunks.
    case output(Data)
    /// The panel's PTY state, with the text to show when it is not running.
    case state(status: String, text: String?)
}

/// What a view the app opened is told besides its snapshot
/// (`MobileViewEvent`).
enum ViewEvent {
    case load(tabId: String, url: String)
    case script(String)
    case reveal(Bool)
    case text(String, version: Int)
    case change(from: Int, to: Int, delta: [TextDelta])
    case error(String)

    private struct Envelope: Decodable {
        let kind: String
        let tabId: String?
        let url: String?
        let script: String?
        let shown: Bool?
        let text: String?
        let version: Int?
        let from: Int?
        let to: Int?
        let delta: [TextDelta]?
        let message: String?
    }

    /// Nil for a snapshot, which the view decodes into its own type.
    static func decode(_ data: Data) -> ViewEvent? {
        guard let event = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }
        switch event.kind {
        case "load": return .load(tabId: event.tabId ?? "", url: event.url ?? "")
        case "script": return .script(event.script ?? "")
        case "reveal": return .reveal(event.shown ?? false)
        case "text": return .text(event.text ?? "", version: event.version ?? 0)
        case "change":
            guard let from = event.from, let to = event.to, let delta = event.delta else { return nil }
            return .change(from: from, to: to, delta: delta)
        case "error": return .error(event.message ?? "")
        default: return nil
        }
    }
}

/// One step of a text change (`MobileTextDelta`), in UTF-16 units.
enum TextDelta: Decodable, Equatable {
    case retain(Int)
    case insert(String)
    case delete(Int)

    private enum Keys: String, CodingKey { case retain, insert, delete }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if let text = try container.decodeIfPresent(String.self, forKey: .insert) {
            self = .insert(text)
        } else if let count = try container.decodeIfPresent(Int.self, forKey: .retain) {
            self = .retain(count)
        } else {
            self = .delete(try container.decode(Int.self, forKey: .delete))
        }
    }

    /// The steps stay within a text of `length` units.
    static func fits(_ delta: [TextDelta], length: Int) -> Bool {
        var index = 0
        var length = length
        for step in delta {
            switch step {
            case .retain(let count): index += count
            case .insert(let inserted):
                let added = (inserted as NSString).length
                index += added
                length += added
            case .delete(let count): length -= count
            }
            if index > length { return false }
        }
        return true
    }

    /// `text` after the steps; nil when they do not fit it.
    static func apply(_ delta: [TextDelta], to text: String) -> String? {
        let out = NSMutableString(string: text)
        var index = 0
        for step in delta {
            switch step {
            case .retain(let count):
                index += count
                if index > out.length { return nil }
            case .insert(let inserted):
                out.insert(inserted, at: index)
                index += (inserted as NSString).length
            case .delete(let count):
                if index + count > out.length { return nil }
                out.deleteCharacters(in: NSRange(location: index, length: count))
            }
        }
        return out as String
    }
}

/// A buffer's whole text (`buffer.text`).
struct BufferText: Decodable {
    let text: String
    let version: Int
}

struct SnapshotEvent<Snapshot: Decodable>: Decodable {
    let kind: String
    let snapshot: Snapshot
}

/// The page of one chat load (`MobileChatPage`).
struct ChatPage: Decodable {
    struct Cookie: Decodable {
        let name: String
        let value: String
    }
    let loadId: Int
    let url: String
    let origin: String
    let cookie: Cookie
    let script: String
    let css: String
}

struct NavigationDecision: Decodable {
    let allow: Bool
}
