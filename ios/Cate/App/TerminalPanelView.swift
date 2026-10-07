// A terminal panel, live: SwiftTerm draws the screen the core streams
// (`terminal.*` in the core API) and sends keystrokes back. As every view, it
// reports the grid it holds (the screen at a readable font) and draws the
// PTY's grid, which fits whichever view last asked: whole, with the font
// fitted to the screen, and pinching zooms in. While the PTY fits another
// view, "Fit to phone" fits it to this one.

import SwiftTerm
import SwiftUI
import UIKit

struct TerminalPanelView: View {
    let workspaceId: String
    let panel: Panel
    @State private var controller = TerminalController()

    var body: some View {
        TerminalScreen(workspaceId: workspaceId, panelId: panel.id, controller: controller)
            .background(Color.black)
            .overlay(alignment: .top) {
                if let message = controller.message {
                    Text(message)
                        .font(.callout)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.top, 8)
                }
            }
            .navigationTitle(panel.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if controller.fitsElsewhere {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Fit to phone", systemImage: "arrow.up.left.and.arrow.down.right", action: controller.fitToPhone)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(
                        controller.typing ? "Hide keyboard" : "Show keyboard",
                        systemImage: controller.typing ? "keyboard.chevron.compact.down" : "keyboard",
                        action: controller.toggleKeyboard
                    )
                }
            }
    }
}

/// What the SwiftUI page shows of the terminal and asks of it.
@MainActor
@Observable
final class TerminalController {
    /// The PTY's state when it is not running.
    fileprivate(set) var message: String?
    /// The keyboard is up.
    fileprivate(set) var typing = false
    /// The live PTY fits another view, at another grid than this one's.
    fileprivate(set) var fitsElsewhere = false
    @ObservationIgnored fileprivate weak var viewport: TerminalViewport?
    @ObservationIgnored fileprivate var fit: (() -> Void)?

    func fitToPhone() { fit?() }

    func toggleKeyboard() {
        guard let terminal = viewport?.terminal else { return }
        if terminal.isFirstResponder {
            _ = terminal.resignFirstResponder()
        } else {
            _ = terminal.becomeFirstResponder()
        }
    }
}

private struct TerminalScreen: UIViewRepresentable {
    @Environment(CoreHost.self) private var core
    let workspaceId: String
    let panelId: String
    let controller: TerminalController

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> TerminalViewport {
        let viewport = TerminalViewport()
        let coordinator = context.coordinator
        coordinator.connect(viewport, core: core, controller: controller, workspaceId: workspaceId, panelId: panelId)
        controller.viewport = viewport
        controller.fit = { [core, terminalId = coordinator.terminalId] in core.fitTerminal(terminalId) }
        viewport.terminal.terminalDelegate = coordinator
        viewport.terminal.onFirstResponder = { [controller] in controller.typing = $0 }
        viewport.onHeldGrid = { [weak coordinator] in coordinator?.held($0) }
        return viewport
    }

    func updateUIView(_ viewport: TerminalViewport, context: Context) {}

    static func dismantleUIView(_ viewport: TerminalViewport, coordinator: Coordinator) {
        coordinator.close()
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let terminalId = UUID().uuidString
        private var core: CoreHost?
        private weak var viewport: TerminalViewport?
        private weak var controller: TerminalController?
        private var workspaceId = ""
        private var panelId = ""
        private var opened = false
        /// The grid this view holds, the PTY's, whether the PTY fits this
        /// view, and whether it runs.
        private var held: Grid?
        private var pty: Grid?
        private var fitted = false
        private var running = false
        /// The person typed: bring the cursor into view with the echo.
        private var followCursor = false

        func connect(_ viewport: TerminalViewport, core: CoreHost, controller: TerminalController, workspaceId: String, panelId: String) {
            self.viewport = viewport
            self.core = core
            self.controller = controller
            self.workspaceId = workspaceId
            self.panelId = panelId
        }

        /// The grid the screen holds, once laid out and on every change: the
        /// terminal opens with it, and while the PTY fits this view the screen
        /// takes it at once rather than a round trip later.
        func held(_ grid: Grid) {
            held = grid
            guard let core else { return }
            if !opened {
                opened = true
                core.openTerminal(terminalId, workspaceId: workspaceId, panelId: panelId, cols: grid.cols, rows: grid.rows) { [weak self] in
                    self?.handle($0)
                }
            } else {
                core.resizeTerminal(terminalId, cols: grid.cols, rows: grid.rows)
                if fitted { viewport?.setGrid(grid) }
            }
            updateFit()
        }

        private func handle(_ event: TerminalEvent) {
            guard let viewport else { return }
            switch event {
            case .size(let cols, let rows, let fitted):
                pty = Grid(cols: cols, rows: rows)
                self.fitted = fitted
                viewport.setGrid(Grid(cols: cols, rows: rows))
                updateFit()
            case .reset:
                // RIS, as xterm's reset: the serialized screen follows.
                viewport.terminal.feed(text: "\u{1b}c")
            case .output(let data):
                viewport.terminal.feed(byteArray: ArraySlice([UInt8](data)))
                if followCursor {
                    followCursor = false
                    viewport.scrollToCursor()
                }
            case .state(let status, let text):
                running = status == "running"
                controller?.message = text
                updateFit()
            }
        }

        private func updateFit() {
            let elsewhere = running && !fitted && pty != nil && pty != held
            if controller?.fitsElsewhere != elsewhere { controller?.fitsElsewhere = elsewhere }
        }

        func close() {
            if opened { core?.closeTerminal(terminalId) }
            core = nil
        }

        // MARK: TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            followCursor = true
            core?.terminalInput(terminalId, String(decoding: data, as: UTF8.self))
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
            UIApplication.shared.open(url)
        }

        func clipboardCopy(source: TerminalView, content: Data) {
            UIPasteboard.general.string = String(decoding: content, as: UTF8.self)
        }

        // The terminal's size is the PTY's, set from `size` events.
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

/// Shows the PTY's grid whole: the font is fitted so `cols` x `rows` cells
/// fill the screen, and pinching zooms in, with panning. While zoomed (or
/// while the keyboard covers part of the grid) panning moves the grid, and
/// the terminal's own scrollback scrolls only when the grid fits.
final class TerminalViewport: UIScrollView, UIScrollViewDelegate {
    let terminal = CateTerminalView(frame: .zero, font: TerminalViewport.font(ofSize: 12))
    /// The grid the screen holds at a readable font: once laid out, and on
    /// every change.
    var onHeldGrid: ((Grid) -> Void)?

    private var grid: Grid?
    private var heldGrid: Grid?
    /// The space the font is fitted to: the width, and the tallest height
    /// seen at that width, so the keyboard coming up does not shrink it.
    private var basis = CGSize.zero
    private var fittedTo: CGSize?
    private static let largestFont: CGFloat = 18
    /// The cell of the font the grid this view holds is measured in, as
    /// SwiftTerm measures it. Fixed, so refitting the font never moves it.
    private static let readableCell: CGSize = {
        let font = TerminalViewport.font(ofSize: 12)
        return CGSize(
            width: "W".size(withAttributes: [.font: font]).width,
            height: ceil(font.ascender - font.descender + font.leading)
        )
    }()

    init() {
        super.init(frame: .zero)
        delegate = self
        backgroundColor = .black
        contentInsetAdjustmentBehavior = .never
        keyboardDismissMode = .interactive
        minimumZoomScale = 1
        maximumZoomScale = 1
        terminal.nativeBackgroundColor = .black
        terminal.nativeForegroundColor = .white
        terminal.keyboardDismissMode = .interactive
        // The system keyboard, with the keys it lacks in a bar above it.
        terminal.inputAccessoryView = TerminalKeyBar(terminal: terminal)
        terminal.inputView = nil
        addSubview(terminal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private static func font(ofSize size: CGFloat) -> UIFont {
        UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Takes the PTY's grid at once: output after it is drawn on it.
    func setGrid(_ next: Grid) {
        guard next.cols > 0, next.rows > 0, next != grid else { return }
        grid = next
        fit()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != basis.width {
            basis = bounds.size
        } else if bounds.height > basis.height {
            basis.height = bounds.height
        }
        if fittedTo != basis { fit() }
        arrange()
        reportHeldGrid()
    }

    private func reportHeldGrid() {
        guard basis.width > 0, basis.height > 0 else { return }
        let next = Grid(cols: max(1, Int(basis.width / Self.readableCell.width)), rows: max(1, Int(basis.height / Self.readableCell.height)))
        guard next != heldGrid else { return }
        heldGrid = next
        onHeldGrid?(next)
    }

    /// The largest font (in quarter points) at which the grid fits `basis`.
    private func fit() {
        guard let grid else { return }
        guard basis.width > 0, basis.height > 0 else {
            // Not laid out yet: take the grid now, fit the font on layout.
            terminal.setGrid(cols: grid.cols, rows: grid.rows, font: terminal.font)
            contentSize = terminal.frame.size
            return
        }
        let zoom = zoomScale
        zoomScale = 1
        let cell = terminal.cellSize
        let size = terminal.font.pointSize
        var fontSize = min(
            basis.width / (CGFloat(grid.cols) * cell.width / size),
            basis.height / (CGFloat(grid.rows) * cell.height / size)
        )
        fontSize = max(2, (fontSize * 4).rounded(.down) / 4)
        terminal.setGrid(cols: grid.cols, rows: grid.rows, font: Self.font(ofSize: fontSize))
        while fontSize > 2, terminal.frame.width > basis.width + 0.5 || terminal.frame.height > basis.height + 0.5 {
            fontSize -= 0.25
            terminal.setGrid(cols: grid.cols, rows: grid.rows, font: Self.font(ofSize: fontSize))
        }
        fittedTo = basis
        contentSize = terminal.frame.size
        maximumZoomScale = max(1, Self.largestFont / fontSize)
        zoomScale = min(zoom, maximumZoomScale)
        sharpen()
        arrange()
    }

    /// Centers the grid when it is narrower than the screen, and lets the
    /// terminal scroll its scrollback only while the grid fits.
    private func arrange() {
        let left = max(0, (bounds.width - contentSize.width) / 2)
        if contentInset.left != left { contentInset = UIEdgeInsets(top: 0, left: left, bottom: 0, right: 0) }
        let fits = contentSize.width <= bounds.width + 0.5 && contentSize.height <= bounds.height + 0.5
        terminal.isScrollEnabled = fits
    }

    /// Redraws the text at the zoomed resolution instead of scaling pixels.
    private func sharpen() {
        terminal.contentScaleFactor = zoomScale * traitCollection.displayScale
        terminal.setNeedsDisplay()
    }

    func scrollToCursor() {
        let cell = terminal.cellSize
        let cursor = terminal.getTerminal().getCursorLocation()
        let rect = CGRect(
            x: CGFloat(cursor.x) * cell.width,
            y: terminal.contentOffset.y + CGFloat(cursor.y) * cell.height,
            width: cell.width,
            height: cell.height
        )
        scrollRectToVisible(convert(rect, from: terminal).insetBy(dx: -cell.width * 4, dy: -cell.height), animated: false)
    }

    // MARK: UIScrollViewDelegate

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { terminal }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { arrange() }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        sharpen()
    }
}

struct Grid: Equatable {
    let cols: Int
    let rows: Int
}

/// SwiftTerm's view, sized to an exact grid and reporting the keyboard.
final class CateTerminalView: TerminalView {
    var onFirstResponder: ((Bool) -> Void)?

    var cellSize: CGSize {
        let frame = getOptimalFrameSize()
        let terminal = getTerminal()
        return CGSize(width: frame.width / CGFloat(terminal.cols), height: frame.height / CGFloat(terminal.rows))
    }

    /// Exactly `cols` x `rows` cells in `font`. The frame is cleared while the
    /// font changes so the terminal never passes through another size.
    func setGrid(cols: Int, rows: Int, font: UIFont) {
        frame = .zero
        self.font = font
        let cell = cellSize
        frame = CGRect(x: 0, y: 0, width: cell.width * CGFloat(cols) + 0.5, height: cell.height * CGFloat(rows) + 0.5)
        layoutIfNeeded()
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFirstResponder?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFirstResponder?(false) }
        return resigned
    }
}

/// The keys the system keyboard lacks, in a row of glass buttons over the
/// terminal, above the keyboard: esc, tab, the arrows (repeating while held),
/// the page keys and the shell's symbols. A key fires when lifted, so a drag
/// across the row scrolls it instead. Ctrl and alt are sticky: the next key
/// typed takes them, then they let go.
final class TerminalKeyBar: UIView {
    private weak var terminal: CateTerminalView?
    private var ctrl: UIButton!
    private var alt: UIButton!
    private var repeatTimer: Timer?
    /// The held key has started repeating: its lift sends nothing more.
    private var repeated = false
    private static let height: CGFloat = 52

    private enum Key {
        case bytes([UInt8])
        case text(String)
        case arrow(app: [UInt8], normal: [UInt8])
    }

    init(terminal: CateTerminalView) {
        self.terminal = terminal
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: Self.height))
        backgroundColor = .clear

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(key(title: "esc", .bytes(EscapeSequences.cmdEsc)))
        ctrl = modifier(title: "ctrl", #selector(toggleCtrl))
        stack.addArrangedSubview(ctrl)
        alt = modifier(title: "alt", #selector(toggleAlt))
        stack.addArrangedSubview(alt)
        stack.addArrangedSubview(key(symbol: "arrow.right.to.line", label: "Tab", .bytes(EscapeSequences.cmdTab)))
        stack.addArrangedSubview(key(symbol: "arrow.left", label: "Left", .arrow(app: EscapeSequences.moveLeftApp, normal: EscapeSequences.moveLeftNormal), repeats: true))
        stack.addArrangedSubview(key(symbol: "arrow.down", label: "Down", .arrow(app: EscapeSequences.moveDownApp, normal: EscapeSequences.moveDownNormal), repeats: true))
        stack.addArrangedSubview(key(symbol: "arrow.up", label: "Up", .arrow(app: EscapeSequences.moveUpApp, normal: EscapeSequences.moveUpNormal), repeats: true))
        stack.addArrangedSubview(key(symbol: "arrow.right", label: "Right", .arrow(app: EscapeSequences.moveRightApp, normal: EscapeSequences.moveRightNormal), repeats: true))
        for symbol in ["|", "~", "/", "\\", "-", "_", "`", "$", "*", "{", "}", "[", "]", "<", ">"] {
            stack.addArrangedSubview(key(title: symbol, .text(symbol)))
        }
        stack.addArrangedSubview(key(title: "home", .arrow(app: EscapeSequences.moveHomeApp, normal: EscapeSequences.moveHomeNormal)))
        stack.addArrangedSubview(key(title: "end", .arrow(app: EscapeSequences.moveEndApp, normal: EscapeSequences.moveEndNormal)))
        stack.addArrangedSubview(key(title: "pgup", .bytes(EscapeSequences.cmdPageUp), repeats: true))
        stack.addArrangedSubview(key(title: "pgdn", .bytes(EscapeSequences.cmdPageDown), repeats: true))

        let scroll = KeyScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.delaysContentTouches = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -6),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor, constant: -12),
        ])

        // SwiftTerm lets go of a modifier once a typed key takes it.
        NotificationCenter.default.addObserver(self, selector: #selector(syncModifiers), name: .terminalViewControlModifierReset, object: terminal)
        NotificationCenter.default.addObserver(self, selector: #selector(syncModifiers), name: .terminalViewMetaModifierReset, object: terminal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: Self.height) }

    private func key(title: String? = nil, symbol: String? = nil, label: String? = nil, _ key: Key, repeats: Bool = false) -> UIButton {
        let button = UIButton(configuration: style(selected: false))
        if let title { button.configuration?.title = title }
        if let symbol { button.configuration?.image = UIImage(systemName: symbol) }
        button.accessibilityLabel = label ?? title
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            if !self.repeated { self.tap(key) }
            self.stopRepeat()
        }, for: .touchUpInside)
        if repeats {
            button.addAction(UIAction { [weak self] _ in self?.startRepeat(key) }, for: .touchDown)
            // A scroll cancels the touch, and a drag off the key lets go of it.
            for event: UIControl.Event in [.touchUpOutside, .touchCancel, .touchDragExit] {
                button.addAction(UIAction { [weak self] _ in self?.stopRepeat() }, for: event)
            }
        }
        return button
    }

    private func modifier(title: String, _ action: Selector) -> UIButton {
        let button = UIButton(configuration: style(selected: false))
        button.configuration?.title = title
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func style(selected: Bool) -> UIButton.Configuration {
        var config = selected ? UIButton.Configuration.prominentGlass() : UIButton.Configuration.glass()
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12)
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFont.monospacedSystemFont(ofSize: 15, weight: .medium)
            return attributes
        }
        return config
    }

    private func tap(_ key: Key) {
        UIDevice.current.playInputClick()
        press(key)
    }

    private func press(_ key: Key) {
        guard let terminal else { return }
        switch key {
        case .text(let text):
            // As typed, so a held ctrl or alt applies.
            terminal.insertText(text)
            return
        case .bytes(let bytes):
            terminal.send(bytes)
        case .arrow(let app, let normal):
            terminal.send(terminal.getTerminal().applicationCursor ? app : normal)
        }
        terminal.controlModifier = false
        terminal.metaModifier = false
        syncModifiers()
    }

    /// Held past a beat, the key repeats; lifted before, it is a tap.
    private func startRepeat(_ key: Key) {
        stopRepeat()
        repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.repeated = true
                self.tap(key)
                self.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.press(key) }
                }
            }
        }
    }

    private func stopRepeat() {
        repeatTimer?.invalidate()
        repeatTimer = nil
        repeated = false
    }

    @objc private func toggleCtrl() {
        UIDevice.current.playInputClick()
        terminal?.controlModifier.toggle()
        syncModifiers()
    }

    @objc private func toggleAlt() {
        UIDevice.current.playInputClick()
        terminal?.metaModifier.toggle()
        syncModifiers()
    }

    @objc private func syncModifiers() {
        for (button, on) in [(ctrl, terminal?.controlModifier ?? false), (alt, terminal?.metaModifier ?? false)] {
            guard let button else { continue }
            let title = button.configuration?.title
            button.configuration = style(selected: on)
            button.configuration?.title = title
        }
    }
}

extension TerminalKeyBar: UIInputViewAudioFeedback {
    var enableInputClicksWhenVisible: Bool { true }
}

/// Scrolls even when the drag starts on a key: UIScrollView otherwise leaves
/// a touch that began on a control to the control.
private final class KeyScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}
