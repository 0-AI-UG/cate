import SwiftUI

// MARK: - CommandPaletteItem

struct CommandPaletteItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String?
    let icon: String  // SF Symbol name
    let action: () -> Void
}

// MARK: - CommandPaletteView

struct CommandPaletteView: View {
    @Binding var isPresented: Bool
    @State private var searchText = ""
    @State private var selectedIndex: Int = 0
    let items: [CommandPaletteItem]

    var filteredItems: [CommandPaletteItem] {
        guard !searchText.isEmpty else { return items }
        return items.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Search field
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField("Type a command...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .onSubmit { commitSelection() }
            }
            .padding(12)

            Divider()

            // Results list
            if filteredItems.isEmpty {
                Text("No results")
                    .foregroundColor(.secondary)
                    .font(.system(size: 13))
                    .padding(20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(filteredItems.enumerated()), id: \.element.id) { index, item in
                            CommandPaletteRow(item: item, isSelected: index == selectedIndex)
                                .onTapGesture {
                                    item.action()
                                    isPresented = false
                                }
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
        .frame(width: 500)
        .background(.ultraThinMaterial)
        .cornerRadius(12)
        .shadow(radius: 20)
        .onKeyPress(.upArrow)   { moveSelection(by: -1); return .handled }
        .onKeyPress(.downArrow) { moveSelection(by:  1); return .handled }
        .onKeyPress(.escape)    { isPresented = false;   return .handled }
        .onChange(of: searchText) { _ in selectedIndex = 0 }
    }

    private func moveSelection(by delta: Int) {
        guard !filteredItems.isEmpty else { return }
        selectedIndex = (selectedIndex + delta + filteredItems.count) % filteredItems.count
    }

    private func commitSelection() {
        guard filteredItems.indices.contains(selectedIndex) else { return }
        filteredItems[selectedIndex].action()
        isPresented = false
    }
}

// MARK: - CommandPaletteRow

private struct CommandPaletteRow: View {
    let item: CommandPaletteItem
    let isSelected: Bool
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.icon)
                .frame(width: 20)
                .foregroundColor(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 13))
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            (isSelected || isHovering)
                ? Color.accentColor.opacity(0.15)
                : Color.clear
        )
        .onHover { isHovering = $0 }
    }
}

// MARK: - CommandPaletteOverlay
//
// Convenience modifier: wrap any view to show the palette on top.

struct CommandPaletteOverlay: ViewModifier {
    @Binding var isPresented: Bool
    let items: [CommandPaletteItem]

    func body(content: Content) -> some View {
        ZStack {
            content
            if isPresented {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { isPresented = false }

                VStack {
                    CommandPaletteView(isPresented: $isPresented, items: items)
                        .padding(.top, 60)
                    Spacer()
                }
            }
        }
    }
}

extension View {
    func commandPalette(isPresented: Binding<Bool>, items: [CommandPaletteItem]) -> some View {
        modifier(CommandPaletteOverlay(isPresented: isPresented, items: items))
    }
}
