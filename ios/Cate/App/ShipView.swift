// Shipping what an agent did, from the phone: the checkout's uncommitted
// changes file by file, then commit, push and a pull request. A task that ran
// in its own worktree is decided here too: apply it to the branch it started
// from, keep its branch for later, or discard it.

import SwiftUI

/// A checkout to review (nil: the workspace root), and the task it belongs to.
struct ShipRoute: Hashable {
    let workspaceId: String
    let checkout: String?
    let taskId: String?
}

struct ShipView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.openURL) private var openURL
    let route: ShipRoute
    @State private var changes: Changes?
    @State private var loadError: String?
    @State private var message = ""
    @State private var busy: String?
    @State private var failure: OpFailure?
    @State private var discarding = false
    @State private var epoch = 0

    var body: some View {
        let task = route.taskId.flatMap { id in core.workspace(route.workspaceId)?.tasks.first { $0.id == id } }
        List {
            if let task, task.isolated {
                taskSection(task)
            }
            if let changes {
                Section {
                    if changes.files.isEmpty {
                        Text("No uncommitted changes.").foregroundStyle(.secondary)
                    }
                    ForEach(changes.files) { file in
                        NavigationLink {
                            ShipDiffView(route: route, path: file.path)
                        } label: {
                            HStack {
                                Text(statusLetter(file.status))
                                    .font(.caption.monospaced().weight(.bold))
                                    .foregroundStyle(statusColor(file.status))
                                    .frame(width: 16)
                                Text(file.path).font(.callout).lineLimit(2).truncationMode(.head)
                                Spacer()
                                if let additions = file.additions { Text("+\(additions)").foregroundStyle(.green) }
                                if let deletions = file.deletions { Text("−\(deletions)").foregroundStyle(.red) }
                            }
                            .font(.caption.monospacedDigit())
                        }
                    }
                } header: {
                    Text(changes.branch.map { "Changes on \($0)" } ?? "Changes")
                } footer: {
                    if !changes.files.isEmpty { Text("+\(changes.additions) −\(changes.deletions) in \(changes.files.count) files") }
                }
                Section("Ship") {
                    TextField("Commit message", text: $message, axis: .vertical)
                        .lineLimit(1...4)
                    Button("Commit All", systemImage: "checkmark.circle") { run("commit") }
                        .disabled(changes.files.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy != nil)
                    Button("Push", systemImage: "arrow.up.circle") { run("push") }
                        .disabled(busy != nil || changes.branch == nil)
                    Button("Open Pull Request", systemImage: "arrow.triangle.pull") { pullRequest() }
                        .disabled(busy != nil || changes.branch == nil)
                }
            } else if let loadError {
                ContentUnavailableView("Could not read the changes", systemImage: "exclamationmark.triangle", description: Text(loadError))
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(task?.title.isEmpty == false ? task!.title : "Changes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if busy != nil { ToolbarItem(placement: .primaryAction) { ProgressView() } }
        }
        .refreshable { await load() }
        .task(id: epoch) { await load() }
        .alert(item: $failure) { Alert(title: Text($0.message)) }
        .confirmationDialog("Discard this task?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard Worktree and Branch", role: .destructive) { decide("discard") }
        } message: {
            Text("Its worktree and branch are deleted, with every change in them.")
        }
    }

    @ViewBuilder
    private func taskSection(_ task: AgentTask) -> some View {
        Section {
            LabeledContent("Agent", value: task.agentName)
            LabeledContent("Status", value: taskStatus(task))
            if let reason = task.failureReason { Text(reason).font(.footnote).foregroundStyle(.red) }
            if task.awaitsDecision {
                Button("Apply to Base Branch", systemImage: "arrow.triangle.merge") { decide("apply") }
                Button("Keep Branch for Later", systemImage: "bookmark") { decide("keep") }
                if task.ownsWorktree {
                    Button("Discard", systemImage: "trash", role: .destructive) { discarding = true }
                }
            } else if ["starting", "working", "waiting"].contains(task.status) {
                Button("Stop Task", systemImage: "stop.circle", role: .destructive) { decide("stop") }
            }
        } header: {
            Text("Task")
        } footer: {
            if task.awaitsDecision { Text("Applying merges the task's branch into the branch checked out in the workspace.") }
        }
        .disabled(busy != nil)
    }

    private func taskStatus(_ task: AgentTask) -> String {
        if let branch = task.appliedToBranch { return "Applied to \(branch)" }
        if task.kept { return "Kept" }
        switch task.status {
        case "starting": return "Starting"
        case "working": return "Working"
        case "waiting": return "Waiting for you"
        case "ready": return "Done"
        case "stopped": return "Stopped"
        default: return "Failed"
        }
    }

    private var checkoutParam: Any { route.checkout ?? NSNull() }

    private func load() async {
        do {
            changes = try await core.call("changes.list", ["workspaceId": route.workspaceId, "checkout": checkoutParam], as: Changes.self)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func run(_ what: String) {
        busy = what
        Task {
            var params: [String: Any] = ["workspaceId": route.workspaceId, "checkout": checkoutParam]
            if what == "commit" { params["message"] = message.trimmingCharacters(in: .whitespacesAndNewlines) }
            let result = await core.action("changes.\(what)", params)
            busy = nil
            if result.ok {
                if what == "commit" { message = "" }
                epoch += 1
            } else {
                failure = OpFailure(message: result.message ?? "That did not work.")
            }
        }
    }

    private func pullRequest() {
        busy = "pr"
        Task {
            let result = (try? await core.call("changes.pullRequest", ["workspaceId": route.workspaceId, "checkout": checkoutParam], as: PullRequestResult.self))
                ?? PullRequestResult(ok: false, url: nil, message: "The pull request could not be opened.")
            busy = nil
            if result.ok, let link = result.url.flatMap(URL.init(string:)) {
                openURL(link)
            } else {
                failure = OpFailure(message: result.message ?? "The pull request could not be opened.")
            }
        }
    }

    private func decide(_ action: String) {
        guard let taskId = route.taskId else { return }
        busy = action
        Task {
            let result = await core.action("agents.taskAction", ["workspaceId": route.workspaceId, "taskId": taskId, "action": action])
            busy = nil
            if result.ok { epoch += 1 } else { failure = OpFailure(message: result.message ?? "That did not work.") }
        }
    }

    private func statusLetter(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
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
}

/// One file's uncommitted diff in the checkout.
private struct ShipDiffView: View {
    @Environment(CoreHost.self) private var core
    let route: ShipRoute
    let path: String
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
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                diff = try await core.call("changes.diff", ["workspaceId": route.workspaceId, "checkout": route.checkout ?? NSNull(), "path": path], as: FileDiff.self)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
