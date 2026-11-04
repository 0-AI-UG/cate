// How an agent chat moves: what shows while a reply is on its way, and how a
// reply comes in. The conversation reaches the app in bursts (the runtime
// reads the agent's session store, which a CLI writes a message at a time),
// so the chat paces what it shows:
// - One slot at the end of the chat says what the agent does: thinking, the
//   step it last completed, or that it is stopping. The slot always takes its
//   room, so nothing moves when it shows or goes; what it says crossfades.
//   Once shown it stays a moment (no flash), a step shows long enough to be
//   read, and a newer one skips those in between.
// - Replies resize when their text changes; the collection view owns their
//   measured height and the scroll position.
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
