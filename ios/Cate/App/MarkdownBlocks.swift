import Foundation

/// A reply split into its Markdown blocks: paragraphs, headings, code,
/// lists, quotes, tables. Blocks part at blank lines outside code and math; an
/// indented line goes on the block before (a list item's next paragraph).
enum MarkdownBlocks {
    static func split(_ text: String) -> [String] {
        var blocks: [String] = []
        var current: [Substring] = []
        var fence: Substring?
        var math = false
        var blank = false
        for line in MarkdownMath.normalize(text).split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop { $0 == " " }
            if let open = fence {
                current.append(line)
                if trimmed.hasPrefix(open) { fence = nil }
                continue
            }
            if math {
                current.append(line)
                if line.components(separatedBy: "$$").count.isMultiple(of: 2) { math = false }
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
            } else if trimmed.hasPrefix("$$"),
                      line.components(separatedBy: "$$").count.isMultiple(of: 2) {
                math = true
            }
            current.append(line)
        }
        if !current.isEmpty { blocks.append(current.joined(separator: "\n")) }
        return blocks
    }
}

