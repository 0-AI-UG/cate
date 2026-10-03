// The core's state and results, mirrored from `src/shells/mobile/contract.ts`.

import Foundation

struct CoreState: Decodable, Equatable {
    var workspaces: [Workspace] = []
}

struct Workspace: Decodable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let runtimeId: String
    let connection: Connection
    /// Nil until the document arrives from the runtime.
    let panels: [Panel]?
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
    let title: String
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
