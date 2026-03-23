import SwiftUI

// MARK: - CanvasToolbar

struct CanvasToolbar: View {

    // MARK: Properties

    let zoomLevel: Double

    var onNewTerminal: () -> Void = {}
    var onNewBrowser: () -> Void = {}
    var onNewEditor: () -> Void = {}
    var onZoomIn: () -> Void = {}
    var onZoomOut: () -> Void = {}

    // MARK: Body

    var body: some View {
        HStack(spacing: 4) {
            // New panel buttons
            Group {
                toolbarButton(symbol: "terminal.fill", label: "Terminal", action: onNewTerminal)
                toolbarButton(symbol: "globe", label: "Browser", action: onNewBrowser)
                toolbarButton(symbol: "doc.text", label: "Editor", action: onNewEditor)
            }

            divider

            // Zoom controls
            Group {
                zoomButton(symbol: "minus", action: onZoomOut)

                Text(zoomText)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(minWidth: 44, alignment: .center)

                zoomButton(symbol: "plus", action: onZoomIn)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule()
                .strokeBorder(.white.opacity(0.12), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.35), radius: 8, x: 0, y: 2)
    }

    // MARK: Helpers

    private var zoomText: String {
        "\(Int((zoomLevel * 100).rounded()))%"
    }

    private var divider: some View {
        Rectangle()
            .fill(.white.opacity(0.15))
            .frame(width: 1, height: 18)
            .padding(.horizontal, 4)
    }

    private func toolbarButton(symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(ToolbarButtonStyle())
        .help(label)
    }

    private func zoomButton(symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(ToolbarButtonStyle())
    }
}

// MARK: - ToolbarButtonStyle

private struct ToolbarButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(.white.opacity(configuration.isPressed ? 0.15 : 0.0))
            )
            .scaleEffect(configuration.isPressed ? 0.92 : 1.0)
            .animation(.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Previews

#if DEBUG
#Preview("CanvasToolbar") {
    ZStack {
        Color(red: 0x12 / 255.0, green: 0x12 / 255.0, blue: 0x18 / 255.0)
            .ignoresSafeArea()

        VStack {
            CanvasToolbar(
                zoomLevel: 1.0,
                onNewTerminal: { print("new terminal") },
                onNewBrowser: { print("new browser") },
                onNewEditor: { print("new editor") },
                onZoomIn: { print("zoom in") },
                onZoomOut: { print("zoom out") }
            )
            .padding(.top, 20)

            Spacer()
        }
    }
    .frame(width: 500, height: 200)
}
#endif
