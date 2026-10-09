// Joining a workspace: scan the pairing QR code another device shows
// (Settings → Devices → Add device, or `cate serve`), or type its code. The
// QR code's `cate://pair` link is only ever scanned, here or by the Camera
// app (which opens Cate with it, `link`); it is never typed or pasted.

import SwiftUI

struct JoinView: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.dismiss) private var dismiss
    /// A scanned link that opened the app: join with it at once.
    let link: String?
    let joined: (String) -> Void

    @State private var code = ""
    @State private var busy = false
    @State private var scanning = false
    @State private var error: String?

    private var trimmedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                if busy && link != nil {
                    Section {
                        LabeledContent("Joining the workspace…") { ProgressView() }
                    }
                } else {
                    if QRScanner.isAvailable {
                        Section {
                            Button("Scan QR code", systemImage: "qrcode.viewfinder") { scanning = true }
                                .disabled(busy)
                        }
                    }
                    Section {
                        TextField("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", text: $code, axis: .vertical)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .lineLimit(2...3)
                            .disabled(busy)
                            .onSubmit { Task { await joinWithCode() } }
                        if UIPasteboard.general.hasStrings {
                            Button("Paste", systemImage: "doc.on.clipboard") {
                                code = UIPasteboard.general.string ?? code
                            }
                            .disabled(busy)
                        }
                    } header: {
                        Text(QRScanner.isAvailable ? "Or type the code" : "Pairing code")
                    } footer: {
                        Text("On a computer with the workspace open, go to Settings → Devices → Add device, or run `cate serve` in the workspace.")
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Join a workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Join") { Task { await joinWithCode() } }.disabled(trimmedCode.isEmpty)
                    }
                }
            }
            .fullScreenCover(isPresented: $scanning) {
                QRScannerView { scanned in
                    scanning = false
                    Task { await join(scanned) }
                } cancel: {
                    scanning = false
                }
            }
        }
        .interactiveDismissDisabled(busy)
        .task {
            if let link { await join(link) }
        }
    }

    private func joinWithCode() async {
        guard !trimmedCode.isEmpty, !busy else { return }
        if trimmedCode.lowercased().hasPrefix("cate://") {
            error = "That is the QR code's link. Scan the QR code, or type the code shown below it."
            return
        }
        await join(trimmedCode)
    }

    private func join(_ input: String) async {
        busy = true
        error = nil
        let result = await core.join(input)
        busy = false
        if result.ok, let id = result.workspaceId {
            joined(id)
        } else {
            error = result.message ?? "Could not join."
        }
    }
}
