import Foundation

// MARK: - FileTreeNode

struct FileTreeNode: Identifiable {
    let id: String      // == path
    let name: String
    let path: String
    let isDirectory: Bool
    var children: [FileTreeNode] = []
    var isExpanded: Bool = false

    var fileExtension: String { (name as NSString).pathExtension }

    var sfSymbolName: String {
        if isDirectory {
            return isExpanded ? "folder.fill" : "folder"
        }
        switch fileExtension.lowercased() {
        case "swift":               return "swift"
        case "js", "jsx",
             "ts", "tsx":          return "doc.text"
        case "py":                  return "doc.text"
        case "json":                return "curlybraces"
        case "md", "markdown":      return "doc.richtext"
        case "html", "htm":         return "globe"
        case "css", "scss":         return "paintbrush"
        case "png", "jpg", "jpeg",
             "gif", "svg":          return "photo"
        default:                    return "doc"
        }
    }

    // MARK: Init

    init(name: String, path: String, isDirectory: Bool) {
        self.id = path
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
    }
}
