import AppKit

// MARK: - Panel Protocol
// PanelType is defined in CanvasLayoutEngine.swift (same module).

protocol Panel: AnyObject, Identifiable where ID == UUID {
    var id: UUID { get }
    var panelType: PanelType { get }
    var title: String { get }
    var isDirty: Bool { get }

    func makeContentView() -> NSView
    func focus()
    func unfocus()
}
