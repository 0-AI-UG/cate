import SwiftUI

// MARK: - WorkspaceTabView
//
// Single workspace card displayed inside ProjectListView.

struct WorkspaceTabView: View {
    @ObservedObject var workspace: Workspace
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 8) {
            // Color dot
            Circle()
                .fill(Color(nsColor: workspace.color))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.name)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(.primary)
                    .lineLimit(1)

                if let root = workspace.rootPath {
                    Text(URL(fileURLWithPath: root).lastPathComponent)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            // Panel count badge
            let nodeCount = workspace.canvasState.nodes.count
            if nodeCount > 0 {
                Text("\(nodeCount)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(isSelected ? Color.white.opacity(0.08) : Color.clear)
        .cornerRadius(6)
        .contentShape(Rectangle())
    }
}
