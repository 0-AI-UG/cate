// The box at the bottom of an agent chat, like a chat app's: the text, and
// for a new agent its options in the box itself. `+` holds where it works
// (a new worktree keeps it off the branch you are on) and attaches photos
// and files: each is stored on the runtime's machine and its path goes with
// the prompt, which every agent CLI reads the same way. `@` names a file of
// the agent's checkout. The picker on the right picks the agent CLI that
// runs it in a terminal; the last choice is remembered on this device.
// While the agent works, a prompt is queued until it can take it, and with
// nothing typed the send button is its stop button.

import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The agent CLIs a workspace can run a new agent with, and the pick.
@MainActor
@Observable
final class AgentChoiceOptions {
    private(set) var choices: [AgentChoice]?
    /// The picked agent id.
    var selected: String?

    var loaded: Bool { choices != nil }

    /// The picked agent when it can start now.
    var ready: AgentChoice? {
        choices?.first { $0.agentId == selected && $0.ready }
    }

    var label: String {
        if selected == nil { return loaded ? "No agents" : "Agent" }
        return choices?.first { $0.agentId == selected }?.displayName ?? "Agent"
    }

    func load(_ core: CoreHost, workspaceId: String, remembered: String) async {
        choices = (try? await core.call("agents.choices", ["workspaceId": workspaceId], as: [AgentChoice].self)) ?? []
        guard ready == nil else { return }
        let ready = choices?.filter(\.ready) ?? []
        selected = ready.first { $0.agentId == remembered }?.agentId ?? ready.first?.agentId
    }
}

/// Photos and files going with the next prompt: each is stored on the
/// runtime's machine as soon as it is picked, and the prompt names its path.
@MainActor
@Observable
final class ComposerAttachments {
    struct Item: Identifiable {
        let id = UUID()
        let name: String
        let thumbnail: UIImage?
        var path: String?
        var failure: String?
    }

    private(set) var items: [Item] = []

    var isEmpty: Bool { items.isEmpty }
    /// Every item is stored (or failed and can be removed).
    var ready: Bool { items.allSatisfy { $0.path != nil || $0.failure != nil } }

    /// Longest side of a photo as sent; agents read it no better larger.
    private static let maxSide: CGFloat = 2048

    func addPhoto(_ image: UIImage, core: CoreHost, workspaceId: String) {
        let scaled = Self.scaled(image)
        guard let data = scaled.jpegData(compressionQuality: 0.85) else { return }
        let name = "photo-\(UUID().uuidString.prefix(8)).jpg"
        add(Item(name: name, thumbnail: scaled), data: data, kind: "image", core: core, workspaceId: workspaceId)
    }

    func addFile(_ url: URL, core: CoreHost, workspaceId: String) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        add(Item(name: url.lastPathComponent, thumbnail: nil), data: data, kind: "file", core: core, workspaceId: workspaceId)
    }

    func remove(_ id: UUID) {
        items.removeAll { $0.id == id }
    }

    /// The prompt with the stored files' paths, one per line after it.
    func prompt(_ text: String) -> String {
        let paths = items.compactMap(\.path)
        guard !paths.isEmpty else { return text }
        return ([text].filter { !$0.isEmpty } + [paths.joined(separator: "\n")]).joined(separator: "\n\n")
    }

    func clear() {
        items = []
    }

    private func add(_ item: Item, data: Data, kind: String, core: CoreHost, workspaceId: String) {
        items.append(item)
        let id = item.id
        Task {
            let params: [String: Any] = [
                "workspaceId": workspaceId, "name": item.name, "kind": kind, "data": data.base64EncodedString(),
            ]
            let result = (try? await core.call("agents.attach", params, as: AttachResult.self))
                ?? AttachResult(ok: false, path: nil, message: "It could not be stored.")
            guard let index = items.firstIndex(where: { $0.id == id }) else { return }
            if result.ok, let path = result.path {
                items[index].path = path
            } else {
                items[index].failure = result.message ?? "It could not be stored."
            }
        }
    }

    private static func scaled(_ image: UIImage) -> UIImage {
        let side = max(image.size.width, image.size.height)
        guard side > maxSide else { return image }
        let scale = maxSide / side
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}

struct AgentComposer: View {
    @Environment(CoreHost.self) private var core
    @Binding var text: String
    let placeholder: String
    /// The agent can take a prompt now (or queue one).
    let canSend: Bool
    let sending: Bool
    let workspaceId: String
    /// Where `@` finds files: the agent's checkout, nil for the workspace root.
    var searchRoot: String?
    let attachments: ComposerAttachments
    /// A new agent's options; nil in a running agent's chat.
    var options: AgentChoiceOptions?
    var worktree: Binding<Bool>?
    let send: () -> Void
    /// Stops the agent's work; nil when nothing runs that can be stopped.
    var stop: (() -> Void)?
    /// The box has the keyboard; the chat around it can take it away.
    var typing: FocusState<Bool>.Binding

    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var pickingFiles = false
    @State private var matches: [FileMatch] = []

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
        let mention = Self.mentionQuery(text)
        VStack(alignment: .leading, spacing: 12) {
            if mention != nil, !matches.isEmpty {
                MentionList(matches: matches) { pick($0) }
            }
            if !attachments.isEmpty {
                AttachmentStrip(attachments: attachments)
            }
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...8)
                .focused(typing)
                .padding(.horizontal, 4)
            HStack(spacing: 10) {
                plusMenu
                if let worktree, worktree.wrappedValue {
                    Button { worktree.wrappedValue = false } label: {
                        Label("Worktree", systemImage: "arrow.triangle.branch")
                            .font(.subheadline.weight(.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .accessibilityHint("Turns off working in a new worktree")
                }
                Spacer(minLength: 0)
                if let options { AgentPicker(options: options) }
                if let stop, !canSend || empty {
                    Button(action: stop) {
                        Image(systemName: "stop.fill")
                            .font(.body.weight(.semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Stop")
                } else {
                    Button(action: send) {
                        Group {
                            if sending {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.up").font(.body.weight(.semibold))
                            }
                        }
                        .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .disabled(!canSend || sending || empty || !attachments.ready)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
        // A tap anywhere in the box types in it, not only on the text line;
        // its buttons still take their own taps.
        .contentShape(.rect(cornerRadius: 28))
        .onTapGesture { typing.wrappedValue = true }
        // Not interactive: the box is not a button, and a press effect on a
        // tap that does not focus the text reads as a dead tap.
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onAppear { if options != nil { typing.wrappedValue = true } }
        .task(id: mention) { await search(mention) }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, matching: .images)
        .onChange(of: photos) { _, picked in load(picked) }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            for url in (try? result.get()) ?? [] { attachments.addFile(url, core: core, workspaceId: workspaceId) }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { attachments.addPhoto($0, core: core, workspaceId: workspaceId) }
                .ignoresSafeArea()
        }
    }

    private var plusMenu: some View {
        Menu {
            Section {
                Button("Photo Library", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take Photo", systemImage: "camera") { takingPhoto = true }
                }
                Button("Files", systemImage: "folder") { pickingFiles = true }
            }
            if let worktree {
                Toggle(isOn: worktree) {
                    Label("New Worktree", systemImage: "arrow.triangle.branch")
                    Text("The agent works on its own branch")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .frame(width: 30, height: 30)
                .contentShape(.rect)
        }
        .foregroundStyle(.primary)
        .accessibilityLabel("Options")
    }

    private func load(_ picked: [PhotosPickerItem]) {
        guard !picked.isEmpty else { return }
        photos = []
        for item in picked {
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
                attachments.addPhoto(image, core: core, workspaceId: workspaceId)
            }
        }
    }

    // MARK: Mentions

    /// What follows an `@` being typed at the end of the text, or nil.
    static func mentionQuery(_ text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if let before = text[..<at].last, !before.isWhitespace { return nil }
        let query = text[text.index(after: at)...]
        guard !query.isEmpty, !query.contains(where: \.isWhitespace) else { return nil }
        return String(query)
    }

    private func search(_ query: String?) async {
        guard let query else {
            matches = []
            return
        }
        try? await Task.sleep(for: .milliseconds(150))
        if Task.isCancelled { return }
        var params: [String: Any] = ["workspaceId": workspaceId, "query": query]
        if let searchRoot { params["root"] = searchRoot }
        let found = (try? await core.call("files.search", params, as: [FileMatch].self)) ?? []
        if !Task.isCancelled { matches = Array(found.prefix(6)) }
    }

    /// The `@` being typed becomes the file's path in the checkout.
    private func pick(_ match: FileMatch) {
        guard let at = text.lastIndex(of: "@") else { return }
        text = String(text[..<at]) + "@" + match.relativePath + (match.isDirectory ? "/" : " ")
        matches = []
    }
}

/// Files whose names match what follows `@`, to name one in the prompt.
private struct MentionList: View {
    let matches: [FileMatch]
    let pick: (FileMatch) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(matches) { match in
                Button { pick(match) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: match.isDirectory ? "folder" : "doc")
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(match.name).lineLimit(1)
                            Text(match.relativePath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 6)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// What goes with the prompt: a photo's thumbnail or a file's name, each
/// removable, marked while it is stored and when it could not be.
private struct AttachmentStrip: View {
    let attachments: ComposerAttachments

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments.items) { item in
                    ZStack(alignment: .topTrailing) {
                        tile(item)
                        Button { attachments.remove(item.id) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .buttonStyle(.plain)
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Remove \(item.name)")
                    }
                }
            }
            .padding(.top, 6)
            .padding(.trailing, 6)
        }
    }

    @ViewBuilder
    private func tile(_ item: ComposerAttachments.Item) -> some View {
        Group {
            if let thumbnail = item.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 56, height: 56)
            } else {
                Label(item.name, systemImage: "doc")
                    .font(.footnote)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: 160, minHeight: 56)
            }
        }
        .background(.fill.tertiary)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            if item.failure != nil {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            } else if item.path == nil {
                ProgressView()
            }
        }
        .accessibilityLabel(item.failure ?? item.name)
    }
}

/// The camera, for a photo to send.
private struct CameraPicker: UIViewControllerRepresentable {
    let take: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.take(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// The agent CLI a new agent runs in a terminal: each one whose Cate hooks
/// are on. Unavailable ones are left out.
private struct AgentPicker: View {
    let options: AgentChoiceOptions

    var body: some View {
        Menu {
            ForEach((options.choices ?? []).filter(\.ready)) { choice in
                item(choice.agentId, choice.displayName)
            }
        } label: {
            HStack(spacing: 4) {
                if options.loaded {
                    Text(options.label)
                } else {
                    ProgressView().controlSize(.small)
                }
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
        }
        .foregroundStyle(.primary)
        .disabled(!options.loaded)
    }

    private func item(_ agentId: String, _ title: String) -> some View {
        Button {
            options.selected = agentId
        } label: {
            if options.selected == agentId {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }
}

/// A line that shimmers while the agent is busy, as chat apps show a reply
/// on its way. The sweep is read off the clock, so no other animation or
/// change of text can stop it; a new text crossfades.
struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: TimeInterval = 1.5

    var body: some View {
        ZStack(alignment: .leading) {
            line.id(text).transition(.opacity)
        }
        .animation(.easeInOut(duration: 0.25), value: text)
        .accessibilityLabel(text)
    }

    private var line: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .overlay {
                if !reduceMotion {
                    TimelineView(.animation) { timeline in
                        let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                        GeometryReader { geometry in
                            let band = max(geometry.size.width * 0.5, 40)
                            LinearGradient(colors: [.clear, .primary, .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + (geometry.size.width + band) * phase)
                        }
                    }
                    .mask { Text(text) }
                    .allowsHitTesting(false)
                }
            }
    }
}
