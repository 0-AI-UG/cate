import SwiftUI

// MARK: - FileExplorerView

struct FileExplorerView: View {
    @ObservedObject var model: FileTreeModel
    let onFileSelected: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Explorer")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Button {
                    model.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Reload")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()
                .padding(.horizontal, 8)

            if model.rootNodes.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "folder")
                        .font(.system(size: 24))
                        .foregroundColor(.secondary)
                    Text("No folder open")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.top, 32)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.rootNodes) { node in
                            FileTreeNodeView(
                                node: node,
                                model: model,
                                depth: 0,
                                onFileSelected: onFileSelected
                            )
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - FileTreeNodeView

private struct FileTreeNodeView: View {
    let node: FileTreeNode
    @ObservedObject var model: FileTreeModel
    let depth: Int
    let onFileSelected: (String) -> Void

    private let indentWidth: CGFloat = 16
    private let rowHeight: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row
            HStack(spacing: 4) {
                // Indentation
                Rectangle()
                    .fill(Color.clear)
                    .frame(width: CGFloat(depth) * indentWidth)

                // Chevron for directories
                if node.isDirectory {
                    Image(systemName: node.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(.secondary)
                        .frame(width: 12)
                } else {
                    Rectangle()
                        .fill(Color.clear)
                        .frame(width: 12)
                }

                // Icon
                Image(systemName: node.sfSymbolName)
                    .font(.system(size: 12))
                    .foregroundColor(iconColor)
                    .frame(width: 16)

                // Name
                Text(node.name)
                    .font(.system(size: 12))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer()
            }
            .frame(height: rowHeight)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
            .onTapGesture {
                if node.isDirectory {
                    model.toggleExpanded(path: node.path)
                } else {
                    onFileSelected(node.path)
                }
            }

            // Expanded children
            if node.isExpanded && node.isDirectory {
                ForEach(node.children) { child in
                    FileTreeNodeView(
                        node: child,
                        model: model,
                        depth: depth + 1,
                        onFileSelected: onFileSelected
                    )
                }
            }
        }
    }

    private var iconColor: Color {
        switch node.sfSymbolName {
        case "folder", "folder.fill":   return .yellow.opacity(0.8)
        case "swift":                    return .orange
        case "globe":                    return .blue
        case "paintbrush":               return .purple
        case "photo":                    return .teal
        default:                         return .secondary
        }
    }
}
