// An agent's reply as GitHub-flavored Markdown (tables, code blocks, lists,
// quotes, strikethrough, links, math), rendered by Textual in its GitHub style.

import SwiftUI
import Textual

struct MarkdownText: View, Equatable {
    let text: String
    /// Text can be selected. Off in a chat, where each selectable message
    /// would add its own touch handling and layout tracking to every scroll.
    var selectable = true

    var body: some View {
        if selectable {
            content.textual.textSelection(.enabled)
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(MarkdownBlocks.split(text).enumerated()), id: \.offset) { _, block in
                if MarkdownMath.isDisplayBlock(block) {
                    Overflow {
                        markdown(block).fixedSize(horizontal: true, vertical: true)
                    }
                    .textual.overflowMode(.scroll)
                } else {
                    markdown(block)
                }
            }
        }
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func markdown(_ text: String) -> some View {
        StructuredText(markdown: text, syntaxExtensions: [.math])
            .textual.structuredTextStyle(.gitHub)
    }
}
