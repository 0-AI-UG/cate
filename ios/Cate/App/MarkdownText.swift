// An agent's reply as GitHub-flavored Markdown (tables, code blocks, lists,
// quotes, strikethrough, links), rendered by Textual in its GitHub style.

import SwiftUI
import Textual

struct MarkdownText: View, Equatable {
    let text: String

    var body: some View {
        StructuredText(markdown: text)
            .textual.structuredTextStyle(.gitHub)
            .textual.textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
