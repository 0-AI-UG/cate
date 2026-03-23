import AppKit

// MARK: - PanelContentFactory
//
// Single dispatch point: given any Panel, returns the right NSView.
// TerminalPanel/TerminalView is created by Phase 3 (GhosttyAppManager);
// we forward to it here via the protocol so CanvasNode stays type-agnostic.

enum PanelContentFactory {

    /// Returns the appropriate content view for `panel`.
    /// The returned view should be embedded directly into CanvasNode's content area.
    static func makeContentView(for panel: any Panel) -> NSView {
        switch panel.panelType {

        case .terminal:
            // TerminalPanel (Phase 3) is a plain struct managed by GhosttyAppManager.
            // We create a TerminalView directly; surface attachment is deferred to
            // viewDidMoveToWindow inside TerminalView itself.
            let terminalView = TerminalView()
            return terminalView

        case .browser:
            guard let browserPanel = panel as? BrowserPanel else {
                return panel.makeContentView()
            }
            return BrowserPanelView(panel: browserPanel)

        case .editor:
            guard let editorPanel = panel as? EditorPanel else {
                return panel.makeContentView()
            }
            return EditorPanelView(panel: editorPanel)
        }
    }
}
