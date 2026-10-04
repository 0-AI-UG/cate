// A files panel: the file it shows, edited through its shared buffer
// (`buffer.*`, the Yjs buffer every editor of the file shares), with Save,
// the on-disk conflict choice, a markdown preview, previews of documents
// (images, PDFs) and a file browser to open another file in the panel.

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
    let workspaceId: String
    let panel: Panel
    @State private var session = PanelSession<EditorSnapshot>()
    @State private var browsing = false
    @State private var discarding: [String: Any]?
    @State private var failure: OpFailure?
    /// Source or preview of a markdown file is this device's pick, for the
    /// file it was made on (the runtime shares only a conflict's diff).
    @State private var sourceFor: String?

    var body: some View {
        content
            .navigationTitle(panel.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let snapshot = session.snapshot, let path = snapshot.filePath, isMarkdown(path), snapshot.documentType == nil {
                    ToolbarItem(placement: .primaryAction) {
                        let preview = showsPreview(snapshot)
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
    }

    /// A saved markdown file shows its preview until this device picks the source.
    private func showsPreview(_ snapshot: EditorSnapshot) -> Bool {
        guard let path = snapshot.filePath, isMarkdown(path), snapshot.documentType == nil, !snapshot.draft else { return false }
        return sourceFor != path
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

    private func isMarkdown(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ext == "md" || ext == "markdown" || ext == "mdx"
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
/// and reach the core in order; edits made elsewhere arrive as whole text,
/// taken when no local edit is in flight (each edit's answer carries the
/// text after it, so nothing is missed).
@MainActor
@Observable
final class BufferModel {
    private(set) var text: String?
    private(set) var error: String?
    @ObservationIgnored let viewId = UUID().uuidString
    /// The text changed by someone else: the text view takes it.
    @ObservationIgnored var onRemoteText: ((String) -> Void)?
    @ObservationIgnored private weak var core: CoreHost?
    @ObservationIgnored private var pending = 0
    @ObservationIgnored private var missed = false

    func run(_ core: CoreHost, workspaceId: String, path: String) async {
        self.core = core
        core.openBuffer(viewId, workspaceId: workspaceId, path: path) { [weak self] data in
            switch ViewEvent.decode(data) {
            case .text(let text): self?.remote(text)
            case .error(let message): self?.error = message
            default: break
            }
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3_600))
        }
        core.closeBuffer(viewId)
    }

    private func remote(_ next: String) {
        guard pending == 0 else {
            missed = true
            return
        }
        take(next)
    }

    private func take(_ next: String) {
        guard next != text else { return }
        text = next
        onRemoteText?(next)
    }

    /// The text view replaced `length` UTF-16 units at `from` with
    /// `replacement`, leaving `result`.
    func edit(from: Int, length: Int, replacement: String, result: String) {
        text = result
        send(from: from, length: length, replacement: replacement)
    }

    private func send(from: Int, length: Int, replacement: String) {
        guard let core else { return }
        pending += 1
        core.editBuffer(viewId, from: from, length: length, text: replacement) { [weak self] reply in
            guard let self else { return }
            self.pending -= 1
            guard self.pending == 0 else { return }
            if self.missed {
                // Text arrived while edits were in flight: ask for it whole.
                self.missed = false
                self.send(from: 0, length: 0, replacement: "")
            } else if let reply {
                self.take(reply)
            }
        }
    }
}

private struct BufferEditor: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let path: String
    let preview: Bool
    @State private var model = BufferModel()

    var body: some View {
        Group {
            if let error = model.error {
                ContentUnavailableView("Could not open the file", systemImage: "doc.questionmark", description: Text(error))
            } else if let text = model.text {
                if preview {
                    ScrollView {
                        MarkdownPreview(text: text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    }
                } else {
                    BufferTextView(model: model, initial: text)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await model.run(core, workspaceId: workspaceId, path: path) }
    }
}

/// Markdown, line by line: headings, list items and quotes as blocks, inline
/// styling within each.
private struct MarkdownPreview: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                block
            }
        }
        .textSelection(.enabled)
    }

    private var blocks: [Text] {
        var out: [Text] = []
        var fenced = false
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                fenced.toggle()
                continue
            }
            if fenced {
                out.append(Text(line).font(.callout.monospaced()))
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            let level = trimmed.prefix { $0 == "#" }.count
            if level > 0, level <= 6, trimmed.dropFirst(level).hasPrefix(" ") {
                let fonts: [Font] = [.title, .title2, .title3, .headline, .subheadline, .subheadline]
                out.append(Text(Self.inline(String(trimmed.dropFirst(level + 1)))).font(fonts[level - 1]).bold())
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                out.append(Text("• ") + Text(Self.inline(String(trimmed.dropFirst(2)))))
            } else if trimmed.hasPrefix("> ") {
                out.append(Text(Self.inline(String(trimmed.dropFirst(2)))).italic().foregroundStyle(.secondary))
            } else {
                out.append(Text(Self.inline(trimmed)))
            }
        }
        return out
    }

    private static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
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

        func attach(_ view: UITextView) {
            self.view = view
            last = view.text as NSString
            model.onRemoteText = { [weak self] text in self?.replace(with: text) }
        }

        func textViewDidChange(_ view: UITextView) {
            // Mid-composition text is not an edit yet.
            if view.markedTextRange != nil { return }
            let next = view.text as NSString
            let (from, removed, inserted) = Self.difference(last, next)
            last = next
            if removed == 0 && inserted.length == 0 { return }
            model.edit(from: from, length: removed, replacement: inserted as String, result: next as String)
        }

        /// Text from elsewhere: only the changed range is replaced, so the
        /// selection and scroll position stay.
        private func replace(with text: String) {
            guard let view, view.markedTextRange == nil else { return }
            let next = text as NSString
            let (from, removed, inserted) = Self.difference(view.text as NSString, next)
            last = next
            if removed == 0 && inserted.length == 0 { return }
            let selection = view.selectedRange
            let offset = view.contentOffset
            view.textStorage.replaceCharacters(in: NSRange(location: from, length: removed), with: inserted as String)
            let shift = inserted.length - removed
            func moved(_ location: Int) -> Int {
                location <= from ? location : max(from, location + shift)
            }
            let start = moved(selection.location)
            let end = moved(selection.location + selection.length)
            view.selectedRange = NSRange(location: start, length: max(0, end - start))
            view.setContentOffset(offset, animated: false)
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
