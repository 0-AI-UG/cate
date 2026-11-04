import SwiftUI

struct ChatCollectionRow {
    let id: String
    let revision: AnyHashable
    let content: AnyView
}

/// A chat has one scroll owner and measured row heights. Preparing a page
/// yields between new rows; scrolling reuses their cached layout heights.
struct ChatCollectionList: UIViewRepresentable {
    let rows: [ChatCollectionRow]
    let firstMessageId: String?
    let ready: Bool
    let scrollRequest: Int
    let onFollowing: (Bool) -> Void
    let onApplied: (String?) -> Void
    var onPositions: (([String: CGRect]) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UICollectionView {
        let collection = ChatCollectionView(frame: .zero, collectionViewLayout: ChatCollectionLayout())
        collection.backgroundColor = .clear
        collection.alwaysBounceVertical = true
        collection.keyboardDismissMode = .interactive
        context.coordinator.install(collection)
        collection.widthChanged = { [weak coordinator = context.coordinator] in coordinator?.prepare() }
        collection.heightChanged = { [weak coordinator = context.coordinator] in coordinator?.viewportResized() }
        collection.positionsUpdated = { [weak coordinator = context.coordinator] in coordinator?.publishPositions() }
        return collection
    }

    func updateUIView(_ collection: UICollectionView, context: Context) {
        context.coordinator.model = self
        context.coordinator.prepare()
    }

    static func dismantleUIView(_ collection: UICollectionView, coordinator: Coordinator) {
        coordinator.stop()
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate, UICollectionViewDataSourcePrefetching {
        var model: ChatCollectionList?
        weak var collection: UICollectionView?
        var preparation: Task<Void, Never>?
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
        private var displayed: [String: ChatCollectionRow] = [:]
        private var heights: [String: (revision: AnyHashable, height: CGFloat)] = [:]
        private var width: CGFloat = 0
        private var positioned = false
        private var following = true
        private var scrollRequest = 0
        private var applying = false
        private var userScrolling = false
        private var prepareAfterApply = false
        private var pendingSizes: [String: CGFloat] = [:]
        private final class Renderer {
            let host: UIHostingController<AnyView>
            init(_ host: UIHostingController<AnyView>) { self.host = host }
        }
        private var renderers: [String: Renderer] = [:]
        private var rendererOrder: [String] = []
        private var prefetches: [String: Task<Void, Never>] = [:]

        func stop() {
            preparation?.cancel()
            for task in prefetches.values { task.cancel() }
            prefetches.removeAll()
            for renderer in renderers.values {
                renderer.host.willMove(toParent: nil)
                renderer.host.view.removeFromSuperview()
                renderer.host.removeFromParent()
            }
            renderers.removeAll()
        }

        func install(_ collection: UICollectionView) {
            self.collection = collection
            collection.delegate = self
            collection.prefetchDataSource = self
            collection.register(ChatCollectionCell.self, forCellWithReuseIdentifier: "chat")
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) { [weak self] collection, path, id in
                let cell = collection.dequeueReusableCell(withReuseIdentifier: "chat", for: path)
                cell.clipsToBounds = true
                guard let self, let row = self.displayed[id] else { return cell }
                let renderer = self.renderers[id] ?? self.makeRenderer(row)
                if let renderer { (cell as? ChatCollectionCell)?.show(renderer.host.view) }
                self.touch(id)
                return cell
            }
        }

        func prepare() {
            guard let collection, collection.window != nil, let model, collection.bounds.width > 32 else { return }
            if applying || userScrolling { prepareAfterApply = true; return }
            preparation?.cancel()
            let rowWidth = collection.bounds.width - 32
            if width != rowWidth { heights.removeAll(); width = rowWidth }
            preparation = Task { @MainActor [weak self] in
                guard let self else { return }
                for row in model.rows {
                    guard !Task.isCancelled else { return }
                    if self.heights[row.id]?.revision != row.revision {
                        guard let height = await self.measure(row, width: rowWidth) else { return }
                        self.heights[row.id] = (row.revision, height)
                    }
                }
                guard !Task.isCancelled else { return }
                self.apply(model)
            }
        }

        private func makeRenderer(_ row: ChatCollectionRow) -> Renderer? {
            guard let collection else { return nil }
            var responder: UIResponder? = collection
            while responder != nil, !(responder is UIViewController) { responder = responder?.next }
            guard let owner = responder as? UIViewController else { return nil }
            let content = AnyView(row.content.frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { [weak self] height in
                    self?.resize(row.id, height: height)
                })
            let host = UIHostingController(rootView: content)
            // The collection owns insets. A row must not gain safe-area
            // padding as its hosting view moves underneath the navigation bar.
            host.safeAreaRegions = []
            host.view.backgroundColor = .clear
            owner.addChild(host)
            host.didMove(toParent: owner)
            let renderer = Renderer(host)
            if renderers[row.id] == nil { renderers[row.id] = renderer }
            return renderer
        }

        private func measure(_ row: ChatCollectionRow, width: CGFloat) async -> CGFloat? {
            guard let collection else { return nil }
            let existing = renderers[row.id]
            guard let renderer = makeRenderer(row) else { return nil }
            let host = renderer.host
            host.view.frame = CGRect(x: -width * 2, y: 0, width: width, height: 1)
            host.view.isUserInteractionEnabled = false
            host.view.accessibilityElementsHidden = true
            collection.addSubview(host.view)
            var result: CGFloat?
            var previous: CGFloat = -1
            for attempt in 0..<6 {
                try? await Task.sleep(for: .milliseconds(16))
                if Task.isCancelled { break }
                host.view.layoutIfNeeded()
                let height = max(1, ceil(host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height))
                if attempt > 0, height == previous { result = height; break }
                previous = height
            }
            if result == nil, !Task.isCancelled { result = previous }
            if host.view.superview === collection { host.view.removeFromSuperview() }
            host.view.isUserInteractionEnabled = true
            host.view.accessibilityElementsHidden = false
            if let existing {
                if result != nil { existing.host.rootView = host.rootView }
                host.willMove(toParent: nil)
                host.removeFromParent()
            }
            touch(row.id)
            return result
        }

        private func touch(_ id: String) {
            rendererOrder.removeAll { $0 == id }
            rendererOrder.append(id)
        }

        private func pruneRenderers() {
            guard let collection else { return }
            let visible = Set(collection.indexPathsForVisibleItems.compactMap { dataSource.itemIdentifier(for: $0) })
            for id in rendererOrder where !visible.contains(id) && prefetches[id] == nil {
                guard renderers.count > 24 || displayed[id] == nil else { continue }
                if let renderer = renderers.removeValue(forKey: id) {
                    renderer.host.willMove(toParent: nil)
                    renderer.host.view.removeFromSuperview()
                    renderer.host.removeFromParent()
                }
            }
            rendererOrder.removeAll { renderers[$0] == nil }
        }

        func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
            for path in indexPaths {
                guard let id = dataSource.itemIdentifier(for: path), renderers[id] == nil,
                      prefetches[id] == nil, let row = displayed[id] else { continue }
                prefetches[id] = Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let height = await self.measure(row, width: self.width) { self.resize(id, height: height) }
                    self.prefetches.removeValue(forKey: id)
                    self.pruneRenderers()
                }
            }
        }

        private func anchor() -> (id: String, y: CGFloat)? {
            guard let collection else { return nil }
            return collection.indexPathsForVisibleItems.sorted().compactMap { path -> (String, CGFloat)? in
                guard let id = dataSource.itemIdentifier(for: path), !id.hasPrefix("__"),
                      let frame = collection.layoutAttributesForItem(at: path)?.frame,
                      frame.maxY > collection.contentOffset.y + collection.adjustedContentInset.top else { return nil }
                return (id, frame.minY - collection.contentOffset.y)
            }.first
        }

        private func restore(_ anchor: (id: String, y: CGFloat)?, atEnd: Bool) {
            guard let collection else { return }
            collection.layoutIfNeeded()
            if atEnd {
                let y = max(-collection.adjustedContentInset.top,
                            collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
                collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            } else if let anchor, let path = dataSource.indexPath(for: anchor.id),
                      let frame = collection.layoutAttributesForItem(at: path)?.frame {
                collection.setContentOffset(CGPoint(x: 0, y: frame.minY - anchor.y), animated: false)
            }
            collection.setNeedsLayout()
            collection.layoutIfNeeded()
            publishPositions()
        }

        private func apply(_ model: ChatCollectionList) {
            guard let collection, let layout = collection.collectionViewLayout as? ChatCollectionLayout else { return }
            if applying || userScrolling { prepareAfterApply = true; return }
            let anchor = anchor()
            let requested = scrollRequest != model.scrollRequest
            let atEnd = following || (!positioned && model.ready) || requested
            let oldIds = dataSource.snapshot().itemIdentifiers
            let newIds = model.rows.map(\.id)
            let changed = model.rows.filter { displayed[$0.id]?.revision != $0.revision }.map(\.id)
            if oldIds == newIds, changed.isEmpty {
                if requested { following = true; restore(nil, atEnd: true); model.onFollowing(true) }
                scrollRequest = model.scrollRequest
                return
            }
            applying = true
            displayed = Dictionary(uniqueKeysWithValues: model.rows.map { ($0.id, $0) })
            heights = heights.filter { displayed[$0.key] != nil }
            layout.heights = model.rows.map { heights[$0.id]?.height ?? 1 }
            if atEnd {
                let height = 16 + layout.heights.reduce(0) { $0 + $1 + 16 }
                layout.updateOffset = CGPoint(x: 0, y: max(-collection.adjustedContentInset.top, height - collection.bounds.height + collection.adjustedContentInset.bottom))
            } else if let anchor, let index = newIds.firstIndex(of: anchor.id) {
                let y = 16 + layout.heights.prefix(index).reduce(0) { $0 + $1 + 16 }
                layout.updateOffset = CGPoint(x: 0, y: y - anchor.y)
            }
            layout.invalidateLayout()
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(newIds)
            let existing = Set(oldIds)
            snapshot.reconfigureItems(changed.filter { existing.contains($0) })
            UIView.performWithoutAnimation {
                dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
                    guard let self else { return }
                    self.restore(anchor, atEnd: atEnd)
                    layout.updateOffset = nil
                    self.applying = false
                    self.pruneRenderers()
                    self.positioned = self.positioned || model.ready
                    self.scrollRequest = model.scrollRequest
                    if requested { self.following = true; model.onFollowing(true) }
                    model.onApplied(model.firstMessageId)
                    let pending = self.pendingSizes
                    self.pendingSizes.removeAll()
                    for (id, height) in pending { self.resize(id, height: height) }
                    if self.prepareAfterApply {
                        self.prepareAfterApply = false
                        self.prepare()
                    }
                }
            }
        }

        private func resize(_ id: String, height: CGFloat) {
            let height = max(1, ceil(height))
            if applying || userScrolling { pendingSizes[id] = height; return }
            guard let collection, let row = displayed[id],
                  let old = heights[id], abs(old.height - height) > 0.5,
                  let layout = collection.collectionViewLayout as? ChatCollectionLayout,
                  let path = dataSource.indexPath(for: id) else { return }
            let anchor = anchor()
            heights[id] = (row.revision, max(1, ceil(height)))
            layout.heights[path.item] = max(1, ceil(height))
            layout.invalidateLayout()
            restore(anchor, atEnd: following)
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            userScrolling = true
            following = false
            model?.onFollowing(false)
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { scrollingEnded() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { scrollingEnded() }

        private func scrollingEnded() {
            guard let collection else { return }
            userScrolling = false
            following = collection.contentSize.height - collection.contentOffset.y - collection.bounds.height + collection.adjustedContentInset.bottom <= 2
            model?.onFollowing(following)
            let pending = pendingSizes
            pendingSizes.removeAll()
            for (id, height) in pending { resize(id, height: height) }
            if prepareAfterApply { prepareAfterApply = false; prepare() }
        }

        func viewportResized() {
            if positioned, following, !applying { restore(nil, atEnd: true) }
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            publishPositions()
        }

        func publishPositions() {
            guard let collection, let callback = model?.onPositions else { return }
            var frames: [String: CGRect] = [:]
            for path in collection.indexPathsForVisibleItems {
                if let id = dataSource.itemIdentifier(for: path), !id.hasPrefix("__"),
                   let frame = collection.layoutAttributesForItem(at: path)?.frame {
                    frames[id] = frame.offsetBy(dx: 0, dy: -collection.contentOffset.y)
                }
            }
            callback(frames)
        }
    }
}

private final class ChatCollectionView: UICollectionView {
    var widthChanged: (() -> Void)?
    var heightChanged: (() -> Void)?
    var positionsUpdated: (() -> Void)?
    private var lastWidth: CGFloat = 0
    private var lastHeight: CGFloat = 0

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { widthChanged?() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != lastWidth {
            lastWidth = bounds.width
            widthChanged?()
        }
        if bounds.height != lastHeight {
            lastHeight = bounds.height
            heightChanged?()
        }
        positionsUpdated?()
    }
}

/// The layout owns heights; hosting configuration must not supply a second
/// competing self-sizing estimate during batch updates.
private final class ChatCollectionCell: UICollectionViewCell {
    private weak var hosted: UIView?

    func show(_ view: UIView) {
        if hosted !== view, hosted?.superview === contentView { hosted?.removeFromSuperview() }
        hosted = view
        view.frame = contentView.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if view.superview !== contentView { contentView.addSubview(view) }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        if hosted?.superview === contentView { hosted?.removeFromSuperview() }
        hosted = nil
    }

    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        layoutAttributes
    }
}

/// Frames use measured heights, never provisional estimates that change
/// when a page boundary scrolls into view.
private final class ChatCollectionLayout: UICollectionViewLayout {
    var heights: [CGFloat] = []
    var updateOffset: CGPoint?
    private var attributes: [UICollectionViewLayoutAttributes] = []
    private var size = CGSize.zero

    override func prepare() {
        guard let collectionView else { return }
        var y: CGFloat = 16
        attributes = heights.enumerated().map { index, height in
            let value = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
            value.frame = CGRect(x: 16, y: y, width: max(1, collectionView.bounds.width - 32), height: height)
            y += height + 16
            return value
        }
        size = CGSize(width: collectionView.bounds.width, height: y)
    }

    override var collectionViewContentSize: CGSize { size }
    override func targetContentOffset(forProposedContentOffset proposedContentOffset: CGPoint) -> CGPoint {
        updateOffset ?? proposedContentOffset
    }
    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        attributes.filter { $0.frame.intersects(rect) }
    }
    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        attributes.indices.contains(indexPath.item) ? attributes[indexPath.item] : nil
    }
    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }
}
