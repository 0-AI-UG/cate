// The box at the bottom of an agent chat, like a chat app's: the text, and
// for a new agent its options in the box itself. `+` holds where it works
// (a new worktree keeps it off the branch you are on); the picker on the
// right picks what runs it: an agent CLI in a terminal, or a T3 Code
// provider and model. The last choice is remembered on this device. While
// the agent works, the send button is its stop button.

import SwiftUI

/// What runs a new agent (`MobileAgentLaunch`).
enum AgentLaunch: Hashable {
    case terminal(agentId: String)
    case t3(instanceId: String, model: String)

    var params: [String: Any] {
        switch self {
        case .terminal(let agentId): ["runner": "terminal", "agentId": agentId]
        case .t3(let instanceId, let model): ["runner": "t3", "instanceId": instanceId, "model": model]
        }
    }

    /// As stored on the device: `terminal:<agent>` or `t3:<instance>:<model>`.
    var key: String {
        switch self {
        case .terminal(let agentId): "terminal:\(agentId)"
        case .t3(let instanceId, let model): "t3:\(instanceId):\(model)"
        }
    }

    init?(key: String) {
        let parts = key.split(separator: ":", maxSplits: 2).map(String.init)
        switch parts.first {
        case "terminal" where parts.count == 2: self = .terminal(agentId: parts[1])
        case "t3" where parts.count == 3: self = .t3(instanceId: parts[1], model: parts[2])
        default: return nil
        }
    }
}

/// What a workspace can run a new agent with, and the pick.
@MainActor
@Observable
final class AgentLaunchOptions {
    private(set) var choices: [AgentChoice]?
    private(set) var providers: [T3Provider]?
    var selected: AgentLaunch?

    var loaded: Bool { choices != nil && providers != nil }

    /// The selected terminal agent.
    var terminalChoice: AgentChoice? {
        guard case .terminal(let agentId) = selected else { return nil }
        return choices?.first { $0.agentId == agentId }
    }

    /// The pick when it can start an agent now.
    var launch: AgentLaunch? {
        switch selected {
        case .terminal: return terminalChoice?.ready == true ? selected : nil
        case .t3(let instanceId, let model):
            let provider = providers?.first { $0.instanceId == instanceId }
            return provider?.ready == true && provider?.models.contains { $0.slug == model } == true ? selected : nil
        case nil: return nil
        }
    }

    /// The pick in a few words: the agent, or the model.
    var label: String {
        switch selected {
        case .terminal: return terminalChoice?.displayName ?? "Agent"
        case .t3(let instanceId, let model):
            let provider: T3Provider? = providers?.first { $0.instanceId == instanceId }
            let picked: T3Provider.Model? = provider?.models.first { $0.slug == model }
            return picked?.name ?? model
        case nil: return loaded ? "No agents" : "Agent"
        }
    }

    func load(_ core: CoreHost, workspaceId: String, remembered: String) async {
        async let choices = core.call("agents.choices", ["workspaceId": workspaceId], as: [AgentChoice].self)
        async let providers = core.call("agents.t3Models", ["workspaceId": workspaceId], as: [T3Provider].self)
        self.choices = (try? await choices) ?? []
        self.providers = (try? await providers) ?? []
        if selected == nil || launch == nil { selected = AgentLaunch(key: remembered).flatMap(valid) ?? fallback }
    }

    private func valid(_ launch: AgentLaunch) -> AgentLaunch? {
        switch launch {
        case .terminal(let agentId): choices?.contains { $0.agentId == agentId && $0.ready } == true ? launch : nil
        case .t3(let instanceId, let model):
            providers?.first { $0.instanceId == instanceId && $0.ready }?.models.contains { $0.slug == model } == true ? launch : nil
        }
    }

    /// The first ready terminal agent, else a ready T3 provider's default
    /// model.
    private var fallback: AgentLaunch? {
        if let choice = choices?.first(where: \.ready) { return .terminal(agentId: choice.agentId) }
        if let provider = providers?.first(where: \.ready),
           let model = provider.models.first(where: \.isDefault) ?? provider.models.first {
            return .t3(instanceId: provider.instanceId, model: model.slug)
        }
        return nil
    }
}

struct AgentComposer: View {
    @Binding var text: String
    let placeholder: String
    /// The agent can take a prompt now.
    let canSend: Bool
    let sending: Bool
    /// A new agent's options; nil in a running agent's chat.
    var options: AgentLaunchOptions?
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

/// The agent or model a new agent runs with: each agent CLI whose Cate hooks
/// are on, in a terminal, and each ready T3 Code provider's models.
/// Unavailable ones are left out.
private struct AgentPicker: View {
    let options: AgentLaunchOptions

    var body: some View {
        Menu {
            let choices = (options.choices ?? []).filter(\.ready)
            if !choices.isEmpty {
                Section("Terminal") {
                    ForEach(choices) { choice in
                        item(.terminal(agentId: choice.agentId), choice.displayName)
                    }
                }
            }
            let providers = (options.providers ?? []).filter(\.ready)
            if !providers.isEmpty {
                Section("T3 Code") {
                    ForEach(providers) { provider in
                        Menu(provider.label) {
                            ForEach(provider.models) { model in
                                item(.t3(instanceId: provider.instanceId, model: model.slug), model.name)
                            }
                        }
                    }
                }
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

    private func item(_ launch: AgentLaunch, _ title: String) -> some View {
        Button {
            options.selected = launch
        } label: {
            if options.selected == launch {
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
