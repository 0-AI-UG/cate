// A workspace's parallel checkouts on this phone: a panel that runs in one
// can move to another (`WorktreePicker`, in its screen's toolbar and its
// card's menu), and a canvas map shows each checkout's panels on a terraced
// territory in its color, as the desktop's canvas does.

import SwiftUI

extension Worktree {
    /// Its palette key as a system color.
    var tint: Color {
        switch color {
        case "green": .green
        case "cyan": .cyan
        case "magenta": .pink
        case "yellow": .yellow
        case "brightGreen": .mint
        case "brightCyan": .teal
        case "brightMagenta": .purple
        case "brightYellow": .orange
        case "blue": .blue
        case "brightBlue": .indigo
        case "red", "brightRed": .red
        default: .gray
        }
    }
}

// MARK: Switching

extension EnvironmentValues {
    /// Moves a panel to a checkout: `(panelId, worktreeId)`. Set by
    /// `worktreeSwitching(_:)`.
    @Entry var switchWorktree: ((String, String) -> Void)?
}

extension View {
    /// Lets the pickers inside move panels of `workspaceId`; asks before a
    /// switch that stops what runs in the panel.
    func worktreeSwitching(_ workspaceId: String) -> some View {
        modifier(WorktreeSwitching(workspaceId: workspaceId))
    }
}

private struct WorktreeSwitching: ViewModifier {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    /// A switch the panel refused while busy, waiting on the person.
    @State private var busy: BusySwitch?
    @State private var failure: OpFailure?

    private struct BusySwitch {
        let panelId: String
        let worktreeId: String
        let message: String
    }

    func body(content: Content) -> some View {
        content
            .environment(\.switchWorktree) { panelId, worktreeId in send(panelId, worktreeId, discard: false) }
            .confirmationDialog(
                busy?.message ?? "",
                isPresented: Binding(get: { busy != nil }, set: { if !$0 { busy = nil } }),
                titleVisibility: .visible,
                presenting: busy
            ) { busy in
                Button("Stop and Switch", role: .destructive) { send(busy.panelId, busy.worktreeId, discard: true) }
            }
            .alert(item: $failure) { Alert(title: Text($0.message)) }
    }

    private func send(_ panelId: String, _ worktreeId: String, discard: Bool) {
        Task {
            var params: [String: Any] = ["workspaceId": workspaceId, "panelId": panelId, "worktreeId": worktreeId]
            if discard { params["discard"] = true }
            let result = await core.action("panel.setWorktree", params)
            if result.dirty == true {
                busy = BusySwitch(panelId: panelId, worktreeId: worktreeId, message: result.message ?? "The panel is busy. Stop it and switch the worktree?")
            } else if !result.ok {
                failure = OpFailure(message: result.message ?? "The worktree could not be switched.")
            }
        }
    }
}

/// Picks the checkout a panel runs in, for a panel that can move and a
/// workspace with parallel checkouts; nothing otherwise. Its style is the
/// caller's (`.menu` in a card's menu, `.inline` in a toolbar menu).
struct WorktreePicker: View {
    @Environment(\.switchWorktree) private var switchWorktree
    let panel: Panel
    let worktrees: [Worktree]

    var body: some View {
        if panel.switchesWorktree, worktrees.count > 1, let switchWorktree {
            Picker(selection: Binding(
                get: { panel.worktreeId ?? "" },
                set: { id in if id != panel.worktreeId { switchWorktree(panel.id, id) } }
            )) {
                ForEach(worktrees) { worktree in
                    Label {
                        Text(worktree.label)
                    } icon: {
                        Image(systemName: "circle.fill").foregroundStyle(worktree.tint)
                    }
                    .tag(worktree.id)
                }
            } label: {
                Label("Worktree", systemImage: "arrow.triangle.branch")
            }
        }
    }
}

/// The detail view's toolbar button: the panel's checkout, which opens the
/// picker.
struct WorktreeMenu: View {
    let panel: Panel
    let worktrees: [Worktree]

    var body: some View {
        if panel.switchesWorktree, worktrees.count > 1 {
            let current = worktrees.first { $0.id == panel.worktreeId }
            Menu {
                WorktreePicker(panel: panel, worktrees: worktrees).pickerStyle(.inline)
            } label: {
                Label(current?.label ?? "Worktree", systemImage: "arrow.triangle.branch")
            }
            .tint(current?.tint)
            .accessibilityLabel("Worktree: \(current?.label ?? "none")")
        }
    }
}

// MARK: Territories

/// One checkout's territory on a map: its cards' rects rounded and grown into
/// two terraced shelves, fused by bridges between cards close to each other,
/// with a thin outline at each terrace's edge. Drawn in its own box, so the
/// map holds no map-sized drawing; a lifted card takes its territory along.
struct WorktreeTerritory: View {
    let layout: MapLayout
    let nodes: [CanvasModel.Node]
    let color: Color
    let touch: MapTouch

    // The desktop's look (territoryConfig), in canvas units.
    private static let reach: CGFloat = 70
    private static let innerRing: CGFloat = reach / 3
    private static let corner: CGFloat = 18
    private static let fillet: CGFloat = 28
    private static let connectRadius: CGFloat = 110
    private static let connectMaxGap: CGFloat = 520
    private static let connectFalloff: CGFloat = 360
    private static let outerFill = 0.1
    private static let innerFill = 0.13

    var body: some View {
        let rects = nodes.map { node in
            let offset = touch.offset(of: node.id)
            return layout.frame(node).offsetBy(dx: offset.width, dy: offset.height)
        }
        let outer = Self.filled(Self.shelf(rects, at: Self.reach, scale: layout.scale))
        let inner = Self.shelf(rects, at: Self.innerRing, scale: layout.scale)
        let box = outer.boundingBoxOfPath.insetBy(dx: -1, dy: -1)
        if !box.isNull, !box.isEmpty {
            let shift = CGAffineTransform(translationX: -box.minX, y: -box.minY)
            let outerPath = Path(outer.copy(using: [shift]) ?? outer)
            let innerPath = Path(inner.copy(using: [shift]) ?? inner)
            ZStack {
                outerPath.fill(color.opacity(Self.outerFill))
                innerPath.fill(color.opacity(Self.innerFill))
                outerPath.stroke(color.opacity(0.2), lineWidth: 1)
                innerPath.stroke(color.opacity(0.4), lineWidth: 1)
            }
            .frame(width: box.width, height: box.height)
            .position(x: box.midX, y: box.midY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// The cards grown by `distance` canvas units and fused by their bridges,
    /// with the corners where shapes meet rounded off.
    private static func shelf(_ rects: [CGRect], at distance: CGFloat, scale: CGFloat) -> CGPath {
        let d = distance * scale
        var shapes: [CGPath] = rects.map { rect in
            let radius = (corner + distance) * scale
            return CGPath(roundedRect: rect.insetBy(dx: -d, dy: -d), cornerWidth: radius, cornerHeight: radius, transform: nil)
        }
        for a in rects.indices {
            for b in rects.indices where b > a {
                if let bridge = bridge(rects[a], rects[b], scale: scale), bridge.radius + d > 0 {
                    shapes.append(capsule(from: bridge.from, to: bridge.to, radius: bridge.radius + d))
                }
            }
        }
        guard var union = shapes.first else { return CGMutablePath() }
        for shape in shapes.dropFirst() { union = union.union(shape) }
        guard shapes.count > 1 else { return union }
        // Grow, then shrink back: the inner corners where shapes fuse round
        // off, as the desktop's smooth merge does.
        let k = fillet * scale
        let grown = union.union(union.copy(strokingWithWidth: k * 2, lineCap: .round, lineJoin: .round, miterLimit: 1))
        return grown.subtracting(grown.copy(strokingWithWidth: k * 2, lineCap: .round, lineJoin: .round, miterLimit: 1))
    }

    /// The shelf with the pockets it encloses filled: a ring of cards traps no
    /// lake of background, as on the desktop.
    private static func filled(_ path: CGPath) -> CGPath {
        var contours: [CGMutablePath] = []
        path.applyWithBlock { element in
            let points = element.pointee.points
            switch element.pointee.type {
            case .moveToPoint:
                let contour = CGMutablePath()
                contour.move(to: points[0])
                contours.append(contour)
            case .addLineToPoint: contours.last?.addLine(to: points[0])
            case .addQuadCurveToPoint: contours.last?.addQuadCurve(to: points[1], control: points[0])
            case .addCurveToPoint: contours.last?.addCurve(to: points[2], control1: points[0], control2: points[1])
            case .closeSubpath: contours.last?.closeSubpath()
            @unknown default: break
            }
        }
        let result = CGMutablePath()
        for contour in contours where !contours.contains(where: { other in
            other !== contour && other.boundingBox.contains(contour.boundingBox) && other.contains(contour.currentPoint)
        }) {
            result.addPath(contour)
        }
        return result
    }

    /// A bridge between two cards near enough to fuse (the desktop's
    /// `buildBridges` and `bridgeCapsule`): between their facing edges, its
    /// radius fading with the gap; negative while only the outer shelf joins.
    private static func bridge(_ a: CGRect, _ b: CGRect, scale: CGFloat) -> (from: CGPoint, to: CGPoint, radius: CGFloat)? {
        let gapX = max(a.minX - b.maxX, b.minX - a.maxX, 0)
        let gapY = max(a.minY - b.maxY, b.minY - a.maxY, 0)
        let gap = hypot(gapX, gapY) / scale
        guard gap < connectMaxGap else { return nil }
        var weight: CGFloat = 1
        let fadeStart = connectMaxGap - connectFalloff
        if gap > fadeStart {
            let t = 1 - (gap - fadeStart) / connectFalloff
            weight = t * t * (3 - 2 * t)
        }
        let radius = (connectRadius * weight - reach * 1.14 * (1 - weight)) * scale
        let dx = b.midX - a.midX, dy = b.midY - a.midY
        let dist = hypot(dx, dy)
        guard dist > 0.001 else { return nil }
        let ux = dx / dist, uy = dy / dist
        let alongA = abs(ux) * a.width / 2 + abs(uy) * a.height / 2
        let alongB = abs(ux) * b.width / 2 + abs(uy) * b.height / 2
        let acrossA = abs(uy) * a.width / 2 + abs(ux) * a.height / 2
        let acrossB = abs(uy) * b.width / 2 + abs(ux) * b.height / 2
        var start = alongA, end = dist - alongB
        if start > end { start = (start + end) / 2; end = start }
        return (
            CGPoint(x: a.midX + ux * start, y: a.midY + uy * start),
            CGPoint(x: a.midX + ux * end, y: a.midY + uy * end),
            min(radius, acrossA, acrossB, 2 * alongA, 2 * alongB)
        )
    }

    private static func capsule(from: CGPoint, to: CGPoint, radius: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.move(to: from)
        path.addLine(to: to)
        return path.copy(strokingWithWidth: radius * 2, lineCap: .round, lineJoin: .round, miterLimit: 1)
    }
}
