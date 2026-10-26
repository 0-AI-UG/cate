// How an agent chat moves: what shows while a reply is on its way, and how a
// reply comes in. The conversation reaches the app in bursts (the runtime
// reads the agent's session store, which a CLI writes a message at a time),
// so the chat paces what it shows:
// - One slot at the end of the chat says what the agent does: thinking, the
//   step it last completed, or that it is stopping. The slot always takes its
//   room, so nothing moves when it shows or goes; what it says crossfades.
//   Once shown it stays a moment (no flash), a step shows long enough to be
//   read, and a newer one skips those in between.
// - A reply that comes in while you watch shows line by line, top to
//   bottom at a steady reading pace with a soft leading edge; a long one is
//   all there within a few seconds. It is laid out once, not per line.
// - The conversation loading: a spinner only when it takes a moment, then
//   long enough to be seen.

import SwiftUI

/// What the chat's last slot says.
enum TailContent: Hashable {
    /// Starting, sending, working without a step yet.
    case waiting
    /// The step the agent last completed.
    case step(String)
    /// Stopping the agent's turn.
    case stopping
    /// Why nothing more happens here.
    case note(String)

    var busy: Bool {
        if case .note = self { return false }
        return true
    }
}

/// The chat's last slot. It always takes one line, so the chat does not move
/// when it shows or goes.
struct TailSlot: View {
    /// What it should say; nil for nothing.
    let wanted: TailContent?
    @State private var shown: TailContent?
    @State private var since = Date.distantPast

    /// Shown, a busy slot stays at least this long.
    private static let minimum: Duration = .milliseconds(600)
    /// A step stays at least this long before the next.
    private static let stepMinimum: Duration = .milliseconds(450)

    var body: some View {
        ZStack(alignment: .leading) {
            if let shown {
                TailLine(content: shown)
                    .id(shown)
                    .transition(.asymmetric(insertion: .opacity, removal: .opacity.animation(.easeOut(duration: 0.12))))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
        .animation(.easeInOut(duration: 0.22), value: shown)
        .task(id: wanted) { await follow(wanted) }
    }

    private func follow(_ wanted: TailContent?) async {
        guard wanted != shown else { return }
        let elapsed = Duration.seconds(Date.now.timeIntervalSince(since))
        // Busy shows at once; anything after a busy slot waits its turn.
        if let shown, shown.busy {
            let hold: Duration
            if wanted == nil || wanted?.busy == false {
                hold = Self.minimum - elapsed
            } else if case .step = shown {
                hold = Self.stepMinimum - elapsed
            } else {
                hold = .zero
            }
            if hold > .zero {
                try? await Task.sleep(for: hold)
                if Task.isCancelled { return }
            }
        }
        shown = wanted
        since = .now
    }
}

private struct TailLine: View {
    let content: TailContent

    var body: some View {
        switch content {
        case .waiting:
            ShimmerText(text: "Thinking").font(.subheadline)
        case .step(let step):
            ShimmerText(text: step).font(.subheadline).lineLimit(1)
        case .stopping:
            ShimmerText(text: "Stopping").font(.subheadline)
        case .note(let note):
            Text(note).font(.callout).foregroundStyle(.secondary)
        }
    }
}

/// A spinner for something that is on its way: none when it comes quickly,
/// and once shown, long enough to not flash.
struct DelayedSpinner: View {
    let active: Bool
    @State private var shown = false
    @State private var since = Date.distantPast

    private static let delay: Duration = .milliseconds(250)
    private static let minimum: Duration = .milliseconds(500)

    var body: some View {
        ZStack {
            if shown { ProgressView().transition(.opacity) }
        }
        .animation(.easeInOut(duration: 0.2), value: shown)
        .task(id: active) {
            if active {
                try? await Task.sleep(for: Self.delay)
                guard !Task.isCancelled else { return }
                shown = true
                since = .now
            } else if shown {
                let hold = Self.minimum - .seconds(Date.now.timeIntervalSince(since))
                if hold > .zero { try? await Task.sleep(for: hold) }
                guard !Task.isCancelled else { return }
                shown = false
            }
        }
    }
}

/// A reply split into its Markdown blocks: paragraphs, headings, code,
/// lists, quotes, tables. Blocks part at blank lines outside code; an
/// indented line goes on the block before (a list item's next paragraph).
enum MarkdownBlocks {
    static func split(_ text: String) -> [String] {
        var blocks: [String] = []
        var current: [Substring] = []
        var fence: Substring?
        var blank = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop { $0 == " " }
            if let open = fence {
                current.append(line)
                if trimmed.hasPrefix(open) { fence = nil }
                continue
            }
            if trimmed.isEmpty {
                blank = true
                continue
            }
            let indented = line.first == " " || line.first == "\t"
            if blank, !current.isEmpty, !indented {
                blocks.append(current.joined(separator: "\n"))
                current = []
            } else if blank, !current.isEmpty {
                current.append("")
            }
            blank = false
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fence = trimmed.prefix(3)
            }
            current.append(line)
        }
        if !current.isEmpty { blocks.append(current.joined(separator: "\n")) }
        return blocks
    }
}

/// An agent's reply as Markdown. One that came in while you watch shows
/// line by line: it is laid out whole once and shown through a frame that
/// grows down at a steady pace, its leading edge fading, so the chat grows
/// with it and nothing is laid out again on the way. It waits while you
/// scroll the chat, so what you scroll does not move under you. One that was
/// there shows whole.
struct ReplyView: View {
    let item: AgentConversation.Item
    @Environment(\.chatScrolling) private var scrolling
    /// How much of the reply shows; nil for all of it.
    @State private var shown: CGFloat?
    /// The reply's height laid out whole.
    @State private var height: CGFloat = 0
    /// The leading edge fades while it moves.
    @State private var revealing = false
    @State private var revealer: Task<Void, Never>?
    /// The chat is being scrolled: the reveal waits.
    @State private var paused = false

    init(item: AgentConversation.Item) {
        self.item = item
        _shown = State(initialValue: item.live ? 0 : nil)
    }

    /// Points a second: about twelve lines.
    private static let speed: CGFloat = 260
    /// However long the reply, it is all there in about this many seconds.
    private static let longest: CGFloat = 2.5
    private static let edge: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(MarkdownBlocks.split(item.text).enumerated()), id: \.offset) { _, block in
                MarkdownText(text: block, selectable: false).equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { next in
            height = next
            if shown != nil, revealer == nil { revealer = Task { await reveal() } }
        }
        .frame(height: shown.map { min($0, height) }, alignment: .top)
        .clipped()
        .mask {
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: revealing ? Self.edge : 0)
            }
        }
        .onChange(of: scrolling, initial: true) { _, now in paused = now }
        .onDisappear {
            revealer?.cancel()
            revealer = nil
            shown = nil
        }
    }

    /// Shows more of the reply every frame, at a steady pace (faster while
    /// much waits, so a long reply does not take long), then all of it. Not
    /// an animation: the chat lays out what shows each frame, so it grows
    /// with the reply and its end stays in view.
    private func reveal() async {
        revealing = true
        let clock = ContinuousClock()
        var last = clock.now
        while let current = shown, current < height {
            try? await Task.sleep(for: .milliseconds(16))
            if Task.isCancelled { return }
            let now = clock.now
            let elapsed = CGFloat((now - last) / .seconds(1))
            last = now
            if paused { continue }
            let pace = max(Self.speed, (height - current) / Self.longest)
            shown = min(height, current + pace * elapsed)
        }
        withAnimation(.easeOut(duration: 0.35)) { revealing = false }
        try? await Task.sleep(for: .seconds(0.35))
        if Task.isCancelled { return }
        shown = nil
        revealer = nil
    }
}

extension EnvironmentValues {
    /// You are scrolling the chat (dragging, or flicked and it still moves).
    @Entry var chatScrolling = false
}
