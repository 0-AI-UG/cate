// A canvas panel: the canvas it shows, drawn as a map of its nodes where
// they sit (pinch to zoom, drag to pan), and listed below. Tapping a node
// opens its panel; a node with several tabs asks which.

import SwiftUI

struct CanvasPanelView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel
    @State private var picking: CanvasModel.Node?
    @State private var opened: PanelRoute?
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        let panels = core.workspace(workspaceId)?.panels ?? []
        let byId = Dictionary(panels.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let nodes = panel.canvas?.nodes ?? []
        Group {
            if nodes.isEmpty {
                ContentUnavailableView("Empty canvas", systemImage: "square.grid.3x3", description: Text("Panels placed on this canvas show here."))
            } else {
                List {
                    Section {
                        CanvasMap(nodes: nodes, panels: byId, scale: zoom * pinch) { node in
                            if node.panels.count == 1 {
                                opened = PanelRoute(workspaceId: workspaceId, panelId: node.panels[0])
                            } else {
                                picking = node
                            }
                        }
                        .frame(height: 320)
                        .listRowInsets(EdgeInsets())
                        .gesture(
                            MagnifyGesture()
                                .updating($pinch) { value, state, _ in state = value.magnification }
                                .onEnded { value in zoom = min(4, max(0.5, zoom * value.magnification)) }
                        )
                    }
                    Section("Panels") {
                        ForEach(nodes.flatMap(\.panels), id: \.self) { id in
                            if let item = byId[id] {
                                PanelRow(workspaceId: workspaceId, panel: item)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $opened) { PanelView(route: $0) }
        .alert("Open", isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }), presenting: picking) { node in
            ForEach(node.panels, id: \.self) { id in
                Button(byId[id]?.title ?? "Panel") { opened = PanelRoute(workspaceId: workspaceId, panelId: id) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// The canvas's nodes at their places, fitted to the width at scale 1.
private struct CanvasMap: View {
    let nodes: [CanvasModel.Node]
    let panels: [String: Panel]
    let scale: CGFloat
    let open: (CanvasModel.Node) -> Void

    var body: some View {
        GeometryReader { geometry in
            let bounds = Self.bounds(nodes)
            let padding: CGFloat = 16
            let fit = min(
                (geometry.size.width - padding * 2) / max(bounds.width, 1),
                (geometry.size.height - padding * 2) / max(bounds.height, 1)
            )
            let factor = fit * scale
            ScrollView([.horizontal, .vertical]) {
                ZStack(alignment: .topLeading) {
                    Color.clear.frame(width: bounds.width * factor + padding * 2, height: bounds.height * factor + padding * 2)
                    ForEach(nodes) { node in
                        let first = node.panels.first.flatMap { panels[$0] }
                        Button { open(node) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Label(first?.title ?? "Panel", systemImage: PanelIcon.symbol(first?.icon ?? ""))
                                    .font(.caption)
                                    .lineLimit(1)
                                if node.panels.count > 1 {
                                    Text("+\(node.panels.count - 1) more").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            .padding(6)
                            .frame(width: max(24, node.rect.width * factor), height: max(24, node.rect.height * factor), alignment: .topLeading)
                            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                        }
                        .buttonStyle(.plain)
                        .offset(x: padding + (node.rect.x - bounds.minX) * factor, y: padding + (node.rect.y - bounds.minY) * factor)
                    }
                }
            }
            .background(Color.secondary.opacity(0.06))
        }
    }

    private static func bounds(_ nodes: [CanvasModel.Node]) -> CGRect {
        nodes.reduce(CGRect.null) { rect, node in
            rect.union(CGRect(x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height))
        }
    }
}
