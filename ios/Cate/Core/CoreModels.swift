// The core's state and results, mirrored from `src/shells/mobile/contract.ts`.

import Foundation

struct CoreState: Decodable, Equatable {
    /// This client's id, as browser sessions name it.
    var clientId = ""
    var workspaces: [Workspace] = []
}

struct Workspace: Decodable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let runtimeId: String
    let connection: Connection
    /// Nil until the document arrives from the runtime.
    let panels: [Panel]?
    /// Empty while not connected.
    let agents: [Agent]
    let tasks: [AgentTask]
    /// Keep-awake on the runtime's machine; nil while not connected.
    let power: PowerState?
    /// This device's pushes from the workspace; nil until registered.
    let push: PushStatus?
}

/// An agent a panel hosts (`MobileAgent`).
struct Agent: Decodable, Equatable, Hashable, Identifiable {
    let panelId: String
    /// `terminal` or `chat`.
    let panelType: String
    let title: String
    let agentId: String?
    let agentName: String?
    let runner: String
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
    let taskId: String?
    var id: String { panelId }

    /// Blocked on the person: a permission or a question.
    var needsYou: Bool { status == "waitingForInput" && !canReceivePrompt }
    var working: Bool { status == "running" }
    var name: String { agentName ?? (runner == "t3" ? "T3 Code" : "Agent") }
    var sinceDate: Date { Date(timeIntervalSince1970: since / 1_000) }
}

/// A mission worker (`MobileTask`).
struct AgentTask: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let panelId: String
    let agentName: String
    let title: String
    /// `starting`, `working`, `waiting`, `ready`, `stopped` or `failed`.
    let status: String
    let checkout: String
    let isolated: Bool
    let ownsWorktree: Bool
    let appliedToBranch: String?
    let kept: Bool
    let statusLine: String?
    let failureReason: String?

    /// Finished in its own worktree, with nothing decided about it yet.
    var awaitsDecision: Bool { status == "ready" && isolated && appliedToBranch == nil && !kept }
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
    let kind: Kind
    let text: String
    let retryable: Bool
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
    var id: String { type }
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

/// The answer to an agent or git action (`MobileActionResult`).
struct ActionResult: Decodable {
    let ok: Bool
    let message: String?
}

/// `agents.startTask`'s answer.
struct StartedTask: Decodable {
    let ok: Bool
    let panelId: String?
    let message: String?
}

/// `changes.pullRequest`'s answer.
struct PullRequestResult: Decodable {
    let ok: Bool
    let url: String?
    let message: String?
}

/// One visible turn of an agent's conversation.
struct ConversationMessage: Decodable, Hashable {
    let role: String
    let text: String
    let createdAt: String?
}

/// An agent a new task can run with.
struct TaskAgent: Decodable, Hashable, Identifiable {
    let agentId: String
    let displayName: String
    var id: String { agentId }
}

/// A checkout's uncommitted changes (`MobileChanges`).
struct Changes: Decodable, Equatable {
    struct File: Decodable, Equatable, Identifiable {
        let path: String
        let status: String
        let additions: Int?
        let deletions: Int?
        var id: String { path }
    }
    let branch: String?
    let files: [File]
    let additions: Int
    let deletions: Int
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
    case text(String)
    case error(String)

    private struct Envelope: Decodable {
        let kind: String
        let tabId: String?
        let url: String?
        let script: String?
        let text: String?
        let message: String?
    }

    /// Nil for a snapshot, which the view decodes into its own type.
    static func decode(_ data: Data) -> ViewEvent? {
        guard let event = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }
        switch event.kind {
        case "load": return .load(tabId: event.tabId ?? "", url: event.url ?? "")
        case "script": return .script(event.script ?? "")
        case "text": return .text(event.text ?? "")
        case "error": return .error(event.message ?? "")
        default: return nil
        }
    }
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
