// Where a new panel or agent goes on the canvas it was asked from: the spot
// you tap in its map, or, without a tap, where there is room. Asked from
// anywhere else, it goes to the dock without this sheet.

import SwiftUI

struct PlacementSheet: View {
    @Environment(CoreHost.self) private var core
    @Environment(\.dismiss) private var dismiss
    let workspaceId: String
    let title: String
    /// The confirm button's words: Create, Start.
    let action: String
    /// The canvas it was asked from.
    let canvasPanelId: String
    let place: (Placement) -> Void
    @State private var point: CGPoint?

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let panels = Dictionary((workspace?.panels ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let canvas = panels[canvasPanelId]
        NavigationStack {
            VStack(spacing: 12) {
                CanvasMap(
                    nodes: canvas?.canvas?.nodes ?? [],
                    panels: panels,
                    pick: { point = $0 },
                    marker: point
                )
                .clipShape(.rect(cornerRadius: 16))
                .padding(.horizontal)
                Text(point == nil ? "Tap where it goes, or it goes where there is room." : "Tap elsewhere to move it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action, role: .confirm) { confirm() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func confirm() {
        place(Placement(canvasPanelId: canvasPanelId, point: point))
        dismiss()
    }
}

/// A new panel or agent waiting for its place.
struct PendingPlacement: Identifiable {
    let id = UUID()
    let title: String
    let action: String
    let canvasPanelId: String
    let place: (Placement) -> Void
}

extension View {
    /// Shows the placement sheet for `pending` while it is set.
    func placementSheet(_ pending: Binding<PendingPlacement?>, workspaceId: String) -> some View {
        sheet(item: pending) { pending in
            PlacementSheet(
                workspaceId: workspaceId,
                title: pending.title,
                action: pending.action,
                canvasPanelId: pending.canvasPanelId,
                place: pending.place
            )
        }
    }
}

extension CoreHost {
    /// Creates a panel of `type` at `placement` (the dock without one); its
    /// id, or nil.
    func createPanel(_ workspaceId: String, type: String, at placement: Placement?) async -> String? {
        var params: [String: Any] = ["workspaceId": workspaceId, "type": type]
        if let placement { params["placement"] = placement.params }
        return (try? await call("panel.create", params, as: String?.self)) ?? nil
    }
}
