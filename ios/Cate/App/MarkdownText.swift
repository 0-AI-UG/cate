// An agent's reply as GitHub-flavored Markdown (tables, code blocks, lists,
// quotes, strikethrough, links), rendered by Textual in its GitHub style.

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
        StructuredText(markdown: text)
            .textual.structuredTextStyle(.gitHub)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
