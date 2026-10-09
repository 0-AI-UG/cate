// A surface panel: a placeholder that becomes the panel type picked here, in
// place (`surface.pick`).

import SwiftUI

struct SurfacePanelView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel
    @State private var choices: [PanelChoice]?

    var body: some View {
        Group {
            if let choices {
                List(choices) { choice in
                    Button {
                        Task { _ = try? await core.call("surface.pick", ["workspaceId": workspaceId, "panelId": panel.id, "type": choice.type], as: Bool.self) }
                    } label: {
                        Label(choice.label, systemImage: PanelIcon.symbol(choice.icon))
                    }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { choices = await core.panelChoices("surface.choices", ["workspaceId": workspaceId, "panelId": panel.id]) }
    }
}
