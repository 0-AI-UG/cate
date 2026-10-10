// The box at the bottom of an agent chat, like a chat app's: the text, and
// for a new agent its options in the box itself. `+` holds where it works
// (a new worktree keeps it off the branch you are on); the picker on the
// right picks the agent CLI that runs it in a terminal. The last choice is
// remembered on this device. While the agent works, the send button is its
// stop button.

import SwiftUI

/// The agent CLIs a workspace can run a new agent with, and the pick.
@MainActor
@Observable
final class AgentChoiceOptions {
    private(set) var choices: [AgentChoice]?
    /// The picked agent id.
    var selected: String?

    var loaded: Bool { choices != nil }

    /// The picked agent when it can start now.
    var ready: AgentChoice? {
        choices?.first { $0.agentId == selected && $0.ready }
    }

    var label: String {
        if selected == nil { return loaded ? "No agents" : "Agent" }
        return choices?.first { $0.agentId == selected }?.displayName ?? "Agent"
    }

    func load(_ core: CoreHost, workspaceId: String, remembered: String) async {
        choices = (try? await core.call("agents.choices", ["workspaceId": workspaceId], as: [AgentChoice].self)) ?? []
        guard ready == nil else { return }
        let ready = choices?.filter(\.ready) ?? []
        selected = ready.first { $0.agentId == remembered }?.agentId ?? ready.first?.agentId
    }
}

struct AgentComposer: View {
    @Binding var text: String
    let placeholder: String
    /// The agent can take a prompt now.
    let canSend: Bool
    let sending: Bool
    /// A new agent's options; nil in a running agent's chat.
    var options: AgentChoiceOptions?
    var worktree: Binding<Bool>?
    let send: () -> Void
    /// Stops the agent's work; nil when nothing runs that can be stopped.
    var stop: (() -> Void)?
    /// The box has the keyboard; the chat around it can take it away.
    var typing: FocusState<Bool>.Binding

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 12) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...8)
                .focused(typing)
                .padding(.horizontal, 4)
            HStack(spacing: 10) {
                if let worktree {
                    plusMenu(worktree)
                    if worktree.wrappedValue {
                        Button { worktree.wrappedValue = false } label: {
                            Label("Worktree", systemImage: "arrow.triangle.branch")
                                .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .accessibilityHint("Turns off working in a new worktree")
                    }
                }
                Spacer(minLength: 0)
                if let options { AgentPicker(options: options) }
                if let stop, !canSend || empty {
                    Button(action: stop) {
                        Image(systemName: "stop.fill")
                            .font(.body.weight(.semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Stop")
                } else {
                    Button(action: send) {
                        Image(systemName: sending ? "ellipsis" : "arrow.up")
                            .font(.body.weight(.semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .disabled(!canSend || sending || empty)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onAppear { if options != nil { typing.wrappedValue = true } }
    }

    private func plusMenu(_ worktree: Binding<Bool>) -> some View {
        Menu {
            Toggle(isOn: worktree) {
                Label("New Worktree", systemImage: "arrow.triangle.branch")
                Text("The agent works on its own branch")
            }
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .frame(width: 30, height: 30)
                .contentShape(.rect)
        }
        .foregroundStyle(.primary)
        .accessibilityLabel("Options")
    }
}

/// The agent CLI a new agent runs in a terminal: each one whose Cate hooks
/// are on. Unavailable ones are left out.
private struct AgentPicker: View {
    let options: AgentChoiceOptions

    var body: some View {
        Menu {
            ForEach((options.choices ?? []).filter(\.ready)) { choice in
                item(choice.agentId, choice.displayName)
            }
        } label: {
            HStack(spacing: 4) {
                if options.loaded {
                    Text(options.label)
                } else {
                    ProgressView().controlSize(.small)
                }
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
        }
        .foregroundStyle(.primary)
        .disabled(!options.loaded)
    }

    private func item(_ agentId: String, _ title: String) -> some View {
        Button {
            options.selected = agentId
        } label: {
            if options.selected == agentId {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }
}

/// A line that shimmers while the agent is busy, as chat apps show a reply
/// on its way.
struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweeping = false

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        let band = max(geometry.size.width * 0.5, 40)
                        LinearGradient(colors: [.clear, .primary, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: sweeping ? geometry.size.width : -band)
                    }
                    .mask { Text(text) }
                    .allowsHitTesting(false)
                }
            }
            .onAppear {
                withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) { sweeping = true }
            }
            .accessibilityLabel(text)
    }
}
