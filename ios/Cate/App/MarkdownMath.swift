import Foundation

/// Textual accepts dollar-delimited math. Normalize the other delimiters
/// agents use before Markdown consumes their backslashes. Leave code alone,
/// including unfinished code fences while a reply is streaming.
enum MarkdownMath {
    static func normalize(_ text: String) -> String {
        var result = ""
        var cursor = text.startIndex
        var fence: (character: Character, count: Int)?
        var lineStart = true

        while cursor < text.endIndex {
            if lineStart {
                let end = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
                let line = text[cursor..<end]
                let trimmed = line.drop(while: { $0 == " " })
                if fence == nil, line.hasPrefix("    ") || line.hasPrefix("\t") {
                    result += line
                    cursor = end
                    lineStart = false
                    continue
                }
                if let character = trimmed.first, character == "`" || character == "~" {
                    let count = trimmed.prefix(while: { $0 == character }).count
                    if let open = fence {
                        if character == open.character, count >= open.count,
                           trimmed.dropFirst(count).allSatisfy({ $0.isWhitespace }) {
                            fence = nil
                        }
                    } else if count >= 3 {
                        fence = (character, count)
                    }
                    if count >= 3 {
                        result += line
                        cursor = end
                        lineStart = false
                        continue
                    }
                }
            }

            let character = text[cursor]
            lineStart = character == "\n"
            if fence == nil, character == "`" {
                let run = text[cursor...].prefix(while: { $0 == "`" })
                let start = text.index(cursor, offsetBy: run.count)
                var search = start
                var codeEnd: String.Index?
                while search < text.endIndex {
                    guard let next = text[search...].firstIndex(of: "`") else { break }
                    let closing = text[next...].prefix(while: { $0 == "`" })
                    search = text.index(next, offsetBy: closing.count)
                    if closing.count == run.count {
                        codeEnd = search
                        break
                    }
                }
                if let codeEnd {
                    result += text[cursor..<codeEnd]
                    cursor = codeEnd
                    continue
                }
                result += run
                cursor = start
                continue
            }
            if fence == nil, character == "\\" {
                let next = text.index(after: cursor)
                if next < text.endIndex {
                    let opener = text[next]
                    if opener == "(" || opener == "[" {
                        let start = text.index(after: next)
                        let closer = opener == "(" ? "\\)" : "\\]"
                        if let end = text.range(of: closer, range: start..<text.endIndex),
                           opener == "[" || !text[start..<end.lowerBound].contains("\n") {
                            let delimiter = opener == "(" ? "$" : "$$"
                            result += delimiter + text[start..<end.lowerBound] + delimiter
                            cursor = end.upperBound
                            continue
                        }
                    }
                    // An escaped backslash must not start a math delimiter.
                    result += text[cursor...next]
                    cursor = text.index(after: next)
                    continue
                }
            }
            result.append(character)
            cursor = text.index(after: cursor)
        }
        return result
    }
}
