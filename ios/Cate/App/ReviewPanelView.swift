// Recorded agent edits grouped by commit, with on-demand diffs.
// Git comparisons and mutations belong to the repository, outside this panel.

import SwiftUI

struct ReviewSnapshot: Decodable, Equatable {
    struct Review: Decodable, Equatable {
        let repoPath: String
        let agentChanges: AgentFilter?
    }
    /// Present for recorded agent edits: whose edits show.
    struct AgentFilter: Decodable, Equatable {
        let agentId: String?
        let panelId: String?
        let sessionId: String?
        let turnId: String?
    }
    struct RecordedFile: Decodable, Equatable, Identifiable {
        let recordId: String
        let path: String
        let oldPath: String?
        let additions: Int
        let deletions: Int
        let commit: Commit?
        let uncommitted: Bool?
        var id: String { recordId + "\u{0}" + path }
    }
    struct Recorded: Decodable, Equatable {
        let loading: Bool
        let error: String?
        let files: [RecordedFile]
    }
    struct Commit: Decodable, Equatable, Identifiable {
        let hash: String
        let message: String
        var id: String { hash }
    }
    let review: Review
    let recorded: Recorded
    let loading: Bool
    let agentBusy: Bool
    let error: String?

}

/// A file's diff (`GitFileDiff`, `AgentChangedFile`).
struct FileDiff: Decodable {
    struct Hunk: Decodable, Identifiable {
        let header: String
        let lines: [Line]
        var id: String { header }
    }
    struct Line: Decodable {
        let kind: String
        let text: String
        let oldLine: Int?
        let newLine: Int?
    }
    let hunks: [Hunk]
    let page: Int
    let pageCount: Int
    let coverage: String
}

/// An agent a review can hand its work to (`MobileReviewAgent`).
struct ReviewAgent: Decodable, Identifiable, Equatable {
    let agentId: String
    let name: String
    let ready: Bool
    var id: String { agentId }
}

/// How this device shows diffs.
private enum ReviewDisplay {
    static let wrap = "review.wrap"
}

struct ReviewPanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.panelOnScreen) private var onScreen
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<ReviewSnapshot>()
    @State private var agents: [ReviewAgent] = []
    @State private var opened: PanelRoute?
    @State private var failure: OpFailure?
    @AppStorage(ReviewDisplay.wrap) private var wrap = false

    var body: some View {
        Group {
            if let snapshot = session.snapshot {
                content(snapshot)
            } else {
                ProgressView()
            }
        }
        .panelTitle(panel.title)
        .toolbar {
            if onScreen, let snapshot = session.snapshot {
                ToolbarItem(placement: .primaryAction) { agentMenu(snapshot) }
                ToolbarItem(placement: .primaryAction) { reviewMenu(snapshot) }
            }
        }
        .alert(item: $failure) { Alert(title: Text("Could not complete that"), message: Text($0.message)) }
        .navigationDestination(item: $opened) { PanelView(route: $0) }
        .task { await session.run(core, workspaceId: workspaceId, panelId: panel.id) }
        .task(id: session.snapshot != nil) {
            guard session.snapshot != nil else { return }
            agents = (try? await session.call("review.agents", [:], as: [ReviewAgent].self)) ?? []
        }
    }

    // MARK: Menus

    /// Starts a reviewer; findings stay in the agent's terminal conversation.
    private func agentMenu(_ snapshot: ReviewSnapshot) -> some View {
        Menu("Review in Terminal", systemImage: "terminal") {
            ForEach(agents) { agent in
                Button(agent.name) { run(["kind": "reviewWithAgent", "agentId": agent.agentId]) }.disabled(!agent.ready)
            }
        }
        .disabled(snapshot.agentBusy || agents.isEmpty || snapshot.recorded.files.isEmpty)
    }

    private func reviewMenu(_ snapshot: ReviewSnapshot) -> some View {
        return Menu {
            Button("Refresh", systemImage: "arrow.clockwise") { run(["kind": "refresh"]) }
            Toggle("Wrap Lines", systemImage: "text.word.spacing", isOn: $wrap)
        } label: {
            Label("Review Options", systemImage: "ellipsis.circle")
        }
    }

    // MARK: Lists

    @ViewBuilder
    private func content(_ snapshot: ReviewSnapshot) -> some View {
        agentFiles(snapshot)
    }

    private func agentFiles(_ snapshot: ReviewSnapshot) -> some View {
        List {
            if let filter = snapshot.review.agentChanges {
                let chips = filterChips(filter)
                if !chips.isEmpty {
                    Section {
                        ForEach(chips, id: \.label) { chip in
                            LabeledContent {
                                Button("Remove", systemImage: "xmark.circle.fill") { run(["kind": "updateFilter", "patch": chip.patch]) }
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(.secondary)
                            } label: {
                                Label(chip.label, systemImage: "line.3.horizontal.decrease.circle.fill")
                            }
                        }
                    } footer: {
                        Text("Only the edits these filters match show here.")
                    }
                }
            }
            if let error = snapshot.recorded.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            }
            if snapshot.recorded.loading && snapshot.recorded.files.isEmpty {
                ProgressView()
            }
            Section {
                ForEach(Array(snapshot.recorded.files.enumerated()), id: \.element.id) { index, file in
                    let group = file.commit?.hash ?? (file.uncommitted == true ? "uncommitted" : "unattributed")
                    let previous = index > 0 ? snapshot.recorded.files[index - 1] : nil
                    let previousGroup = previous.map { $0.commit?.hash ?? ($0.uncommitted == true ? "uncommitted" : "unattributed") }
                    if group != previousGroup {
                        Label(file.commit.map { "\($0.message) · \(String($0.hash.prefix(7)))" } ?? (file.uncommitted == true ? "Uncommitted changes" : "Other recorded edits"), systemImage: "point.3.connected.trianglepath.dotted")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    NavigationLink {
                        diffView(snapshot, path: file.path, oldPath: file.oldPath, source: .recorded(file.recordId))
                    } label: {
                        FileRow(status: nil, path: file.path, additions: file.additions, deletions: file.deletions)
                    }
                    .contextMenu {
                        Button("Open File", systemImage: "doc.text") { openFile(file.path) }
                        Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = file.path }
                    }
                }
            } header: {
                Text(snapshot.recorded.files.isEmpty ? "No recorded edits" : "Agent edits")
            } footer: {
                if snapshot.recorded.files.isEmpty && !snapshot.recorded.loading {
                    Text("No recorded edits match these filters.")
                }
            }
        }
        .refreshable { await session.send(["kind": "refresh"]) }
    }

    private func diffView(_ snapshot: ReviewSnapshot, path: String, oldPath: String?, source: DiffSource) -> some View {
        DiffView(session: session, path: path, oldPath: oldPath, source: source, openFile: { openFile(path) })
    }

    /// The filters on recorded edits, each with the patch that removes it.
    private func filterChips(_ filter: ReviewSnapshot.AgentFilter) -> [(label: String, patch: [String: Any])] {
        var chips: [(label: String, patch: [String: Any])] = []
        if let agentId = filter.agentId {
            chips.append((agents.first { $0.agentId == agentId }?.name ?? agentId, ["agentId": NSNull()]))
        }
        if let panelId = filter.panelId {
            let title = core.workspace(workspaceId)?.panels?.first { $0.id == panelId }?.title ?? "One panel"
            chips.append((title, ["panelId": NSNull(), "sessionId": NSNull(), "turnId": NSNull()]))
        }
        if filter.sessionId != nil { chips.append(("This conversation", ["sessionId": NSNull(), "turnId": NSNull()])) }
        if filter.turnId != nil { chips.append(("This turn", ["turnId": NSNull()])) }
        return chips
    }

    // MARK: Actions

    private func openFile(_ path: String) {
        Task {
            if case let panelId?? = try? await session.call("review.openFile", ["path": path], as: String?.self) {
                opened = PanelRoute(workspaceId: workspaceId, panelId: panelId)
            } else {
                failure = OpFailure(message: "The file could not be opened.")
            }
        }
    }

    private func run(_ op: [String: Any]) {
        Task {
            let reply = await session.send(op)
            if !reply.ok { failure = OpFailure(message: reply.message ?? "Something went wrong.") }
        }
    }
}

private struct FileRow: View {
    let status: String?
    let path: String
    let additions: Int?
    let deletions: Int?

    var body: some View {
        HStack {
            if let status {
                Text(Self.label(status)).font(.caption.monospaced()).foregroundStyle(Self.color(status)).frame(width: 14)
            }
            Text(path)
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.head)
            Spacer()
            Totals(additions: additions, deletions: deletions)
        }
    }

    static func label(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "copied": "C"
        case "type-changed": "T"
        case "unmerged": "U"
        default: "M"
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "added": .green
        case "deleted": .red
        case "unmerged": .orange
        default: .yellow
        }
    }
}

private struct Totals: View {
    let additions: Int?
    let deletions: Int?

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions.map(String.init) ?? "–")").foregroundStyle(.green)
            Text("-\(deletions.map(String.init) ?? "–")").foregroundStyle(.red)
        }
        .font(.caption.monospacedDigit())
    }
}

private enum DiffSource: Equatable {
    /// A recorded agent edit.
    case recorded(String)
}

private struct DiffView: View {
    let session: PanelSession<ReviewSnapshot>
    let path: String
    let oldPath: String?
    let source: DiffSource
    let openFile: () -> Void
    @AppStorage(ReviewDisplay.wrap) private var wrap = false
    @State private var diff: FileDiff?
    @State private var error: String?
    @State private var page = 0

    var body: some View {
        Group {
            if let diff {
                DiffContent(
                    diff: diff,
                    wrap: wrap
                )
            } else if let error {
                ContentUnavailableView("Could not load the diff", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Toggle("Wrap Lines", systemImage: "text.word.spacing", isOn: $wrap)
                    Divider()
                    Button("Open File", systemImage: "doc.text", action: openFile)
                    Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                } label: {
                    Label("Diff Options", systemImage: "ellipsis.circle")
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let diff, diff.pageCount > 1 {
                HStack {
                    Button("Previous") { page -= 1 }.disabled(page == 0)
                    Spacer()
                    Text("\(page + 1) / \(diff.pageCount)").font(.caption)
                    Spacer()
                    Button("Next") { page += 1 }.disabled(page + 1 >= diff.pageCount)
                }.padding().background(.regularMaterial)
            }
        }
        .task(id: page) { await load() }
    }

    private func load() async {
        let op: [String: Any]
        switch source {
        case .recorded(let recordId):
            op = ["kind": "recordedDiff", "recordId": recordId, "path": path, "page": page]
        }
        diff = nil
        error = nil
        let reply = await session.send(op, as: FileDiff.self)
        if let result = reply.result {
            diff = result
            error = nil
        } else {
            error = reply.message ?? "Something went wrong."
        }
    }

}

/// A file's diff: its hunks, scrolling both ways for long lines unless
/// they wrap.
private struct DiffContent: View {
    let diff: FileDiff
    let wrap: Bool

    var body: some View {
        if diff.hunks.isEmpty {
            ContentUnavailableView("No changes", systemImage: "equal")
        } else {
            GeometryReader { geometry in
                ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(diff.hunks) { hunk in
                            Text(hunk.header)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.blue.opacity(0.08))
                            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                                DiffLine(line: line, wrap: wrap, numbered: diff.coverage == "patch")
                                    .contextMenu { lineMenu(line) }
                            }
                        }
                    }
                    // Short diffs start at the top left, long lines scroll.
                    .frame(minWidth: geometry.size.width, maxWidth: wrap ? geometry.size.width : nil, minHeight: geometry.size.height, alignment: .topLeading)
                }
            }
        }
    }

    @ViewBuilder
    private func lineMenu(_ line: FileDiff.Line) -> some View {
        Button("Copy Line", systemImage: "doc.on.doc") { UIPasteboard.general.string = line.text }
    }

}

private struct DiffLine: View {
    let line: FileDiff.Line
    let wrap: Bool
    let numbered: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(numbered ? line.oldLine.map(String.init) ?? "" : "").frame(width: 34, alignment: .trailing).foregroundStyle(.secondary)
            Text(numbered ? line.newLine.map(String.init) ?? "" : "").frame(width: 34, alignment: .trailing).foregroundStyle(.secondary)
            Text(marker + line.text)
                .fixedSize(horizontal: !wrap, vertical: false)
                .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
        }
        .font(.caption.monospaced())
        .foregroundStyle(line.kind == "meta" ? .secondary : .primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .contentShape(.rect)
    }

    private var marker: String {
        switch line.kind {
        case "add": "+"
        case "delete": "-"
        default: " "
        }
    }

    private var background: Color {
        switch line.kind {
        case "add": .green.opacity(0.15)
        case "delete": .red.opacity(0.15)
        default: .clear
        }
    }
}
