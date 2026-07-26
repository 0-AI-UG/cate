import { useAppStore } from '../../renderer/stores/appStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'

/** Give a newly-created Agent panel its initial worktree by creating a tagged
 * chat. The panel itself stays worktree-agnostic. */
export async function seedAgentPanelWithWorktreeChat(
  workspaceId: string,
  rootPath: string,
  panelId: string,
  worktreeId: string,
): Promise<void> {
  const chats = useChatsStore.getState()
  try {
    await chats.loadChats(rootPath)
  } catch {
    return
  }
  const panel = useAppStore.getState().getWorkspace(workspaceId)?.panels[panelId]
  if (panel?.type !== 'cateAgent') return
  const chat = useChatsStore.getState().createChat(rootPath, 'New chat', panelId, worktreeId)
  useAppStore.getState().setPanelInitialChat(workspaceId, panelId, chat.id)
}
