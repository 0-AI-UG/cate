// Starting a task from the phone: a workspace, an agent whose Cate hooks are
// ready there, where it works (a new worktree keeps it off the branch you are
// on) and what to do. The agent starts in a new terminal on the workspace, as
// a supervisor agent's worker would (`agents.startTask`).

import SwiftUI

struct TaskComposerView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.dismiss) private var dismiss
    let started: (AgentRoute) -> Void
    @State private var workspaceId: String?
    @State private var agents: [TaskAgent]?
    @State private var agentId: String?
    @State private var worktree = true
    @State private var prompt = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let connected = core.state.workspaces.filter { $0.connection.kind == .connected }
        NavigationStack {
            Form {
                Section {
                    Picker("Workspace", selection: $workspaceId) {
                        ForEach(connected) { Text($0.name).tag(Optional($0.id)) }
                    }
                    if let agents {
                        if agents.isEmpty {
                            Text("No agent has Cate hooks enabled in this workspace. Turn them on in Cate's settings on your computer.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            Picker("Agent", selection: $agentId) {
                                ForEach(agents) { Text($0.displayName).tag(Optional($0.agentId)) }
                            }
                        }
                    } else if workspaceId != nil {
                        LabeledContent("Agent") { ProgressView() }
                    }
                    Toggle("In a new worktree", isOn: $worktree)
                } footer: {
                    Text(worktree
                         ? "The agent works on its own branch. Review and apply its changes when it is done."
                         : "The agent works in the workspace folder, on the branch checked out there.")
                }
                Section("Task") {
                    TextField("What should the agent do?", text: $prompt, axis: .vertical)
                        .lineLimit(5...14)
                        .disabled(busy)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Start") { start() }
                            .disabled(workspaceId == nil || agents?.isEmpty != false
                                      || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .task(id: workspaceId) { await loadAgents() }
            .onAppear { if workspaceId == nil { workspaceId = connected.first?.id } }
        }
        .interactiveDismissDisabled(busy)
    }

    private func loadAgents() async {
        guard let workspaceId else { return }
        agents = nil
        let list = (try? await core.call("agents.taskAgents", ["workspaceId": workspaceId], as: [TaskAgent].self)) ?? []
        agents = list
        if !list.contains(where: { $0.agentId == agentId }) { agentId = list.first?.agentId }
    }

    private func start() {
        guard let workspaceId else { return }
        busy = true
        error = nil
        Task {
            let params: [String: Any] = [
                "workspaceId": workspaceId,
                "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                "agentId": agentId ?? NSNull(),
                "worktree": worktree,
            ]
            let result = (try? await core.call("agents.startTask", params, as: StartedTask.self))
                ?? StartedTask(ok: false, panelId: nil, message: "The task could not start.")
            busy = false
            if result.ok, let panelId = result.panelId {
                started(AgentRoute(workspaceId: workspaceId, panelId: panelId))
            } else {
                error = result.message ?? "The task could not start."
            }
        }
    }
}
