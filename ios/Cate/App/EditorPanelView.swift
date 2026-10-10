// A files panel: the file it shows, edited through its shared buffer
// (`buffer.*`, the Yjs buffer every editor of the file shares), with Save,
// the on-disk conflict choice, previews of documents (images, PDFs) and a
// file browser to open another file in the panel. A text file with a
// preview (markdown, HTML, CSV) shows it first; Edit switches to its source.

import SwiftUI
import UIKit
import WebKit

struct EditorSnapshot: Decodable, Equatable {
    struct ConnectedDraft: Decodable, Equatable {
        let syncError: String?
    }
    let filePath: String?
    let checkout: String?
    let draft: Bool
    let documentType: String?
    let dirty: Bool
    let conflict: String?
    let merging: Bool
    let connectedDraft: ConnectedDraft?
    let loading: Bool
    let error: String?
}

struct EditorPanelView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.panelOnScreen) private var onScreen
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<EditorSnapshot>()
    @State private var browsing = false
    @State private var discarding: [String: Any]?
    @State private var failure: OpFailure?
    /// Source or preview of a previewable file is this device's pick, for
    /// the file it was made on (the runtime shares only a conflict's diff).
    @State private var sourceFor: String?

    var body: some View {
        content
            .panelTitle(panel.title)
            .toolbar {
                if onScreen {
                    if let snapshot = session.snapshot, let path = snapshot.filePath, TextPreview.kind(path) != nil, snapshot.documentType == nil, !snapshot.draft {
                        ToolbarItem(placement: .primaryAction) {
                            let preview = showsPreview(snapshot) != nil
                            Button(preview ? "Edit" : "Preview", systemImage: preview ? "pencil" : "eye") {
                                sourceFor = preview ? path : nil
                            }
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Files", systemImage: "folder") { browsing = true }
                            .disabled(session.snapshot?.checkout == nil)
                    }
                    if let snapshot = session.snapshot, snapshot.filePath != nil, snapshot.documentType == nil {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Save", systemImage: "square.and.arrow.down") { run(["kind": "save"]) }
                                .disabled(!snapshot.dirty || snapshot.draft)
                        }
                    }
                }
            }
            .sheet(isPresented: $browsing) {
                if let root = session.snapshot?.checkout {
                    NavigationStack {
                        FileBrowser(workspaceId: workspaceId, path: root) { path in
                            browsing = false
                            run(["kind": "openFile", "path": path])
                        }
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { browsing = false } }
                        }
                    }
                }
            }
            .alert("Discard unsaved changes?", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } })) {
                Button("Discard", role: .destructive) {
                    if var op = discarding {
                        op["discard"] = true
                        run(op)
                    }
                    discarding = nil
                }
                Button("Cancel", role: .cancel) { discarding = nil }
            } message: {
                Text("The file has edits that are not saved.")
            }
            .alert(item: $failure) { Alert(title: Text("Could not complete that"), message: Text($0.message)) }
            .task { await session.run(core, workspaceId: workspaceId, panelId: panel.id) }
            // The file's buffer syncs while the snapshot naming it is on its way.
            .task {
                if let path = panel.detail { await core.call("buffer.warm", ["workspaceId": workspaceId, "path": path]) }
            }
    }

    /// A saved file with a preview shows it until this device picks the source.
    private func showsPreview(_ snapshot: EditorSnapshot) -> TextPreview? {
        guard let path = snapshot.filePath, let kind = TextPreview.kind(path), snapshot.documentType == nil, !snapshot.draft else { return nil }
        return sourceFor == path ? nil : kind
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot = session.snapshot {
            VStack(spacing: 0) {
                if let conflict = snapshot.conflict {
                    ConflictBanner(conflict: conflict) { resolution in
                        run(["kind": "resolveConflict", "resolution": resolution])
                    }
                }
                if let syncError = snapshot.connectedDraft?.syncError {
                    Banner(text: syncError, systemImage: "exclamationmark.triangle")
                }
                if let error = snapshot.error {
                    ContentUnavailableView("Could not open the file", systemImage: "doc.questionmark", description: Text(error))
                } else if let path = snapshot.filePath {
                    if snapshot.documentType != nil {
                        FilePreview(workspaceId: workspaceId, path: path)
                    } else {
                        BufferEditor(workspaceId: workspaceId, path: path, preview: showsPreview(snapshot))
                            .id(path)
                    }
                } else if snapshot.loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let root = snapshot.checkout {
                    FileBrowser(workspaceId: workspaceId, path: root) { run(["kind": "openFile", "path": $0]) }
                } else {
                    ContentUnavailableView("No file", systemImage: "doc")
                }
            }
        } else {
            ProgressView()
        }
    }

    /// Runs an op; one that would lose unsaved edits asks first.
    private func run(_ op: [String: Any]) {
        Task {
            let reply = await session.send(op)
            if reply.ok { return }
            if reply.code == "dirty" {
                discarding = op
            } else {
                failure = OpFailure(message: reply.message ?? "Something went wrong.")
            }
        }
    }
}

private struct ConflictBanner: View {
    let conflict: String
    let resolve: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(conflict == "deleted" ? "The file was deleted on disk." : "The file changed on disk.", systemImage: "exclamationmark.triangle")
                .font(.callout)
            HStack {
                if conflict != "deleted" {
                    Button("Reload from disk") { resolve("reload") }
                }
                Button("Keep my edits") { resolve("keep") }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.yellow.opacity(0.15))
    }
}

struct Banner: View {
    let text: String
    let systemImage: String

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.yellow.opacity(0.15))
    }
}

/// A folder on the runtime's machine; picking a file calls `open`.
struct FileBrowser: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let path: String
    let open: (String) -> Void
    @State private var entries: [FileEntry]?
    @State private var error: String?

    var body: some View {
        Group {
            if let entries {
                List(entries) { entry in
                    if entry.isDirectory {
                        NavigationLink {
                            FileBrowser(workspaceId: workspaceId, path: entry.path, open: open)
                        } label: {
                            Label(entry.name, systemImage: "folder")
                        }
                    } else {
                        Button { open(entry.path) } label: {
                            Label(entry.name, systemImage: "doc.text").foregroundStyle(.primary)
                        }
                    }
                }
                .overlay {
                    if entries.isEmpty { ContentUnavailableView("Empty folder", systemImage: "folder") }
                }
            } else if let error {
                ContentUnavailableView("Could not list the folder", systemImage: "folder.badge.questionmark", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                entries = try await core.call("files.list", ["workspaceId": workspaceId, "path": path], as: [FileEntry].self)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A document (image, PDF) through the workspace's web view: the runtime
/// serves the file.
private struct FilePreview: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let path: String
    @State private var page: WebPageController?
    @State private var error: String?

    var body: some View {
        Group {
            if let page {
                WebPage(controller: page)
            } else if let error {
                ContentUnavailableView("Could not show the file", systemImage: "doc.questionmark", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: path) {
            do {
                let url = try await core.call("files.url", ["workspaceId": workspaceId, "path": path], as: String.self)
                guard let target = URL(string: url) else { return }
                await core.routeLoopback(workspaceId, target)
                let controller = WebPageController(store: core.webDataStore(workspaceId)) { [core, workspaceId] in await core.routeLoopback(workspaceId, $0) }
                controller.webView.load(URLRequest(url: target))
                page = controller
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// The text of a file's shared buffer on this view. Local edits apply at once
/// and reach the core in order. The buffer has a version: changes made
/// elsewhere arrive as deltas from the version this view has; when they came
/// between its own edits (an edit's answer is not one version on), or while
/// edits were in flight, it takes the text whole once its edits are in.
@MainActor
@Observable
final class BufferModel {
    private(set) var text: String?
    private(set) var error: String?
    @ObservationIgnored let viewId = UUID().uuidString
    /// A change made elsewhere: the text view takes it.
    @ObservationIgnored var onRemote: ((RemoteText) -> Void)?
    @ObservationIgnored private weak var core: CoreHost?
    @ObservationIgnored private var version = 0
    @ObservationIgnored private var pending = 0
    /// Changes made elsewhere were missed: take the text whole.
    @ObservationIgnored private var stale = false

    enum RemoteText {
        case whole(String)
        case delta([TextDelta])
    }

    func run(_ core: CoreHost, workspaceId: String, path: String) async {
        self.core = core
        core.openBuffer(viewId, workspaceId: workspaceId, path: path) { [weak self] data in
            switch ViewEvent.decode(data) {
            case .text(let text, let version): self?.take(text, version: version)
            case .change(let from, let to, let delta): self?.change(from: from, to: to, delta: delta)
            case .error(let message): self?.error = message
            default: break
            }
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3_600))
        }
        core.closeBuffer(viewId)
    }

    /// The text whole: the text view takes it even when this model had it,
    /// as the view may have missed a change.
    private func take(_ next: String, version: Int) {
        self.version = version
        if next != text { text = next }
        onRemote?(.whole(next))
    }

    private func change(from: Int, to: Int, delta: [TextDelta]) {
        // Older than the text this view has: already in it.
        if from < version { return }
        guard pending == 0, from == version, let text, let next = TextDelta.apply(delta, to: text) else {
            stale = true
            resync()
            return
        }
        version = to
        self.text = next
        onRemote?(.delta(delta))
    }

    /// The text view replaced `length` UTF-16 units at `from` with
    /// `replacement`, leaving `result`.
    func edit(from: Int, length: Int, replacement: String, result: String) {
        text = result
        guard let core else { return }
        pending += 1
        core.editBuffer(viewId, from: from, length: length, text: replacement) { [weak self] reply in
            guard let self else { return }
            self.pending -= 1
            if let reply, reply == self.version + 1 {
                self.version = reply
            } else {
                self.stale = true
            }
            self.resync()
        }
    }

    /// The text view missed changes made elsewhere (while composing text).
    func missedRemote() {
        stale = true
        resync()
    }

    /// Takes the text whole once no edit is in flight.
    private func resync() {
        guard stale, pending == 0, let core else { return }
        stale = false
        core.bufferText(viewId) { [weak self] reply in
            guard let self, let reply else { return }
            // Edits made since are in flight: the next answer resyncs.
            guard self.pending == 0 else {
                self.stale = true
                return
            }
            if reply.version >= self.version { self.take(reply.text, version: reply.version) }
        }
    }
}

private struct BufferEditor: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let path: String
    let preview: TextPreview?
    @State private var model = BufferModel()

    var body: some View {
        Group {
            if let error = model.error {
                ContentUnavailableView("Could not open the file", systemImage: "doc.questionmark", description: Text(error))
            } else if let text = model.text {
                switch preview {
                case .markdown:
                    ScrollView {
                        MarkdownText(text: text).padding()
                    }
                case .html:
                    HTMLPreview(workspaceId: workspaceId, path: path, html: text)
                case .table(let separator):
                    TablePreview(text: text, separator: separator)
                case nil:
                    BufferTextView(model: model, initial: text)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await model.run(core, workspaceId: workspaceId, path: path) }
    }
}

/// A plain-text editor over a buffer model: each change goes to the buffer as
/// the range it replaced, and text from elsewhere keeps the selection where
/// it was.
private struct BufferTextView: UIViewRepresentable {
    let model: BufferModel
    let initial: String

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.autocapitalizationType = .none
        view.autocorrectionType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.spellCheckingType = .no
        view.keyboardDismissMode = .interactive
        view.alwaysBounceVertical = true
        view.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        view.text = initial
        view.delegate = context.coordinator
        context.coordinator.attach(view)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        private let model: BufferModel
        private weak var view: UITextView?
        /// The text as the buffer last saw it from this view.
        private var last: NSString = ""

        init(model: BufferModel) {
            self.model = model
        }

        /// A change from elsewhere came while text was being composed.
        private var missed = false

        func attach(_ view: UITextView) {
            self.view = view
            last = view.text as NSString
            model.onRemote = { [weak self] change in
                switch change {
                case .whole(let text): self?.replace(with: text)
                case .delta(let delta): self?.apply(delta)
                }
            }
        }

        func textViewDidChange(_ view: UITextView) {
            // Mid-composition text is not an edit yet.
            if view.markedTextRange != nil { return }
            let next = view.text as NSString
            let (from, removed, inserted) = Self.difference(last, next)
            last = next
            if removed != 0 || inserted.length != 0 {
                model.edit(from: from, length: removed, replacement: inserted as String, result: next as String)
            }
            if missed {
                missed = false
                model.missedRemote()
            }
        }

        /// Text from elsewhere, whole: only the changed range is replaced.
        private func replace(with text: String) {
            guard let view, view.markedTextRange == nil else {
                missed = true
                return
            }
            let next = text as NSString
            let (from, removed, inserted) = Self.difference(view.text as NSString, next)
            if removed != 0 || inserted.length != 0 {
                keepingPlace(view) { replace(view, from: from, length: removed, with: inserted as String) }
            }
            last = next
        }

        /// A change from elsewhere, step by step.
        private func apply(_ delta: [TextDelta]) {
            guard let view, view.markedTextRange == nil else {
                missed = true
                return
            }
            guard TextDelta.fits(delta, length: view.textStorage.length) else {
                if let text = model.text { replace(with: text) }
                return
            }
            keepingPlace(view) {
                var index = 0
                for step in delta {
                    switch step {
                    case .retain(let count): index += count
                    case .insert(let text):
                        replace(view, from: index, length: 0, with: text)
                        index += (text as NSString).length
                    case .delete(let count): replace(view, from: index, length: count, with: "")
                    }
                }
            }
            last = view.text as NSString
        }

        /// The selection and scroll position stay where they were.
        private var selection = NSRange()

        private func keepingPlace(_ view: UITextView, _ change: () -> Void) {
            selection = view.selectedRange
            let offset = view.contentOffset
            view.textStorage.beginEditing()
            change()
            view.textStorage.endEditing()
            view.selectedRange = selection
            view.setContentOffset(offset, animated: false)
        }

        private func replace(_ view: UITextView, from: Int, length: Int, with text: String) {
            view.textStorage.replaceCharacters(in: NSRange(location: from, length: length), with: text)
            let shift = (text as NSString).length - length
            func moved(_ location: Int) -> Int {
                location <= from ? location : max(from, location + shift)
            }
            let start = moved(selection.location)
            let end = moved(selection.location + selection.length)
            selection = NSRange(location: start, length: max(0, end - start))
        }

        /// The one range that differs: where it starts, how many UTF-16 units
        /// of `old` it covers, and what `new` has there.
        private static func difference(_ old: NSString, _ new: NSString) -> (Int, Int, NSString) {
            let oldLength = old.length
            let newLength = new.length
            var prefix = 0
            let shortest = min(oldLength, newLength)
            while prefix < shortest && old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
            var suffix = 0
            while suffix < shortest - prefix && old.character(at: oldLength - 1 - suffix) == new.character(at: newLength - 1 - suffix) { suffix += 1 }
            let inserted = new.substring(with: NSRange(location: prefix, length: newLength - prefix - suffix)) as NSString
            return (prefix, oldLength - prefix - suffix, inserted)
        }
    }
}

// MARK: Previews

/// The preview a text file has besides its source, by its extension.
enum TextPreview: Equatable {
    case markdown
    case html
    /// Rows of cells split by `separator`.
    case table(Character)

    static func kind(_ path: String) -> TextPreview? {
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown", "mdx": .markdown
        case "html", "htm": .html
        case "csv": .table(",")
        case "tsv": .table("\t")
        default: nil
        }
    }
}

/// An HTML file as a page, from its buffer's text; links and assets resolve
/// next to the file as the runtime serves it.
private struct HTMLPreview: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let path: String
    let html: String
    @State private var page: WebPageController?
    @State private var base: URL?

    var body: some View {
        Group {
            if let page {
                WebPage(controller: page)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: path) {
            let url = try? await core.call("files.url", ["workspaceId": workspaceId, "path": path], as: String.self)
            base = url.flatMap(URL.init(string:))
            if let base { await core.routeLoopback(workspaceId, base) }
            let controller = WebPageController(store: core.webDataStore(workspaceId)) { [core, workspaceId] in await core.routeLoopback(workspaceId, $0) }
            controller.webView.loadHTMLString(html, baseURL: base)
            page = controller
        }
        .onChange(of: html) { _, next in page?.webView.loadHTMLString(next, baseURL: base) }
    }
}

/// CSV or TSV as a table, the first row as its header.
private struct TablePreview: View {
    let text: String
    let separator: Character
    /// The rows and column widths, read off the main thread.
    @State private var table: Table?

    struct Table: Sendable {
        let rows: [[String]]
        let widths: [CGFloat]

        /// Each column as wide as its longest cell in the first rows, in
        /// average characters of the cells' font, within 48...280 points.
        init(_ text: String, separator: Character) {
            rows = TablePreview.rows(text, separator: separator)
            var widths: [CGFloat] = []
            for row in rows.prefix(200) {
                for (column, cell) in row.enumerated() {
                    let width = min(280, max(48, CGFloat(cell.count) * 8))
                    if column < widths.count { widths[column] = max(widths[column], width) } else { widths.append(width) }
                }
            }
            self.widths = widths
        }
    }

    var body: some View {
        Group {
            if let table, table.rows.isEmpty {
                ContentUnavailableView("Empty file", systemImage: "tablecells")
            } else if let table {
                ScrollView([.vertical, .horizontal]) {
                    // Rows are laid out as they scroll in.
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(table.rows.indices, id: \.self) { index in
                            let row = table.rows[index]
                            HStack(alignment: .top, spacing: 16) {
                                ForEach(table.widths.indices, id: \.self) { column in
                                    Text(column < row.count ? row[column] : "")
                                        .font(.callout)
                                        .fontWeight(index == 0 ? .semibold : .regular)
                                        .lineLimit(3)
                                        .frame(width: table.widths[column], alignment: .leading)
                                }
                            }
                            if index == 0 { Divider() }
                        }
                    }
                    .padding()
                    .textSelection(.enabled)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: text) {
            let text = text, separator = separator
            table = await Task.detached(priority: .userInitiated) { Table(text, separator: separator) }.value
        }
    }

    /// The rows, with quoted cells (which may hold the separator, quotes
    /// doubled and line breaks) taken whole.
    nonisolated static func rows(_ text: String, separator: Character) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var cell = ""
        var quoted = false
        var iterator = text.makeIterator()
        var pending: Character?
        while let char = pending ?? iterator.next() {
            pending = nil
            if quoted {
                if char == "\"" {
                    if let next = iterator.next() {
                        if next == "\"" { cell.append("\"") } else { quoted = false; pending = next }
                    } else {
                        quoted = false
                    }
                } else {
                    cell.append(char)
                }
            } else if char == "\"" && cell.isEmpty {
                quoted = true
            } else if char == separator {
                row.append(cell)
                cell = ""
            } else if char == "\n" || char == "\r\n" || char == "\r" {
                row.append(cell)
                rows.append(row)
                row = []
                cell = ""
            } else {
                cell.append(char)
            }
        }
        if !cell.isEmpty || !row.isEmpty {
            row.append(cell)
            rows.append(row)
        }
        return rows
    }
}
