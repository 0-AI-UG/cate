#if DEBUG
import SwiftUI

/// Simulator-only fixture using the production conversation and row views.
/// Launch with --chat-scroll-fixture; no runtime or paired workspace needed.
struct ChatScrollFixture: View {
    @State private var conversation = AgentConversation(panelId: "scroll-fixture")
    @State private var start = 30
    @State private var chunk = 0
    @State private var input = ChatInput()
    @State private var attachments = ComposerAttachments()

    var body: some View {
        NavigationStack {
            AgentChatScrollFixtureList(conversation: conversation, input: input, attachments: attachments)
                .navigationTitle("Chat scroll fixture")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    Button("Stream burst") {
                        Task {
                            try? await Task.sleep(for: .seconds(1))
                            for _ in 0..<5 {
                                try? await Task.sleep(for: .milliseconds(200))
                                chunk += 1
                                conversation.appendFixtureReply(chunk: chunk)
                            }
                        }
                    }
                    Button("Append reply") {
                        chunk += 1
                        conversation.appendFixtureReply(chunk: chunk)
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 0) {
                        Text(ChatScrollProbe.shared.report)
                            .accessibilityIdentifier("scroll-position-result")
                            .font(.caption.monospaced())
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
                        TextField("Mock reply", text: Bindable(input).text)
                            .textFieldStyle(.roundedBorder).padding(.horizontal)
                    }
                    .background(.bar)
                }
                .task {
                    conversation.loadFixturePage = {
                        ChatScrollProbe.shared.capture()
                        Task {
                            try? await Task.sleep(for: .milliseconds(300))
                            start = max(0, start - 10)
                            conversation.showFixturePage(start: start)
                        }
                    }
                    // Exercise history arriving after the initially empty view.
                    try? await Task.sleep(for: .milliseconds(400))
                    conversation.showFixturePage(start: start)
                }
        }
    }
}

@MainActor
@Observable
final class ChatScrollProbe {
    static let shared = ChatScrollProbe()
    @ObservationIgnored var frames: [String: CGRect] = [:]
    @ObservationIgnored private var reference: (id: String, y: CGFloat)?
    var report = "10 messages · waiting for pagination"

    func capture() {
        reference = frames.filter { $0.value.maxY > 0 && $0.value.minY < 500 }
            .min { $0.value.minY < $1.value.minY }
            .map { (id: $0.key, y: $0.value.minY) }
        report = "Loading · tracking \(reference?.id ?? "none")"
    }

    func finish(count: Int) async {
        try? await Task.sleep(for: .seconds(1))
        guard let reference, let frame = frames[reference.id] else {
            report = "\(count) messages · FAIL: reference \(reference?.id ?? "none") left viewport"
            return
        }
        let delta = frame.minY - reference.y
        report = String(format: "%d messages · %@ · Δy %.1f pt", count, reference.id, delta)
        print("CHAT_SCROLL_FIXTURE: \(report)")
    }
}
#endif
