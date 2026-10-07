// A canvas panel: the canvas it shows, drawn as a map of its nodes where
// they sit (pinch to zoom, drag to pan), and listed below. Tapping a node
// opens its panel; a node with several tabs asks which. `+` adds a panel or
// an agent to the canvas, where you tap in the placement sheet.

import SwiftUI

struct CanvasPanelView: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panel: Panel
    @State private var picking: CanvasModel.Node?
    @State private var opened: PanelRoute?
    @State private var creatable: [PanelChoice] = []
    @State private var placing: PendingPlacement?
    @State private var newAgent: NewAgentRoute?
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        let panels = core.workspace(workspaceId)?.panels ?? []
        let byId = Dictionary(panels.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let nodes = panel.canvas?.nodes ?? []
        Group {
            if nodes.isEmpty {
                ContentUnavailableView("Empty canvas", systemImage: "square.grid.3x3", description: Text("Add a panel or an agent with +."))
            } else {
                List {
                    Section {
                        CanvasMap(nodes: nodes, panels: byId, scale: zoom * pinch, open: { node in
                            if node.panels.count == 1 {
                                opened = PanelRoute(workspaceId: workspaceId, panelId: node.panels[0])
                            } else {
                                picking = node
                            }
                        })
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
        .navigationDestination(item: $newAgent) { AgentChatView(workspaceId: $0.workspaceId, panelId: nil, canvasPanelId: $0.canvasPanelId) }
        .placementSheet($placing, workspaceId: workspaceId)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New Agent", systemImage: "square.and.pencil") {
                        newAgent = NewAgentRoute(workspaceId: workspaceId, canvasPanelId: panel.id)
                    }
                    Section {
                        ForEach(creatable.filter(\.canvas)) { choice in
                            Button(choice.label, systemImage: PanelIcon.symbol(choice.icon)) { add(choice) }
                        }
                    }
                } label: {
                    Label("Add to Canvas", systemImage: "plus")
                }
            }
        }
        .task { creatable = await core.panelChoices("panel.creatable", ["workspaceId": workspaceId]) }
        .alert("Open", isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }), presenting: picking) { node in
            ForEach(node.panels, id: \.self) { id in
                Button(byId[id]?.title ?? "Panel") { opened = PanelRoute(workspaceId: workspaceId, panelId: id) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func add(_ choice: PanelChoice) {
        placing = PendingPlacement(title: "New \(choice.label)", action: "Create", canvasPanelId: panel.id) { placement in
            Task {
                if let id = await core.createPanel(workspaceId, type: choice.type, at: placement) {
                    opened = PanelRoute(workspaceId: workspaceId, panelId: id)
                }
            }
        }
    }
}

/// The canvas's nodes at their places, fitted to the frame at scale 1.
/// With `pick`, tapping anywhere picks that canvas point instead (shown by
/// `marker`), and the map leaves room around the nodes to pick from.
struct CanvasMap: View {
    let nodes: [CanvasModel.Node]
    let panels: [String: Panel]
    var scale: CGFloat = 1
    var open: ((CanvasModel.Node) -> Void)?
    var pick: ((CGPoint) -> Void)?
    var marker: CGPoint?

    /// Canvas units around the nodes a placement can pick from.
    private static let room: CGFloat = 400

    var body: some View {
        GeometryReader { geometry in
            let bounds = extent
            let padding: CGFloat = 16
            let fit = min(
                (geometry.size.width - padding * 2) / max(bounds.width, 1),
                (geometry.size.height - padding * 2) / max(bounds.height, 1)
            )
            let factor = fit * scale
            let place = { (point: CGPoint) in
                CGPoint(x: padding + (point.x - bounds.minX) * factor, y: padding + (point.y - bounds.minY) * factor)
            }
            ScrollView([.horizontal, .vertical]) {
                ZStack(alignment: .topLeading) {
                    Color.clear.frame(width: bounds.width * factor + padding * 2, height: bounds.height * factor + padding * 2)
                    ForEach(nodes) { node in
                        let first = node.panels.first.flatMap { panels[$0] }
                        let origin = place(CGPoint(x: node.rect.x, y: node.rect.y))
                        Button { open?(node) } label: {
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
                        .allowsHitTesting(pick == nil)
                        .offset(x: origin.x, y: origin.y)
                    }
                    if let marker {
                        let at = place(marker)
                        Image(systemName: "plus.circle.fill")
                            .font(.title)
                            .foregroundStyle(.tint)
                            .background(Circle().fill(.background))
                            .frame(width: 32, height: 32)
                            .offset(x: at.x - 16, y: at.y - 16)
                            .allowsHitTesting(false)
                            .accessibilityLabel("Placed here")
                    }
                }
                .contentShape(.rect)
                .onTapGesture { location in
                    pick?(CGPoint(x: bounds.minX + (location.x - padding) / factor, y: bounds.minY + (location.y - padding) / factor))
                }
            }
            .background(Color.secondary.opacity(0.06))
        }
    }

    private var extent: CGRect {
        let around = nodes.reduce(CGRect.null) { rect, node in
            rect.union(CGRect(x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height))
        }
        if pick == nil { return around }
        return around.isNull ? CGRect(x: 0, y: 0, width: 1_600, height: 1_000) : around.insetBy(dx: -Self.room, dy: -Self.room)
    }
}
