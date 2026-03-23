import SwiftUI
import AppKit

/// SwiftUI wrapper around TerminalView.
/// Use this when embedding a terminal inside a SwiftUI hierarchy (e.g. CanvasNode).
/// For pure AppKit contexts, use TerminalView directly.
struct TerminalPanelView: NSViewRepresentable {

    /// The panel model. The view reads its workingDirectory on creation.
    var panel: TerminalPanel

    // MARK: - NSViewRepresentable

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView()
        // Surface attachment is deferred to viewDidMoveToWindow inside TerminalView
        return view
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        // Nothing to update for now — the surface is self-contained.
        // If `panel` properties change (e.g. resize) we'd propagate them here.
        _ = panel
    }

    // MARK: - Coordinator (reserved for delegate callbacks)

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {}
}

// MARK: - Previews

#if DEBUG
struct TerminalPanelView_Previews: PreviewProvider {
    static var previews: some View {
        TerminalPanelView(panel: TerminalPanel(title: "Preview Terminal"))
            .frame(width: 700, height: 400)
    }
}
#endif
