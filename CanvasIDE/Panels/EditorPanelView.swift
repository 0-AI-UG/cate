import AppKit

// MARK: - EditorPanelView
//
// NSScrollView + NSTextView with a line-number gutter.
// Dark theme: background #1E1E24, text near-white.
// Monospace font: Menlo 12pt.
// No external dependencies — syntax highlighting via NSAttributedString
// keyword colouring for common languages (plain-text fallback).

final class EditorPanelView: NSView {

    // MARK: Constants

    private static let background   = NSColor(red: 0x1E / 255.0,
                                              green: 0x1E / 255.0,
                                              blue: 0x24 / 255.0,
                                              alpha: 1.0)
    private static let textColor    = NSColor(white: 0.90, alpha: 1.0)
    private static let gutterBG     = NSColor(red: 0x16 / 255.0,
                                              green: 0x16 / 255.0,
                                              blue: 0x1B / 255.0,
                                              alpha: 1.0)
    private static let gutterWidth: CGFloat  = 44
    private static let editorFont   = NSFont(name: "Menlo", size: 12)
                                      ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    // MARK: Subviews

    private let scrollView:     NSScrollView
    private let textView:       NSTextView
    private let lineNumberView: LineNumberView

    // MARK: Model

    private let panel: EditorPanel

    // MARK: Init

    init(panel: EditorPanel) {
        self.panel = panel

        // Build text storage + layout stack
        let textStorage  = NSTextStorage()
        let layoutMgr    = NSLayoutManager()
        let textContainer = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude,
                                                         height: CGFloat.greatestFiniteMagnitude))
        textContainer.widthTracksTextView  = true
        textContainer.heightTracksTextView = false
        layoutMgr.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutMgr)

        let tv = NSTextView(frame: .zero, textContainer: textContainer)
        tv.minSize = NSSize(width: 0, height: 0)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude,
                            height: CGFloat.greatestFiniteMagnitude)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.isEditable = true
        tv.isRichText = false
        tv.allowsUndo = true
        tv.font = Self.editorFont
        tv.textColor = Self.textColor
        tv.backgroundColor = Self.background
        tv.insertionPointColor = NSColor(white: 0.85, alpha: 1.0)
        tv.selectedTextAttributes = [
            .backgroundColor: NSColor(white: 1.0, alpha: 0.15),
            .foregroundColor: Self.textColor,
        ]
        self.textView = tv

        let sv = NSScrollView()
        sv.hasVerticalScroller   = true
        sv.hasHorizontalScroller = false
        sv.autohidesScrollers    = true
        sv.backgroundColor       = Self.background
        sv.drawsBackground       = true
        sv.documentView          = tv
        self.scrollView = sv

        self.lineNumberView = LineNumberView(textView: tv, font: Self.editorFont)

        super.init(frame: .zero)

        panel.textView = tv
        setupLayout()
        loadContent()
        tv.delegate = self
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Layout

    private func setupLayout() {
        wantsLayer = true
        layer?.backgroundColor = Self.background.cgColor

        // Gutter
        lineNumberView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(lineNumberView)

        // Scroll view
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)

        NSLayoutConstraint.activate([
            lineNumberView.leadingAnchor.constraint(equalTo: leadingAnchor),
            lineNumberView.topAnchor.constraint(equalTo: topAnchor),
            lineNumberView.bottomAnchor.constraint(equalTo: bottomAnchor),
            lineNumberView.widthAnchor.constraint(equalToConstant: Self.gutterWidth),

            scrollView.leadingAnchor.constraint(equalTo: lineNumberView.trailingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    // MARK: Content

    private func loadContent() {
        guard !panel.content.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Self.editorFont,
            .foregroundColor: Self.textColor,
        ]
        textView.textStorage?.setAttributedString(
            NSAttributedString(string: panel.content, attributes: attrs)
        )
        applySyntaxHighlighting()
        lineNumberView.needsDisplay = true
    }

    // MARK: Syntax Highlighting (lightweight, no external deps)

    private func applySyntaxHighlighting() {
        guard let storage = textView.textStorage else { return }
        let text = storage.string
        guard !text.isEmpty else { return }

        // Determine language from file extension
        let ext = panel.filePath.map { URL(fileURLWithPath: $0).pathExtension.lowercased() } ?? ""
        SyntaxHighlighter.highlight(storage, language: ext, baseFont: Self.editorFont)
    }
}

// MARK: - NSTextViewDelegate

extension EditorPanelView: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) {
        panel.textDidChange(textView.string)
        applySyntaxHighlighting()
        lineNumberView.needsDisplay = true
    }
}

// MARK: - LineNumberView

final class LineNumberView: NSView {

    private weak var textView: NSTextView?
    private let font: NSFont

    private static let foreground = NSColor(white: 0.40, alpha: 1.0)
    private static let background = NSColor(red: 0x16 / 255.0,
                                            green: 0x16 / 255.0,
                                            blue: 0x1B / 255.0,
                                            alpha: 1.0)
    private static let borderColor = NSColor(white: 1.0, alpha: 0.07)

    init(textView: NSTextView, font: NSFont) {
        self.textView = textView
        self.font = NSFont(name: font.fontName, size: font.pointSize - 1)
                    ?? font
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Self.background.cgColor

        // Redraw when the text view scrolls
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(textDidScroll),
            name: NSView.boundsDidChangeNotification,
            object: textView.enclosingScrollView?.contentView
        )
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func textDidScroll(_ note: Notification) {
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let tv = textView,
              let layoutManager = tv.layoutManager,
              let textContainer = tv.textContainer else { return }

        // Right border
        Self.borderColor.setFill()
        NSRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height).fill()

        let visibleRect   = tv.visibleRect
        let glyphRange    = layoutManager.glyphRange(forBoundingRect: visibleRect,
                                                      in: textContainer)
        let charRange     = layoutManager.characterRange(forGlyphRange: glyphRange,
                                                          actualGlyphRange: nil)
        let text          = tv.string as NSString
        let scrollOffset  = tv.enclosingScrollView?.contentView.bounds.origin.y ?? 0

        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: Self.foreground,
        ]

        var lineNumber = 1
        // Count lines before visible range
        let precedingText = text.substring(to: charRange.location) as NSString
        precedingText.enumerateSubstrings(in: NSRange(location: 0, length: precedingText.length),
                                          options: [.byLines, .substringNotRequired]) { _, _, _, _ in
            lineNumber += 1
        }

        var glyphIndex = glyphRange.location
        while glyphIndex < NSMaxRange(glyphRange) {
            var lineGlyphRange = NSRange()
            let lineRect = layoutManager.lineFragmentRect(
                forGlyphAt: glyphIndex, effectiveRange: &lineGlyphRange
            )
            let yPos = lineRect.origin.y - scrollOffset
            let labelStr = "\(lineNumber)" as NSString
            let strSize  = labelStr.size(withAttributes: attrs)
            let drawRect = CGRect(
                x: bounds.width - strSize.width - 6,
                y: yPos + (lineRect.height - strSize.height) / 2,
                width: strSize.width,
                height: strSize.height
            )
            labelStr.draw(in: drawRect, withAttributes: attrs)
            lineNumber  += 1
            glyphIndex   = NSMaxRange(lineGlyphRange)
        }
    }
}

// MARK: - SyntaxHighlighter (built-in, no external deps)

enum SyntaxHighlighter {

    // Colour palette
    private static let keyword   = NSColor(red: 0.80, green: 0.47, blue: 0.97, alpha: 1) // purple
    private static let string_   = NSColor(red: 0.67, green: 0.87, blue: 0.55, alpha: 1) // green
    private static let comment   = NSColor(red: 0.45, green: 0.51, blue: 0.55, alpha: 1) // grey
    private static let number    = NSColor(red: 0.98, green: 0.75, blue: 0.40, alpha: 1) // amber
    private static let typeColor = NSColor(red: 0.38, green: 0.75, blue: 0.93, alpha: 1) // cyan
    private static let plain     = NSColor(white: 0.90, alpha: 1)

    static func highlight(_ storage: NSTextStorage, language: String, baseFont: NSFont) {
        let text = storage.string
        guard !text.isEmpty else { return }
        let fullRange = NSRange(text.startIndex..., in: text)

        // Reset to plain
        storage.addAttributes([.foregroundColor: plain, .font: baseFont], range: fullRange)

        switch language {
        case "swift", "kt", "java", "cs", "cpp", "c", "h", "m":
            applyKeywords(swiftKeywords, to: storage, in: text)
        case "py":
            applyKeywords(pythonKeywords, to: storage, in: text)
        case "js", "ts", "jsx", "tsx":
            applyKeywords(jsKeywords, to: storage, in: text)
        default:
            break // plain text only
        }

        applyStrings(to: storage, in: text)
        applyComments(to: storage, in: text, language: language)
        applyNumbers(to: storage, in: text)
    }

    // MARK: Keyword sets

    private static let swiftKeywords: Set<String> = [
        "import", "class", "struct", "enum", "protocol", "extension", "func", "var", "let",
        "if", "else", "guard", "return", "for", "while", "in", "switch", "case", "default",
        "break", "continue", "throw", "throws", "try", "catch", "defer", "do", "init",
        "deinit", "self", "super", "nil", "true", "false", "static", "final", "override",
        "private", "public", "internal", "open", "fileprivate", "weak", "unowned",
        "lazy", "typealias", "associatedtype", "where", "as", "is", "any", "some",
    ]

    private static let pythonKeywords: Set<String> = [
        "def", "class", "import", "from", "as", "return", "if", "elif", "else",
        "for", "while", "in", "not", "and", "or", "True", "False", "None",
        "pass", "break", "continue", "try", "except", "finally", "raise",
        "with", "lambda", "yield", "global", "nonlocal", "del", "assert",
    ]

    private static let jsKeywords: Set<String> = [
        "const", "let", "var", "function", "return", "if", "else", "for", "while",
        "class", "extends", "import", "export", "default", "from", "new", "this",
        "true", "false", "null", "undefined", "typeof", "instanceof", "in", "of",
        "try", "catch", "finally", "throw", "switch", "case", "break", "continue",
        "async", "await", "static", "get", "set",
    ]

    // MARK: Regex helpers

    private static func applyKeywords(_ keywords: Set<String>,
                                      to storage: NSTextStorage,
                                      in text: String) {
        for kw in keywords {
            let pattern = "\\b\(NSRegularExpression.escapedPattern(for: kw))\\b"
            guard let re = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(text.startIndex..., in: text)
            for match in re.matches(in: text, range: range) {
                storage.addAttribute(.foregroundColor, value: keyword, range: match.range)
            }
        }
    }

    private static func applyStrings(to storage: NSTextStorage, in text: String) {
        // Match double-quoted and single-quoted strings (simple, non-multiline)
        let pattern = #"("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return }
        let range = NSRange(text.startIndex..., in: text)
        for match in re.matches(in: text, range: range) {
            storage.addAttribute(.foregroundColor, value: string_, range: match.range)
        }
    }

    private static func applyComments(to storage: NSTextStorage,
                                      in text: String,
                                      language: String) {
        // Single-line // comments
        let slPattern = #"//[^\n]*"#
        if let re = try? NSRegularExpression(pattern: slPattern) {
            let range = NSRange(text.startIndex..., in: text)
            for match in re.matches(in: text, range: range) {
                storage.addAttribute(.foregroundColor, value: comment, range: match.range)
            }
        }
        // Block /* */ comments
        let blPattern = #"/\*[\s\S]*?\*/"#
        if let re = try? NSRegularExpression(pattern: blPattern) {
            let range = NSRange(text.startIndex..., in: text)
            for match in re.matches(in: text, range: range) {
                storage.addAttribute(.foregroundColor, value: comment, range: match.range)
            }
        }
        // Python # comments
        if language == "py" {
            let pyPattern = #"#[^\n]*"#
            if let re = try? NSRegularExpression(pattern: pyPattern) {
                let range = NSRange(text.startIndex..., in: text)
                for match in re.matches(in: text, range: range) {
                    storage.addAttribute(.foregroundColor, value: comment, range: match.range)
                }
            }
        }
    }

    private static func applyNumbers(to storage: NSTextStorage, in text: String) {
        let pattern = #"\b\d+(\.\d+)?\b"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return }
        let range = NSRange(text.startIndex..., in: text)
        for match in re.matches(in: text, range: range) {
            storage.addAttribute(.foregroundColor, value: number, range: match.range)
        }
    }
}
