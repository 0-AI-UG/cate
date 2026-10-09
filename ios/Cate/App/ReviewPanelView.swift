// A diff review panel: the comparison of its checkout (working tree, staged,
// the last commit, the branch) or an agent's recorded edits, as a file list
// with each file's diff. Working-tree files stage, unstage and discard;
// staged changes commit.

import SwiftUI

struct ReviewSnapshot: Decodable, Equatable {
    struct Spec: Decodable, Equatable {
        let kind: String
        let commit: String?
        let base: String?
        let target: String?
    }
    struct Review: Decodable, Equatable {
        let repoPath: String
        let spec: Spec
        let agentChanges: AgentFilter?
    }
    /// Present for recorded agent edits: whose edits show.
    struct AgentFilter: Decodable, Equatable {
        let agentId: String?
        let panelId: String?
        let sessionId: String?
        let turnId: String?
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
        let additions: Int
        let deletions: Int
        var id: String { recordId + "\u{0}" + path }
    }
    struct Recorded: Decodable, Equatable {
        let loading: Bool
        let error: String?
        let files: [RecordedFile]
    }
    let review: Review
    let comparison: Comparison?
    let diffEpoch: Int
    let recorded: Recorded
    let loading: Bool
    let busy: Bool
    let error: String?
    let notRepository: Bool
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

private let comparisons: [(kind: String, label: String)] = [
    ("uncommitted", "Uncommitted"), ("unstaged", "Unstaged"), ("staged", "Staged"),
    ("commit", "Last commit"), ("branch", "Branch"), ("agent", "Agent edits"),
]

struct ReviewPanelView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<ReviewSnapshot>()
    @State private var committing = false
    @State private var message = ""
    @State private var discarding: ReviewSnapshot.ChangedFile?
    @State private var failure: OpFailure?

    var body: some View {
        Group {
            if let snapshot = session.snapshot {
                content(snapshot)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let snapshot = session.snapshot, !snapshot.notRepository {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker("Compare", selection: Binding(get: { kind(snapshot) }, set: { run(["kind": "selectComparison", "comparison": $0]) })) {
                            ForEach(comparisons, id: \.kind) { Text($0.label).tag($0.kind) }
                        }
                        Button("Refresh", systemImage: "arrow.clockwise") { run(["kind": "refresh"]) }
                        if snapshot.review.spec.kind == "staged" || snapshot.review.spec.kind == "uncommitted" {
                            Button("Commit…", systemImage: "checkmark.circle") { committing = true }
                        }
                    } label: {
                        Label("Comparison", systemImage: "line.3.horizontal.decrease.circle")
                    }
                }
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
            Text(file.untracked == true ? "The file moves to the trash." : "Its working changes are lost.")
        }
        .alert(item: $failure) { Alert(title: Text("Could not complete that"), message: Text($0.message)) }
        .task { await session.run(core, workspaceId: workspaceId, panelId: panel.id) }
    }

    private func kind(_ snapshot: ReviewSnapshot) -> String {
        snapshot.review.agentChanges != nil ? "agent" : snapshot.review.spec.kind
    }

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
            }
            if let files = snapshot.comparison?.files {
                Section(files.isEmpty ? "No changes" : "\(files.count) file\(files.count == 1 ? "" : "s")") {
                    ForEach(files) { file in
                        NavigationLink {
                            DiffView(session: session, title: file.path, epoch: snapshot.diffEpoch, op: ["kind": "diff", "path": file.path])
                        } label: {
                            HStack {
                                Text(statusLabel(file.status)).font(.caption.monospaced()).foregroundStyle(statusColor(file.status)).frame(width: 14)
                                Text(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
                                    .font(.callout.monospaced())
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer()
                                Totals(additions: file.additions, deletions: file.deletions)
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
            if let filter = snapshot.review.agentChanges, filter.panelId != nil || filter.sessionId != nil || filter.turnId != nil {
                Section {
                    LabeledContent {
                        Button("Show All") {
                            run(["kind": "updateFilter", "patch": ["panelId": NSNull(), "sessionId": NSNull(), "turnId": NSNull()]])
                        }
                        .buttonStyle(.glass)
                    } label: {
                        Label(filterTitle(filter), systemImage: "line.3.horizontal.decrease.circle.fill")
                    }
                } footer: {
                    Text("Only the edits this agent made show here.")
                }
            }
            if let error = snapshot.recorded.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            }
            if snapshot.recorded.loading && snapshot.recorded.files.isEmpty {
                ProgressView()
            }
            Section(snapshot.recorded.files.isEmpty ? "No recorded edits" : "Agent edits") {
                ForEach(snapshot.recorded.files) { file in
                    NavigationLink {
                        DiffView(session: session, title: file.path, epoch: snapshot.diffEpoch, op: ["kind": "recordedDiff", "recordId": file.recordId, "path": file.path])
                    } label: {
                        HStack {
                            Text(file.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                            Spacer()
                            Totals(additions: file.additions, deletions: file.deletions)
                        }
                    }
                }
            }
        }
        .refreshable { await session.send(["kind": "refresh"]) }
    }

    /// The agent panel (or turn) the edits are filtered to.
    private func filterTitle(_ filter: ReviewSnapshot.AgentFilter) -> String {
        let source = filter.panelId.flatMap { id in core.workspace(workspaceId)?.panels?.first { $0.id == id }?.title }
        let name = source ?? "One agent"
        return filter.turnId != nil ? "\(name), one turn" : name
    }

    private func title(_ snapshot: ReviewSnapshot) -> String {
        let spec = snapshot.review.spec
        switch spec.kind {
        case "commit": return "Commit \(String((spec.commit ?? "").prefix(7)))"
        case "branch": return "\(spec.base ?? "") → \(spec.target ?? "")"
        default: return comparisons.first { $0.kind == spec.kind }?.label ?? spec.kind
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "copied": "C"
        case "unmerged": "U"
        default: "M"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "added": .green
        case "deleted": .red
        case "unmerged": .orange
        default: .blue
        }
    }

    private func run(_ op: [String: Any]) {
        Task {
            let reply = await session.send(op)
            if !reply.ok { failure = OpFailure(message: reply.message ?? "Something went wrong.") }
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

/// One file's diff, fetched with an op and fetched again when the review's
/// diffs may be stale.
private struct DiffView: View {
    let session: PanelSession<ReviewSnapshot>
    let title: String
    let epoch: Int
    let op: [String: Any]
    @State private var diff: FileDiff?
    @State private var error: String?

    var body: some View {
        Group {
            if let diff {
                DiffContent(diff: diff)
            } else if let error {
                ContentUnavailableView("Could not load the diff", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle((title as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: epoch) {
            let reply = await session.send(op, as: FileDiff.self)
            if let result = reply.result {
                diff = result
                error = nil
            } else {
                error = reply.message ?? "Something went wrong."
            }
        }
    }
}

/// A file's diff: its hunks, scrolling both ways for long lines.
struct DiffContent: View {
    let diff: FileDiff

    var body: some View {
        if diff.binary == true {
            ContentUnavailableView("Binary file", systemImage: "doc")
        } else if diff.tooLarge == true {
            ContentUnavailableView("This diff is too large to show", systemImage: "doc.text")
        } else if diff.hunks.isEmpty {
            ContentUnavailableView("No changes", systemImage: "equal")
        } else {
            GeometryReader { geometry in
                ScrollView([.vertical, .horizontal]) {
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
                                DiffLine(line: line)
                            }
                        }
                    }
                    // Short diffs start at the top left, long lines scroll.
                    .frame(minWidth: geometry.size.width, minHeight: geometry.size.height, alignment: .topLeading)
                }
            }
        }
    }
}

private struct DiffLine: View {
    let line: FileDiff.Line

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(line.oldLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
            Text(marker + line.text)
                .fixedSize(horizontal: true, vertical: false)
        }
        .font(.caption.monospaced())
        .foregroundStyle(line.kind == "meta" ? .secondary : .primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
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
