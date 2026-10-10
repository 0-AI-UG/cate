// A diff review panel: the comparison of its checkout (working tree, staged,
// a commit, a branch) or an agent's recorded edits, as a file list with each
// file's diff, as the desktop's review does. Working-tree files stage,
// unstage and discard; staged changes commit; the branch checked out opens a
// pull request. A line takes a review note; open notes go to an agent as a
// change request, and an agent can review the changes in a terminal. Notes
// copy as Markdown, the comparison as a `git apply` command. How diffs show
// (wrapped, whole files, image previews) is this device's own.

import SwiftUI

struct ReviewSnapshot: Decodable, Equatable {
    struct Spec: Decodable, Equatable {
        let kind: String
        let commit: String?
        let base: String?
        let target: String?
        let ignoreWhitespace: Bool?

        /// The spec as an op sends it, with `change` applied.
        func json(_ change: (inout [String: Any]) -> Void = { _ in }) -> [String: Any] {
            var spec: [String: Any] = ["kind": kind]
            if let commit { spec["commit"] = commit }
            if let base { spec["base"] = base }
            if let target { spec["target"] = target }
            if ignoreWhitespace == true { spec["ignoreWhitespace"] = true }
            change(&spec)
            return spec
        }
    }
    struct Review: Decodable, Equatable {
        let repoPath: String
        let spec: Spec
        let agentChanges: AgentFilter?
        let showHistory: Bool?
        let notes: [Note]?
        let sourceAgent: SourceAgent?
        let agentReview: AgentRun?
    }
    /// Present for recorded agent edits: whose edits show.
    struct AgentFilter: Decodable, Equatable {
        let agentId: String?
        let panelId: String?
        let sessionId: String?
        let turnId: String?
    }
    struct SourceAgent: Decodable, Equatable {
        let panelId: String
    }
    /// An agent reviewing the changes in a terminal.
    struct AgentRun: Decodable, Equatable {
        let terminalPanelId: String
        /// `working`, `complete` or `failed`.
        let status: String
    }
    struct Note: Decodable, Equatable, Identifiable {
        let id: String
        let agentChangeId: String?
        let path: String
        /// `old`, `new` or `file`.
        let side: String
        let line: Int?
        let body: String
        let outdated: Bool?
        let status: String?
        let severity: String?
        let author: String?

        var resolved: Bool { status == "resolved" }
        /// What a change request sends: open and still anchored.
        var open: Bool { !resolved && outdated != true }
    }
    struct ChangedFile: Decodable, Equatable, Identifiable {
        let path: String
        let oldPath: String?
        let status: String
        let additions: Int?
        let deletions: Int?
        let binary: Bool
        let staged: Bool
        let working: Bool
        let untracked: Bool?
        var id: String { path }
    }
    struct Comparison: Decodable, Equatable {
        let files: [ChangedFile]
        let additions: Int
        let deletions: Int
        let currentBranch: String?
    }
    struct RecordedFile: Decodable, Equatable, Identifiable {
        let recordId: String
        let path: String
        let oldPath: String?
        let additions: Int
        let deletions: Int
        var id: String { recordId + "\u{0}" + path }
    }
    struct Recorded: Decodable, Equatable {
        let loading: Bool
        let error: String?
        let files: [RecordedFile]
    }
    struct Branch: Decodable, Equatable, Identifiable {
        let name: String
        let current: Bool
        let isRemote: Bool
        var id: String { name }
    }
    struct Commit: Decodable, Equatable, Identifiable {
        let hash: String
        let message: String
        var id: String { hash }
    }
    let review: Review
    let comparison: Comparison?
    let diffEpoch: Int
    let recorded: Recorded
    let loading: Bool
    let busy: Bool
    let agentBusy: Bool
    let error: String?
    let notRepository: Bool
    let branches: [Branch]
    let commits: [Commit]

    var openNotes: [Note] { (review.notes ?? []).filter { $0.open && $0.side != "file" } }
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
    let binary: Bool?
    let tooLarge: Bool?
}

/// An agent a review can hand its work to (`MobileReviewAgent`).
struct ReviewAgent: Decodable, Identifiable, Equatable {
    let agentId: String
    let name: String
    let ready: Bool
    var id: String { agentId }
}

private let comparisons: [(kind: String, label: String)] = [
    ("uncommitted", "Uncommitted"), ("unstaged", "Unstaged"), ("staged", "Staged"),
    ("commit", "Commit"), ("branch", "Branch"), ("agent", "Agent edits"),
]

/// How this device shows diffs.
private enum ReviewDisplay {
    static let wrap = "review.wrap"
    static let fullFile = "review.fullFile"
    static let images = "review.images"
}

struct ReviewPanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.panelOnScreen) private var onScreen
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<ReviewSnapshot>()
    @State private var agents: [ReviewAgent] = []
    @State private var committing = false
    @State private var message = ""
    @State private var discarding: ReviewSnapshot.ChangedFile?
    @State private var opened: PanelRoute?
    @State private var failure: OpFailure?
    @AppStorage(ReviewDisplay.wrap) private var wrap = false
    @AppStorage(ReviewDisplay.fullFile) private var fullFile = false
    @AppStorage(ReviewDisplay.images) private var images = true

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
            if onScreen, let snapshot = session.snapshot, !snapshot.notRepository {
                ToolbarItem(placement: .primaryAction) { agentMenu(snapshot) }
                ToolbarItem(placement: .primaryAction) { reviewMenu(snapshot) }
            }
        }
        .alert("Commit", isPresented: $committing) {
            TextField("Message", text: $message)
            Button("Commit") {
                let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                message = ""
                run(["kind": "commit", "message": text])
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Commits the staged changes.")
        }
        .alert("Discard changes?", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), presenting: discarding) { file in
            Button("Discard changes to \((file.path as NSString).lastPathComponent)", role: .destructive) {
                run(["kind": "discard", "path": file.path, "untracked": file.untracked ?? false])
            }
            Button("Cancel", role: .cancel) {}
        } message: { file in
            Text(file.untracked == true ? "The file moves to the trash." : "Its working changes are lost. Staged changes stay.")
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

    /// Hands the review to an agent: open notes as a change request, or a
    /// review of the changes in a terminal.
    private func agentMenu(_ snapshot: ReviewSnapshot) -> some View {
        let open = snapshot.openNotes.count
        let reviewing = snapshot.review.agentReview?.status == "working"
        return Menu {
            Section(open == 0 ? "Add a note to request changes" : "Send \(open) open note\(open == 1 ? "" : "s")") {
                if snapshot.review.sourceAgent != nil {
                    Button("Request Changes", systemImage: "paperplane") { requestChanges(nil) }
                        .disabled(open == 0)
                }
                Menu("Request Changes From") {
                    ForEach(agents) { agent in
                        Button(agent.name) { requestChanges(agent.agentId) }.disabled(!agent.ready)
                    }
                }
                .disabled(open == 0 || agents.isEmpty)
            }
            Menu("Review in Terminal", systemImage: "terminal") {
                ForEach(agents) { agent in
                    Button(agent.name) { run(["kind": "reviewWithAgent", "agentId": agent.agentId]) }.disabled(!agent.ready)
                }
            }
            .disabled(reviewing || agents.isEmpty)
        } label: {
            if snapshot.agentBusy || reviewing {
                ProgressView()
            } else {
                Label("Agents", systemImage: "sparkles")
            }
        }
        .disabled(snapshot.agentBusy)
    }

    private func reviewMenu(_ snapshot: ReviewSnapshot) -> some View {
        let spec = snapshot.review.spec
        let agent = snapshot.review.agentChanges != nil
        let hasNotes = !(snapshot.review.notes ?? []).isEmpty
        return Menu {
            Picker("Compare", selection: Binding(get: { kind(snapshot) }, set: { run(["kind": "selectComparison", "comparison": $0]) })) {
                ForEach(comparisons, id: \.kind) { Text($0.label).tag($0.kind) }
            }
            .pickerStyle(.menu)
            if !agent, spec.kind == "commit", !snapshot.commits.isEmpty {
                Picker("Commit", selection: Binding(get: { spec.commit ?? "" }, set: { hash in setSpec(spec.json { $0["commit"] = hash }) })) {
                    ForEach(snapshot.commits) { Text($0.message).tag($0.hash) }
                }
                .pickerStyle(.menu)
            }
            if !agent, spec.kind == "branch" {
                branchPicker("Base", value: spec.base, snapshot) { name in setSpec(spec.json { $0["base"] = name }) }
                branchPicker("Target", value: spec.target, snapshot) { name in setSpec(spec.json { $0["target"] = name }) }
            }
            Button("Refresh", systemImage: "arrow.clockwise") { run(["kind": "refresh"]) }
            if !agent, spec.kind == "staged" || spec.kind == "uncommitted" {
                Button("Commit…", systemImage: "checkmark.circle") { committing = true }
            }
            if !agent, spec.kind == "branch", spec.target == snapshot.comparison?.currentBranch {
                Button("Create Pull Request", systemImage: "arrow.triangle.pull") { createPullRequest() }
            }
            Section("Show") {
                Toggle("Wrap Lines", systemImage: "text.word.spacing", isOn: $wrap)
                Toggle("Full Files", systemImage: "doc.plaintext", isOn: $fullFile)
                Toggle("Image Previews", systemImage: "photo", isOn: $images)
                if agent {
                    Toggle("Recorded History", systemImage: "clock.arrow.circlepath", isOn: Binding(
                        get: { snapshot.review.showHistory == true },
                        set: { run(["kind": "update", "patch": ["showHistory": $0]]) }
                    ))
                } else {
                    Toggle("Ignore Whitespace", systemImage: "space", isOn: Binding(
                        get: { spec.ignoreWhitespace == true },
                        set: { on in setSpec(spec.json { $0["ignoreWhitespace"] = on }) }
                    ))
                }
            }
            Section {
                if !agent {
                    Button("Copy git apply Command", systemImage: "terminal") { copyApplyCommand() }
                        .disabled(snapshot.comparison == nil || snapshot.busy)
                }
                Button("Copy Review Notes", systemImage: "doc.on.clipboard") { copyNotes() }
                    .disabled(!hasNotes)
            }
        } label: {
            Label("Review Options", systemImage: "ellipsis.circle")
        }
    }

    private func branchPicker(_ title: String, value: String?, _ snapshot: ReviewSnapshot, set: @escaping (String) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value ?? "" }, set: set)) {
            ForEach(snapshot.branches) { Text($0.name).tag($0.name) }
        }
        .pickerStyle(.menu)
    }

    private func kind(_ snapshot: ReviewSnapshot) -> String {
        snapshot.review.agentChanges != nil ? "agent" : snapshot.review.spec.kind
    }

    // MARK: Lists

    @ViewBuilder
    private func content(_ snapshot: ReviewSnapshot) -> some View {
        if snapshot.notRepository {
            ContentUnavailableView("Not a Git repository", systemImage: "arrow.left.arrow.right", description: Text("This checkout has nothing to compare."))
        } else if snapshot.review.agentChanges != nil {
            agentFiles(snapshot)
        } else {
            gitFiles(snapshot)
        }
    }

    private func gitFiles(_ snapshot: ReviewSnapshot) -> some View {
        let spec = snapshot.review.spec.kind
        let working = spec == "uncommitted" || spec == "unstaged"
        return List {
            Section {
                if let error = snapshot.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                }
                if let comparison = snapshot.comparison {
                    LabeledContent(title(snapshot)) {
                        Totals(additions: comparison.additions, deletions: comparison.deletions)
                    }
                } else if snapshot.loading {
                    ProgressView()
                }
                agentRun(snapshot)
            }
            notes(snapshot)
            if let files = snapshot.comparison?.files {
                Section(files.isEmpty ? "No changes" : "\(files.count) file\(files.count == 1 ? "" : "s")") {
                    ForEach(files) { file in
                        NavigationLink {
                            diffView(snapshot, path: file.path, oldPath: file.oldPath, source: .git)
                        } label: {
                            FileRow(status: file.status, path: file.oldPath.map { "\($0) → \(file.path)" } ?? file.path, additions: file.additions, deletions: file.deletions, notes: noteCount(snapshot, path: file.path, recordId: nil))
                        }
                        .contextMenu {
                            Button("Open File", systemImage: "doc.text") { openFile(file.path) }
                                .disabled(file.status == "deleted")
                            Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = file.path }
                            if working && file.working {
                                Button("Stage", systemImage: "plus") { run(["kind": "stage", "path": file.path]) }
                            }
                            if spec == "staged" || (spec == "uncommitted" && file.staged) {
                                Button("Unstage", systemImage: "minus") { run(["kind": "unstage", "path": file.path]) }
                            }
                            if working && file.working {
                                Button("Discard Changes", systemImage: "trash", role: .destructive) { discarding = file }
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if working && file.working {
                                Button("Discard", role: .destructive) { discarding = file }
                                Button("Stage") { run(["kind": "stage", "path": file.path]) }.tint(.green)
                            }
                            if spec == "staged" || (spec == "uncommitted" && file.staged) {
                                Button("Unstage") { run(["kind": "unstage", "path": file.path]) }.tint(.orange)
                            }
                        }
                    }
                }
            }
        }
        .disabled(snapshot.busy)
        .refreshable { await session.send(["kind": "refresh"]) }
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
            agentRun(snapshot)
            notes(snapshot)
            Section {
                ForEach(snapshot.recorded.files) { file in
                    NavigationLink {
                        diffView(snapshot, path: file.path, oldPath: file.oldPath, source: .recorded(file.recordId))
                    } label: {
                        FileRow(status: nil, path: file.path, additions: file.additions, deletions: file.deletions, notes: noteCount(snapshot, path: file.path, recordId: file.recordId))
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
                    Text(snapshot.review.showHistory == true
                        ? "No recorded edits match these filters. This does not mean the agent made no changes."
                        : "No active agent edits match these filters. Recorded History in the options shows older ones.")
                }
            }
        }
        .refreshable { await session.send(["kind": "refresh"]) }
    }

    /// The review's notes, open ones first; a swipe resolves or reopens one.
    @ViewBuilder
    private func notes(_ snapshot: ReviewSnapshot) -> some View {
        let all = (snapshot.review.notes ?? []).sorted { $0.open && !$1.open }
        if !all.isEmpty {
            Section("Notes") {
                ForEach(all) { note in
                    NoteRow(note: note, showsPlace: true)
                        .swipeActions(edge: .trailing) {
                            Button(note.resolved ? "Reopen" : "Resolve") { run(["kind": "toggleNote", "noteId": note.id]) }
                                .tint(note.resolved ? .orange : .green)
                        }
                }
            }
        }
    }

    @ViewBuilder
    private func agentRun(_ snapshot: ReviewSnapshot) -> some View {
        if let run = snapshot.review.agentReview {
            switch run.status {
            case "working": Label("An agent is reviewing these changes", systemImage: "sparkles")
            case "complete": Label("The agent finished its review", systemImage: "checkmark.circle").foregroundStyle(.green)
            default: Label("The agent's review failed", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            }
        }
    }

    private func diffView(_ snapshot: ReviewSnapshot, path: String, oldPath: String?, source: DiffSource) -> some View {
        DiffView(session: session, path: path, oldPath: oldPath, source: source, epoch: snapshot.diffEpoch, openFile: { openFile(path) })
    }

    private func noteCount(_ snapshot: ReviewSnapshot, path: String, recordId: String?) -> Int {
        (snapshot.review.notes ?? []).filter { $0.path == path && $0.side != "file" && (recordId == nil || $0.agentChangeId == recordId) && !$0.resolved }.count
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

    private func title(_ snapshot: ReviewSnapshot) -> String {
        let spec = snapshot.review.spec
        switch spec.kind {
        case "commit": return "Commit \(String((spec.commit ?? "").prefix(7)))"
        case "branch": return "\(spec.base ?? "") → \(spec.target ?? "")"
        default: return comparisons.first { $0.kind == spec.kind }?.label ?? spec.kind
        }
    }

    // MARK: Actions

    private func setSpec(_ spec: [String: Any]) {
        run(["kind": "setSpec", "spec": spec])
    }

    private func requestChanges(_ agentId: String?) {
        Task {
            var op: [String: Any] = ["kind": "requestChanges"]
            if let agentId { op["agentId"] = agentId }
            let reply = await session.send(op, as: String.self)
            if !reply.ok {
                failure = OpFailure(message: reply.message ?? "The change request could not be sent.")
            } else if reply.result == "pick-agent" {
                failure = OpFailure(message: "The agent that made these changes is gone. Pick one under Request Changes From.")
            }
        }
    }

    private func createPullRequest() {
        Task {
            struct Created: Decodable { let url: String }
            let reply = await session.send(["kind": "createPullRequest"], as: Created.self)
            if let url = reply.result.flatMap({ URL(string: $0.url) }) {
                await UIApplication.shared.open(url)
            } else {
                failure = OpFailure(message: reply.message ?? "The pull request could not be created.")
            }
        }
    }

    private func copyApplyCommand() {
        Task {
            let reply = await session.send(["kind": "applyCommand"], as: String.self)
            if let command = reply.result {
                UIPasteboard.general.string = command
            } else {
                failure = OpFailure(message: reply.message ?? "Could not copy the patch.")
            }
        }
    }

    private func copyNotes() {
        Task {
            if let markdown = try? await session.call("review.notes", [:], as: String.self) {
                UIPasteboard.general.string = markdown
            }
        }
    }

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
    let notes: Int

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
            if notes > 0 {
                Label("\(notes)", systemImage: "text.bubble")
                    .font(.caption2)
                    .foregroundStyle(.blue)
                    .labelStyle(.titleAndIcon)
            }
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

/// A review note: its severity, words and where it sits.
private struct NoteRow: View {
    let note: ReviewSnapshot.Note
    let showsPlace: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: Self.symbol(note.severity))
                .foregroundStyle(Self.color(note.severity))
            VStack(alignment: .leading, spacing: 2) {
                Text(note.body)
                    .strikethrough(note.resolved)
                    .foregroundStyle(note.open ? .primary : .secondary)
                if showsPlace || note.outdated == true || note.resolved {
                    Text(place)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
        }
    }

    private var place: String {
        var words = showsPlace ? (note.line.map { "\(note.path):\($0)" } ?? note.path) : ""
        if note.author == "agent" { words += words.isEmpty ? "by an agent" : " · by an agent" }
        if note.outdated == true { words += words.isEmpty ? "outdated" : " · outdated" }
        else if note.resolved { words += words.isEmpty ? "resolved" : " · resolved" }
        return words
    }

    static func symbol(_ severity: String?) -> String {
        switch severity {
        case "error": "xmark.octagon.fill"
        case "warning": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }

    static func color(_ severity: String?) -> Color {
        switch severity {
        case "error": .red
        case "warning": .orange
        default: .blue
        }
    }
}

private enum DiffSource: Equatable {
    case git
    /// A recorded agent edit.
    case recorded(String)
}

/// A line a note is being written for.
private struct NoteDraft: Identifiable {
    let side: String
    let line: Int
    let context: String
    var id: String { "\(side):\(line)" }
}

/// One file's diff, fetched with an op and fetched again when the review's
/// diffs may be stale or the display asks for more of it. A line takes a
/// note from its menu; the file's notes sit under their lines.
private struct DiffView: View {
    let session: PanelSession<ReviewSnapshot>
    let path: String
    let oldPath: String?
    let source: DiffSource
    let epoch: Int
    let openFile: () -> Void
    @AppStorage(ReviewDisplay.wrap) private var wrap = false
    @AppStorage(ReviewDisplay.fullFile) private var fullFile = false
    @AppStorage(ReviewDisplay.images) private var showImages = true
    @State private var diff: FileDiff?
    @State private var error: String?
    @State private var allowLarge = false
    @State private var contextLines = 3
    @State private var images: ReviewImages?
    @State private var draft: NoteDraft?
    @State private var failure: OpFailure?

    private struct Load: Equatable {
        let epoch: Int
        let fullFile: Bool
        let allowLarge: Bool
        let contextLines: Int
    }

    var body: some View {
        Group {
            if let diff {
                DiffContent(
                    diff: diff,
                    wrap: wrap,
                    notes: notes,
                    images: showImages ? images : nil,
                    addNote: { side, line, context in draft = NoteDraft(side: side, line: line, context: context) },
                    toggleNote: { noteId in Task { _ = await session.send(["kind": "toggleNote", "noteId": noteId]) } },
                    showLarge: { allowLarge = true }
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
                    Toggle("Full File", systemImage: "doc.plaintext", isOn: $fullFile)
                    if source == .git && !fullFile {
                        Button("Show More Context", systemImage: "arrow.up.and.down.text.horizontal") { contextLines += 20 }
                    }
                    Divider()
                    Button("Open File", systemImage: "doc.text", action: openFile)
                    Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                } label: {
                    Label("Diff Options", systemImage: "ellipsis.circle")
                }
            }
        }
        .sheet(item: $draft) { draft in
            NoteEditor(path: path, draft: draft) { body, severity in add(draft, body: body, severity: severity) }
        }
        .alert(item: $failure) { Alert(title: Text("Could not complete that"), message: Text($0.message)) }
        .task(id: Load(epoch: epoch, fullFile: fullFile, allowLarge: allowLarge, contextLines: contextLines)) { await load() }
        .task(id: showImages) {
            guard showImages else { return }
            var params: [String: Any] = ["path": path]
            if let oldPath { params["oldPath"] = oldPath }
            images = try? await session.call("review.images", params, as: ReviewImages?.self)
        }
    }

    /// This file's notes (of this recorded edit for agent edits).
    private var notes: [ReviewSnapshot.Note] {
        (session.snapshot?.review.notes ?? []).filter { note in
            guard note.path == path, note.side != "file" else { return false }
            if case .recorded(let recordId) = source { return note.agentChangeId == recordId }
            return true
        }
    }

    private func load() async {
        let op: [String: Any]
        switch source {
        case .git:
            var options: [String: Any] = ["contextLines": contextLines]
            if fullFile { options["fullFile"] = true }
            if allowLarge { options["allowLarge"] = true }
            op = ["kind": "diff", "path": path, "options": options]
        case .recorded(let recordId):
            op = ["kind": "recordedDiff", "recordId": recordId, "path": path]
        }
        let reply = await session.send(op, as: FileDiff.self)
        if let result = reply.result {
            diff = result
            error = nil
        } else {
            error = reply.message ?? "Something went wrong."
        }
    }

    private func add(_ draft: NoteDraft, body: String, severity: String) {
        var note: [String: Any] = ["path": path, "side": draft.side, "line": draft.line, "context": draft.context, "body": body, "severity": severity]
        if case .recorded(let recordId) = source { note["agentChangeId"] = recordId }
        Task {
            let reply = await session.send(["kind": "addNote", "note": note])
            if !reply.ok { failure = OpFailure(message: reply.message ?? "The note could not be added.") }
        }
    }
}

/// A changed image's two versions (`review.images`), base64.
private struct ReviewImages: Decodable {
    let mime: String
    let old: String?
    let new: String?
}

/// Writes a note for one line.
private struct NoteEditor: View {
    let path: String
    let draft: NoteDraft
    let add: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var severity = "info"
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(draft.context.trimmingCharacters(in: .whitespaces))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                } header: {
                    Text("\((path as NSString).lastPathComponent), \(draft.side == "old" ? "old" : "new") line \(draft.line)")
                }
                Section {
                    TextField("What should change?", text: $text, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($focused)
                    Picker("Severity", selection: $severity) {
                        Label("Info", systemImage: NoteRow.symbol("info")).tag("info")
                        Label("Warning", systemImage: NoteRow.symbol("warning")).tag("warning")
                        Label("Error", systemImage: NoteRow.symbol("error")).tag("error")
                    }
                }
            }
            .navigationTitle("Add Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", role: .confirm) {
                        add(text.trimmingCharacters(in: .whitespacesAndNewlines), severity)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A file's diff: its hunks, scrolling both ways for long lines unless
/// they wrap, with each line's notes under it.
private struct DiffContent: View {
    let diff: FileDiff
    let wrap: Bool
    let notes: [ReviewSnapshot.Note]
    let images: ReviewImages?
    let addNote: (String, Int, String) -> Void
    let toggleNote: (String) -> Void
    let showLarge: () -> Void

    var body: some View {
        if let images, images.old != nil || images.new != nil {
            ScrollView { ImageComparison(images: images).padding() }
        } else if diff.binary == true {
            ContentUnavailableView("Binary file", systemImage: "doc")
        } else if diff.tooLarge == true {
            ContentUnavailableView {
                Label("This diff is large", systemImage: "doc.text")
            } description: {
                Text("Showing it may take a moment.")
            } actions: {
                Button("Show Anyway", action: showLarge)
            }
        } else if diff.hunks.isEmpty {
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
                                DiffLine(line: line, wrap: wrap)
                                    .contextMenu { lineMenu(line) }
                                ForEach(notes(of: line)) { note in
                                    NoteRow(note: note, showsPlace: false)
                                        .font(.callout)
                                        .padding(10)
                                        .frame(maxWidth: wrap ? .infinity : min(geometry.size.width, 560), alignment: .leading)
                                        .background(.regularMaterial, in: .rect(cornerRadius: 10))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .contextMenu {
                                            Button(note.resolved ? "Reopen" : "Resolve", systemImage: note.resolved ? "arrow.uturn.backward" : "checkmark") { toggleNote(note.id) }
                                            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = note.body }
                                        }
                                }
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
        if let new = line.newLine, line.kind != "delete" {
            Button("Add Note…", systemImage: "text.bubble") { addNote("new", new, line.text) }
        } else if let old = line.oldLine {
            Button("Add Note…", systemImage: "text.bubble") { addNote("old", old, line.text) }
        }
        Button("Copy Line", systemImage: "doc.on.doc") { UIPasteboard.general.string = line.text }
    }

    private func notes(of line: FileDiff.Line) -> [ReviewSnapshot.Note] {
        notes.filter { note in
            switch note.side {
            case "old": line.kind == "delete" && note.line == line.oldLine
            default: line.kind != "delete" && note.line == line.newLine
            }
        }
    }
}

/// A changed image before and after.
private struct ImageComparison: View {
    let images: ReviewImages

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            side("Before", images.old)
            side("After", images.new)
        }
    }

    @ViewBuilder
    private func side(_ title: String, _ base64: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let base64, let data = Data(base64Encoded: base64), let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 8))
            } else {
                Text(base64 == nil ? "None" : "Cannot be shown here")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 8))
            }
        }
    }
}

private struct DiffLine: View {
    let line: FileDiff.Line
    let wrap: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(line.oldLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.secondary)
            Text(line.newLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.secondary)
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
