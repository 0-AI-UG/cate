// A canvas as a map of its panels where they sit, with their connections
// drawn between them. UIKit pans and pinches the map natively (`MapScroll`),
// and only an edge swipe goes back from it; the SwiftUI map is laid out
// again at the new scale when a pinch ends, so it stays sharp. Each panel is
// a tile, a place on the map rather than the panel: its kind as a badge (an
// agent's logo while one stands in for it), its title with the agent's
// status mark as the desktop's tabs show them, and where it is, all drawn at
// the map's scale so a tile is the same at every zoom. Tap a tile to zoom
// into the panel, long-press it to lift and move it, drag its `+` handle
// onto another to connect them; its `…` moves it to another worktree, sets
// when it sends context, or closes it. Each worktree's tiles sit on its territory
// (Worktrees). A new panel is placed on the map itself: it zooms out to the
// desktop's recommended spots, and a tap on one puts the panel there.

import SwiftUI
import UIKit

// MARK: Card actions

/// What a card asks of the screen it is on.
struct CardActions {
    let zoom: Namespace.ID
    let open: (Panel) -> Void
    /// Sets when a panel's prompts take its connections' context.
    let contextMode: (String, String) -> Void
    let close: (String) -> Void
}

/// Hosts a map: opens what its cards ask for (a panel zooms out of its card).
struct PlaceHost<Content: View>: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    @ViewBuilder let content: (CardActions) -> Content
    @Namespace private var zoom
    @State private var destination: CardDestination?

    var body: some View {
        let actions = CardActions(
            zoom: zoom,
            open: { destination = .panel($0.id) },
            contextMode: { panelId, mode in
                Task { _ = try? await core.call("relations.setContextMode", ["workspaceId": workspaceId, "panelId": panelId, "mode": mode], as: Bool.self) }
            },
            close: { panelId in Task { await core.removePanel(workspaceId, panelId: panelId) } }
        )
        content(actions)
            .worktreeSwitching(workspaceId)
            .navigationDestination(item: $destination) { destination in
                switch destination {
                case .panel(let panelId):
                    PanelView(route: PanelRoute(workspaceId: workspaceId, panelId: panelId))
                        .navigationTransition(.zoom(sourceID: panelId, in: zoom))
                }
            }
    }
}

private enum CardDestination: Hashable {
    case panel(String)
}

// MARK: Tiles

/// A tile's sizes in canvas units. Drawn at the map's scale, a tile is the
/// same drawing at every zoom, only smaller or larger.
enum TileMetrics {
    static let badge: CGFloat = 132
    static let glyph: CGFloat = 60
    static let title: CGFloat = 38
    static let text: CGFloat = 28
    static let spacing: CGFloat = 14
    /// The room the badge and words take, which a smaller tile shrinks to.
    static let composition = CGSize(width: 420, height: 320)
    static let padding: CGFloat = 18
    static let corner: CGFloat = 32
    static let menu: CGFloat = 76
    static let handle: CGFloat = 76
}

/// A panel on the map as a tile, a place on the map rather than the panel
/// itself: its kind as a badge (an agent's logo while one stands in for it),
/// its title with the agent's status mark as the desktop's tabs show them,
/// and where it is (a folder, a host). Every size is the map's scale times
/// `TileMetrics`.
struct PanelTile<Menu: View>: View {
    let panel: Panel
    let agent: Agent?
    /// The tabs of its canvas node; 1 for a panel alone.
    let tabs: Int
    let size: CGSize
    /// Map points per canvas unit.
    let scale: CGFloat
    @ViewBuilder let menu: () -> Menu

    var body: some View {
        // The badge and words shrink, never jump, in a tile smaller than
        // their room; the frame, menu and handle keep the map's scale.
        let s = scale * min(1, size.width / scale / TileMetrics.composition.width, size.height / scale / TileMetrics.composition.height)
        let tint = Self.tint(panel.type)
        VStack(spacing: TileMetrics.spacing * s) {
            PanelGlyph(icon: panel.icon, logo: agent?.logo)
                .foregroundStyle(.white)
                .frame(width: TileMetrics.glyph * 1.2 * s, height: TileMetrics.glyph * 1.2 * s)
                .frame(width: TileMetrics.badge * s, height: TileMetrics.badge * s)
                .background(tint.gradient, in: .circle)
                .overlay(alignment: .topTrailing) {
                    if tabs > 1 {
                        Text("\(tabs)")
                            .font(.system(size: TileMetrics.text * s, weight: .bold))
                            .foregroundStyle(tint)
                            .padding(.horizontal, 7 * s)
                            .frame(minWidth: 30 * s, minHeight: 30 * s)
                            .background(Color(.secondarySystemGroupedBackground), in: .capsule)
                            .offset(x: 8 * s, y: -4 * s)
                    }
                }
            HStack(spacing: 10 * s) {
                if let agent { AgentStatusMark(status: agent.status, size: TileMetrics.title * 0.6 * s) }
                Text(agent?.title ?? panel.title)
                    .font(.system(size: TileMetrics.title * s, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            if let place = place {
                Text(place)
                    .font(.system(size: TileMetrics.text * s))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(TileMetrics.padding * s)
        .frame(width: size.width, height: size.height)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: TileMetrics.corner * scale))
        .overlay {
            RoundedRectangle(cornerRadius: TileMetrics.corner * scale)
                .strokeBorder(Color(.separator), lineWidth: 0.5)
        }
        .overlay(alignment: .topTrailing) {
            menu()
                .frame(width: TileMetrics.menu * scale, height: TileMetrics.menu * scale)
                .padding(TileMetrics.padding * scale / 2)
        }
    }

    /// Where the panel is, in a word or two: a terminal's folder, an editor
    /// file's folder, a browser's host, a canvas's panels.
    private var place: String? {
        if let canvas = panel.canvas {
            let count = canvas.nodes.reduce(0) { $0 + $1.panels.count }
            return count == 1 ? "1 panel" : "\(count) panels"
        }
        guard let detail = panel.detail else { return nil }
        if let url = URL(string: detail), let host = url.host() { return host }
        var parts = detail.split(separator: "/").map(String.init)
        if panel.type == "editor" { parts = parts.dropLast() }
        guard let last = parts.last else { return nil }
        let home = parts.count == 2 && (parts[0] == "Users" || parts[0] == "home")
        return home ? "~" : last
    }

    /// A panel kind's badge color.
    static func tint(_ type: String) -> Color {
        switch type {
        case "terminal": Color(white: 0.25)
        case "editor": .blue
        case "browser": .teal
        case "chat": .purple
        case "review": .orange
        case "canvas": .indigo
        default: .gray
        }
    }
}

/// An agent's status as the desktop marks it on tabs: a dashed ring while it
/// runs, an orange dot while it waits for the person, nothing otherwise.
struct AgentStatusMark: View {
    let status: String
    let size: CGFloat

    var body: some View {
        switch status {
        case "running":
            Circle()
                .inset(by: size * 0.125)
                .stroke(.secondary, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, dash: [size * 0.175, size * 0.133]))
                .frame(width: size, height: size)
                .accessibilityLabel("Agent running")
        case "waitingForInput":
            Circle()
                .fill(Color.orange.mix(with: .primary, by: 0.3))
                .padding(size * 0.2)
                .frame(width: size, height: size)
                .accessibilityLabel("Awaiting input")
        default:
            EmptyView()
        }
    }
}

/// A tile on the map. The map's own gestures tap it open, lift it on a long
/// press and drag out its connections (`MapScroll`), so it takes no touches
/// itself but its menu; a lifted tile follows the finger without laying the
/// map out again.
private struct MapCard: View {
    let node: CanvasModel.Node
    let layout: MapLayout
    let touch: MapTouch
    let panel: Panel
    /// The other tabs of its node.
    let others: [Panel]
    let agent: Agent?
    let actions: CardActions
    let relationsEnabled: Bool
    let linkable: Bool
    let worktrees: [Worktree]

    var body: some View {
        let frame = layout.frame(node)
        let s = layout.scale
        let lifted = touch.movingNode == node.id
        // SwiftUI draws no text, symbol or glass below a few points: a small
        // tile is drawn at `draw` and shrunk whole, so it keeps its
        // proportions all the way down.
        let draw = max(s, 0.5)
        let shrink = s / draw
        PanelTile(panel: panel, agent: agent, tabs: others.count + 1, size: CGSize(width: frame.width / shrink, height: frame.height / shrink), scale: draw) { menu(draw) }
            .overlay(alignment: .bottomTrailing) {
                if linkable { ConnectHandle(size: TileMetrics.handle * draw).padding(TileMetrics.padding * draw / 2) }
            }
            .scaleEffect(shrink, anchor: .topLeading)
            .frame(width: frame.width, height: frame.height, alignment: .topLeading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(panel.title)
            .accessibilityValue(panel.typeLabel)
            .accessibilityAction { actions.open(panel) }
            .matchedTransitionSource(id: panel.id, in: actions.zoom)
            .overlay {
                if touch.hovered == node.id {
                    RoundedRectangle(cornerRadius: TileMetrics.corner * s).strokeBorder(.tint, lineWidth: max(1.5, 4 * s))
                }
            }
            .scaleEffect(lifted ? 1.04 : 1)
            .shadow(color: .black.opacity(lifted ? 0.22 : 0), radius: lifted ? 18 : 0, y: lifted ? 8 : 0)
            .animation(.snappy(duration: 0.2), value: lifted)
            .frame(width: frame.width, height: frame.height)
            .offset(touch.offset(of: node.id))
            .position(x: frame.midX, y: frame.midY)
            .zIndex(lifted ? 1 : 0)
    }

    private func menu(_ scale: CGFloat) -> some View {
        Menu {
            ForEach(others) { other in
                Button(other.title, systemImage: PanelIcon.symbol(other.icon)) { actions.open(other) }
            }
            WorktreePicker(panel: panel, worktrees: worktrees).pickerStyle(.menu)
            if relationsEnabled, panel.execution {
                Picker(selection: Binding(get: { panel.contextMode }, set: { mode in actions.contextMode(panel.id, mode) })) {
                    Text("Next Message").tag("once")
                    Text("Every Message").tag("always")
                    Text("Never").tag("off")
                } label: {
                    Label("Send Context", systemImage: "paperplane")
                }
                .pickerStyle(.menu)
            }
            Button("Close", systemImage: "xmark", role: .destructive) { actions.close(panel.id) }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: TileMetrics.menu * 0.4 * scale, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.tertiarySystemFill), in: .circle)
                .contentShape(.rect)
        }
        .accessibilityLabel("\(panel.title) Actions")
    }
}

/// The handle in a tile's corner a connection is dragged out of, at the
/// map's scale; the map's gesture drags it (`MapScroll`).
private struct ConnectHandle: View {
    let size: CGFloat

    var body: some View {
        Image(systemName: "plus")
            .font(.system(size: size * 0.42, weight: .bold))
            .foregroundStyle(.tint)
            .frame(width: size, height: size)
            .glassEffect(.regular, in: .circle)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

// MARK: Canvas

/// A canvas as a map. `center` follows the canvas point in the middle of the
/// screen once it settles, where new panels go.
struct CanvasPlace: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let canvasPanel: Panel
    let actions: CardActions
    @Binding var center: CGPoint?
    /// The new panel's type, while it waits for its spot.
    @Binding var placing: PanelChoice?
    @State private var touch = MapTouch()
    /// A connection dropped on a card, waiting for its meaning.
    @State private var pending: PendingLink?
    /// The part of the canvas on screen, in canvas units.
    @State private var visible: CGRect?
    /// The spots the placing panel can take, best first, in canvas units.
    @State private var spots: [CGRect] = []
    /// Where the map zooms to show the spots.
    @State private var fit: MapFit?

    var body: some View {
        let workspace = core.workspace(workspaceId)
        let panels = Dictionary((workspace?.panels ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let agents = Dictionary((workspace?.agents ?? []).map { ($0.panelId, $0) }, uniquingKeysWith: { first, _ in first })
        let relations = workspace?.relations ?? []
        let relationsEnabled = workspace?.relationsEnabled == true
        let worktrees = workspace?.worktrees ?? []
        let nodes = canvasPanel.canvas?.nodes ?? []
        // Each checkout's nodes, by the panel each card shows.
        let territories = worktrees.compactMap { worktree -> (worktree: Worktree, nodes: [CanvasModel.Node])? in
            let mine = nodes.filter { $0.panels.first.flatMap { panels[$0]?.worktreeId } == worktree.id }
            return mine.isEmpty ? nil : (worktree, mine)
        }
        // The panels of the cards in view, which a tap opens.
        let inView = nodes
            .filter { node in visible.map { $0.intersects(CGRect(x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height)) } ?? true }
            .compactMap { $0.panels.first }
            .filter { panels[$0].map { $0.type != "canvas" } == true }
        if nodes.isEmpty {
            ContentUnavailableView("Empty canvas", systemImage: "square.grid.3x3", description: Text("Add a panel with +, or start an agent here."))
        } else {
            let linkable = { (node: CanvasModel.Node, layout: MapLayout) -> Bool in
                relationsEnabled && node.panels.first.flatMap { panels[$0] }.map { $0.type != "canvas" } == true
            }
            MapScroll(
                nodes: nodes,
                spots: spots,
                placing: placing != nil,
                fit: fit,
                touch: touch,
                linkable: linkable,
                tapped: { point, layout in
                    if placing != nil {
                        if let spot = spots.first(where: { layout.frame(canvas: $0).contains(point) }) {
                            place(at: spot)
                        } else {
                            placing = nil
                        }
                    } else if let panel = layout.node(at: point)?.panels.first.flatMap({ panels[$0] }) {
                        actions.open(panel)
                    }
                },
                moved: { node, by, layout in move(node, by: by, scale: layout.scale) },
                linked: { node, point, layout in
                    guard let from = node.panels.first, let target = layout.node(at: point), target.id != node.id, let to = target.panels.first else { return }
                    connect(from: from, to: to, at: layout.canvasPoint(point))
                },
                settled: { rect in
                    visible = rect
                    center = CGPoint(x: rect.midX, y: rect.midY)
                }
            ) { layout in
                ZStack(alignment: .topLeading) {
                    ForEach(territories, id: \.worktree.id) { territory in
                        WorktreeTerritory(layout: layout, nodes: territory.nodes, color: territory.worktree.tint, touch: touch)
                    }
                    ForEach(relations) { relation in
                        RelationLine(layout: layout, relation: relation, touch: touch)
                    }
                    DraftLine(layout: layout, touch: touch)
                    Group {
                    // Chips sit with the lines, under the cards; their menus
                    // are system popovers over everything.
                    ForEach(relations) { relation in
                        RelationChip(layout: layout, relation: relation, touch: touch) { kind in
                            call("relations.setKind", ["relationId": relation.id, "kind": kind])
                        } remove: {
                            call("relations.remove", ["relationId": relation.id])
                        }
                    }
                    ForEach(nodes) { node in
                        let tabs = node.panels.compactMap { panels[$0] }
                        if let panel = tabs.first {
                            MapCard(
                                node: node,
                                layout: layout,
                                touch: touch,
                                panel: panel,
                                others: Array(tabs.dropFirst()),
                                agent: agents[panel.id],
                                actions: actions,
                                relationsEnabled: relationsEnabled,
                                linkable: linkable(node, layout),
                                worktrees: worktrees
                            )
                        }
                    }
                    }
                    // While placing, a tap is for the spots alone.
                    .allowsHitTesting(placing == nil)
                    if let placing {
                        ForEach(Array(spots.enumerated()), id: \.element) { index, spot in
                            SpotView(choice: placing, number: index + 1, frame: layout.frame(canvas: spot))
                                .transition(.scale(scale: 0.9).combined(with: .opacity))
                        }
                    }
                    if let pending {
                        Color.clear
                            .contentShape(.rect)
                            .onTapGesture { self.pending = nil }
                        LinkMenu(pending: pending, target: panels[pending.to]) { kind in
                            self.pending = nil
                            call("relations.connect", ["fromPanelId": pending.from, "toPanelId": pending.to, "kind": kind])
                        }
                        .position(layout.clamped(layout.viewPoint(pending.at), size: CGSize(width: 280, height: 220)))
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                    }
                }
                .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
                .animation(.snappy(duration: 0.2), value: pending)
                .animation(.snappy(duration: 0.25), value: spots)
                .sensoryFeedback(.success, trigger: pending)
            }
            // Under the bars, which float over the map.
            .ignoresSafeArea()
            .background(Color(.systemGroupedBackground))
            .overlay(alignment: .bottom) {
                if let placing {
                    PlacingBar(choice: placing, ready: !spots.isEmpty) { self.placing = nil }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.25), value: placing)
            .onChange(of: placing, initial: true) { suggest() }
            // The moved node now sits where the document has it.
            .onChange(of: nodes) { old, new in
                guard let id = touch.movingNode else { return }
                if old.first(where: { $0.id == id })?.rect != new.first(where: { $0.id == id })?.rect { touch.endMove() }
            }
            // Their sessions open ahead of the tap (`panel.warm`), renewed
            // while the map shows them.
            .task(id: inView) {
                while !Task.isCancelled {
                    await core.call("panel.warm", ["workspaceId": workspaceId, "panelIds": inView])
                    try? await Task.sleep(for: .seconds(25))
                }
            }
        }
    }

    /// The spots for the placing panel, and the map zoomed out to show them;
    /// on an empty canvas the panel goes straight where you are looking.
    private func suggest() {
        guard let placing else {
            spots = []
            return
        }
        guard canvasPanel.canvas?.nodes.isEmpty == false, let visible else {
            create(placing, at: Placement(canvasPanelId: canvasPanel.id, point: center))
            return
        }
        Task {
            let found = (try? await core.call("canvas.suggest", [
                "workspaceId": workspaceId, "canvasPanelId": canvasPanel.id, "type": placing.type,
                "visible": ["x": visible.minX, "y": visible.minY, "width": visible.width, "height": visible.height],
            ], as: [CanvasRect].self)) ?? []
            guard self.placing == placing else { return }
            guard !found.isEmpty else {
                create(placing, at: Placement(canvasPanelId: canvasPanel.id, point: center))
                return
            }
            spots = found.map(\.rect)
            fit = MapFit(rect: spots.reduce(visible) { $0.union($1) }.insetBy(dx: -40, dy: -40))
        }
    }

    private func place(at spot: CGRect) {
        guard let placing else { return }
        create(placing, at: Placement(canvasPanelId: canvasPanel.id, point: CGPoint(x: spot.midX, y: spot.midY), size: spot.size))
    }

    private func create(_ choice: PanelChoice, at placement: Placement) {
        placing = nil
        Task { _ = await core.createPanel(workspaceId, type: choice.type, at: placement) }
    }

    /// Moves the node by `translation` map points: one op when the drag ends.
    private func move(_ node: CanvasModel.Node, by translation: CGSize, scale: CGFloat) {
        guard let canvasId = canvasPanel.canvas?.id else { return touch.endMove() }
        let origin = ["x": (node.rect.x + translation.width / scale).rounded(), "y": (node.rect.y + translation.height / scale).rounded()]
        Task {
            let moved = (try? await core.call("canvas.moveNode", ["workspaceId": workspaceId, "canvasId": canvasId, "nodeId": node.id, "origin": origin], as: Bool.self)) ?? false
            if !moved, touch.movingNode == node.id { touch.endMove() }
        }
    }

    /// A connection dropped on a card: its meanings, when it can be made.
    private func connect(from: String, to: String, at point: CGPoint) {
        Task {
            let allowed = (try? await core.call("relations.targets", ["workspaceId": workspaceId, "panelId": from], as: [String].self)) ?? []
            guard allowed.contains(to) else { return }
            let options = (try? await core.call("relations.options", [
                "workspaceId": workspaceId, "fromPanelId": from, "toPanelId": to,
            ], as: [RelationOption].self)) ?? []
            guard !options.isEmpty else { return }
            pending = PendingLink(from: from, to: to, at: point, options: options)
        }
    }

    private func call(_ method: String, _ params: [String: Any]) {
        var params = params
        params["workspaceId"] = workspaceId
        Task { _ = try? await core.call(method, params, as: Bool.self) }
    }
}

private struct PendingLink: Equatable {
    let from: String
    let to: String
    /// Where it was dropped, in canvas units: the map may zoom meanwhile.
    let at: CGPoint
    let options: [RelationOption]
}

/// A canvas rect the map zooms out (or in) to show; a new one each time.
struct MapFit: Equatable {
    let id = UUID()
    /// In canvas units.
    let rect: CGRect
}

/// A spot a new panel can take: numbered, the best first, with the panel's
/// kind. The map's tap picks it (`MapScroll`).
private struct SpotView: View {
    let choice: PanelChoice
    let number: Int
    let frame: CGRect

    var body: some View {
        let best = number == 1
        let roomy = frame.width >= 110 && frame.height >= 70
        RoundedRectangle(cornerRadius: 18)
            .fill(Color.accentColor.opacity(best ? 0.18 : 0.08))
            .strokeBorder(Color.accentColor.opacity(best ? 0.9 : 0.5), style: StrokeStyle(lineWidth: best ? 2.5 : 1.5, dash: [7, 5]))
            .overlay {
                VStack(spacing: 6) {
                    Text("\(number)")
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(best ? Color.white : Color.accentColor)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(best ? Color.accentColor : Color.accentColor.opacity(0.15)))
                    if roomy {
                        Label(choice.label, systemImage: PanelIcon.symbol(choice.icon))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.tint)
                    }
                }
            }
            .frame(width: frame.width, height: frame.height)
            .position(x: frame.midX, y: frame.midY)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Spot \(number) for the new \(choice.label)")
    }
}

/// While a new panel waits for its spot: what to do, and Cancel.
private struct PlacingBar: View {
    let choice: PanelChoice
    /// The spots are on the map.
    let ready: Bool
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: PanelIcon.symbol(choice.icon)).foregroundStyle(.tint)
            Text(ready ? "Tap a spot for the new \(choice.label)" : "Finding spots…")
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            Button("Cancel", role: .cancel, action: cancel)
                .buttonStyle(.glass)
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, 12)
        .padding(.horizontal)
    }
}

/// What a finger is doing on the map. Each view reads only what it shows, so
/// a drag redraws the moved card and its lines, not the map.
@MainActor
@Observable
final class MapTouch {
    /// The node being moved.
    private(set) var movingNode: String?
    /// How far, in map points.
    private(set) var movedBy = CGSize.zero
    /// A connection being dragged out of a node's handle.
    var linking: Linking?
    /// The node a dragged connection is over.
    var hovered: String?

    struct Linking: Equatable {
        let fromNode: String
        /// The finger, in map points.
        let point: CGPoint
    }

    func move(_ nodeId: String, by translation: CGSize) {
        if movingNode != nodeId { movingNode = nodeId }
        movedBy = translation
    }

    func endMove() {
        movingNode = nil
        movedBy = .zero
    }

    /// How far a node is moved; asking about one not moving does not follow
    /// the drag.
    func offset(of nodeId: String) -> CGSize {
        movingNode == nodeId ? movedBy : .zero
    }
}

/// The map's scroll view. UIKit pans, decelerates, pinches and bounces it;
/// when a pinch ends the map is laid out again at the new scale (sharp, and
/// with cards' text at its size) with the same canvas point in the middle. A
/// long press on a card lifts it to move it; a touch on a card's `+` handle
/// drags out a connection.
struct MapScroll<Content: View>: UIViewControllerRepresentable {
    let nodes: [CanvasModel.Node]
    /// Spots a new panel can take, in canvas units: the map reaches them.
    let spots: [CGRect]
    /// A new panel waits for its spot: a tap is all the map takes.
    let placing: Bool
    /// Where to zoom, once per new value.
    let fit: MapFit?
    let touch: MapTouch
    /// The nodes whose handle drags out a connection.
    let linkable: (CanvasModel.Node, MapLayout) -> Bool
    /// A tap at a map point.
    let tapped: (CGPoint, MapLayout) -> Void
    /// A node dropped `by` map points away.
    let moved: (CanvasModel.Node, CGSize, MapLayout) -> Void
    /// A connection dropped at a map point.
    let linked: (CanvasModel.Node, CGPoint, MapLayout) -> Void
    /// The part of the canvas on screen, once scrolling stops.
    let settled: (CGRect) -> Void
    @ViewBuilder let content: (MapLayout) -> Content

    func makeUIViewController(context: Context) -> MapScrollController {
        MapScrollController(touch: touch)
    }

    func updateUIViewController(_ controller: MapScrollController, context: Context) {
        controller.nodes = nodes
        controller.spots = spots
        controller.placing = placing
        controller.fit = fit
        controller.linkable = linkable
        controller.tapped = tapped
        controller.moved = moved
        controller.linked = linked
        controller.settled = settled
        controller.content = { AnyView(content($0)) }
        controller.render()
    }
}

final class MapScrollController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    /// Zoomed in no further than the canvas's own size.
    static let maxScale: CGFloat = 1

    let touch: MapTouch
    var nodes: [CanvasModel.Node] = []
    var spots: [CGRect] = []
    var placing = false
    var fit: MapFit?
    var linkable: (CanvasModel.Node, MapLayout) -> Bool = { _, _ in false }
    var tapped: (CGPoint, MapLayout) -> Void = { _, _ in }
    var moved: (CanvasModel.Node, CGSize, MapLayout) -> Void = { _, _, _ in }
    var linked: (CanvasModel.Node, CGPoint, MapLayout) -> Void = { _, _, _ in }
    var settled: (CGRect) -> Void = { _ in }
    var content: (MapLayout) -> AnyView = { _ in AnyView(EmptyView()) }

    private let scrollView = UIScrollView()
    private let host = UIHostingController(rootView: AnyView(EmptyView()))
    private let tap = UITapGestureRecognizer()
    private let press = UILongPressGestureRecognizer()
    private let link = UILongPressGestureRecognizer()
    private let lift = UIImpactFeedbackGenerator(style: .medium)
    private let tick = UISelectionFeedbackGenerator()
    /// Map points per canvas unit; nil until fitted to the screen.
    private var scale: CGFloat?
    private var layout: MapLayout?
    /// The node being moved and where the finger lifted it.
    private var grabbed: (node: CanvasModel.Node, start: CGPoint)?
    /// The node a connection is dragged out of.
    private var linkFrom: CanvasModel.Node?
    /// The last fit zoomed to.
    private var fitted: UUID?

    init(touch: MapTouch) {
        self.touch = touch
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        scrollView.frame = view.bounds
        scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scrollView.delegate = self
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.alwaysBounceHorizontal = true
        scrollView.alwaysBounceVertical = true
        scrollView.bouncesZoom = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .clear
        view.addSubview(scrollView)

        addChild(host)
        host.sizingOptions = []
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        scrollView.addSubview(host.view)
        host.didMove(toParent: self)

        tap.addTarget(self, action: #selector(tapped(_:)))
        tap.delegate = self
        // A tap is a press let go before it lifts the card.
        tap.require(toFail: press)
        scrollView.addGestureRecognizer(tap)
        press.addTarget(self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.3
        press.delegate = self
        scrollView.addGestureRecognizer(press)
        link.addTarget(self, action: #selector(linkDragged(_:)))
        link.minimumPressDuration = 0
        link.allowableMovement = .greatestFiniteMagnitude
        link.delegate = self
        scrollView.addGestureRecognizer(link)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if layout?.viewport != scrollView.bounds.size { render() }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        if layout?.safe != view.safeAreaInsets { render() }
    }

    /// The part of the scroll view no bar covers, in its own coordinates.
    private var open: CGRect { scrollView.bounds.inset(by: view.safeAreaInsets) }

    /// On the map a swipe pans, pinches or drags; only a swipe from the
    /// screen's edge goes back, and not one that starts on a card's handle.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
        navigationController?.interactivePopGestureRecognizer?.require(toFail: link)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = true
    }

    /// Lays the map out at the current scale, keeping the canvas point at the
    /// screen's corner where it was. Waits while a pinch is under way.
    func render() {
        guard isViewLoaded, scrollView.bounds.width > 0, scrollView.zoomScale == 1 else { return }
        let viewport = scrollView.bounds.size
        let safe = view.safeAreaInsets
        // Within the zoom range the nodes, spots and screen allow now: the
        // range moves when they change, and a scale outside it would put 1
        // outside the scroll view's zoom range.
        let open = MapLayout.open(viewport, safe)
        let scale = min(Self.maxScale, max(minScale(open), self.scale ?? fit(open)))
        self.scale = scale
        let previous = layout
        let next = MapLayout(nodes: nodes, spots: spots, scale: scale, viewport: viewport, safe: safe)
        layout = next
        host.rootView = content(next)
        if host.view.frame.size != next.size {
            host.view.frame = CGRect(origin: .zero, size: next.size)
            scrollView.contentSize = next.size
        }
        scrollView.minimumZoomScale = minScale(open) / scale
        scrollView.maximumZoomScale = Self.maxScale / scale
        if let previous {
            if !previous.maps(like: next) {
                scrollView.contentOffset = clamped(next.viewPoint(previous.canvasPoint(scrollView.contentOffset)))
            }
        } else {
            // Not from within SwiftUI's update.
            DispatchQueue.main.async { [weak self] in self?.report() }
        }
        if let fit, fit.id != fitted {
            fitted = fit.id
            DispatchQueue.main.async { [weak self] in self?.zoom(to: fit.rect) }
        }
    }

    /// Zoomed out no further than the whole canvas (and the spots a new
    /// panel can take) on the open screen.
    private func minScale(_ viewport: CGSize) -> CGFloat {
        let extent = MapLayout.extent(nodes, spots)
        let whole = min(
            (viewport.width - MapLayout.padding * 2) / max(extent.width, 1),
            (viewport.height - MapLayout.padding * 2) / max(extent.height, 1)
        )
        return min(Self.maxScale, max(0.01, whole))
    }

    private func fit(_ viewport: CGSize) -> CGFloat {
        let width = MapLayout.extent(nodes, spots).width
        return min(Self.maxScale, max(minScale(viewport), (viewport.width - MapLayout.padding * 2) / max(width, 1)))
    }

    private func clamped(_ offset: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(0, offset.x), max(0, scrollView.contentSize.width - scrollView.bounds.width)),
            y: min(max(0, offset.y), max(0, scrollView.contentSize.height - scrollView.bounds.height))
        )
    }

    /// The part of the canvas on screen.
    private func report() {
        guard let layout else { return }
        let a = layout.canvasPoint(scrollView.convert(CGPoint(x: open.minX, y: open.minY), to: host.view))
        let b = layout.canvasPoint(scrollView.convert(CGPoint(x: open.maxX, y: open.maxY), to: host.view))
        settled(CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y))
    }

    /// Glides to show `rect` (canvas units) whole, then lays the map out at
    /// the scale it reached.
    private func zoom(to rect: CGRect) {
        guard let layout, scrollView.zoomScale == 1, rect.width > 0, rect.height > 0 else { return }
        let bounds = scrollView.bounds.size
        let open = self.open
        let zoom = min(scrollView.maximumZoomScale, max(scrollView.minimumZoomScale,
            min(open.width / (rect.width * layout.scale), open.height / (rect.height * layout.scale))))
        let middle = layout.viewPoint(CGPoint(x: rect.midX, y: rect.midY))
        // From the open screen's middle to the scroll view's.
        let shift = CGPoint(x: open.midX - scrollView.bounds.midX, y: open.midY - scrollView.bounds.midY)
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
            self.scrollView.zoomScale = zoom
            let size = self.scrollView.contentSize
            let inset = self.scrollView.contentInset
            self.scrollView.contentOffset = CGPoint(
                x: min(max(-inset.left, middle.x * zoom - bounds.width / 2 - shift.x), max(-inset.left, size.width - bounds.width)),
                y: min(max(-inset.top, middle.y * zoom - bounds.height / 2 - shift.y), max(-inset.top, size.height - bounds.height))
            )
        } completion: { _ in
            self.commitZoom()
        }
    }

    // MARK: Zoom

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { host.view }

    /// A map smaller than the screen stays centred while pinched.
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        guard scrollView.zoomScale != 1 else { return }
        let size = scrollView.contentSize
        scrollView.contentInset = UIEdgeInsets(
            top: max(0, (scrollView.bounds.height - size.height) / 2),
            left: max(0, (scrollView.bounds.width - size.width) / 2),
            bottom: 0,
            right: 0
        )
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale zoom: CGFloat) {
        commitZoom()
    }

    /// Lays the map out at the scale a zoom reached, with the same canvas
    /// point in the middle.
    private func commitZoom() {
        let zoom = scrollView.zoomScale
        guard zoom != 1, let layout, let scale else { return }
        let middle = scrollView.convert(CGPoint(x: open.midX, y: open.midY), to: host.view)
        let anchor = layout.canvasPoint(middle)
        UIView.performWithoutAnimation {
            // The scroll view clamps the zoom to its range: with 1 outside
            // it the map would stay zoomed, and render and every touch wait
            // for a zoom of 1.
            scrollView.minimumZoomScale = min(scrollView.minimumZoomScale, 1)
            scrollView.maximumZoomScale = max(scrollView.maximumZoomScale, 1)
            scrollView.zoomScale = 1
            scrollView.contentInset = .zero
            self.scale = min(Self.maxScale, max(minScale(MapLayout.open(scrollView.bounds.size, view.safeAreaInsets)), scale * zoom))
            render()
            host.view.layoutIfNeeded()
            if let next = self.layout {
                let point = next.viewPoint(anchor)
                let safe = view.safeAreaInsets
                let open = MapLayout.open(scrollView.bounds.size, safe)
                scrollView.contentOffset = clamped(CGPoint(x: point.x - safe.left - open.width / 2, y: point.y - safe.top - open.height / 2))
            }
        }
        report()
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { report() }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { report() }
    }

    // MARK: Moving and connecting

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive event: UITouch) -> Bool {
        guard let layout, scrollView.zoomScale == 1 else { return false }
        let point = event.location(in: host.view)
        if placing { return recognizer === tap }
        let onHandle = handle(at: point, in: layout) != nil
        if recognizer === link { return onHandle }
        // Tap and press: a card, but not its handle or its menu.
        guard !onHandle, let node = layout.node(at: point) else { return false }
        return !layout.menu(node).contains(point)
    }

    /// SwiftUI's recognizers in the map never hold a card's gestures back;
    /// the scroll view's own stay exclusive (`takeOver`).
    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other.view !== scrollView
    }

    private func handle(at point: CGPoint, in layout: MapLayout) -> CanvasModel.Node? {
        layout.nodes.last { layout.handle($0).contains(point) && linkable($0, layout) }
    }

    /// The finger now belongs to the card: the map stops scrolling.
    private func takeOver() {
        scrollView.panGestureRecognizer.isEnabled = false
        scrollView.panGestureRecognizer.isEnabled = true
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard let layout else { return }
        tapped(recognizer.location(in: host.view), layout)
    }

    @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
        guard let layout else { return }
        let point = recognizer.location(in: host.view)
        switch recognizer.state {
        case .began:
            guard let node = layout.node(at: point) else { return }
            grabbed = (node, point)
            takeOver()
            lift.impactOccurred()
            touch.move(node.id, by: .zero)
        case .changed:
            guard let grabbed else { return }
            touch.move(grabbed.node.id, by: CGSize(width: point.x - grabbed.start.x, height: point.y - grabbed.start.y))
        case .ended:
            guard let grabbed else { return }
            self.grabbed = nil
            let by = CGSize(width: point.x - grabbed.start.x, height: point.y - grabbed.start.y)
            if hypot(by.width, by.height) < 1 {
                touch.endMove()
            } else {
                moved(grabbed.node, by, layout)
            }
        default:
            grabbed = nil
            touch.endMove()
        }
    }

    @objc private func linkDragged(_ recognizer: UILongPressGestureRecognizer) {
        guard let layout else { return }
        let point = recognizer.location(in: host.view)
        switch recognizer.state {
        case .began:
            guard let node = handle(at: point, in: layout) else { return }
            linkFrom = node
            takeOver()
            lift.impactOccurred(intensity: 0.6)
            touch.linking = MapTouch.Linking(fromNode: node.id, point: point)
        case .changed:
            guard let from = linkFrom else { return }
            touch.linking = MapTouch.Linking(fromNode: from.id, point: point)
            let over = layout.node(at: point).flatMap { $0.id == from.id ? nil : $0.id }
            if over != touch.hovered {
                touch.hovered = over
                if over != nil { tick.selectionChanged() }
            }
        case .ended:
            let from = linkFrom
            endLink()
            if let from { linked(from, point, layout) }
        default:
            endLink()
        }
    }

    private func endLink() {
        linkFrom = nil
        touch.linking = nil
        touch.hovered = nil
    }
}

/// Canvas units to map points: the nodes' extent scaled, padded and, when
/// smaller than the screen, centred on it.
struct MapLayout {
    static let padding: CGFloat = 32

    let nodes: [CanvasModel.Node]
    let scale: CGFloat
    let viewport: CGSize
    /// The bars over the map's edges: the map runs under them, and its
    /// edges scroll clear of them.
    let safe: UIEdgeInsets
    let bounds: CGRect
    let inset: CGPoint
    let size: CGSize

    /// `spots`, in canvas units, are reached by the map too.
    init(nodes: [CanvasModel.Node], spots: [CGRect] = [], scale: CGFloat, viewport: CGSize, safe: UIEdgeInsets = .zero) {
        self.nodes = nodes
        self.scale = scale
        self.viewport = viewport
        self.safe = safe
        bounds = Self.extent(nodes, spots)
        let open = Self.open(viewport, safe)
        // Room for the worktree territories, which reach past the windows.
        let padding = Self.padding + 90 * scale
        let width = bounds.width * scale + padding * 2
        let height = bounds.height * scale + padding * 2
        inset = CGPoint(x: safe.left + padding + max(0, (open.width - width) / 2), y: safe.top + padding + max(0, (open.height - height) / 2))
        size = CGSize(width: max(width, open.width) + safe.left + safe.right, height: max(height, open.height) + safe.top + safe.bottom)
    }

    /// The part of the screen no bar covers.
    static func open(_ viewport: CGSize, _ safe: UIEdgeInsets) -> CGSize {
        CGSize(width: max(1, viewport.width - safe.left - safe.right), height: max(1, viewport.height - safe.top - safe.bottom))
    }

    static func extent(_ nodes: [CanvasModel.Node], _ spots: [CGRect] = []) -> CGRect {
        let union = nodes.reduce(spots.reduce(CGRect.null) { $0.union($1) }) { $0.union(CGRect(x: $1.rect.x, y: $1.rect.y, width: $1.rect.width, height: $1.rect.height)) }
        return union.isNull ? CGRect(x: 0, y: 0, width: 1, height: 1) : union
    }

    /// Both put every canvas point at the same map point.
    func maps(like other: MapLayout) -> Bool {
        scale == other.scale && inset == other.inset && bounds.origin == other.bounds.origin
    }

    func viewPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: inset.x + (point.x - bounds.minX) * scale, y: inset.y + (point.y - bounds.minY) * scale)
    }

    func canvasPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: bounds.minX + (point.x - inset.x) / scale, y: bounds.minY + (point.y - inset.y) / scale)
    }

    func frame(_ node: CanvasModel.Node) -> CGRect {
        frame(canvas: CGRect(x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height))
    }

    /// A canvas rect in map points.
    func frame(canvas rect: CGRect) -> CGRect {
        let origin = viewPoint(rect.origin)
        return CGRect(x: origin.x, y: origin.y, width: rect.width * scale, height: rect.height * scale)
    }

    /// Where a finger grabs the node's `+` handle: the handle and the inset
    /// around it, at the map's scale.
    func handle(_ node: CanvasModel.Node) -> CGRect {
        let frame = frame(node)
        let side = (TileMetrics.handle + TileMetrics.padding) * scale
        return CGRect(x: frame.maxX - side, y: frame.maxY - side, width: side, height: side)
    }

    /// Where the tile's `…` button sits, in its top corner.
    func menu(_ node: CanvasModel.Node) -> CGRect {
        let frame = frame(node)
        let side = (TileMetrics.menu + TileMetrics.padding) * scale
        return CGRect(x: frame.maxX - side, y: frame.minY, width: side, height: side)
    }

    /// The topmost node under a map point.
    func node(at point: CGPoint) -> CanvasModel.Node? {
        nodes.last { frame($0).contains(point) }
    }

    /// Where a view of `size` centred at `point` stays inside the map.
    func clamped(_ point: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(
            x: min(max(point.x, size.width / 2 + 8), self.size.width - size.width / 2 - 8),
            y: min(max(point.y, size.height / 2 + 8), self.size.height - size.height / 2 - 8)
        )
    }

    /// A relation's line between the edges of its two nodes, each moved by
    /// `offset`; nil when either panel is not on this canvas or both share a
    /// node.
    func line(_ relation: Relation, offset: (String) -> CGSize) -> (from: CGPoint, to: CGPoint)? {
        guard let from = nodes.first(where: { $0.panels.contains(relation.fromPanelId) }),
              let to = nodes.first(where: { $0.panels.contains(relation.toPanelId) }),
              from.id != to.id else { return nil }
        let a = frame(from).offsetBy(dx: offset(from.id).width, dy: offset(from.id).height)
        let b = frame(to).offsetBy(dx: offset(to.id).width, dy: offset(to.id).height)
        return (edge(of: a, toward: CGPoint(x: b.midX, y: b.midY)), edge(of: b, toward: CGPoint(x: a.midX, y: a.midY)))
    }

    /// Where the line from the rect's centre to `point` leaves the rect.
    func edge(of rect: CGRect, toward point: CGPoint) -> CGPoint {
        let dx = point.x - rect.midX
        let dy = point.y - rect.midY
        guard dx != 0 || dy != 0 else { return CGPoint(x: rect.midX, y: rect.midY) }
        let t = min(dx == 0 ? .infinity : rect.width / 2 / abs(dx), dy == 0 ? .infinity : rect.height / 2 / abs(dy))
        return CGPoint(x: rect.midX + dx * t, y: rect.midY + dy * t)
    }
}

// MARK: Connections

/// A relation's color, the same on the map and in lists: one per flow, as
/// on the desktop (a golden-angle hue step), the accent outside any flow.
enum RelationStyle {
    static func color(_ relation: Relation) -> Color {
        guard let flow = relation.flow else { return .accentColor }
        let hue = (211 + Double(flow) * 137.508).truncatingRemainder(dividingBy: 360).rounded() / 360
        return Color(hue: hue, saturation: 0.72, lightness: 0.58)
    }
}

private extension Color {
    /// From HSL, the way the desktop writes its flow colors.
    init(hue: Double, saturation: Double, lightness: Double) {
        let value = lightness + saturation * min(lightness, 1 - lightness)
        let hsbSaturation = value == 0 ? 0 : 2 * (1 - lightness / value)
        self.init(hue: hue, saturation: hsbSaturation, brightness: value)
    }
}

/// A connection as an arrow from node to node, drawn like the desktop's: a
/// dashed line in its flow's color ending in a small triangle. Drawn in its
/// own small box, so the map holds no map-sized drawing.
private struct RelationLine: View {
    let layout: MapLayout
    let relation: Relation
    let touch: MapTouch

    var body: some View {
        if let line = layout.line(relation, offset: touch.offset(of:)) {
            let color = RelationStyle.color(relation)
            Arrow(from: line.from, to: line.to) { context, from, to in
                var path = Path()
                path.move(to: from)
                path.addLine(to: to)
                context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 2.25, lineCap: .round, dash: [10, 8]))
                context.fill(Self.arrowhead(at: to, from: from), with: .color(color))
            }
        }
    }

    /// The desktop's 8 by 8 triangle, its tip a point past the line's end.
    private static func arrowhead(at end: CGPoint, from start: CGPoint) -> Path {
        let angle = atan2(end.y - start.y, end.x - start.x)
        let along = CGPoint(x: cos(angle), y: sin(angle))
        let across = CGPoint(x: -along.y, y: along.x)
        let tip = CGPoint(x: end.x + along.x, y: end.y + along.y)
        let base = CGPoint(x: tip.x - along.x * 8, y: tip.y - along.y * 8)
        var path = Path()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: base.x + across.x * 4, y: base.y + across.y * 4))
        path.addLine(to: CGPoint(x: base.x - across.x * 4, y: base.y - across.y * 4))
        path.closeSubpath()
        return path
    }
}

/// A connection being dragged out of a card's handle.
private struct DraftLine: View {
    let layout: MapLayout
    let touch: MapTouch

    var body: some View {
        if let link = touch.linking, let node = layout.nodes.first(where: { $0.id == link.fromNode }) {
            Arrow(from: layout.edge(of: layout.frame(node), toward: link.point), to: link.point) { context, from, to in
                var path = Path()
                path.move(to: from)
                path.addLine(to: to)
                context.stroke(path, with: .color(.accentColor), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [4, 5]))
                context.fill(Path(ellipseIn: CGRect(x: to.x - 6, y: to.y - 6, width: 12, height: 12)), with: .color(.accentColor))
            }
        }
    }
}

/// Draws between two map points in a box just around them.
private struct Arrow: View {
    let from: CGPoint
    let to: CGPoint
    let draw: (inout GraphicsContext, CGPoint, CGPoint) -> Void

    var body: some View {
        let box = CGRect(x: min(from.x, to.x), y: min(from.y, to.y), width: abs(to.x - from.x), height: abs(to.y - from.y)).insetBy(dx: -12, dy: -12)
        Canvas { context, _ in
            let shift = CGPoint(x: -box.minX, y: -box.minY)
            draw(&context, CGPoint(x: from.x + shift.x, y: from.y + shift.y), CGPoint(x: to.x + shift.x, y: to.y + shift.y))
        }
        .frame(width: box.width, height: box.height)
        .position(x: box.midX, y: box.midY)
        .allowsHitTesting(false)
    }
}

/// A connection's meaning at the middle of its line, as a menu that changes
/// the meaning or removes it. A line too short for its words gets a dot in
/// its color.
private struct RelationChip: View {
    let layout: MapLayout
    let relation: Relation
    let touch: MapTouch
    let setKind: (String) -> Void
    let remove: () -> Void

    var body: some View {
        if let line = layout.line(relation, offset: touch.offset(of:)) {
            // Sized in canvas units, so it zooms with the map like the cards;
            // the words fit or not whatever the zoom.
            let s = layout.scale
            let roomy = hypot(line.to.x - line.from.x, line.to.y - line.from.y) / s >= CGFloat(relation.label.count) * 6.5 + 24
            // Drawn at `draw` and shrunk whole below it, as the cards are.
            let draw = max(s, 0.5)
            Menu {
                Section("Meaning") {
                    ForEach(relation.options) { option in
                        Button { setKind(option.kind) } label: {
                            if option.kind == relation.kind {
                                Label(option.label, systemImage: "checkmark")
                            } else {
                                Text(option.label)
                            }
                            Text(option.description)
                        }
                    }
                }
                Button("Remove Connection", systemImage: "trash", role: .destructive, action: remove)
            } label: {
                chip(roomy: roomy, scale: draw)
                    .scaleEffect(s / draw)
            }
            .position(x: (line.from.x + line.to.x) / 2, y: (line.from.y + line.to.y) / 2)
        }
    }

    @ViewBuilder
    private func chip(roomy: Bool, scale: CGFloat) -> some View {
        let color = RelationStyle.color(relation)
        if roomy {
            Text(relation.label)
                .font(.system(size: 11 * scale, weight: .medium))
                .foregroundStyle(color)
                .padding(.horizontal, 8 * scale)
                .padding(.vertical, 4 * scale)
                .background(.regularMaterial, in: .capsule)
                .fixedSize()
        } else {
            Circle()
                .fill(color)
                .frame(width: 10 * scale, height: 10 * scale)
                .padding(7 * scale)
                .background(.regularMaterial, in: .circle)
                .accessibilityLabel(relation.label)
        }
    }
}

/// The meanings a dropped connection can take, at the spot it was dropped.
private struct LinkMenu: View {
    let pending: PendingLink
    let target: Panel?
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Connect to \(target?.title ?? "panel")")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            ForEach(Array(pending.options.enumerated()), id: \.element.id) { index, option in
                Button { pick(option.kind) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(option.label).font(.body.weight(.medium))
                            if index == 0 {
                                Text("Recommended").font(.caption2.weight(.semibold)).foregroundStyle(.tint)
                            }
                        }
                        Text(option.description).font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 12)
        .frame(width: 280)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

// MARK: Panels

/// A canvas panel opened on its own (a canvas on a canvas, an agent's or a
/// notification's): its map.
struct CanvasPanelView: View {
    let workspaceId: String
    let panel: Panel
    @State private var center: CGPoint?
    @State private var placing: PanelChoice?

    var body: some View {
        PlaceHost(workspaceId: workspaceId) { actions in
            CanvasPlace(workspaceId: workspaceId, canvasPanel: panel, actions: actions, center: $center, placing: $placing)
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NewPanelMenu(workspaceId: workspaceId, placement: Placement(canvasPanelId: panel.id, point: center), pick: { placing = $0 })
            }
        }
    }
}

/// `+`: a new panel in the place on screen. On a canvas, `pick` places it
/// there; otherwise it opens once made, or goes to `opened`.
struct NewPanelMenu: View {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    /// The canvas spot it goes to; nil for the dock.
    let placement: Placement?
    /// Shows a new panel in place of opening it.
    var opened: ((String) -> Void)?
    /// Places a picked type on the canvas, in place of making it here.
    var pick: ((PanelChoice) -> Void)?
    @State private var choices: [PanelChoice] = []
    @State private var created: PanelRoute?

    var body: some View {
        Menu {
            ForEach(choices.filter { placement == nil || $0.canvas }) { choice in
                Button(choice.label, systemImage: PanelIcon.symbol(choice.icon)) {
                    if let pick { pick(choice) } else { add(choice) }
                }
            }
        } label: {
            Label("New Panel", systemImage: "plus")
        }
        .navigationDestination(item: $created) { PanelView(route: $0) }
        .task { choices = await core.panelChoices("panel.creatable", ["workspaceId": workspaceId]) }
    }

    private func add(_ choice: PanelChoice) {
        Task {
            guard let id = await core.createPanel(workspaceId, type: choice.type, at: placement) else { return }
            if let opened {
                opened(id)
            } else {
                created = PanelRoute(workspaceId: workspaceId, panelId: id)
            }
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
