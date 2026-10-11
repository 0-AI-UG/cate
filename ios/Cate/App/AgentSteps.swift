// The steps of an agent's turn (the tool calls its hooks reported), folded
// into one row: how many, which tools; open, each step with what it worked
// on. A ghost stands where steps ran before the runtime kept them: something
// happened there, not what.

import SwiftUI

struct AgentStepsRow: View {
    let group: AgentStepGroup

    var body: some View {
        if group.ghost {
            GhostSteps()
        } else {
            StepList(steps: group.steps)
        }
    }
}

private struct StepList: View {
    let steps: [AgentStep]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(steps.count == 1 ? "1 step" : "\(steps.count) steps")
                        .font(.subheadline.weight(.medium))
                    Text(tools)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
            if open {
                Divider().padding(.leading, 12)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        StepLine(step: step)
                    }
                }
                .padding(12)
            }
        }
        .background(.fill.quinary, in: .rect(cornerRadius: 14))
    }

    /// Which tools ran, most used first: "Bash ×5 · Read ×3".
    private var tools: String {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for step in steps {
            if counts[step.tool] == nil { order.append(step.tool) }
            counts[step.tool, default: 0] += 1
        }
        return order
            .sorted { counts[$0]! > counts[$1]! }
            .map { counts[$0]! > 1 ? "\($0) ×\(counts[$0]!)" : $0 }
            .joined(separator: " · ")
    }
}

private struct StepLine: View {
    let step: AgentStep

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(step.tool)
                .font(.footnote.weight(.semibold))
            if let subject = step.subject {
                Text(subject)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Steps ran here, before this runtime started keeping them.
private struct GhostSteps: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.footnote)
            HStack(spacing: 6) {
                ForEach([44.0, 70, 36], id: \.self) { width in
                    Capsule().frame(width: width, height: 8)
                }
            }
            .opacity(0.5)
            Spacer(minLength: 0)
            Text("Earlier steps")
                .font(.footnote)
        }
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("The agent took steps here before Cate kept them")
    }
}
