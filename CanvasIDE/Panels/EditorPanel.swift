import AppKit

// MARK: - EditorPanel

final class EditorPanel: Panel {
    let id = UUID()
    let panelType: PanelType = .editor
    private(set) var title: String
    var isDirty: Bool = false

    var filePath: String?
    private(set) var content: String = ""

    // Weak reference to the live text view so EditorPanel can push
    // programmatic content changes (e.g. after save) without owning the view.
    weak var textView: NSTextView?

    init(filePath: String? = nil) {
        self.filePath = filePath
        self.title = filePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Untitled"
        if let path = filePath {
            loadFile(path)
        }
    }

    func makeContentView() -> NSView {
        EditorPanelView(panel: self)
    }

    func focus() {
        textView?.window?.makeFirstResponder(textView)
    }

    func unfocus() {}

    // MARK: File I/O

    private func loadFile(_ path: String) {
        content = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    }

    func save() {
        guard let path = filePath else { return }
        try? content.write(toFile: path, atomically: true, encoding: .utf8)
        isDirty = false
        // Update title to remove dirty marker
        title = URL(fileURLWithPath: path).lastPathComponent
    }

    // Called by EditorPanelView whenever the user edits text.
    func textDidChange(_ newContent: String) {
        content = newContent
        if !isDirty {
            isDirty = true
            if let path = filePath {
                title = URL(fileURLWithPath: path).lastPathComponent + " •"
            }
        }
    }
}
