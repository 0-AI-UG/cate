import SwiftUI

// MARK: - ProjectListView
//
// Shows all workspaces as stacked cards in the sidebar.

struct ProjectListView: View {
    @Binding var workspaces: [Workspace]
    @Binding var selectedWorkspaceId: UUID?
    var onAddWorkspace: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Section header
            HStack {
                Text("Workspaces")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Button(action: onAddWorkspace) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("New Workspace")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()
                .padding(.horizontal, 8)

            ScrollView {
                VStack(spacing: 4) {
                    ForEach(workspaces) { workspace in
                        WorkspaceTabView(
                            workspace: workspace,
                            isSelected: selectedWorkspaceId == workspace.id
                        )
                        .onTapGesture { selectedWorkspaceId = workspace.id }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
        }
    }
}
